// Models and thinking depth, as DSH's session/modelCatalog lists them and session/selectModel sets them
// (shapes from sorsama/deepseek-harness-mobile's SessionsDtos.kt, tested against a real harness).
export interface Selection { provider: string; model: string; reasoningEffort?: string }
export interface Effort { id: string; name: string }
export interface Model { id: string; name: string; description?: string; efforts: Effort[]; defaultEffort?: string }
export interface Group { id: string; name: string; models: Model[] }
export interface Catalog { default?: Selection; groups: Group[] }

// DSH 0.2.2-rc.5 dsh-agent-team: the setting is saved on the root Session.
// rc.1's experimental agentTeam has members/tasks but no saved enabled selection.
export type TeamMode = { kind: 'available'; enabled: boolean; failure?: string } | { kind: 'unsupported' } | { kind: 'error' }

/** Only exact session/projections values are authoritative, never list-row/cache hints. */
export function teamModeOf(v: unknown): TeamMode {
  const o = obj(v), values = obj(o?.values)
  if (!values || o?.kind !== 'sequenced') return { kind: 'error' }
  if (!Object.prototype.hasOwnProperty.call(values, 'agentTeam')) return { kind: 'unsupported' }
  const team = obj(values.agentTeam)
  if (team && team.enabled === undefined && Array.isArray(team.members) && Array.isArray(team.tasks)) return { kind: 'unsupported' }
  if (!team || typeof team.enabled !== 'boolean' || !Array.isArray(team.tasks) || (team.failure !== undefined && typeof team.failure !== 'string')) return { kind: 'error' }
  return { kind: 'available', enabled: team.enabled, failure: str(team.failure) }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined)

export function selectionOf(v: unknown): Selection | undefined {
  const o = obj(v), provider = str(o?.provider), model = str(o?.model)
  if (!provider || !model) return undefined
  const effort = str(o?.reasoningEffort)
  return effort ? { provider, model, reasoningEffort: effort } : { provider, model }
}

export function catalogOf(v: unknown): Catalog {
  const o = obj(v)
  const groups = (Array.isArray(o?.groups) ? o!.groups : []).flatMap((g: unknown): Group[] => {
    const go = obj(g), id = str(go?.id), name = str(go?.name)
    if (!id || !name) return []
    const models = (Array.isArray(go?.models) ? go!.models : []).flatMap((m: unknown): Model[] => {
      const mo = obj(m), mid = str(mo?.id), mname = str(mo?.name)
      if (!mid || !mname) return []
      const efforts = (Array.isArray(mo?.reasoning?.efforts) ? mo!.reasoning.efforts : []).flatMap((e: unknown): Effort[] => {
        const eo = obj(e), eid = str(eo?.id), ename = str(eo?.name)
        return eid && ename ? [{ id: eid, name: ename }] : []
      })
      return [{ id: mid, name: mname, description: str(mo?.description), efforts, defaultEffort: str(mo?.reasoning?.defaultEffort) }]
    })
    return [{ id, name, models }]
  })
  return { default: selectionOf(o?.default), groups }
}

export function findModel(catalog: Catalog, s: Selection | undefined): Model | undefined {
  return s ? catalog.groups.find((g) => g.id === s.provider)?.models.find((m) => m.id === s.model) : undefined
}

/** "DeepSeek V4 Pro (High)": the model's name and, for a model that thinks, its depth (the default when unset). */
export function modelLabel(catalog: Catalog, selection: Selection | undefined): string {
  const s = selection ?? catalog.default
  if (!s) return ''
  const m = findModel(catalog, s)
  if (!m) return s.model
  const effort = m.efforts.find((e) => e.id === (s.reasoningEffort ?? m.defaultEffort))
  return effort ? `${m.name} (${effort.name})` : m.name
}
