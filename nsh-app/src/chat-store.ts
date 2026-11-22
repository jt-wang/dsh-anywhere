// The one copy of what the phone shows about the linked computer's chats outside a chat: the chats themselves, which
// are pinned and archived (DSH's workspace registry) and their titles. The chat list, a chat's header and its menu all
// read it; session/list, DSH's workspace/follow frames, the replies of fork, pin, unpin, archive, unarchive and rename,
// and a chat's own title projection all write it. Nothing keeps a copy of its own.
// DSH Desktop does the same (dsh-api-workspace-controller 0.2.2-rc.5 src/client/model.ts:191-257): a pin or archive
// reply installs the complete set it returns, unless a later request or a pushed frame superseded it.
import { signal } from 'nsh'
import { Workspaces, type ChatSummary } from './workspaces.ts'

let registry = new Workspaces()
const version = signal(0)
// Bumped by every request and every pushed set: a reply installs only when nothing came after its request.
let pinSeq = 0, archiveSeq = 0

/** The registry, read reactively. */
export const workspaces = () => (version(), registry)
export const isPinned = (id: string) => { const w = workspaces(); return w.pinned.includes(id) && !w.archived.has(id) }
export const isArchived = (id: string) => workspaces().archived.has(id)

/** A frame of DSH's workspace/follow stream, or a saved baseline. */
export function applyWorkspaces(frame: unknown) {
  const type = (frame as { type?: unknown } | null)?.type
  if (type === 'baseline' || type === 'replace') { pinSeq++; archiveSeq++ }
  else if (type === 'pinned') pinSeq++
  else if (type === 'archived') archiveSeq++
  registry.apply(frame)
  version.update((n) => n + 1)
}

/** A pin or unpin request: the reply's complete pin set, unless superseded. */
export function pinRequest() {
  const seq = ++pinSeq
  return (reply: { pinnedSessionIds?: unknown }) => {
    if (seq !== pinSeq || !Array.isArray(reply?.pinnedSessionIds)) return
    registry.apply({ type: 'pinned', pinnedSessionIds: reply.pinnedSessionIds }); version.update((n) => n + 1)
  }
}

/** An archive or unarchive request: the reply's complete archive set, unless superseded. Archiving drops the chat's
 * pin in the same write on the computer, so it goes here too. */
export function archiveRequest(sessionId: string, archiving: boolean) {
  const seq = ++archiveSeq
  return (reply: { archivedSessionIds?: unknown }) => {
    if (seq !== archiveSeq || !Array.isArray(reply?.archivedSessionIds)) return
    registry.apply({ type: 'archived', archivedSessionIds: reply.archivedSessionIds })
    if (archiving) registry.apply({ type: 'pinned', pinnedSessionIds: registry.pinned.filter((id) => id !== sessionId) })
    version.update((n) => n + 1)
  }
}

/** The chats session/list gave, with those a fork added after that read went out. */
const listed = signal<ChatSummary[]>([])
let added: { chat: ChatSummary; at: number }[] = [], changes = 0
export const listedChats = () => listed()
/** Chats saved for offline, shown until the computer's list comes. */
export const showSaved = (chats: ChatSummary[]) => listed.set(chats)
/** A session/list read: taken before the request goes out; the function it returns installs the reply, keeping a
 * fork the reply may predate. */
export function listRead() {
  const at = changes
  return (value: ChatSummary[]) => {
    added = added.filter((a) => a.at > at)
    listed.set([...added.map((a) => a.chat).filter((c) => !value.some((v) => v.sessionId === c.sessionId)), ...value])
    setTitles(Object.fromEntries(value.map((c) => [c.sessionId, c.title])))
  }
}

/** A fork's reply: the new chat joins the list now, in its source's workspace, as DSH Desktop adds its row
 * (dsh-api-session-controller 0.2.2-rc.5 src/client/sessions/manager.ts:538-557). */
export function addForked(source: ChatSummary, sessionId: string): ChatSummary {
  const chat: ChatSummary = { ...source, sessionId, title: titleOf(source.sessionId, source.title), running: false, updatedAt: Date.now(), preview: undefined }
  added.push({ chat, at: ++changes })
  registry.attach(sessionId, source.sessionId)
  listed.update((l) => [chat, ...l.filter((c) => c.sessionId !== sessionId)])
  setTitles({ [sessionId]: chat.title })
  version.update((n) => n + 1)
  return chat
}

/** The title DSH Desktop gives a fork (dsh-api-session-controller 0.2.2-rc.5 src/client/sessions/service.ts:138-160):
 * the source's with its trailing number raised, " (1)" when it has none, past every title the list has. */
export function forkTitle(source: string): string {
  const taken = new Set(listed().map((c) => titleOf(c.sessionId, c.title)))
  const next = (t: string) => { const m = /^(.*?)\((\d+)\)$/u.exec(t) ?? /^(.*?)（(\d+)）$/u.exec(t); return m ? t.replace(/\d+(?=[)）]$)/u, String(Number(m[2]) + 1)) : `${t} (1)` }
  let title = next(source)
  while (taken.has(title)) title = next(title)
  return title
}

/** Titles by chat: from the list, a rename's reply and the open chat's title projection. */
export const titles = signal<Record<string, string>>({})
export const setTitles = (next: Record<string, string>) => titles.update((m) => (Object.entries(next).every(([id, t]) => m[id] === t) ? m : { ...m, ...next }))
export const titleOf = (id: string, fallback: string) => titles()[id] ?? fallback

/** Another computer linked: nothing of the last one's stays. */
export function resetChats() { registry = new Workspaces(); pinSeq++; archiveSeq++; added = []; changes++; listed.set([]); titles.set({}); version.update((n) => n + 1) }
