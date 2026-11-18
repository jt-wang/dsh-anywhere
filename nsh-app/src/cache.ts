// Read-only copies of what this phone has already shown. One paired identity, not the bridge's changing port.
// No credentials, terminal input, pending prompts or remote actions belong here.
import { signal, Storage } from 'nsh'
import type { Row } from './fold.ts'
import type { ChatSummary, Workspace } from './workspaces.ts'

interface Copy<T> { at: number; value: T }
export interface WorkspaceCopy { items: Workspace[]; archivedSessionIds: string[]; pinnedSessionIds: string[] }
interface ChatCopy { at: number; rows: Row[]; draft: string }
interface Saved {
  identity: string
  list?: Copy<ChatSummary[]>
  workspaces?: Copy<WorkspaceCopy>
  chats: Record<string, ChatCopy>
}
const KEY = 'offline-v1'
const MAX_CHATS = 20, MAX_ROWS = 100
// Bounds on serialized JSON code units (UTF-16): 2 Mi total, 64 Ki of history per chat.
const MAX_CHAT = 65_536, MAX_TOTAL = 2_097_152
let writes = Promise.resolve()

export class OfflineCache {
  readonly failed = signal(false)
  private active = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private constructor(readonly data: Saved) {}

  static async open(identity: string): Promise<OfflineCache> {
    await writes
    let data: Saved = { identity, chats: {} }, failed = false
    try {
      const raw = await Storage.getItem(KEY)
      const saved = raw ? JSON.parse(raw) : undefined
      if (saved?.identity === identity && saved.chats) data = saved
    } catch { failed = true }
    const cache = new OfflineCache(data)
    cache.failed.set(failed)
    // Replacing the single key also discards any previous computer's copies.
    cache.flush()
    return cache
  }

  static async discard() {
    await writes
    await Storage.removeItem(KEY)
  }

  chat(id: string): ChatCopy | undefined {
    const copy = this.data.chats[id]
    if (copy) { delete this.data.chats[id]; this.data.chats[id] = copy }
    return copy
  }

  list(value: ChatSummary[]) { this.data.list = { at: Date.now(), value: value.slice(0, 500).map((c) => ({ ...c, running: false })) }; this.schedule() }
  workspaces(value: WorkspaceCopy) { this.data.workspaces = { at: Date.now(), value }; this.schedule() }

  history(id: string, rows: Row[]) {
    const copy = this.data.chats[id] ?? { at: 0, rows: [], draft: '' }
    const saved = rows.slice(-MAX_ROWS).map((r) => r.kind === 'assistant' ? { ...r, streaming: false } : r)
    while (saved.length && JSON.stringify(saved).length > MAX_CHAT) saved.shift()
    this.put(id, { ...copy, at: rows.length && !saved.length ? 0 : Date.now(), rows: saved })
  }

  draft(id: string, draft: string) {
    this.put(id, { ...(this.data.chats[id] ?? { at: 0, rows: [] }), draft })
  }

  private put(id: string, copy: ChatCopy) {
    delete this.data.chats[id]; this.data.chats[id] = copy
    while (Object.keys(this.data.chats).length > MAX_CHATS) delete this.data.chats[Object.keys(this.data.chats)[0]!]
    this.schedule()
  }

  private schedule() {
    if (!this.active || this.timer) return
    this.timer = setTimeout(() => this.flush(), 500)
  }

  flush() {
    clearTimeout(this.timer); this.timer = undefined
    if (!this.active) return
    let raw = JSON.stringify(this.data)
    while (raw.length > MAX_TOTAL) {
      const first = Object.keys(this.data.chats)[0]
      if (first) delete this.data.chats[first]
      else if (this.data.workspaces) delete this.data.workspaces
      else delete this.data.list
      raw = JSON.stringify(this.data)
    }
    this.write(() => Storage.setItem(KEY, raw))
  }

  clear() {
    this.active = false; clearTimeout(this.timer)
    this.write(() => Storage.removeItem(KEY))
  }

  private write(run: () => Promise<void>) {
    writes = writes.then(run).then(() => this.failed.set(false), () => this.failed.set(true))
  }
}
