// rc.5 owners: dsh-web and experimental-client-ui-cot-translation. Settings only; never execute a capability.
import type { Dsh } from './dsh.ts'
import { readDesktopSettings, saveDesktopSetting, settingFields, type DesktopConfiguration, type SettingsNamespace } from './desktop-settings.ts'

export type Localized = string | Record<string, string>
export interface WebProvider { id: string; title?: string; description?: Localized }
export interface WebCatalog { search: WebProvider[]; fetch: WebProvider[] }
export interface TranslationLimits { preferences: { provider: string; targetLanguage: string }; maxTextChars: number; availableProviders: string[] }
export type CapabilityRead<T> = { status: 'ready'; value: T } | { status: 'failed' }
export interface CapabilitySnapshot { configuration: DesktopConfiguration; web: CapabilityRead<WebCatalog>; translation: CapabilityRead<TranslationLimits> }
// Dsh currently exposes rpc/stream but no event subscription API. Do not invent a web/follow or $events filter.
export const capabilityRefreshBoundary = 'foreground-reconnect-explicit' as const
export function capabilityLocale(locale: string) {
  const l = locale.replace(/_/g, '-').toLowerCase()
  const key = l.startsWith('zh') ? /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh' : l.split('-')[0]
  return ['zh', 'zh-Hant', 'en', 'es', 'fr', 'ko', 'ja', 'ru'].includes(key) ? key : 'en'
}
export function capabilityText(value: Localized | undefined, locale: string): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  const key = capabilityLocale(locale), normalized = Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toLowerCase().replace(/_/g, '-'), v]))
  return normalized[key.toLowerCase()] ?? normalized[key.split('-')[0]] ?? normalized.en ?? ''
}
export async function readCapabilities(client: Dsh): Promise<CapabilitySnapshot> {
  const read = async <T>(method: string): Promise<CapabilityRead<T>> => {
    try { return { status: 'ready', value: await client.rpc<T>(method, {}) } } catch { return { status: 'failed' } }
  }
  const [configuration, web, translation] = await Promise.all([readDesktopSettings(client), read<WebCatalog>('web/listProviders'), read<TranslationLimits>('cotTranslation/limits')])
  return { configuration, web, translation }
}
export function capabilityNamespace(configuration: DesktopConfiguration, kind: 'web' | 'translation') {
  const required = kind === 'web' ? ['searchProvider', 'fetchProvider'] : ['provider', 'targetLanguage']
  return configuration.namespaces.find(ns => required.every(key => settingFields(ns).some(f => f.path.length === 1 && f.path[0] === key && !f.secret)))
}
export function capabilityValue(namespace: SettingsNamespace | undefined, field: string): string | undefined {
  const value = namespace?.value
  const v = value && !Array.isArray(value) && typeof value === 'object' ? value[field] : undefined
  return typeof v === 'string' ? v : undefined
}
export function capabilityBase(namespace: SettingsNamespace, field: string): string | undefined {
  return capabilityValue({ ...namespace, value: namespace.base ?? {} }, field)
}
export function translationOptions(namespace: SettingsNamespace, limits: TranslationLimits): string[] {
  const accepted = settingFields(namespace).find(f => f.path.length === 1 && f.path[0] === 'provider')?.choices
  return limits.availableProviders.filter(id => accepted?.includes(id))
}
/** Only these four owner-declared, non-secret paths may be written here. Undefined restores inheritance. */
export async function saveCapability(client: Dsh, namespace: SettingsNamespace, field: 'searchProvider' | 'fetchProvider' | 'provider' | 'targetLanguage', value?: string) {
  if (!settingFields(namespace).some(f => f.path.length === 1 && f.path[0] === field && !f.secret)) throw new Error('capability/unsupported')
  // The desktop clears overrides equal to composition. Auto is unset, not the literal string "auto" for web.
  const inherited = value === undefined || value === capabilityBase(namespace, field)
  const result = await saveDesktopSetting(client, namespace, inherited ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value })
  if (!result.confirmed) throw new Error('capability/unconfirmed')
  return result.configuration
}
