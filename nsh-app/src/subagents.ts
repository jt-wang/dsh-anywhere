// A chat's subagents, as DSH 0.2.1-rc.3 publishes them: the parent's `subagentCatalog` projection lists its
// children (the follow snapshot's, then each `subagent/catalog` event appends one); session/list says which run, as
// Desktop's catalog reads them. A child is read through session/follow's subagent address; a continuable child takes
// follow-ups through subagents/prompt (dsh-subagent, dsh-client-ui-subagent).
import { DshError, type Dsh } from './dsh.ts'

export type SubagentMode = 'one-shot' | 'external' | 'continuable' | 'unknown'
// agentName is the catalog's immutable `name`, not the display title in Child.name.
export interface Subagent { id: string; createdAt: number; mode: SubagentMode; label?: string; agentName?: string }
export interface Child extends Subagent { running: boolean; name: string }

const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined)
const MODES: SubagentMode[] = ['one-shot', 'external', 'continuable', 'unknown']

export function catalogOf(v: unknown): Subagent[] {
  return (Array.isArray(v) ? v : []).flatMap((e) => {
    const s = obj(e)
    if (typeof s?.id !== 'string') return []
    return [{ id: s.id, createdAt: Number(s.createdAt) || 0, mode: MODES.includes(s.mode) ? s.mode : 'unknown', ...(typeof s.label === 'string' && s.label ? { label: s.label } : {}),
      ...((s.mode === 'continuable' || s.mode === 'external') && typeof s.name === 'string' && s.name !== 'lead' && /^[a-z][a-z0-9-]{0,31}$/.test(s.name) ? { agentName: s.name } : {}),
    }]
  })
}

/** The catalog's children with whether each runs (session/list's `running`), newest first. A row is named by the
 * child's label, else its own title, else its id, as Desktop's catalog rows are. */
export function children(catalog: Subagent[], list: unknown): Child[] {
  const listed = new Map<string, Record<string, any>>()
  for (const s of Array.isArray(obj(list)?.items) ? obj(list)!.items : []) if (typeof s?.sessionId === 'string') listed.set(s.sessionId, s)
  return catalog.map((c) => {
    const s = listed.get(c.id), title = s?.projections?.values?.title
    return { ...c, running: s?.running === true, name: c.label ?? (typeof title === 'string' && title ? title : c.agentName ?? c.id) }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

/** rc.5 v3 records contain name; v0–2 history is unnamed. These are immutable discovery facts,
 * not rename/patch operations (dsh-subagent catalog projection state v6). A replay adds no second row. */
export function catalogAdd(catalog: Subagent[], data: unknown): Subagent[] {
  const d = obj(data)
  const [entry] = catalogOf([{ ...d, id: d?.childId, createdAt: d?.childCreatedAt }])
  return entry && !catalog.some((c) => c.id === entry.id) ? [...catalog, entry] : catalog
}

/** session/follow's address for a child; an external task has no mode of its own there. */
export function addressOf(parentSessionId: string, child: Subagent) {
  return { kind: 'subagent' as const, parentSessionId, childSessionId: child.id, mode: child.mode === 'external' ? 'unknown' as const : child.mode }
}

/** What a child's composer is, as Desktop elects it: a continuable child takes follow-ups; a one-shot child is a
 * finished record; any other is read-only until its own history says more. */
export function composerOf(mode: SubagentMode): 'compose' | 'one-shot' | 'read-only' {
  return mode === 'continuable' ? 'compose' : mode === 'one-shot' ? 'one-shot' : 'read-only'
}

/** An external task is a leaf of the catalog: it has no conversation to open. */
export const opens = (child: Subagent) => child.mode !== 'external'

/** Select before a side effect. The released control contract changed in 0.2.2-rc.2, not rc.5.
 * Re-read this connection's version; never probe through a mutation or reuse another computer's selection. */
async function userControls(client: Dsh): Promise<boolean> {
  const { dshVersion: version } = await client.computer()
  if (/^0\.2\.2-rc\.[2-5]$/.test(version)) return true
  if (version === '0.2.0-rc.2' || version === '0.2.2-rc.1' || /^0\.2\.1(?:-(?:alpha|beta|rc)\.(?:0|[1-9][0-9]*))?$/.test(version)) return false
  throw new DshError('client/subagent-controls-unverified', 'Subagent controls are unavailable for this DSH version. Update DSH Anywhere.')
}

/** A follow-up queues one message; acceptance does not mean the child's next turn has started. */
export async function followUp(client: Dsh, parentSessionId: string, childSessionId: string, requestId: string, content: unknown[]) {
  const user = await userControls(client)
  return client.rpc<{ messageId: string }>('subagents/prompt', { request: { requestId, childSessionId, delivery: 'queue', content,
    ...(!user ? { parentSessionId, mode: 'continuable' } : {}),
  } })
}

/** Admission of the cancel signal is not quiescence; the follow stream still owns running state. */
export async function interruptChild(client: Dsh, parentSessionId: string, childSessionId: string) {
  const user = await userControls(client)
  return user ? client.rpc<{ accepted: true }>('subagents/interruptByUser', { childSessionId })
    : client.rpc<{ accepted: true }>('subagents/interruptByParent', { childSessionId, parentSessionId, mode: 'continuable' })
}
