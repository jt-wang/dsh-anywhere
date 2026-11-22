import { cleanup, effect, locale, signal, Text, View } from 'nsh'
import { Input } from 'nsh/base'
import { DshError, type Dsh } from './dsh.ts'
import { appActive, connection, dsh } from './state.ts'
import { language } from './strings.ts'
import { desktopSettingsStrings } from './desktop-settings-strings.ts'
import { providerSettingsStrings } from './provider-settings-strings.ts'
import type { Json, SettingsNamespace } from './desktop-settings.ts'
import { atPath, deleteProvider, discoverProviderModels, ProviderCreation, providerChoices, providerSchema, readProviders, removeProviderKey, saveProviderField, validateModels, writeProviderKey, type ProviderRow, type ProviderSnapshot } from './provider-settings.ts'

const lang = () => language() === 'system' ? locale() : language()
const w = () => providerSettingsStrings(lang()), common = () => desktopSettingsStrings(lang())
function Action(p: { id: string; label: string; disabled?: boolean; press: () => void }) {
  return <View testID={p.id} role="button" accessibilityLabel={p.label} accessibilityState={{ disabled: !!p.disabled }} onPress={() => { if (!p.disabled) p.press() }} class={`min-h-[44px] justify-center rounded-[8px] bg-secondary px-3 ${p.disabled ? 'opacity-40' : 'active:opacity-60'}`}><Text class="text-foreground text-[14px]">{p.label}</Text></View>
}
function Entry(p: { id: string; label: string; value: string; change: (v: string) => void; masked?: boolean; disabled?: boolean }) {
  return <View class="gap-1"><Text class="text-muted-foreground text-[13px]">{p.label}</Text><Input testID={p.id} accessibilityLabel={p.label} value={p.value} masked={p.masked} disabled={p.disabled} onChange={e => { if (!p.disabled) p.change(e.value) }} class="min-h-[44px] rounded-[8px] border border-input bg-background px-3 text-foreground" /></View>
}

function ModelFields(p: { id: string; namespace: SettingsNamespace; path: string[]; initial: Json; disabled: () => boolean; set: (field: string, text: string) => void }) {
  const model = p.initial as Record<string, Json>
  return <View class="gap-2">{['id', 'name', 'contextWindow', 'maxTokens', 'input', 'inputModalities', 'reasoningEfforts'].filter(field => !!providerSchema(p.namespace, [...p.path, '0', field])).map(field => {
    const initial = model[field], text = signal(typeof initial === 'string' ? initial : initial === undefined ? '' : JSON.stringify(initial)), invalid = signal(false)
    return <View class="gap-1"><Entry id={`${p.id}-${field}`} label={field === 'reasoningEfforts' ? w().reasoning : field === 'input' || field === 'inputModalities' ? `${field} · ${w().modalities}` : field} value={text()} disabled={p.disabled()} change={v => { text.set(v); try { p.set(field, v); invalid.set(false) } catch { p.set(field, 'null'); invalid.set(true) } }} /><If when={invalid()}><Text class="text-destructive text-[13px]">{common().rejected}</Text></If></View>
  })}</View>
}

/** Each row edits a copied model, retaining every field the handwritten form does not know. */
function ModelCatalog(p: { id: string; namespace: SettingsNamespace; path: string[]; initial: Json[]; disabled: () => boolean; change: (models: Json[]) => void }) {
  let serial = 0
  const rows = signal(p.initial.map(value => ({ key: ++serial, value })))
  const publish = () => p.change(rows().map(r => r.value))
  const set = (key: number, field: string, text: string) => {
    rows.set(rows().map(r => {
      if (r.key !== key) return r
      const value = { ...(r.value as Record<string, Json>) }
      if (!text) delete value[field]
      else value[field] = ['contextWindow', 'maxTokens'].includes(field) ? Number(text) : ['input', 'inputModalities', 'reasoningEfforts'].includes(field) ? JSON.parse(text) : text
      return { ...r, value }
    })); publish()
  }
  const move = (key: number, offset: number) => {
    const next = [...rows()], index = next.findIndex(r => r.key === key), target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]; rows.set(next); publish()
  }
  return <View class="gap-2">
    <Text class="text-foreground text-[15px] font-medium">{w().models}</Text>
    <Each of={rows()} key={r => r.key}>{r => <View class="border border-border rounded-[8px] p-3 gap-2">
      <ModelFields id={`${p.id}-${r().key}`} namespace={p.namespace} path={p.path} initial={r().value} disabled={p.disabled} set={(field, text) => set(r().key, field, text)} />
      <View class="flex-row flex-wrap gap-2"><Action id={`${p.id}-${r().key}-up`} label={w().up} disabled={p.disabled()} press={() => move(r().key, -1)} /><Action id={`${p.id}-${r().key}-down`} label={w().down} disabled={p.disabled()} press={() => move(r().key, 1)} /><Action id={`${p.id}-${r().key}-remove`} label={w().drop} disabled={p.disabled()} press={() => { rows.set(rows().filter(item => item.key !== r().key)); publish() }} /></View>
    </View>}</Each>
    <Action id={`${p.id}-add`} label={w().newModel} disabled={p.disabled()} press={() => { rows.set([...rows(), { key: ++serial, value: { id: '' } }]); publish() }} />
  </View>
}

