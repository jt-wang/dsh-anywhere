// Desktop's redacted Settings surface. Writes are path edits, never replacement of a redacted section.
import { DshError, type Dsh } from './dsh.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface SettingsNamespace {
  ns: string; schema: unknown; value: Json; revision: number; applies: 'live'; autoGenerate: boolean
  base?: Json; user?: Json; secrets: { path: string[]; set: boolean }[]
}
export interface DesktopConfiguration { writable: boolean; hasDocument: boolean; namespaces: SettingsNamespace[] }
export type SettingEdit = { op: 'set'; path: string[]; value: Json } | { op: 'unset'; path: string[] }
export interface SettingField { path: string[]; type: string; value?: Json; secret: boolean; configured: boolean; choices: Json[]; add?: 'array' | 'dict' }
type Schema = { type?: string; dict?: Record<string, number>; list?: number[]; inner?: number; value?: Json; meta?: { role?: string; hidden?: boolean } }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

export async function readDesktopSettings(client: Dsh): Promise<DesktopConfiguration> {
  return client.rpc<DesktopConfiguration>('settings/describe', {})
}

/** Even after a lost write acknowledgement, read the authority once; never repeat the edit blindly. */
export async function saveDesktopSetting(client: Dsh, namespace: SettingsNamespace, edit: SettingEdit): Promise<{ configuration: DesktopConfiguration; confirmed: boolean }> {
  let failure: unknown
  try { await client.rpc('settings/mutate', { ns: namespace.ns, ops: [edit], expectedRevision: namespace.revision }) }
  catch (error) { failure = error }
  const configuration = await readDesktopSettings(client)
  const current = configuration.namespaces.find(n => n.ns === namespace.ns)
  if (failure instanceof DshError && failure.code === 'settings/conflict') throw failure
  if (!current) throw new DshError('client/settings-unconfirmed', 'The settings entry is no longer available')
  const at = (value: unknown, path: string[]) => path.reduce<unknown>((v, key) => object(v) || Array.isArray(v) ? (v as any)[key] : undefined, value)
  const secret = current.secrets.find(s => samePath(s.path, edit.path))
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const parentPath = edit.path.slice(0, -1), parent = at(namespace.value, parentPath)
  const removed = Array.isArray(parent) ? parent.filter((_, i) => i !== Number(edit.path.at(-1))) : undefined
  const confirmed = edit.op === 'unset' ? secret ? !secret.set : removed ? equal(at(current.value, parentPath), removed) : equal(at(current.value, edit.path), at(current.base, edit.path))
    : secret ? !failure && secret.set : JSON.stringify(at(current.value, edit.path)) === JSON.stringify(edit.value)
  if (failure && !confirmed) throw failure
  return { configuration, confirmed }
}

/** Flatten the schema together with its resolved value. Container children retain their exact mutation paths. */
export function settingFields(namespace: SettingsNamespace): SettingField[] {
  const envelope = namespace.schema as { uid?: number; refs?: Record<string, Schema> }
  if (!object(envelope) || !object(envelope.refs) || envelope.uid === undefined) return []
  const refs = envelope.refs
  const result: SettingField[] = []
  function walk(id: number | undefined, value: Json | undefined, path: string[], ancestry: number[]) {
    const schema = id === undefined ? undefined : refs[String(id)]
    if (schema?.meta?.hidden) return
    const secret = namespace.secrets.find(s => samePath(s.path, path))
    if (secret || schema?.meta?.role === 'secret') {
      result.push({ path, type: 'string', secret: true, configured: secret?.set === true, choices: [] }); return
    }
    // Recursive schemas are rendered through existing finite data, not infinite schema expansion.
    if (id !== undefined && ancestry.includes(id) && value === undefined) return
    const next = id === undefined ? ancestry : [...ancestry, id]
    if (schema?.type === 'intersect') {
      for (const child of schema.list ?? []) walk(child, value, path, next)
      return
    }
    if (schema?.type === 'union') {
      const choices = (schema.list ?? []).map(i => refs[String(i)]).filter(s => s?.type === 'const' && s.value !== undefined).map(s => s.value!)
      if (choices.length && choices.length === schema.list?.length) { result.push({ path, type: 'choice', value, secret: false, configured: false, choices }); return }
      const branch = schema.list?.find(i => {
        const type = refs[String(i)]?.type
        return type === (Array.isArray(value) ? 'array' : object(value) ? 'object' : typeof value) || (type === 'dict' && object(value)) || (type === 'const' && refs[String(i)]?.value === value)
      })
      if (branch !== undefined) { walk(branch, value, path, next); return }
    }
    if (schema?.type === 'object' || (object(value) && schema?.type !== 'dict')) {
      const values: Record<string, Json> = object(value) ? value as Record<string, Json> : {}
      const keys = new Set([...Object.keys(schema?.dict ?? {}), ...Object.keys(values)])
      for (const key of keys) walk(schema?.dict?.[key], values[key] as Json | undefined, [...path, key], next)
      return
    }
    if (schema?.type === 'dict') {
      for (const [key, item] of Object.entries(object(value) ? value : {})) walk(schema.inner, item, [...path, key], next)
      result.push({ path, type: 'container', value, secret: false, configured: false, choices: [], add: 'dict' }); return
    }
    if (schema?.type === 'array' || Array.isArray(value)) {
      for (const [index, item] of (Array.isArray(value) ? value : []).entries()) walk(schema?.inner, item, [...path, String(index)], next)
      result.push({ path, type: 'container', value, secret: false, configured: false, choices: [], add: 'array' }); return
    }
    if (!path.length) return
    result.push({ path, type: schema?.type ?? typeof value, value, secret: false, configured: false, choices: [] })
  }
  walk(envelope.uid, namespace.value, [], [])
  return [...new Map(result.map(field => [JSON.stringify(field.path), field])).values()]
}

export function settingValue(field: SettingField, text: string): Json {
  if (field.secret || field.type === 'string') return text
  if (field.type === 'choice') {
    const choice = field.choices.find(value => (typeof value === 'string' ? value : JSON.stringify(value)) === text)
    if (choice !== undefined) return choice
    throw new Error('Invalid choice')
  }
  if (field.type === 'number') {
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Invalid number')
    return Number(text)
  }
  return JSON.parse(text) as Json
}
