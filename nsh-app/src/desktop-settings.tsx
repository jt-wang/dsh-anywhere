import { cleanup, locale, signal, Text, View } from 'nsh'
import { Input, Switch } from 'nsh/base'
import { DshError, type Dsh } from './dsh.ts'
import { dsh } from './state.ts'
import { language } from './strings.ts'
import { readDesktopSettings, saveDesktopSetting, settingFields, settingValue, type DesktopConfiguration, type SettingEdit, type SettingField, type SettingsNamespace } from './desktop-settings.ts'
import { desktopSettingsScope, desktopSettingsStrings } from './desktop-settings-strings.ts'
import { SpeechSettings } from './speech-settings.tsx'
import { ProviderSettings } from './provider-settings.tsx'
import { HostSettings } from './host-settings.tsx'
import { WorkspaceSettings } from './workspace-settings.tsx'
import { CapabilitySettings } from './capability-settings.tsx'

const words = () => desktopSettingsStrings(language() === 'system' ? locale() : language())
function Action(props: { id: string; label: string; disabled?: boolean; press: () => void }) {
  return <View role="button" testID={props.id} accessibilityLabel={props.label} accessibilityState={{ disabled: !!props.disabled }} onPress={() => { if (!props.disabled) props.press() }} class={`min-h-[44px] justify-center rounded-[9px] bg-secondary px-3 ${props.disabled ? 'opacity-40' : 'active:opacity-60'}`}><Text class="text-foreground text-[14px]">{props.label}</Text></View>
}

function Field(props: { ns: SettingsNamespace; field: SettingField; disabled: boolean; save: (edit: SettingEdit) => Promise<void> }) {
  const f = props.field, id = `${props.ns.ns}-${f.path.join('.')}`
  const draft = signal(f.secret ? '' : typeof f.value === 'string' ? f.value : f.value === undefined ? '' : JSON.stringify(f.value))
  const name = signal(''), invalid = signal(false)
  const save = async (unset = false) => {
    invalid.set(false)
    try {
      const path = f.add ? [...f.path, f.add === 'array' ? String(Array.isArray(f.value) ? f.value.length : 0) : name().trim()] : f.path
      if (f.add === 'dict' && (!name().trim() || (f.value && typeof f.value === 'object' && name().trim() in f.value))) { invalid.set(true); return }
      await props.save(unset ? { op: 'unset', path } : { op: 'set', path, value: f.add ? JSON.parse(draft()) : settingValue(f, draft()) })
      if (f.secret) draft.set('')
    } catch { invalid.set(true) }
  }
  cleanup(() => draft.set(''))
  return <View testID={`desktop-field-${id}`} class="border-t border-border px-[14px] py-3 gap-2">
    <Text class="text-foreground text-[14px] font-medium">{f.path.join(' › ') || props.ns.ns}</Text>
    <If when={f.secret}><Text class="text-muted-foreground text-[12px]">{f.configured ? words().configured : words().notConfigured}</Text></If>
    <If when={f.add === 'dict'}><Input testID={`desktop-name-${id}`} accessibilityLabel={words().key} value={name()} onChange={e => name.set(e.value)} placeholder={words().key} class="min-h-[44px] bg-background rounded-[8px] border border-input px-3 text-foreground" /></If>
    <If when={f.type === 'boolean'} else={f.type === 'choice' ? <View class="flex-row flex-wrap gap-2">{f.choices.map((choice, i) => <Action id={`desktop-choice-${id}-${i}`} label={`${draft() === JSON.stringify(choice) || draft() === choice ? '✓ ' : ''}${String(choice)}`} disabled={props.disabled} press={() => draft.set(typeof choice === 'string' ? choice : JSON.stringify(choice))} />)}</View> :
      <Input testID={`desktop-value-${id}`} accessibilityLabel={f.path.join(' › ') || words().value} masked={f.secret} value={f.add ? draft() === JSON.stringify(f.value) ? '' : draft() : draft()} onChange={e => draft.set(e.value)} placeholder={f.add ? 'JSON' : f.secret ? f.configured ? words().configured : words().notConfigured : words().value} class="min-h-[44px] bg-background rounded-[8px] border border-input px-3 text-foreground" />
    }><Switch testID={`desktop-value-${id}`} accessibilityLabel={f.path.join(' › ')} checked={draft() === 'true'} onChange={e => draft.set(String(e.checked))} class="w-[46px] h-[28px]" trackClass="w-full h-full rounded-full bg-input checked:bg-primary justify-center px-[3px]" thumbClass="w-[22px] h-[22px] rounded-full bg-background checked:translate-x-[18px]" /></If>
    <View class="flex-row flex-wrap gap-2"><Action id={`desktop-save-${id}`} label={f.add ? words().add : words().save} disabled={props.disabled || (f.secret && !draft())} press={() => void save()} /><If when={!f.add}><Action id={`desktop-reset-${id}`} label={words().reset} disabled={props.disabled} press={() => void save(true)} /></If></View>
    <If when={invalid()}><Text class="text-destructive text-[13px]">{words().rejected}</Text></If>
  </View>
}