function ProviderCard(p: { row: ProviderRow; client: () => Dsh; writable: boolean; refresh: () => Promise<void> }) {
  const row = p.row, ns = row.namespace, id = `provider-${row.provider}`
  const open = signal(false), busy = signal(false), message = signal(''), key = signal(''), confirm = signal(false)
  const candidates = signal<Json[]>([]), catalogVersion = signal(0)
  const initialModels = atPath(ns?.value, [...row.settingsPath, 'models'])
  const models = signal<Json[]>(Array.isArray(initialModels) ? initialModels : [])
  const baseURL = signal(String(atPath(ns?.value, [...row.settingsPath, 'baseURL']) ?? row.defaultBaseURL ?? ''))
  const api = signal(String(atPath(ns?.value, [...row.settingsPath, 'api']) ?? ''))
  const disabled = () => busy() || !p.writable
  cleanup(() => key.set(''))
  const run = async (operation: () => Promise<unknown>, refresh = true) => {
    if (disabled()) return
    busy.set(true); message.set('')
    try { await operation(); message.set(common().saved); if (refresh) await p.refresh() }
    catch (error) { message.set(error instanceof DshError && error.code === 'settings/conflict' ? common().conflict : common().uncertain) }
    finally { key.set(''); busy.set(false) }
  }
  const fields = ['displayName', 'api', 'baseURL', 'retryPolicy', 'modelOverrides'].filter(field => ns && providerSchema(ns, [...row.settingsPath, field]) && (field !== 'api' || row.declared === true))
  return <View class="rounded-[14px] border border-border bg-card p-[14px] gap-2">
    <Action id={id} label={`${row.displayName} · ${row.active ? w().active : w().dormant}`} press={() => { open.set(!open()); if (!open()) key.set('') }} />
    <If when={open()}>
      <Text class="text-muted-foreground text-[12px]">{row.provider}</Text>
      <If when={row.error}><Text class="text-destructive text-[13px]">{row.error}</Text></If>
      <If when={row.nativeAuth}><Text class="text-muted-foreground text-[13px]">{w().native}: {row.nativeAuth?.env.join(', ')}{row.nativeAuth?.oauth ? ' · OAuth' : ''}</Text></If>
      <If when={row.baseURLEnv?.length}><Text class="text-muted-foreground text-[13px]">{row.baseURLEnv?.join(', ')}</Text></If>
      {fields.map(field => {
        const value = atPath(ns?.value, [...row.settingsPath, field]), json = field === 'retryPolicy' || field === 'modelOverrides'
        const text = signal(field === 'baseURL' ? baseURL() : field === 'api' ? api() : json ? JSON.stringify(value ?? {}) : String(value ?? ''))
        return <View class="gap-2"><Entry id={`${id}-${field}`} label={field === 'retryPolicy' ? w().retry : field} value={text()} disabled={disabled()} change={v => { text.set(v); if (field === 'baseURL') baseURL.set(v); if (field === 'api') api.set(v) }} />
          <If when={field === 'api'}><Text class="text-muted-foreground text-[12px]">{ns ? providerChoices(ns, [...row.settingsPath, field]).join(' · ') : ''}</Text></If>
          <View class="flex-row flex-wrap gap-2"><Action id={`${id}-${field}-save`} label={common().save} disabled={disabled()} press={() => void run(() => saveProviderField(p.client(), row, field, json ? JSON.parse(text()) : text()))} /><Action id={`${id}-${field}-reset`} label={common().reset} disabled={disabled()} press={() => void run(() => saveProviderField(p.client(), row, field))} /></View>
        </View>
      })}
      <If when={ns && providerSchema(ns, [...row.settingsPath, 'models'])}>
        <Each of={[catalogVersion()]} key={v => v}>{() => <ModelCatalog id={`${id}-models`} namespace={ns!} path={[...row.settingsPath, 'models']} initial={models()} disabled={disabled} change={v => models.set(v)} />}</Each>
        <Action id={`${id}-models-save`} label={common().save} disabled={disabled()} press={() => void run(async () => { validateModels(models()); await saveProviderField(p.client(), row, 'models', models()) })} />
        <Action id={`${id}-discover`} label={w().discover} disabled={disabled()} press={() => void run(async () => { candidates.set(await discoverProviderModels(p.client(), row.settingsNs, { provider: row.provider, ...(baseURL() ? { baseURL: baseURL() } : {}), ...(api() ? { api: api() } : {}), ...(key().trim() ? { apiKey: key().trim() } : {}) })) }, false)} />
        <Text class="text-muted-foreground text-[13px]">{w().draft}</Text>
        <Each of={candidates()} key={v => String((v as any).id)}>{v => <Action id={`${id}-adopt-${(v() as any).id}`} label={`${w().adopt}: ${(v() as any).name ?? (v() as any).id}`} disabled={disabled()} press={() => {
          const model = { ...(v() as Record<string, Json>) }
          if (model.inputModalities && ns && providerSchema(ns, [...row.settingsPath, 'models', '0', 'input'])) { model.input = model.inputModalities; delete model.inputModalities }
          if (!models().some(m => (m as any).id === model.id)) { models.set([...models(), model]); catalogVersion.set(catalogVersion() + 1) }
        }} />}</Each>
      </If>
      <If when={row.provider !== 'deepseek-account' && ns && providerSchema(ns, [...row.settingsPath, 'apiKeyEnv'])}>
        <Text class="text-muted-foreground text-[13px]">{row.ref} · {row.credential?.configured ? common().configured : common().notConfigured}{row.credential?.source ? ` · ${row.credential.source}` : ''}{row.credential?.masked ? ` · ${row.credential.masked}` : ''}</Text>
        <Entry id={`${id}-key`} label={w().key} value={key()} change={v => key.set(v)} masked disabled={disabled() || !row.credential?.writable} />
        <View class="flex-row flex-wrap gap-2"><Action id={`${id}-key-save`} label={common().setKey} disabled={disabled() || !row.credential?.writable || !key().trim()} press={() => void run(() => writeProviderKey(p.client(), row, key()))} /><Action id={`${id}-key-remove`} label={common().removeKey} disabled={disabled() || !row.credential?.writable || !row.credential?.configured} press={() => void run(() => removeProviderKey(p.client(), row))} /></View>
      </If>
      <If when={row.removable}><Action id={`${id}-delete`} label={w().remove} disabled={disabled()} press={() => confirm.set(true)} /><If when={confirm()}><Text class="text-destructive text-[13px]">{w().confirm}</Text><Action id={`${id}-delete-confirm`} label={w().confirm} disabled={disabled()} press={() => void run(() => deleteProvider(p.client(), row))} /><Action id={`${id}-delete-cancel`} label={w().cancel} press={() => confirm.set(false)} /></If></If>
      <If when={message()}><Text testID={`${id}-message`} class="text-foreground text-[13px]">{message()}</Text></If>
    </If>
  </View>
}

