// Domain operations outside settings/describe. Contracts inspected in installed DSH 0.2.2-rc.5
// dsh-agent-preset-registry, dsh-cua, dsh-deepseek-account, dsh-host-plugin-inventory.
import { DshError } from './dsh.ts'

export interface HostSettingsClient { rpc<T = any>(method: string, args: Record<string, unknown>): Promise<T> }
export type ReadResult<T> = { kind: 'ready'; value: T } | { kind: 'unavailable' } | { kind: 'failed' }
export interface Preset { id: string; isDefault: boolean; name?: string; description?: string; broken?: string }
export interface PresetDocument { agentPreset: string; content: string; name?: string; description?: string }
export interface PresetSettings { presets: Preset[]; writable: boolean; revision?: number }
export type SystemPermission = 'accessibility' | 'screenRecording'
interface PermissionProcess { pid: number; name?: string; path?: string }
export type ComputerAccess = { platform: 'darwin'; accessibility: boolean; screenRecording: boolean; helper: PermissionProcess; parent: PermissionProcess; launchApplication?: { name: string; path: string } }
  | { platform: 'win32'; sessionLocked: boolean | null; captureAvailable: boolean; elevated: boolean; helper: PermissionProcess }
export interface ApplicationGrant { id: string; name: string; executablePath?: string }
export interface Applications { allowedApps: ApplicationGrant[]; blockedApps: ApplicationGrant[]; persistentAvailable: boolean }
export interface PtcConfiguration { persistent: boolean; writable: boolean }
export interface AccountIdentity { version: string; locale: string; timezoneOffsetSeconds: number }
export interface AccountState { status: 'signed-out' | 'credential-stored'; links: { usageUrl: string; topUpUrl: string }; attempt: null | { id: string; phase: string; expiresAt?: number; errorCode?: string } }
export type Profile = { status: 'ready'; value: { id: string | null; name: string | null; contact: string | null } } | { status: 'failed' }
export interface Wallet { currency: 'CNY' | 'USD'; balance: string }
export type Balance = { status: 'ready'; value: Wallet[]; bonusWallets: Wallet[] } | { status: 'failed' }
export interface AccountNotice { id: string; createdAt: string; displayUntil: string | null; title: string; body: string; actions: { label: string; style: 'primary' | 'secondary'; target: { type: 'app_route'; name: 'account' } | { type: 'dismiss' } }[] }
export interface NoticeBatch { nextPollAfterSeconds: number; notifications: AccountNotice[] }
export type LocalizedPluginText = string | { en: string; [locale: string]: string }
export interface InventoryRow { entryId: string | null; moduleName: string; enabled: boolean | 'conditional'; fiberPhase: string | null; diagnostic?: string; condition?: string; meta?: { title?: LocalizedPluginText; description?: LocalizedPluginText; error?: string } }
export interface Inventory { managementAvailable?: boolean; entries: InventoryRow[]; agentPresets?: { id: string; name?: string; isDefault: boolean; broken?: string; rows: InventoryRow[] }[] }

export function pluginText(text: LocalizedPluginText | undefined, locale: string): string {
  if (!text) return ''
  if (typeof text === 'string') return text
  const tag = locale.toLowerCase().replace(/_/g, '-')
  return text[tag] ?? text[tag.split('-')[0]] ?? text.en
}

/** No mobile/platform enum exists. This is the requesting UI build, not the host's version. */
export function accountIdentity(version: string, locale: string, offsetMinutes = new Date().getTimezoneOffset()): AccountIdentity {
  if (!version.trim() || !locale.trim() || !Number.isFinite(offsetMinutes)) throw new Error('Missing client identity')
  return { version, locale, timezoneOffsetSeconds: -offsetMinutes * 60 }
}

export async function readHostDomain<T>(client: HostSettingsClient, method: string, args: Record<string, unknown> = {}): Promise<ReadResult<T>> {
  try { return { kind: 'ready', value: await client.rpc<T>(method, args) } }
  catch (e) {
    // Authentication/network failures must not masquerade as missing capabilities.
    return { kind: e instanceof DshError && ['gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/invocation-unavailable', 'gateway/definition-unavailable'].includes(e.code) ? 'unavailable' : 'failed' }
  }
}

/** rc.1's untagged status is not an rc.5 Darwin observation. Never infer permission actions. */
export async function readComputerStatus(client: HostSettingsClient): Promise<ReadResult<ComputerAccess>> {
  const result = await readHostDomain<ComputerAccess>(client, 'cuaAccess/systemStatus')
  return result.kind === 'ready' && !['darwin', 'win32'].includes(result.value?.platform) ? { kind: 'unavailable' } : result
}

export async function readPresetSettings(client: HostSettingsClient): Promise<PresetSettings> {
  const [roster, settings] = await Promise.all([
    client.rpc<{ presets: Preset[] }>('agentPresets/list', {}),
    client.rpc<{ writable: boolean; namespaces: { ns: string; revision: number }[] }>('settings/describe', {}),
  ])
  const ns = settings.namespaces.find(n => n.ns === 'agent-preset-registry')
  return { presets: roster.presets, writable: settings.writable && !!ns, revision: ns?.revision }
}

export function readPresetComposition(client: HostSettingsClient, id: string): Promise<PresetDocument> {
  // The generated rc.5 argument is agentPreset, NOT the inventory note's shorthand id.
  return client.rpc('agentPresets/read', { agentPreset: id })
}

/** Use the revision the user saw; never refetch a revision just to bypass a conflict. No retry. */
export async function setDefaultPreset(client: HostSettingsClient, snapshot: PresetSettings, id: string): Promise<PresetSettings> {
  const preset = snapshot.presets.find(p => p.id === id)
  if (!snapshot.writable || snapshot.revision === undefined || !preset || preset.broken) throw new Error('Preset is not writable')
  await client.rpc('settings/mutate', { ns: 'agent-preset-registry', ops: [{ op: 'set', path: ['selectedDefault'], value: id }], expectedRevision: snapshot.revision })
  return readPresetSettings(client)
}

export type CuaAction = { method: 'revoke' | 'retryApproval'; id: string }
  | { method: 'requestPermission' | 'openSettings'; permission: SystemPermission }
  | { method: 'enablePersistentPtc' }

/** A confirmation is required by the native card before calling; the computer owns all OS consent. */
export async function performCuaAction(client: HostSettingsClient, action: CuaAction, locale: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error('Computer action requires confirmation')
  const { method } = action
  await client.rpc(`cuaAccess/${method}`, 'id' in action ? { id: action.id } : 'permission' in action ? { permission: action.permission, locale } : {})
}

export function noticeVisible(notice: AccountNotice, now = Date.now()): boolean {
  return notice.displayUntil === null || Date.parse(notice.displayUntil) > now
}

export function reportNotice(client: HostSettingsClient, identity: AccountIdentity, id: string, event: 'displayed' | 'cta_clicked' | 'dismissed'): Promise<boolean> {
  return client.rpc('account/reportNotificationEvent', { id, event, client: identity })
}
