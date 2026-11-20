// Local-only interactive acceptance surface. All HTTP reads answered in memory; no computer or model.
import { mount, Scroll, signal, Text, View } from 'nsh'
import { ActivityButton, ActivityDock, ActivityPanel, createActivity, followDetails } from '../../activity.tsx'
import { SubagentsSheet } from '../../subagents.tsx'
import { catalogOf, children } from '../../subagents.ts'
import { TeamBoard } from '../../team-board.tsx'
import { fixtureCatalog, fixtureProjection } from '../../team-board-fixture.ts'
import { language, type Language } from '../../strings.ts'
import { network, settings } from '../../state.ts'
import { ActionSheetHost } from '../../ui.tsx'

let mode = 'normal'
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const frame = JSON.parse(init?.body as string)
  if (frame.method !== 'session/projections') throw new Error('Fixture only allows session/projections')
  if (mode === 'offline') throw new Error('Synthetic transport loss')
  return new Response(JSON.stringify({ result: { ok: true, value: fixtureProjection(mode) } }))
}) as typeof fetch

function App() {
  settings.set({ origin: 'https://synthetic.invalid/dsh', key: 'synthetic' })
  const a = createActivity(), opened = signal(''), sheet = signal(false)
  a.children.set(children(catalogOf(fixtureCatalog), { items: [] }))
  const refresh = followDetails('synthetic-team-root', a)
  const open = (c: { id: string }) => opened.set(`child ${c.id}`)
  return <View class="flex-1 bg-background pt-[54px]">
    <View class="absolute top-[10px] right-[12px]"><ActivityButton activity={a} /></View>
    <Scroll class="flex-1">
      <View class="px-[14px] gap-1">
        <Text class="text-muted-foreground text-[12px]">Synthetic rc.5 team board fixture</Text>
        <View class="flex-row flex-wrap gap-2">
          {['normal', 'failure', 'old', 'offline', 'network-offline', 'disabled', 'empty'].map(m => <View role="button" testID={`fixture-${m}`} class="min-h-[44px] justify-center px-2 bg-secondary rounded-lg" onPress={() => { mode = m; network.set(m !== 'network-offline'); refresh() }}><Text class="text-foreground text-[13px]">{m}</Text></View>)}
        </View>
        <View class="flex-row flex-wrap gap-2">
          {(['en', 'zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru'] as Language[]).map(l => <View role="button" testID={`locale-${l}`} class="min-h-[44px] justify-center px-2" onPress={() => language.set(l)}><Text class="text-foreground text-[13px]">{l}</Text></View>)}
        </View>
        <View role="button" testID="fixture-subagents" class="min-h-[44px] justify-center" onPress={() => sheet.set(true)}><Text class="text-foreground">Subagents</Text></View>
        <Text testID="fixture-opened" class="text-foreground">{opened()}</Text>
      </View>
      <TeamBoard board={a.team} onOpenChild={open} />
    </Scroll>
    <ActivityPanel activity={a} openJobs={() => {}} openChildren={() => sheet.set(true)} onOpenChild={open} />
    <ActivityDock activity={a} openJobs={() => {}} openChildren={() => sheet.set(true)} onOpenChild={open} />
    <SubagentsSheet open={sheet} onClose={() => sheet.set(false)} kids={a.children} onOpen={open} />
    <ActionSheetHost />
  </View>
}
mount(App)