function AddProvider(p: { namespace: SettingsNamespace; taken: string[]; client: () => Dsh; writable: boolean; done: () => Promise<void> }) {
  const ns = p.namespace, creation = new ProviderCreation(), choices = providerChoices(ns, ['providers', '\u0000probe', 'api'])
  const route = signal(''), name = signal(''), api = signal(choices[0] ?? ''), baseURL = signal(''), key = signal(''), models = signal<Json[]>([])
  const busy = signal(false), committed = signal(false), message = signal(''), candidates = signal<Json[]>([]), version = signal(0)
  const disabled = () => busy() || committed() || !p.writable
  cleanup(() => key.set(''))
  const create = async () => {
    if (busy() || !p.writable) return
    busy.set(true); message.set('')
    try { await creation.create(p.client(), ns, p.taken, { route: route(), displayName: name(), api: api(), baseURL: baseURL(), models: models() }, key()); await p.done() }
    catch (error) { message.set(creation.committed ? w().partial : error instanceof DshError && error.code === 'settings/conflict' ? common().conflict : common().rejected) }
    finally { committed.set(creation.committed); key.set(''); busy.set(false) }
  }
  const discover = async () => {
    if (disabled()) return
    busy.set(true); message.set('')
    try { candidates.set(await discoverProviderModels(p.client(), ns.ns, { baseURL: baseURL(), api: api(), ...(key().trim() ? { apiKey: key().trim() } : {}) })) }
    catch { message.set(common().failed) } finally { key.set(''); busy.set(false) }
  }
  return <View class="rounded-[14px] border border-border bg-card p-[14px] gap-2">
    <Text class="text-foreground text-[15px] font-medium">{w().add}</Text>
    <Entry id="provider-new-route" label={w().route} value={route()} change={v => route.set(v)} disabled={disabled()} />
    <Entry id="provider-new-name" label={w().name} value={name()} change={v => name.set(v)} disabled={disabled()} />
    <Text class="text-muted-foreground text-[13px]">{w().protocol}</Text><View class="flex-row flex-wrap gap-2">{choices.map(choice => <Action id={`provider-new-api-${choice}`} label={`${api() === choice ? '✓ ' : ''}${choice}`} disabled={disabled()} press={() => api.set(choice)} />)}</View>
    <Entry id="provider-new-baseURL" label={w().endpoint} value={baseURL()} change={v => baseURL.set(v)} disabled={disabled()} />
    <Entry id="provider-new-key" label={w().key} value={key()} change={v => key.set(v)} masked disabled={busy() || !p.writable} />
    <Each of={[version()]} key={v => v}>{() => <ModelCatalog id="provider-new-models" namespace={ns} path={['providers', '\u0000probe', 'models']} initial={models()} disabled={disabled} change={v => models.set(v)} />}</Each>
    <Action id="provider-new-discover" label={w().discover} disabled={disabled()} press={() => void discover()} /><Text class="text-muted-foreground text-[13px]">{w().draft}</Text>
    <Each of={candidates()} key={v => String((v as any).id)}>{v => <Action id={`provider-new-adopt-${(v() as any).id}`} label={`${w().adopt}: ${(v() as any).name ?? (v() as any).id}`} disabled={disabled()} press={() => {
      const model = { ...(v() as Record<string, Json>) }; if (model.inputModalities) { model.input = model.inputModalities; delete model.inputModalities }
      if (!models().some(m => (m as any).id === model.id)) { models.set([...models(), model]); version.set(version() + 1) }
    }} />}</Each>
    <Action id="provider-new-save" label={committed() ? common().setKey : common().save} disabled={busy() || !p.writable || !choices.length || (committed() && !key().trim())} press={() => void create()} />
    <If when={message()}><Text testID="provider-new-message" class="text-foreground text-[13px]">{message()}</Text></If>
  </View>
}

