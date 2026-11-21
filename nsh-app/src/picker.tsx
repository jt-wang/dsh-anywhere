// The model and thinking-depth picker under the composer (where Claude's and ChatGPT's apps keep theirs): the chat's
// current model as a label; a press opens a sheet of DSH's routable models by provider and the chosen model's depths.
import { Scroll, signal, Text, View } from 'nsh'
import { Switch } from 'nsh/base'
import { catalogOf, findModel, modelLabel, teamModeOf, type Catalog, type Selection, type TeamMode } from './models.ts'
import { dsh } from './state.ts'
import { readable, S } from './strings.ts'
import { BottomSheet, DropdownButton, Grabber, haptic, sheetBottom, sheetMax } from './ui.tsx'

let cached: Catalog | undefined

export function ModelPicker(props: { sessionId: string; selection: () => Selection | undefined; onSelected: (s: Selection) => void; onError: (message: string) => void }) {
  const catalog = signal<Catalog>(cached ?? { groups: [] })
  const open = signal(false)
  const load = async () => { try { cached = catalogOf(await dsh().rpc('session/modelCatalog', {})); catalog.set(cached) } catch (e) { props.onError(readable(e)) } }
  const team = signal<TeamMode | undefined>(undefined)
  const teamBusy = signal(false)
  const teamReadError = signal('')
  const teamWriteError = signal('')
  const readTeam = async () => {
    teamReadError.set('')
    try { team.set(teamModeOf(await dsh().rpc('session/projections', { request: { sessionId: props.sessionId } }))) }
    catch (e) { team.set({ kind: 'error' }); teamReadError.set(readable(e)) }
  }
  const refreshTeam = async () => {
    if (teamBusy()) return
    teamBusy.set(true); team.set(undefined)
    try { await readTeam() } finally { teamBusy.set(false) }
  }
  const setTeam = async (enabled: boolean) => {
    const before = team()
    if (teamBusy() || before?.kind !== 'available' || before.enabled === enabled) return
    teamBusy.set(true); teamWriteError.set('')
    // Direct rc.5 call, void result. Even a failed flush can leave the mode changed.
    // Never retry the write or infer selection from its acknowledgement: always read back.
    try { await dsh().rpc('agentTeams/setEnabled', { agentId: props.sessionId, enabled }) }
    catch (e) { teamWriteError.set(`${S.team.unconfirmed} ${readable(e)}`) }
    try { await readTeam() } finally { teamBusy.set(false) }
  }
  const teamEnabled = () => { const t = team(); return t?.kind === 'available' && t.enabled }
  const teamFailure = () => { const t = team(); return t?.kind === 'available' && t.failure !== undefined }
  if (!cached) load()
  const current = () => props.selection() ?? catalog().default
  const choose = async (s: Selection) => {
    haptic('tick')
    try {
      await dsh().rpc('session/selectModel', { request: { sessionId: props.sessionId, ...s } })
      props.onSelected(s)
    } catch (e) { props.onError(readable(e)) }
  }
  const pickModel = (provider: string, model: string) => {
    const m = findModel(catalog(), { provider, model })
    const keep = current()?.reasoningEffort
    const effort = m?.efforts.some((e) => e.id === keep) ? keep : m?.defaultEffort
    choose(effort ? { provider, model, reasoningEffort: effort } : { provider, model })
    if (!m?.efforts.length) open.set(false)
  }
  const efforts = () => findModel(catalog(), current())?.efforts ?? []
  return (
    <>
      <DropdownButton testID="model" accessibilityLabel={S.model} onPress={() => { open.set(true); load(); refreshTeam() }} label={modelLabel(catalog(), current()) || S.model} />
      <BottomSheet open={open()} onOpenChange={(e) => open.set(e.open)}>
        <View class="pt-3" style={{ maxHeight: sheetMax(640), paddingBottom: sheetBottom() }} testID="model-sheet">
          <Grabber />
          <Text class="px-5 text-foreground text-[15px] font-semibold mb-1">{S.model}</Text>
          <Scroll style={{ flexShrink: 1 }} contentClass="pb-2">
            <View class="px-5 py-3 border-b border-border gap-2">
              <View class="flex-row items-center gap-3">
                <View class="flex-1 gap-[2px]">
                  <Text class="text-foreground text-[15px]">{S.team.title}</Text>
                  <Text class="text-muted-foreground text-[13px] leading-[18px]">{S.team.hint}</Text>
                </View>
                <If when={team()?.kind === 'available'}>
                  <Switch testID="teamwork" accessibilityLabel={S.team.title} checked={teamEnabled()} disabled={teamBusy()} onChange={(e) => setTeam(e.checked)}
                    class="w-[46px] h-[28px] disabled:opacity-50" trackClass="w-full h-full rounded-full bg-input checked:bg-primary justify-center px-[3px] transition-colors duration-150"
                    thumbClass="w-[22px] h-[22px] rounded-full bg-background shadow-sm checked:translate-x-[18px] transition-transform duration-150" />
                </If>
              </View>
              <Text testID="teamwork-status" class="text-muted-foreground text-[13px] leading-[18px]">{teamBusy() ? S.switching : team()?.kind === 'available' ? (teamEnabled() ? S.team.on : S.team.off) : team()?.kind === 'unsupported' ? S.team.unsupported : S.team.readFailed}</Text>
              <If when={teamReadError()}><Text class="text-destructive text-[13px] leading-[18px]">{teamReadError()}</Text></If>
              <If when={teamWriteError()}><Text testID="teamwork-write-error" class="text-destructive text-[13px] leading-[18px]">{teamWriteError()}</Text></If>
              <If when={teamFailure()}><Text testID="teamwork-failure" class="text-destructive text-[13px] leading-[18px]">{S.team.taskFailure}</Text></If>
              <If when={team()?.kind === 'error' && !teamBusy()}>
                <View role="button" testID="teamwork-refresh" accessibilityLabel={S.team.refresh} onPress={refreshTeam} class="self-start py-2 active:opacity-70">
                  <Text class="text-primary text-[13px]">{S.team.refresh}</Text>
                </View>
              </If>
            </View>
            {catalog().groups.filter((g) => g.models.length).map((g) => (
              <View class="pt-3">
                <Text class="px-5 pb-1 text-muted-foreground text-[12px]">{g.name}</Text>
                {g.models.map((m) => {
                  const selected = () => current()?.provider === g.id && current()?.model === m.id
                  return (
                    <View role="button" testID={`model-${g.id}-${m.id}`} onPress={() => pickModel(g.id, m.id)} class="flex-row items-center gap-3 px-5 py-[10px] active:bg-secondary">
                      <View class="flex-1">
                        <Text class="text-foreground text-[15px] leading-5">{m.name}</Text>
                        {m.description ? <Text class="text-muted-foreground text-[12px] leading-[16px] line-clamp-2">{m.description}</Text> : null}
                      </View>
                      <Text class="text-foreground text-[15px]">{selected() ? '✓' : ''}</Text>
                    </View>
                  )
                })}
              </View>
            ))}
          </Scroll>
          <If when={efforts().length > 0}>
            <View class="px-5 pt-3 pb-2 border-t border-border gap-2">
              <Text class="text-muted-foreground text-[12px]">{S.thinking}</Text>
              <View class="flex-row flex-wrap gap-2">
                {efforts().map((e) => {
                  const active = () => (current()?.reasoningEffort ?? findModel(catalog(), current())?.defaultEffort) === e.id
                  return (
                    <View role="button" testID={`effort-${e.id}`} onPress={() => { const c = current(); if (c) choose({ provider: c.provider, model: c.model, reasoningEffort: e.id }) }}
                      class={`px-[12px] h-[30px] justify-center rounded-full border ${active() ? 'bg-primary border-primary' : 'border-border'} active:opacity-70`}>
                      <Text class={`text-[13px] ${active() ? 'text-primary-foreground' : 'text-foreground'}`}>{e.name}</Text>
                    </View>
                  )
                })}
              </View>
            </View>
          </If>
        </View>
      </BottomSheet>
    </>
  )
}
