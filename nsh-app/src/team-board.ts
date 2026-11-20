// Read-only rc.5 agentTeam wire view. DSH owns revisions, readiness, dependency resolution and failure retention.
// dsh-agent-team types/types.d.ts:42–88; subagentCatalog is the separate member source.
import { catalogOf, type Subagent } from './subagents.ts'

export interface TeamTask {
  id: string; revision: number; subject: string; description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ownerId?: string; ownerName?: string; blockedBy: string[]; writeScopes: string[]
  ready: boolean; writeScopeWarnings: string[]
}
export type TeamBoardState = { kind: 'loading' | 'unavailable' | 'error' } | {
  kind: 'ready'; enabled: boolean; tasks: TeamTask[]; failure?: string; members: Subagent[]; stale?: boolean
}
const obj = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
function taskOf(v: unknown): TeamTask | undefined {
  const t = obj(v)
  if (!t || typeof t.id !== 'string' || !Number.isInteger(t.revision) || (t.revision as number) < 1
    || typeof t.subject !== 'string' || typeof t.description !== 'string'
    || !['pending', 'in_progress', 'completed', 'deleted'].includes(t.status as string)
    || typeof t.ready !== 'boolean' || !strings(t.blockedBy) || !strings(t.writeScopes) || !strings(t.writeScopeWarnings)
    || (t.ownerId !== undefined && typeof t.ownerId !== 'string') || (t.ownerName !== undefined && typeof t.ownerName !== 'string')) return undefined
  return { id: t.id, revision: t.revision as number, subject: t.subject, description: t.description, status: t.status as TeamTask['status'],
    ready: t.ready, blockedBy: [...t.blockedBy], writeScopes: [...t.writeScopes], writeScopeWarnings: [...t.writeScopeWarnings],
    ...(typeof t.ownerId === 'string' ? { ownerId: t.ownerId } : {}), ...(typeof t.ownerName === 'string' ? { ownerName: t.ownerName } : {}),
  }
}

/** Missing capability is not disabled/empty. Reject a malformed view as a whole, not a plausible partial board. */
export function teamBoardOf(projections: unknown): TeamBoardState {
  const values = obj(obj(projections)?.values)
  if (!values || !Object.hasOwn(values, 'agentTeam')) return { kind: 'unavailable' }
  const team = obj(values.agentTeam)
  if (!team || typeof team.enabled !== 'boolean' || !Array.isArray(team.tasks) || (team.failure !== undefined && typeof team.failure !== 'string')) return { kind: 'error' }
  const tasks = team.tasks.map(taskOf)
  if (tasks.some(t => !t) || new Set(tasks.map(t => t!.id)).size !== tasks.length) return { kind: 'error' }
  return { kind: 'ready', enabled: team.enabled, tasks: (tasks as TeamTask[]).filter(t => t.status !== 'deleted'), members: catalogOf(values.subagentCatalog),
    ...(typeof team.failure === 'string' ? { failure: team.failure } : {}),
  }
}

/** Transport loss never turns a known board into an empty board or confirms fresh state. */
export function teamBoardOffline(previous: TeamBoardState): TeamBoardState {
  return previous.kind === 'ready' ? { ...previous, stale: true } : { kind: 'error' }
}

export const teamCounts = (tasks: TeamTask[]) => ({
  pending: tasks.filter(t => t.status === 'pending').length,
  active: tasks.filter(t => t.status === 'in_progress').length,
  completed: tasks.filter(t => t.status === 'completed').length,
})
