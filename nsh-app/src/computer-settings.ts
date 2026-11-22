// The computer's settings as DSH Desktop arranges them (.dev/dsh-official-alignment.md "Computer settings on the phone"),
// read once into one store every Computer settings page derives from. DSH 0.2.2-rc.5 serves them through
// settings/describe + settings/mutate (dsh-api-settings-controller), the plugin list through pluginManager/* and the
// permission choices through permissionPresets/catalog. Nothing here writes a file on the computer.
import { signal } from 'nsh'
import { DshError, type Dsh } from './dsh.ts'
import { saveDesktopSetting, settingFields, type DesktopConfiguration, type Json, type SettingEdit, type SettingsNamespace } from './desktop-settings.ts'
import { listBundles, SELF, type Bundle } from './plugins.ts'
import { capabilityNamespace } from './capability-settings.ts'

export { SELF }

export type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'failed' | 'unsupported' | 'forbidden' }
export interface PermissionCatalog { defaultOptions: { value: string; name: string; description?: string }[]; defaultPreset: string }
type Client = Pick<Dsh, 'rpc'>

const loadKind = (e: unknown): 'failed' | 'unsupported' | 'forbidden' => {
  const code = (e as { code?: string })?.code ?? ''
  return code === 'http/403' ? 'forbidden' : code === 'http/404' || /not[-_ ]?found|unknown[-_ ]?method/i.test(code) ? 'unsupported' : 'failed'
}

/** One store per link. Pages read it; a write replaces it with the computer's answer, never with what the phone sent. */
export interface ComputerInfo { name: string; dshVersion: string; control?: boolean }
export function createComputerStore(client: () => Client, options: { info?: () => Promise<ComputerInfo> } = {}) {
  const config = signal<Load<DesktopConfiguration>>({ kind: 'loading' })
  const bundles = signal<Load<Bundle[]>>({ kind: 'loading' })
  const catalog = signal<PermissionCatalog | undefined>(undefined)
  const info = signal<ComputerInfo | undefined>(undefined)
  const busy = signal(false)
  let started = false, generation = 0
  const read = async () => {
    const at = ++generation
    started = true
    if (config().kind !== 'ready') config.set({ kind: 'loading' })
    if (bundles().kind !== 'ready') bundles.set({ kind: 'loading' })
    await Promise.all([
      client().rpc<DesktopConfiguration>('settings/describe', {}).then(v => { if (at === generation) config.set({ kind: 'ready', value: v }) }, e => { if (at === generation) config.set({ kind: loadKind(e) }) }),
      readBundles(at),
      client().rpc<PermissionCatalog>('permissionPresets/catalog', {}).then(v => { if (at === generation) catalog.set(v) }, () => {}),
      options.info?.().then(v => { if (at === generation) info.set(v) }, () => {}),
    ])
  }
  const readBundles = async (at = generation) => {
    try { const v = await listBundles(client()); if (at === generation) bundles.set({ kind: 'ready', value: v }) }
    catch (e) { if (at === generation) bundles.set({ kind: loadKind(e) }) }
  }
  /** Whether this phone may change the computer: the companion says so (capabilities.control; a phone that may only
   * read chats gets `false`), and for settings DSH's document is writable too. */
  const control = () => info()?.control !== false
  const writable = () => {
    const c = config()
    return control() && c.kind === 'ready' && c.value.writable
  }
  const namespace = (ns: string) => { const c = config(); return c.kind === 'ready' ? c.value.namespaces.find(n => n.ns === ns) : undefined }
  /** One edit, confirmed by reading the computer again (saveDesktopSetting); a conflict reads the new value too. */
  const save = async (ns: string, edit: SettingEdit): Promise<'saved' | 'uncertain' | 'conflict' | 'rejected'> => {
    const n = namespace(ns)
    if (!n || busy() || !writable()) return 'rejected'
    busy.set(true)
    try {
      const r = await saveDesktopSetting(client() as Dsh, n, edit)
      config.set({ kind: 'ready', value: r.configuration })
      return r.confirmed ? 'saved' : 'uncertain'
    } catch (e) {
      const conflict = e instanceof DshError && e.code === 'settings/conflict'
      await client().rpc<DesktopConfiguration>('settings/describe', {}).then(v => config.set({ kind: 'ready', value: v }), () => {})
      return conflict ? 'conflict' : e instanceof DshError && e.code === 'settings/rejected' ? 'rejected' : 'uncertain'
    } finally { busy.set(false) }
  }
  return {
    config, bundles, catalog, info, busy, control, writable, namespace, save, readBundles: () => readBundles(),
    /** Read when a page first shows; again after a reconnect, because DSH's revisions restart with DSH. */
    ensure: () => { if (!started || config().kind !== 'ready') void read() },
    reconnected: () => { if (started) void read() },
    reset: () => { generation++; started = false; config.set({ kind: 'loading' }); bundles.set({ kind: 'loading' }); catalog.set(undefined); info.set(undefined) },
    client,
  }
}
export type ComputerStore = ReturnType<typeof createComputerStore>

