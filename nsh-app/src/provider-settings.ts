// rc.5 parity: dsh-client-ui-settings-models store/ProviderEditor/CustomProviderCard.
// See .amp/in/orb-backup/settings-inventory.md §4; extend the upstream owners, not a second catalog.
import { DshError, type Dsh } from './dsh.ts'
import { readDesktopSettings, type DesktopConfiguration, type Json, type SettingEdit, type SettingsNamespace } from './desktop-settings.ts'

export interface Credential { configured: boolean; writable: boolean; source?: string; masked?: string }
export interface ProviderEntry {
  provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean
  defaultBaseURL?: string; baseURLEnv?: string[]; nativeAuth?: { env: string[]; oauth: boolean }; error?: string
}
export interface ProviderRow extends ProviderEntry {
  active: boolean; removable: boolean; namespace?: SettingsNamespace; ref: string; credential?: Credential
}
export interface ProviderSnapshot { configuration: DesktopConfiguration; rows: ProviderRow[] }
export const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export const atPath = (v: unknown, path: string[]): any => path.reduce<any>((at, key) => record(at) || Array.isArray(at) ? (at as any)[key] : undefined, v)
export const deriveProviderKey = (route: string) => `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

// Settings resolved objects contain owner defaults and can reorder keys. Compare semantic values,
// preferring the raw user layer; never compare serialized object strings to confirm a creation.
const matches = (actual: any, expected: any): boolean => Array.isArray(expected)
  ? Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matches(actual[i], v))
  : record(expected) ? record(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.keys(expected).every(k => matches(actual[k], expected[k])) : actual === expected
async function writeSetting(client: Dsh, namespace: SettingsNamespace, edit: SettingEdit) {
  let failure: unknown
  try { await client.rpc('settings/mutate', { ns: namespace.ns, ops: [edit], expectedRevision: namespace.revision }) } catch (error) { failure = error }
  const configuration = await readDesktopSettings(client), current = configuration.namespaces.find(n => n.ns === namespace.ns)
  if (failure instanceof DshError && failure.code === 'settings/conflict') throw failure
  if (!current) throw new Error('provider/unconfirmed')
  const confirmed = edit.op === 'set'
    ? matches(atPath(current.user, edit.path), edit.value) || matches(atPath(current.value, edit.path), edit.value)
    : atPath(current.user, edit.path) === undefined
  if (!confirmed) throw failure ?? new Error('provider/unconfirmed')
  return configuration
}

/** Traverse the actual Schemastery envelope, including dict profiles and union fields. */
export function providerSchema(namespace: SettingsNamespace, path: string[]): any {
  const envelope = namespace.schema as any, refs = envelope?.refs ?? {}
  const walk = (id: number, rest: string[]): any => {
    const node = refs[id]
    if (!node || !rest.length) return node
    if (node.type === 'union') return (node.list ?? []).map((i: number) => walk(i, rest)).find(Boolean)
    const next = node.type === 'object' ? node.dict?.[rest[0]] : node.type === 'dict' || node.type === 'array' ? node.inner : undefined
    return next === undefined ? undefined : walk(next, rest.slice(1))
  }
  return walk(envelope?.uid, path)
}
export function providerChoices(namespace: SettingsNamespace, path: string[]): string[] {
  const node = providerSchema(namespace, path), refs = (namespace.schema as any)?.refs ?? {}
  return (node?.list ?? []).map((id: number) => refs[id]?.value).filter((v: unknown): v is string => typeof v === 'string')
}

export async function readProviders(client: Dsh): Promise<ProviderSnapshot> {
  const [configuration, registered, directory] = await Promise.all([
    readDesktopSettings(client), client.rpc<{ id: string; name: string }[]>('llm/listProviders', {}),
    client.rpc<ProviderEntry[]>('llm/listConfigurableProviders', {}),
  ])
  const entries = [...directory, ...registered.filter(p => !directory.some(e => e.provider === p.id)).map(p => ({ provider: p.id, displayName: p.name, settingsNs: '', settingsPath: [] }))]
  const rows: ProviderRow[] = entries.map(entry => {
    const namespace = configuration.namespaces.find(n => n.ns === entry.settingsNs)
    const profile = atPath(namespace?.value, entry.settingsPath)
    return { ...entry, namespace, active: registered.some(p => p.id === entry.provider),
      removable: !!namespace && entry.settingsPath.length > 0 && atPath(namespace.user, entry.settingsPath) !== undefined && atPath(namespace.base, entry.settingsPath) === undefined,
      ref: typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv ? profile.apiKeyEnv : deriveProviderKey(entry.provider) }
  })
  const refs = [...new Set(rows.filter(r => r.provider !== 'deepseek-account').flatMap(r => [r.ref, ...r.nativeAuth?.env ?? []]))]
  const credentials: Record<string, Credential> = {}
  // Deliberately fail closed on unknown credential writability, rather than offer destructive controls.
  for (let i = 0; i < refs.length; i += 64) Object.assign(credentials, await client.rpc('credentials/describe', { refs: refs.slice(i, i + 64) }))
  for (const row of rows) row.credential = credentials[row.ref]
  return { configuration, rows }
}

/** One observed field only. Never serialize a whole redacted provider back to the host. */
export async function saveProviderField(client: Dsh, row: ProviderRow, field: string, value?: Json) {
  if (!row.namespace || !providerSchema(row.namespace, [...row.settingsPath, field])) throw new Error('provider/unsupported')
  if (field === 'retryPolicy' && record(value) && !Array.isArray(value)) {
    const backoff = (value as any).backoff ?? {}
    if ((backoff.initialDelayMs ?? 500) > (backoff.maxDelayMs ?? 10000)) throw new Error('provider/invalid-backoff')
  }
  return writeSetting(client, row.namespace, value === undefined
    ? { op: 'unset', path: [...row.settingsPath, field] }
    : { op: 'set', path: [...row.settingsPath, field], value })
}

/** No key is retained, logged, or returned. A lost key ACK is uncertain, even if a key now exists. */
export async function writeProviderKey(client: Dsh, row: ProviderRow, key: string) {
  if (!row.credential?.writable || !key.trim() || /[\r\n]/.test(key.trim())) throw new Error('provider/key-unavailable')
  if (atPath(row.namespace?.value, [...row.settingsPath, 'apiKeyEnv']) !== row.ref) await saveProviderField(client, row, 'apiKeyEnv', row.ref)
  try { await client.rpc('credentials/set', { ref: row.ref, value: key.trim() }) }
  finally { key = ''; await client.rpc('credentials/describe', { refs: [row.ref] }) }
}
export async function removeProviderKey(client: Dsh, row: ProviderRow) {
  if (!row.credential?.writable || !row.credential.configured) throw new Error('provider/key-unavailable')
  await client.rpc('credentials/unset', { ref: row.ref })
  // Catalog conventional refs are cleared to restore OAuth/ADC/environment lookup, as on desktop.
  if (row.declared === false && row.ref === deriveProviderKey(row.provider) && row.namespace) {
    const configuration = await readDesktopSettings(client)
    await saveProviderField(client, { ...row, namespace: configuration.namespaces.find(n => n.ns === row.settingsNs) }, 'apiKeyEnv')
  }
  await client.rpc('credentials/describe', { refs: [row.ref] })
}
export async function deleteProvider(client: Dsh, row: ProviderRow) {
  if (!row.removable || !row.namespace) throw new Error('provider/not-removable')
  // Only page-managed records, never arbitrary shared environment/alias references.
  if (row.ref === deriveProviderKey(row.provider) && row.credential?.configured) {
    if (!row.credential.writable) throw new Error('provider/key-read-only')
    await client.rpc('credentials/unset', { ref: row.ref })
  }
  await writeSetting(client, row.namespace, { op: 'unset', path: row.settingsPath })
}

export interface CustomProviderDraft { route: string; displayName: string; api: string; baseURL: string; models: Json[] }
/** Holds only the non-secret commit fact so a key failure cannot replay provider creation. */
export class ProviderCreation {
  committed = false
  private ref = ''
  async create(client: Dsh, namespace: SettingsNamespace, taken: string[], draft: CustomProviderDraft, key: string) {
    if (/[\r\n]/.test(key.trim())) throw new Error('provider/invalid-key')
    if (!this.committed) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(draft.route) || taken.includes(draft.route)) throw new Error('provider/invalid-route')
      if (!providerChoices(namespace, ['providers', draft.route, 'api']).includes(draft.api)) throw new Error('provider/invalid-protocol')
      // rc.5 desktop protocol-rules.ts: Gemini has no ambient credential fallback.
      if (draft.api === 'google-generative-ai' && !key.trim()) throw new Error('provider/key-required')
      const url = new URL(draft.baseURL.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !draft.models.length) throw new Error('provider/invalid-profile')
      validateModels(draft.models)
      this.ref = deriveProviderKey(draft.route)
      const profile: Record<string, Json> = { api: draft.api, baseURL: draft.baseURL.trim(), models: draft.models }
      if (draft.displayName.trim()) profile.displayName = draft.displayName.trim()
      if (key.trim()) profile.apiKeyEnv = this.ref
      await writeSetting(client, namespace, { op: 'set', path: ['providers', draft.route], value: profile })
      this.committed = true
    }
    if (key.trim()) {
      try { await client.rpc('credentials/set', { ref: this.ref, value: key.trim() }) }
      finally { key = ''; await client.rpc('credentials/describe', { refs: [this.ref] }) }
    }
  }
}
export function validateModels(models: Json[]) {
  const ids = new Set<string>()
  for (const item of models) {
    const model = item as Record<string, any>
    if (!record(item) || typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) throw new Error('provider/invalid-model')
    ids.add(model.id)
    for (const field of ['contextWindow', 'maxTokens']) if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field] < 1)) throw new Error('provider/invalid-capacity')
    if (model.contextWindow && model.maxTokens && model.maxTokens > model.contextWindow) throw new Error('provider/invalid-capacity')
    for (const field of ['input', 'inputModalities']) if (model[field] !== undefined && (!Array.isArray(model[field]) || !model[field].length || model[field].some((v: unknown) => v !== 'text' && v !== 'image'))) throw new Error('provider/invalid-modalities')
    if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== false && !record(model.reasoningEfforts)) throw new Error('provider/invalid-reasoning')
  }
}
export async function discoverProviderModels(client: Dsh, settingsNs: string, request: { provider?: string; api?: string; baseURL?: string; apiKey?: string }): Promise<Json[]> {
  // Result is a draft only; no mutate or credential write is performed here.
  return client.rpc<Json[]>('llm/discoverModels', { settingsNs, request })
}
