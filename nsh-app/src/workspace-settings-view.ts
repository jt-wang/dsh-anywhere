import { S } from './strings.ts'
import type { ChatSummary, Workspaces } from './workspaces.ts'

/** Same values as rc.5 ui-workspace stores.ts; storage is phone-local, never an RPC. */
export interface WorkspaceViewPrefs {
  groupBy: 'workspace' | 'workspace-tree' | 'flat'
  orderBy: 'manual' | 'updated'
  archivedFilter: 'default' | 'show' | 'only'
  groupExpansion: Record<string, boolean>
  sessionOrderByAccount: Record<string, string[]>
}
export const FLAT_ORDER = '__flat_session_order__'
export const DEFAULT_WORKSPACE_VIEW: WorkspaceViewPrefs = { groupBy: 'workspace', orderBy: 'updated', archivedFilter: 'default', groupExpansion: {}, sessionOrderByAccount: {} }
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
export function workspaceViewOf(raw: unknown): WorkspaceViewPrefs {
  const v = record(raw)
  return {
    groupBy: ['workspace', 'workspace-tree', 'flat'].includes(v.groupBy) ? v.groupBy : 'workspace',
    orderBy: v.orderBy === 'manual' ? 'manual' : 'updated',
    archivedFilter: ['default', 'show', 'only'].includes(v.archivedFilter) ? v.archivedFilter : 'default',
    groupExpansion: Object.fromEntries(Object.entries(record(v.groupExpansion)).filter(([, value]) => typeof value === 'boolean')),
    sessionOrderByAccount: Object.fromEntries(Object.entries(record(v.sessionOrderByAccount)).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, [...new Set((value as unknown[]).filter((id): id is string => typeof id === 'string'))]])),
  }
}

/** rc.5 tree.ts:145-201: ties by identity; saved slots survive, then unseen pins, ordinary, archives. */
export function localSessionOrder(members: string[], chats: ChatSummary[], saved?: string[], state?: { pinned: string[]; archived: Set<string> }): string[] {
  const byId = new Map(chats.map(c => [c.sessionId, c]))
  const recent = [...new Set(members)].filter(id => byId.has(id)).sort((a, b) => byId.get(b)!.updatedAt - byId.get(a)!.updatedAt || (a < b ? -1 : 1))
  if (!state) return recent
  const kept = [...new Set(saved ?? [])].filter(id => members.includes(id))
  const pins = state.pinned.filter(id => members.includes(id) && byId.has(id) && !kept.includes(id) && !state.archived.has(id))
  const rest = recent.filter(id => !kept.includes(id) && !pins.includes(id))
  return [...pins, ...kept, ...rest.filter(id => !state.archived.has(id)), ...rest.filter(id => state.archived.has(id))]
}

export function workspaceAccounts(registry: Workspaces, chats: ChatSummary[], prefs: WorkspaceViewPrefs): Record<string, string[]> {
  const claimed = new Set(registry.list().flatMap(w => w.sessionIds))
  const accounts = [...registry.list().map(w => [w.workspaceId, w.sessionIds] as const), ['', chats.filter(c => !claimed.has(c.sessionId)).map(c => c.sessionId)] as const, [FLAT_ORDER, chats.map(c => c.sessionId)] as const]
  return Object.fromEntries(accounts.map(([key, ids]) => [key, localSessionOrder(ids, chats, prefs.sessionOrderByAccount[key], prefs.orderBy === 'manual' ? registry : undefined)]))
}

/** rc.5 tree.ts:616-641: only Windows paths translate backslashes; ancestry is case-sensitive and segment-bound. */
export function workspaceParent(path: string, parents: string[]): string | undefined {
  const normalize = (v: string) => ((/^[A-Za-z]:[/\\]/.test(v) || v.startsWith('\\\\')) ? v.replaceAll('\\', '/') : v).replace(/\/+$/, '')
  const child = normalize(path)
  return parents.filter(p => child !== normalize(p) && child.startsWith(`${normalize(p)}/`)).sort((a, b) => normalize(b).length - normalize(a).length)[0]
}
export const visibleWorkspaceChat = (registry: Workspaces, id: string, filter: WorkspaceViewPrefs['archivedFilter']) => filter === 'show' || (filter === 'only' ? registry.archived.has(id) : !registry.archived.has(id))
export type WorkspaceViewRow =
  | { kind: 'header'; id: string; title: string; workspaceId?: string; depth: number; expanded: boolean; count: number }
  | { kind: 'chat'; id: string; chat: ChatSummary; account: string; depth: number }

/** rc.5 WorkspaceBrowser.tsx:980-1018,352-381,452-481: local accounts, pinned partition,
 * nearest registered ancestor, child groups before parent's own sessions, archived-only ancestor promotion.
 * Blank/subagent rows have already been excluded by the phone's session-list boundary.
 */
export function workspaceViewRows(registry: Workspaces, chats: ChatSummary[], prefs: WorkspaceViewPrefs): WorkspaceViewRow[] {
  const accounts = workspaceAccounts(registry, chats, prefs), byId = new Map(chats.map(c => [c.sessionId, c]))
  const ordered = (key: string) => {
    const rows = (accounts[key] ?? []).flatMap(id => { const c = byId.get(id); return c && visibleWorkspaceChat(registry, id, prefs.archivedFilter) ? [c] : [] })
    const pinned = (c: ChatSummary) => registry.pinned.includes(c.sessionId) && !registry.archived.has(c.sessionId)
    return [...rows.filter(pinned), ...rows.filter(c => !pinned(c))]
  }
  if (prefs.groupBy === 'flat') return ordered(FLAT_ORDER).map(chat => ({ kind: 'chat', id: chat.sessionId, chat, account: FLAT_ORDER, depth: 0 }))
  const all = registry.list(), paths = all.map(w => w.path)
  const parents = new Map(all.map(w => [w.workspaceId, prefs.groupBy === 'workspace-tree' ? all.find(p => p.path === workspaceParent(w.path, paths))?.workspaceId : undefined]))
  const groups = [...all.map(w => ({ id: w.workspaceId, title: w.title, workspaceId: w.workspaceId, chats: ordered(w.workspaceId) })), { id: '', title: S.otherChats, workspaceId: undefined, chats: ordered('') }]
    .filter(g => g.workspaceId !== undefined ? prefs.archivedFilter !== 'only' || g.chats.length > 0 : g.chats.length > 0)
  const rendered = new Set(groups.map(g => g.id)), rows: WorkspaceViewRow[] = []
  const parentOf = (id: string) => { let parent = parents.get(id); while (parent !== undefined && !rendered.has(parent)) parent = parents.get(parent); return parent }
  const append = (parent: string | undefined, depth: number) => {
    for (const g of groups.filter(g => parentOf(g.id) === parent)) {
      // The phone retains its established expanded default; explicit local folding persists across launches.
      const expanded = prefs.groupExpansion[g.id] ?? true
      rows.push({ kind: 'header', id: `h:${g.id}`, title: g.title, workspaceId: g.workspaceId, depth, expanded, count: g.chats.length })
      if (expanded) { append(g.id, depth + 1); rows.push(...g.chats.map(chat => ({ kind: 'chat' as const, id: chat.sessionId, chat, account: g.id, depth }))) }
    }
  }
  append(undefined, 0)
  return rows
}