function Credentials(props: { client: () => Dsh; disabled: boolean }) {
  const ref = signal(''), secret = signal(''), state = signal(''), busy = signal(false)
  cleanup(() => secret.set(''))
  const read = async () => {
    const result = await props.client().rpc<Record<string, { configured: boolean }>>('credentials/describe', { refs: [ref().trim()] })
    state.set(result[ref().trim()]?.configured ? words().configured : words().notConfigured)
  }
  const write = async (remove: boolean) => {
    if (busy() || props.disabled) return
    busy.set(true)
    try {
      await props.client().rpc(remove ? 'credentials/unset' : 'credentials/set', remove ? { ref: ref().trim() } : { ref: ref().trim(), value: secret() })
      secret.set(''); await read()
    } catch { state.set(words().uncertain) } finally { secret.set(''); busy.set(false) }
  }
  return <View class="rounded-[14px] bg-card border border-border p-[14px] gap-2">
    <Text class="text-foreground text-[15px] font-medium">{words().credentials}</Text><Text class="text-muted-foreground text-[13px]">{words().credentialHint}</Text>
    <Input testID="desktop-credential-ref" accessibilityLabel={words().reference} value={ref()} onChange={e => { ref.set(e.value); state.set('') }} placeholder={words().reference} class="min-h-[44px] border border-input rounded-[8px] px-3 text-foreground" />
    <Input testID="desktop-credential-value" accessibilityLabel={words().credentials} masked value={secret()} onChange={e => secret.set(e.value)} placeholder={words().credentials} class="min-h-[44px] border border-input rounded-[8px] px-3 text-foreground" />
    <View class="flex-row flex-wrap gap-2"><Action id="desktop-credential-read" label={words().refresh} disabled={busy() || !ref().trim()} press={() => { void read().catch(() => state.set(words().failed)) }} /><Action id="desktop-credential-save" label={words().setKey} disabled={props.disabled || busy() || !ref().trim() || !secret()} press={() => void write(false)} /><Action id="desktop-credential-remove" label={words().removeKey} disabled={props.disabled || busy() || !ref().trim()} press={() => void write(true)} /></View>
    <If when={state()}><Text testID="desktop-credential-state" class="text-muted-foreground text-[13px]">{state()}</Text></If>
  </View>
}

export function DesktopSettings(props: { client?: () => Dsh } = {}) {
  const client = props.client ?? dsh
  const open = signal(false), busy = signal(false), message = signal(''), configuration = signal<DesktopConfiguration | undefined>(undefined), expanded = signal('')
  let alive = true
  cleanup(() => { alive = false })
  const load = async () => {
    if (busy()) return
    open.set(true); busy.set(true); message.set('')
    try { const value = await readDesktopSettings(client()); if (alive) configuration.set(value) }
    catch { if (alive) message.set(words().failed) } finally { if (alive) busy.set(false) }
  }
  const save = async (ns: SettingsNamespace, edit: SettingEdit) => {
    if (busy() || !configuration()?.writable) return
    busy.set(true); message.set('')
    try {
      const result = await saveDesktopSetting(client(), ns, edit)
      if (alive) { configuration.set(result.configuration); message.set(result.confirmed ? words().saved : words().uncertain) }
    } catch (error) { if (alive) message.set(error instanceof DshError && error.code === 'settings/conflict' ? words().conflict : words().rejected); throw error }
    finally { if (alive) busy.set(false) }
  }
  return <View testID="desktop-settings" class="gap-2 pt-5">
    <Text class="px-2 text-muted-foreground text-[13px] font-medium">{words().title}</Text>
    <Action id="desktop-settings-open" label={open() ? words().refresh : words().open} disabled={busy()} press={() => void load()} />
    <If when={open()}>
      <Text class="px-2 text-muted-foreground text-[13px]">{words().hint}</Text>
      <If when={busy()}><Text class="px-2 text-muted-foreground text-[13px]">{words().loading}</Text></If>
      <If when={configuration() && !configuration()?.writable}><Text class="px-2 text-muted-foreground text-[13px]">{words().readOnly}</Text></If>
      <If when={message()}><Text testID="desktop-settings-message" class="px-2 text-foreground text-[13px]">{message()}</Text></If>
      <Text testID="desktop-only-settings" class="px-2 text-muted-foreground text-[13px]">{desktopSettingsScope(language() === 'system' ? locale() : language())[0]}</Text>
      <ProviderSettings client={client} />
      <HostSettings client={client} />
      <WorkspaceSettings client={client} />
      <SpeechSettings client={client} />
      <CapabilitySettings client={client} />
      <Text class="px-2 pt-3 text-muted-foreground text-[13px] font-medium">{desktopSettingsScope(language() === 'system' ? locale() : language())[1]}</Text>
      <Each of={configuration()?.namespaces ?? []} key={n => `${n.ns}:${n.revision}`} >{n => <View class="rounded-[14px] bg-card border border-border overflow-hidden">
        <Action id={`desktop-namespace-${n().ns}`} label={n().ns} press={() => expanded.set(expanded() === n().ns ? '' : n().ns)} />
        <If when={expanded() === n().ns}>{settingFields(n()).map(field => <Field ns={n()} field={field} disabled={busy() || !configuration()?.writable} save={edit => save(n(), edit)} />)}</If>
      </View>}</Each>
      <Credentials client={client} disabled={busy() || !configuration()?.writable} />
      <Action id="desktop-settings-close" label={words().close} press={() => { open.set(false); configuration.set(undefined) }} />
    </If>
  </View>
}
