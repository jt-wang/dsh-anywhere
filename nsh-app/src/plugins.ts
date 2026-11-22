// DSH's plugins as DSH Desktop's Plugins page manages them, from the phone. DSH 0.2.2-rc.5 exposes the same calls its own
// page makes (@deepseek-ai/dsh-plugin-manager lib/typert.host.js: pluginManager/listBundles, setBundleEnabled,
// installBundle) and groups the bundles the same way (@deepseek-ai/dsh-client-ui-plugin-manager lib/client.js:
// EXTENSION_BUNDLES, MORE_BUNDLES). The companion lets only a phone allowed to run tasks call them (server.ts ownerRelay)
// and records each change with the phone's name (dsh-relay.ts).
import type { Dsh } from './dsh.ts'
import { pluginStrings } from './plugins-strings.ts'

/** Voice input: DSH's speech API and the SenseVoice model behind it come with this bundle. */
export const VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'
/** DSH Desktop's "Extensions" group, in its order. */
/** DSH Anywhere's own bundle: it carries every phone's link, so it is never an ordinary row with a switch here; Computer
 * settings' danger zone turns it off, updates or removes it, after two confirmations. */
export const SELF = '@jt-wang/dsh-anywhere'
export const EXTENSIONS = [VOICE_BUNDLE, '@deepseek-ai/dsh-experimental-plugin-market-bundle', '@deepseek-ai/dsh-experimental-auto-review']

type Localized = string | Record<string, string>
export interface Bundle {
  name: string
  official: boolean
  availability: 'installation' | 'profile' | 'missing'
  installTarget?: { spec: string; version: string }
  version?: string
  meta?: { title?: Localized; description?: Localized; error?: string }
  description?: string
  listedByDefault?: boolean
  enabled: boolean
  installed: boolean
  optional: boolean
  removable: boolean
  /** How DSH can update it: from its registry, or from a pinned Git commit (dsh-plugin-manager types.ts BundleInfo.update). */
  update?: 'registry' | 'git'
  readOnlyReason?: 'management-required' | 'unaddressable'
  error?: { code: string; diagnostic?: string }
}
export interface Change {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  restartReason?: string
  enabled?: boolean
  error?: { code: string; diagnostic?: string }
}
/** How a change ended, as the phone says it: done; done once DSH restarts; or failed with DSH's reason code. */
export type Outcome = { kind: 'applied' } | { kind: 'restart' } | { kind: 'failed'; code: string }

export function outcomeOf(c: Change): Outcome {
  if (c.application === 'applied') return { kind: 'applied' }
  if (c.application === 'restart-required') return { kind: 'restart' }
  return { kind: 'failed', code: c.error?.code ?? c.application }
}

/** DSH's text in exactly the phone's language: DSH's bundles ship de/en/es/fr/ja/pt/ru/zh, so Korean and Traditional
 * Chinese find none and read the phone's own names below. A plain string is DSH's only wording and always counts. */
const exact = (v: Localized | undefined, lang: string) => {
  if (v === undefined || typeof v === 'string') return v
  const l = lang.replace(/_/g, '-'), base = l.split('-')[0]!.toLowerCase()
  if (base !== 'zh') return v[l] ?? v[base]
  return /hant|tw|hk|mo/i.test(l) ? v['zh-Hant'] : v['zh-Hans'] ?? v.zh
}
const english = (v: Localized | undefined) => (typeof v === 'string' ? v : v?.en)
/** The phone's names for DSH's official bundles, for a language DSH lacks or a bundle whose metadata DSH couldn't read. */
const OFFICIAL: Record<string, 'cua' | 'voice' | 'review' | 'market'> = {
  '@deepseek-ai/dsh-cua-bundle': 'cua', [VOICE_BUNDLE]: 'voice',
  '@deepseek-ai/dsh-experimental-auto-review': 'review', '@deepseek-ai/dsh-experimental-plugin-market-bundle': 'market',
}
const known = (b: Bundle, lang: string) => { const k = OFFICIAL[b.name]; return k ? pluginStrings(lang).known[k] : undefined }
/** The name DSH Desktop shows: the bundle's own title, else the package name without its scope (what DSH itself falls back to). */
export const titleOf = (b: Bundle, lang: string) => exact(b.meta?.title, lang) || known(b, lang)?.[0] || english(b.meta?.title) || b.name.replace(/^@[^/]+\//, '')
export const descriptionOf = (b: Bundle, lang: string) => exact(b.meta?.description, lang) || known(b, lang)?.[1] || english(b.meta?.description) || b.description || ''

/** The bundles DSH Desktop lists, in its groups: its extensions first, then the others it shows. */
export function listed(bundles: Bundle[]): { extensions: Bundle[]; more: Bundle[] } {
  const shown = bundles.filter((b) => b.name !== SELF && (b.listedByDefault || b.enabled || b.installed))
  const extensions = EXTENSIONS.map((n) => shown.find((b) => b.name === n)).filter((b): b is Bundle => !!b)
  const more = shown.filter((b) => !EXTENSIONS.includes(b.name)).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  return { extensions, more }
}

export const listBundles = (client: Pick<Dsh, 'rpc'>) => client.rpc<Bundle[]>('pluginManager/listBundles', {})

/** Turns a bundle on or off as DSH Desktop's switch does. One the installation ships is selected (setBundleEnabled); one
 * DSH offers on demand is installed at the exact version DSH names and selected with it (installBundle). */
export async function setBundle(client: Pick<Dsh, 'rpc'>, b: Bundle, enabled: boolean): Promise<Outcome> {
  const change = enabled && b.availability === 'missing' && b.installTarget
    ? await client.rpc<Change>('pluginManager/installBundle', { spec: b.installTarget.spec, options: { enabled: true, expected: { name: b.name, version: b.installTarget.version } } })
    : await client.rpc<Change>('pluginManager/setBundleEnabled', { name: b.name, enabled })
  return outcomeOf(change)
}

/** Turns voice input on: finds DSH's voice bundle and selects it. `missing` when this DSH has none to offer. */
export async function enableVoice(client: Pick<Dsh, 'rpc'>): Promise<Outcome | { kind: 'missing' }> {
  const b = (await listBundles(client)).find((x) => x.name === VOICE_BUNDLE)
  if (!b) return { kind: 'missing' }
  if (b.enabled && !b.error) return { kind: 'applied' }
  return setBundle(client, b, true)
}