const object = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)
export const valueAt = (n: SettingsNamespace | undefined, path: string[]): Json | undefined => {
  let v: Json | undefined = n?.value
  for (const k of path) v = object(v) ? v[k] : undefined
  if (v !== undefined) return v
  let b: Json | undefined = n?.base
  for (const k of path) b = object(b) ? b[k] : undefined
  return b
}

/** A setting a page shows, at DSH's own key. `fallback` is DSH's schema default, shown while the computer has no value. */
export interface FieldSpec {
  id: string
  ns: string[] // the first namespace the computer serves is used (bash-sandbox on macOS and Linux, pwsh-sandbox on Windows)
  path: string[]
  /** A number DSH keeps in a unit people don't think in (milliseconds, bytes) is shown and stepped in `unit`, DSH's
   * value divided by `scale`, and written back multiplied by it. `min`, `max` and `step` are in the shown unit. */
  control: { kind: 'switch' } | { kind: 'choice'; options: string[] } | { kind: 'number'; min?: number; max?: number; step?: number; scale?: number; unit?: 'unitSeconds' | 'unitKb' } | { kind: 'text' }
  fallback?: Json
}
const f = (id: string, ns: string | string[], path: string[], control: FieldSpec['control'], fallback?: Json): FieldSpec => ({ id, ns: Array.isArray(ns) ? ns : [ns], path, control, fallback })

