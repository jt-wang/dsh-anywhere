import { signal, Text, View } from 'nsh'
import { opens, type Child } from './subagents.ts'
import { teamCounts, type TeamBoardState, type TeamTask } from './team-board.ts'
import { T } from './team-board-strings.ts'
import { Chevron, haptic } from './ui.tsx'

/** One projection, no mutations or inferred lifecycle. The activity panel owns scrolling. */
export function TeamBoard(props: { board: () => TeamBoardState; onOpenChild: (child: Child) => void }) {
  const team = () => { const b = props.board(); return b.kind === 'ready' ? b : undefined }
  const counts = () => teamCounts(team()?.tasks ?? [])
  const expanded = signal<string | undefined>(undefined)
  return (
    <View testID="team-board" class="px-[14px] py-[8px] gap-[6px]">
      <Text class="text-foreground text-[15px] font-semibold">{T.title}</Text>
      <If when={props.board().kind !== 'ready'}>
        <Text testID="team-board-state" class="text-muted-foreground text-[13px] leading-[19px]">{props.board().kind === 'loading' ? T.loading : props.board().kind === 'unavailable' ? T.unavailable : T.error}</Text>
      </If>
      <If when={team()}>
        <Text class="text-muted-foreground text-[13px]">{team()?.enabled ? T.enabled : T.disabled}</Text>
        <If when={team()?.stale}><Text testID="team-board-stale" class="text-destructive text-[13px] leading-[19px]">{T.stale}</Text></If>
        <If when={team()?.failure !== undefined}>
          <View testID="team-board-failure" class="gap-1">
            <Text class="text-destructive text-[13px] leading-[19px]">{T.failure}</Text>
            <Text class="text-muted-foreground text-[12px] leading-[18px]">{team()?.failure}</Text>
          </View>
        </If>
        <Text testID="team-board-counts" class="text-muted-foreground text-[12px] leading-[18px]">{`${T.pending}: ${counts().pending} · ${T.in_progress}: ${counts().active} · ${T.completed}: ${counts().completed}`}</Text>
        <If when={!team()?.tasks.length}><Text testID="team-board-empty" class="text-muted-foreground text-[13px]">{T.empty}</Text></If>
        <Each of={team()?.tasks ?? []} key={t => t.id}>{t => (
          <View class="border-t border-border">
            <View role="button" testID={`team-task-${t().id}`} accessibilityState={{ expanded: expanded() === t().id }}
              accessibilityLabel={`${t().subject}, ${taskStatus(t())}`} onPress={() => { haptic('tick'); expanded.set(expanded() === t().id ? undefined : t().id) }}
              class="min-h-[48px] flex-row items-center gap-2 py-[8px] active:bg-secondary">
              <View class="flex-1 gap-[3px]">
                <Text class="text-foreground text-[14px] leading-[20px]">{t().subject}</Text>
                <Text class="text-muted-foreground text-[12px]">{taskStatus(t())}</Text>
              </View>
              <Chevron dir={expanded() === t().id ? 'up' : 'down'} font={13} />
            </View>
            <If when={expanded() === t().id}>
              <View testID={`team-task-details-${t().id}`} class="pb-[10px] gap-[6px]">
                <If when={t().description}><Text class="text-foreground text-[14px] leading-[20px]">{t().description}</Text></If>
                <Text class="text-muted-foreground text-[13px]">{`${T.owner}: ${t().ownerName ?? t().ownerId ?? T.unowned}`}</Text>
                <If when={t().blockedBy.length}><Text class="text-muted-foreground text-[13px]">{`${T.dependencies}: ${t().blockedBy.join(', ')}`}</Text></If>
                <If when={t().writeScopes.length}><Text class="text-muted-foreground text-[13px]">{`${T.scopes}: ${t().writeScopes.join(', ')}`}</Text></If>
                <If when={t().writeScopeWarnings.length}><Text class="text-destructive text-[13px] leading-[19px]">{`${T.warnings}: ${t().writeScopeWarnings.join(', ')}`}</Text></If>
              </View>
            </If>
          </View>
        )}</Each>
        <If when={team()?.members.length}>
          <Text class="text-muted-foreground text-[13px] font-medium">{T.members}</Text>
          <Each of={team()?.members ?? []} key={m => m.id}>{m => (
            <View testID={`team-member-${m().id}`} role={opens(m()) ? 'button' : undefined}
              onPress={opens(m()) ? () => { haptic('tick'); props.onOpenChild({ ...m(), name: m().label ?? m().agentName ?? m().id, running: false }) } : undefined}
              class={`min-h-[44px] flex-row items-center gap-2 py-[6px] ${opens(m()) ? 'active:bg-secondary' : ''}`}>
              <View class="flex-1 gap-1">
                <Text class="text-foreground text-[14px]">{m().agentName ?? m().id}</Text>
                <If when={m().label}><Text class="text-muted-foreground text-[12px]">{m().label}</Text></If>
              </View>
              <If when={opens(m())}><Chevron dir="right" font={13} /></If>
            </View>
          )}</Each>
        </If>
      </If>
    </View>
  )
}

function taskStatus(t: TeamTask) {
  return t.status === 'pending' ? t.ready ? `${T.pending} · ${T.ready}` : `${T.pending} · ${T.blocked}` : t.status === 'in_progress' ? T.in_progress : T.completed
}