/** Computer settings › Models (computer-settings.tsx); no session picker changes. */
/** `auto`: the Models page of Computer settings: read at once, no open or close button (the page's title names it). */
export function ProviderSettings(props: { client?: () => Dsh; auto?: boolean } = {}) {
  const client = props.client ?? dsh, open = signal(!!props.auto), adding = signal(false), busy = signal(false), message = signal(''), snapshot = signal<ProviderSnapshot | undefined>(undefined)
  let alive = true, generation = 0
  cleanup(() => { alive = false; generation++ })
  const load = async () => {
    const current = ++generation
    busy.set(true); message.set('')
    try { const value = await readProviders(client()); if (alive && generation === current) snapshot.set(value) }
    catch { if (alive && generation === current) message.set(common().failed) }
    finally { if (alive && generation === current) busy.set(false) }
  }
  // Reconnect/foreground gets a fresh authority snapshot. Never replays writes.
  effect(() => { if (open() && connection() === 'online' && appActive()) void load() })
  const custom = () => snapshot()?.configuration.namespaces.find(ns => snapshot()?.rows.some(row => row.settingsNs === ns.ns && row.settingsPath[0] === 'providers') && providerChoices(ns, ['providers', '\u0000probe', 'api']).length > 0 && providerSchema(ns, ['providers', '\u0000probe', 'models']))
  return <View testID="provider-settings" class="gap-2 pt-5">
    <If when={!props.auto}>
      <Text class="px-2 text-muted-foreground text-[13px] font-medium">{w().title}</Text>
      <Action id="provider-settings-open" label={open() ? common().refresh : w().open} disabled={busy()} press={() => { open.set(true); void load() }} />
    </If>
    <If when={open()}>
      <Text class="text-muted-foreground text-[13px]">{w().hint}</Text>
      <If when={busy()}><Text class="text-muted-foreground text-[13px]">{common().loading}</Text></If>
      <If when={message()}><Text class="text-destructive text-[13px]">{message()}</Text></If>
      <If when={snapshot() && !snapshot()?.configuration.writable}><Text class="text-muted-foreground text-[13px]">{common().readOnly}</Text></If>
      <Each of={snapshot()?.rows ?? []} key={row => `${row.provider}:${row.namespace?.revision}:${row.credential?.configured}:${row.credential?.masked ?? ''}`}>{row => <ProviderCard row={row()} client={client} writable={snapshot()?.configuration.writable === true && !busy()} refresh={load} />}</Each>
      <If when={custom() && !adding()}><Action id="provider-add" label={w().add} disabled={busy() || !snapshot()?.configuration.writable} press={() => adding.set(true)} /></If>
      <If when={adding() && custom()}><AddProvider namespace={custom()!} taken={snapshot()?.rows.map(r => r.provider) ?? []} client={client} writable={snapshot()?.configuration.writable === true && !busy()} done={async () => { adding.set(false); await load() }} /><Action id="provider-add-cancel" label={w().cancel} press={() => adding.set(false)} /></If>
      <If when={!props.auto}><Action id="provider-settings-close" label={common().close} press={() => { generation++; adding.set(false); open.set(false); snapshot.set(undefined) }} /></If>
    </If>
  </View>
}
