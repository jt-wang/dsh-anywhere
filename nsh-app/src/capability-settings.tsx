import { cleanup, effect, locale, signal, Text, View } from 'nsh'
import { Input } from 'nsh/base'
import { DshError, type Dsh } from './dsh.ts'
import { appActive, connection, dsh } from './state.ts'
import { language } from './strings.ts'
import type { SettingsNamespace } from './desktop-settings.ts'
import { desktopSettingsStrings } from './desktop-settings-strings.ts'
import { capabilitySettingsStrings } from './capability-settings-strings.ts'
import { capabilityBase, capabilityNamespace, capabilityText, capabilityValue, readCapabilities, saveCapability, translationOptions, type CapabilitySnapshot, type TranslationLimits, type WebProvider } from './capability-settings.ts'

const lang = () => language() === 'system' ? locale() : language(), words = () => capabilitySettingsStrings(lang()), common = () => desktopSettingsStrings(lang())
function Action(p: { id: string; label: string; disabled?: boolean; press: () => void }) {
  return <View testID={p.id} role="button" accessibilityLabel={p.label} accessibilityState={{ disabled: !!p.disabled }} onPress={() => { if (!p.disabled) p.press() }} class={`min-h-[44px] justify-center rounded-[8px] bg-secondary px-3 ${p.disabled ? 'opacity-40' : 'active:opacity-60'}`}><Text class="text-foreground text-[14px]">{p.label}</Text></View>
}
type Save = (namespace: SettingsNamespace, field: 'searchProvider' | 'fetchProvider' | 'provider' | 'targetLanguage', value?: string) => Promise<void>
function WebChoice(p: { kind: 'search' | 'fetch'; namespace: SettingsNamespace; providers: WebProvider[]; disabled: boolean; save: Save }) {
  const field = p.kind === 'search' ? 'searchProvider' : 'fetchProvider', id = `capability-${p.kind}`
  const draft = signal<string | undefined>(capabilityValue(p.namespace, field))
  const missing = () => draft() !== undefined && !p.providers.some(provider => provider.id === draft())
  const autoAllowed = () => capabilityBase(p.namespace, field) === undefined
  return <View class="rounded-[14px] border border-border bg-card p-[14px] gap-2">
    <Text class="text-foreground text-[15px] font-medium">{p.kind === 'search' ? words().search : words().fetch}</Text>
    <If when={missing()}><Text testID={`${id}-missing`} class="text-destructive text-[13px]">{words().missing} [{draft()}]</Text></If>
    <If when={autoAllowed()} else={<Text class="text-muted-foreground text-[13px]">{words().inherited}</Text>}><Action id={`${id}-auto`} label={`${draft() === undefined ? '✓ ' : ''}${words().auto}`} disabled={p.disabled} press={() => draft.set(undefined)} /></If>
    <Each of={p.providers} key={provider => provider.id}>{provider => <View class="gap-1">
      <Action id={`${id}-option-${provider().id}`} label={`${draft() === provider().id ? '✓ ' : ''}${provider().title || provider().id}`} disabled={p.disabled} press={() => draft.set(provider().id)} />
      <If when={draft() === provider().id && provider().description}><Text testID={`${id}-description`} class="text-muted-foreground text-[13px]">{capabilityText(provider().description, lang())}</Text></If>
    </View>}</Each>
    <View class="flex-row flex-wrap gap-2"><Action id={`${id}-save`} label={common().save} disabled={p.disabled || missing() || (draft() === undefined && !autoAllowed())} press={() => void p.save(p.namespace, field, draft())} /><Action id={`${id}-reset`} label={common().reset} disabled={p.disabled} press={() => void p.save(p.namespace, field)} /></View>
  </View>
}
function TranslationChoice(p: { namespace: SettingsNamespace; limits: TranslationLimits; disabled: boolean; save: Save }) {
  const provider = signal(capabilityValue(p.namespace, 'provider') ?? p.limits.preferences.provider)
  const target = signal(capabilityValue(p.namespace, 'targetLanguage') ?? p.limits.preferences.targetLanguage)
  const options = () => translationOptions(p.namespace, p.limits)
  return <View class="rounded-[14px] border border-border bg-card p-[14px] gap-2">
    <Text class="text-foreground text-[15px] font-medium">{words().translation}</Text><Text class="text-muted-foreground text-[13px]">{words().privacy}</Text>
    <Text testID="capability-translation-limits" class="text-muted-foreground text-[13px]">{words().limit}: {p.limits.maxTextChars} · {p.limits.preferences.provider} · {p.limits.preferences.targetLanguage}</Text>
    <Text class="text-foreground text-[14px]">{words().provider}</Text>
    <If when={!options().includes(provider())}><Text testID="capability-translation-missing" class="text-destructive text-[13px]">{words().missing} [{provider()}]</Text></If>
    <View class="flex-row flex-wrap gap-2">{options().map(id => <Action id={`capability-translation-option-${id}`} label={`${provider() === id ? '✓ ' : ''}${id}`} disabled={p.disabled} press={() => provider.set(id)} />)}</View>
    <View class="flex-row flex-wrap gap-2"><Action id="capability-translation-provider-save" label={common().save} disabled={p.disabled || !options().includes(provider())} press={() => void p.save(p.namespace, 'provider', provider())} /><Action id="capability-translation-provider-reset" label={common().reset} disabled={p.disabled} press={() => void p.save(p.namespace, 'provider')} /></View>
    <Text class="text-foreground text-[14px]">{words().target}</Text><Input testID="capability-translation-target" accessibilityLabel={words().target} disabled={p.disabled} value={target()} onChange={e => target.set(e.value)} class="min-h-[44px] rounded-[8px] border border-input bg-background px-3 text-foreground" />
    <View class="flex-row flex-wrap gap-2"><Action id="capability-translation-target-save" label={common().save} disabled={p.disabled || !/^(?:auto|[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*)$/.test(target())} press={() => void p.save(p.namespace, 'targetLanguage', target())} /><Action id="capability-translation-target-reset" label={common().reset} disabled={p.disabled} press={() => void p.save(p.namespace, 'targetLanguage')} /></View>
  </View>
}

/** Mount in the settings Scroll. No text translation, key access, model call or account action. */
/** `auto`: inside Computer settings › Web search and fetch: read at once, no open or close button. */
export function CapabilitySettings(props: { client?: () => Dsh; auto?: boolean } = {}) {
  const client = props.client ?? dsh, open = signal(!!props.auto), busy = signal(false), message = signal(''), snapshot = signal<CapabilitySnapshot | undefined>(undefined)
  let alive = true, generation = 0, refreshing = false
  cleanup(() => { alive = false; generation++ })
  const load = async () => {
    const observed = ++generation
    refreshing = true; busy.set(true)
    try { const value = await readCapabilities(client()); if (alive && observed === generation) snapshot.set(value) }
    catch { if (alive && observed === generation) message.set(common().failed) }
    finally { if (alive && observed === generation) { refreshing = false; busy.set(false) } }
  }
  effect(() => { if (open() && connection() === 'online' && appActive()) void load() })
  const save: Save = async (namespace, field, value) => {
    if (busy() || !snapshot()?.configuration.writable) return
    busy.set(true); message.set('')
    try { await saveCapability(client(), namespace, field, value); await load(); if (alive) message.set(common().saved) }
    catch (error) { if (alive) message.set(error instanceof DshError && error.code === 'settings/conflict' ? common().conflict : common().uncertain) }
    finally { if (alive && !refreshing) busy.set(false) }
  }
  const webNs = () => snapshot() && capabilityNamespace(snapshot()!.configuration, 'web'), translationNs = () => snapshot() && capabilityNamespace(snapshot()!.configuration, 'translation')
  const web = () => snapshot()?.web.status === 'ready' ? (snapshot()!.web as { status: 'ready'; value: import('./capability-settings.ts').WebCatalog }).value : undefined
  const translation = () => snapshot()?.translation.status === 'ready' ? (snapshot()!.translation as { status: 'ready'; value: TranslationLimits }).value : undefined
  return <View testID="capability-settings" class="gap-2 pt-5">
    <If when={!props.auto}>
      <Text class="px-2 text-muted-foreground text-[13px] font-medium">{words().title}</Text>
      <Action id="capability-settings-open" label={open() ? common().refresh : words().open} disabled={busy()} press={() => { open.set(true); message.set(''); void load() }} />
    </If>
    <If when={open()}>
      <If when={busy()}><Text class="text-muted-foreground text-[13px]">{common().loading}</Text></If>
      <If when={message()}><Text testID="capability-settings-message" class="text-foreground text-[13px]">{message()}</Text></If>
      <If when={snapshot() && !snapshot()?.configuration.writable}><Text class="text-muted-foreground text-[13px]">{common().readOnly}</Text></If>
      <Text class="text-muted-foreground text-[13px]">{words().catalog}</Text><Text class="text-muted-foreground text-[13px]">{words().refreshHint}</Text>
      <If when={webNs() && web()} else={<Text testID="capability-web-unavailable" class="text-muted-foreground text-[13px]">{words().unavailable}</Text>}>
        <Each of={webNs() ? [webNs()!] : []} key={ns => `${ns.ns}:${ns.revision}`} >{ns => <View class="gap-2"><WebChoice kind="search" namespace={ns()} providers={web()?.search ?? []} disabled={busy() || !snapshot()?.configuration.writable} save={save} /><WebChoice kind="fetch" namespace={ns()} providers={web()?.fetch ?? []} disabled={busy() || !snapshot()?.configuration.writable} save={save} /></View>}</Each>
      </If>
      <Text class="text-muted-foreground text-[13px]">{words().advanced}</Text>
      <If when={translationNs() && translation()} else={<Text testID="capability-translation-unavailable" class="text-muted-foreground text-[13px]">{words().unavailable}</Text>}>
        <Each of={translationNs() ? [translationNs()!] : []} key={ns => `${ns.ns}:${ns.revision}`} >{ns => <TranslationChoice namespace={ns()} limits={translation()!} disabled={busy() || !snapshot()?.configuration.writable} save={save} />}</Each>
      </If>
      <If when={!props.auto}><Action id="capability-settings-close" label={common().close} press={() => { generation++; open.set(false); snapshot.set(undefined); refreshing = false; busy.set(false) }} /></If>
    </If>
  </View>
}