/** DSH Desktop's General rows (dsh-client-ui-settings-general and the packages that fill it, 0.2.2-rc.5), in its order. */
export const GENERAL = {
  sessions: [f('busyEnter', 'ui-conversation', ['busyEnter'], { kind: 'choice', options: ['queue', 'steer'] }, 'queue')],
  look: [
    f('language', 'locale', ['preference'], { kind: 'choice', options: ['', 'zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] }, ''),
    f('appearance', 'ui-theme', ['preference'], { kind: 'choice', options: ['light', 'dark', 'system'] }, 'system'),
    f('fontSize', 'ui-theme', ['fontSize'], { kind: 'number', min: 10, max: 22 }, 14),
    f('codeFontSize', 'ui-theme', ['codeFontSize'], { kind: 'number', min: 10, max: 16 }, 11),
    f('terminalFontSize', 'ui-theme', ['terminalFontSize'], { kind: 'number', min: 10, max: 20 }, 13),
    f('textFont', 'ui-theme', ['textFontFamily'], { kind: 'text' }, ''),
    f('codeFont', 'ui-theme', ['codeFontFamily'], { kind: 'text' }, ''),
    f('terminalFont', 'ui-theme', ['terminalFontFamily'], { kind: 'text' }, ''),
    f('codingView', 'ui-settings', ['enabled'], { kind: 'switch' }, true),
  ],
  privacy: [f('sessionLog', 'session-log-deepseek', ['enabled'], { kind: 'switch' }, true)],
}
/** DSH Desktop's Plugins page, "Built-in plugin settings" (dsh-client-ui-settings-{subagent,web-search,agent-loop,shell}). */
export const BUILT_IN: Record<'subagent' | 'web' | 'loop' | 'shell', FieldSpec[]> = {
  subagent: [
    f('maxDepth', 'subagent', ['maxDepth'], { kind: 'number', min: 0, max: 8 }, 1),
    f('maxActive', 'subagent', ['maxActiveSubagents'], { kind: 'number', min: 1, max: 64 }, 8),
    f('modelChoice', 'subagent-model-selection-settings', ['enabled'], { kind: 'switch' }, false),
  ],
  web: [
    f('searchCount', 'web-deepseek-api', ['count'], { kind: 'number', min: 1, max: 50 }, 10),
    f('maxUses', 'web-search-deepseek', ['maxUses'], { kind: 'number', min: 1, max: 50 }, 5),
  ],
  loop: [f('parallel', 'agent-loop', ['maxParallelToolCalls'], { kind: 'number', min: 1, max: 64 }, 10)],
  shell: [
    // DSH Desktop's Shell page edits milliseconds and bytes; the phone shows seconds and kilobytes (1000 bytes, so
    // DSH's default 64000 reads 64 KB).
    f('timeout', ['bash-sandbox', 'pwsh-sandbox'], ['timeoutMs'], { kind: 'number', min: 5, step: 5, scale: 1000, unit: 'unitSeconds' }, 120000),
    f('maxOutput', ['bash-sandbox', 'pwsh-sandbox'], ['maxOutputBytes'], { kind: 'number', min: 8, step: 8, scale: 1000, unit: 'unitKb' }, 64000),
  ],
}
/** The namespaces a page of its own shows: what is left is a plugin's own configuration ("Other plugin settings"). */
const CLAIMED = new Set([
  ...[...Object.values(GENERAL), ...Object.values(BUILT_IN)].flat().flatMap(s => s.ns),
  'permission', 'agent-preset-registry', 'llm-deepseek', 'llm-pi-ai', 'web', 'workspace-order',
])
/** Plugin-declared settings DSH serves for a generic form (`autoGenerate`) and no page of the phone shows: not a model
 * provider (Models), not the search or translation providers (Web search and fetch: capabilityNamespace). */
export function pluginForms(c: DesktopConfiguration | undefined): SettingsNamespace[] {
  if (!c) return []
  const providers = new Set([capabilityNamespace(c, 'web')?.ns, capabilityNamespace(c, 'translation')?.ns])
  return c.namespaces.filter(n => n.autoGenerate && !CLAIMED.has(n.ns) && !providers.has(n.ns) && !/^(llm|speech)-/.test(n.ns) && settingFields(n).some(x => !x.add && !x.secret))
}

/** The served namespace of a field, if the computer has it. */
export const nsOf = (store: Pick<ComputerStore, 'namespace'>, spec: FieldSpec) => spec.ns.map(ns => store.namespace(ns)).find(Boolean)
/** A field's current value: the computer's, else DSH's default. */
export const current = (store: Pick<ComputerStore, 'namespace'>, spec: FieldSpec) => { const v = valueAt(nsOf(store, spec), spec.path); return v === undefined ? spec.fallback : v }

/** The newest version DSH can update a bundle to: stable, a bundle, compatible, not deprecated (listVersions). */
export interface VersionList { status: 'listed' | 'refused'; installed?: string; registry?: unknown; versions?: { version: string; prerelease: boolean; bundle: boolean; incompatible?: unknown; deprecated?: string }[] }
export const updateTarget = (l: VersionList | undefined) => l?.status === 'listed' ? l.versions?.find(v => !v.prerelease && v.bundle && !v.incompatible && !v.deprecated)?.version : undefined

/** The first companion that may update, turn off or remove itself for a phone. Up to 0.8.6 it keeps the phone's change
 * only after DSH answers, when DSH has already stopped it, and DSH then exits its whole host (DSH Desktop's crash report
 * "database is not open at HostState.recordPhoneChange"). Such a computer does it on DSH Desktop's Plugins page. */
export const SELF_ACTIONS_FROM = '0.8.7'
/** Whether the computer's DSH Anywhere may act on itself for this phone; an unknown version may not. */
export const selfActionsSafe = (version: string | undefined) => {
  const parts = (v: string) => v.split('-')[0]!.split('.').map(Number)
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) return false
  const a = parts(version), b = parts(SELF_ACTIONS_FROM)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}
