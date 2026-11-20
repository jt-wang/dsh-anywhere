// DSH 0.2.2-rc.5: api-workspace-controller/src/types.ts:64-112,
// commands.ts:71-154. These are registry operations, never filesystem writes.
import { DshError, type Dsh } from './dsh.ts'
import { Workspaces } from './workspaces.ts'

export type WorkspaceEdit =
  | { kind: 'rename'; workspaceId: string; title: string }
  | { kind: 'remove'; workspaceId: string }
  | { kind: 'workspace-order'; workspaceId: string; beforeWorkspaceId?: string }
  | { kind: 'session-order'; workspaceId: string; sessionId: string; beforeSessionId?: string }

type Client = Pick<Dsh, 'rpc' | 'stream'>
export type WorkspaceOutcome = '' | 'confirmed' | 'uncertain' | 'rejected'
const inserted = (ids: string[], id: string, before?: string) => {
  const rest = ids.filter(v => v !== id)
  rest.splice(before === undefined ? rest.length : rest.indexOf(before), 0, id)
  return rest
}
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** One mutation at a time, followed by a NEW official follow baseline. Never retry a write.
 * The live follow keeps external edits/reconnects authoritative; retained offline rows are not editable.
 * insertSessionBefore moves only already-accounted sessions WITHIN a workspace, not between directories.
 */
export class WorkspaceSettingsModel {
  registry = new Workspaces()
  status: 'loading' | 'ready' | 'offline' = 'offline'
  busy = false
  outcome: WorkspaceOutcome = ''
  private stop?: () => void
  private cancelRead?: () => void
  private generation = 0
  private disposed = false

  constructor(private client: () => Client, private changed: () => void = () => {}, private readMs = 15_000) {}

  async refresh(): Promise<boolean> {
    if (this.disposed) return false
    this.cancelRead?.(); this.stop?.()
    const generation = ++this.generation
    this.status = 'loading'; this.changed()
    const registry = new Workspaces()
    return new Promise(resolve => {
      let settled = false
      const finish = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok) } }
      const timer = setTimeout(() => {
        if (generation !== this.generation || this.disposed) return
        this.status = 'offline'; this.stop?.(); this.changed(); finish(false)
      }, this.readMs)
      this.cancelRead = () => finish(false)
      try {
        this.stop = this.client().stream('workspace/follow', {}, frame => {
          if (generation !== this.generation || this.disposed) return
          // Only the opening baseline establishes a generation's authority.
          if (!registry.loaded && (frame as { type?: string })?.type !== 'baseline') return
          registry.apply(frame)
          this.registry = registry; this.status = 'ready'; this.changed(); finish(true)
        }, () => {
          if (generation !== this.generation || this.disposed) return
          this.status = 'offline'; this.changed(); finish(false)
        })
      } catch { this.status = 'offline'; this.changed(); finish(false) }
    })
  }

  async edit(edit: WorkspaceEdit): Promise<void> {
    if (this.disposed || this.busy || this.status !== 'ready') return
    const row = this.registry.list().find(w => w.workspaceId === edit.workspaceId)
    if (!row) return
    const { kind, ...request } = edit
    let method: string, matches: (registry: Workspaces) => boolean
    if (kind === 'rename') {
      if (!edit.title.trim()) { this.outcome = 'rejected'; this.changed(); return }
      method = 'rename'; (request as { title: string }).title = edit.title.trim()
      matches = r => r.list().find(w => w.workspaceId === edit.workspaceId)?.title === edit.title.trim()
    } else if (kind === 'remove') {
      method = 'delete'; matches = r => !r.list().some(w => w.workspaceId === edit.workspaceId)
    } else if (kind === 'workspace-order') {
      const ids = this.registry.list().map(w => w.workspaceId)
      if (edit.beforeWorkspaceId === edit.workspaceId || (edit.beforeWorkspaceId !== undefined && !ids.includes(edit.beforeWorkspaceId))) return
      const expected = inserted(ids, edit.workspaceId, edit.beforeWorkspaceId)
      method = 'insertBefore'; matches = r => equal(r.list().map(w => w.workspaceId), expected)
    } else {
      if (!row.sessionIds.includes(edit.sessionId) || edit.beforeSessionId === edit.sessionId || (edit.beforeSessionId !== undefined && !row.sessionIds.includes(edit.beforeSessionId))) return
      const expected = inserted(row.sessionIds, edit.sessionId, edit.beforeSessionId)
      method = 'insertSessionBefore'; matches = r => equal(r.list().find(w => w.workspaceId === edit.workspaceId)?.sessionIds ?? [], expected)
    }
    this.busy = true; this.outcome = ''; this.changed()
    let rejected = false
    try { await this.client().rpc(`workspace/${method}`, { request }) }
    catch (error) {
      // Explicit upstream refusals are not a transport-loss receipt. No endpoint fallback/probe/replay.
      rejected = error instanceof DshError && !['network', 'timeout', 'unknown'].includes(error.code) && !error.code.startsWith('http/')
    }
    const fresh = await this.refresh()
    if (this.disposed) return
    this.outcome = rejected ? 'rejected' : fresh && matches(this.registry) ? 'confirmed' : 'uncertain'
    this.busy = false; this.changed()
  }

  pause() { this.generation++; this.cancelRead?.(); this.stop?.(); this.status = 'offline'; this.outcome = ''; this.changed() }
  dispose() { this.disposed = true; this.pause() }
}
