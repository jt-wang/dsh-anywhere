// The Progress page beside the chat list: a card per project (a DSH working folder) with what needs you, what is done
// for you to check and how many jobs work or wait; a project's page lists its jobs by state. A job is a chat's turns on
// one piece of work (host/src/progress.ts). Read only: answering and stopping happen in the chat a job opens.
import { cleanup, effect, locale, Scroll, signal, Text, untracked, View } from 'nsh'
import { Switch } from 'nsh/base'
import { appActive, connection, dsh, trying } from './state.ts'
import { ago, language, S } from './strings.ts'
import { ConnectionBar } from './status.tsx'
import { Icon } from './ui.tsx'
import { askText, cardOf, jobLines, loadSeen, markSeen, oneAtATime, sectionsOf, seen, viewOf, type Job, type Kind, type Project, type View as ProgressView } from './progress.ts'

export { markSeen }

/** Whether the linked computer's companion has the page (undefined until it said). */
export const progressAvailable = signal<boolean | undefined>(undefined)
export const progressView = signal<ProgressView | undefined>(undefined)
export const progressError = signal('')
let reload: (() => Promise<void>) | undefined
export const needsYou = () => progressView()?.needsYou ?? 0

/** The page's language for new jobs' names: the app's, as the companion names it. */
export const judgeLanguage = (l: string) => (l === 'zh' || l.startsWith('zh-Hans') || l === 'zh-CN' ? 'zh-Hans' : l.startsWith('zh') ? 'zh-Hant' : ['en', 'es', 'fr', 'ko', 'ja', 'ru'].includes(l.split('-')[0]!) ? l.split('-')[0]! : 'en')

/** Mounted once per link: asks whether the companion has the page, then keeps the jobs fresh while the app is in front. */
export function ProgressFeed() {
  progressAvailable.set(undefined); progressView.set(undefined); progressError.set('')
  loadSeen()
  let stopped = false
  const ask = async () => {
    if (stopped || trying()) { if (trying()) progressAvailable.set(false); return }
    try { progressAvailable.set((await dsh().computer()).progress) } catch { if (!stopped) setTimeout(ask, 15_000) }
  }
  // One list at a time: on a slow computer the 5 s refresh would otherwise pile up requests.
  const load = oneAtATime(async () => {
    if (stopped || !progressAvailable()) return
    try { const v = viewOf(await dsh().companion('progress/list', {})); if (!stopped) { if (v) { progressView.set(v); progressError.set('') } else progressError.set(S.progress.failed) } }
    catch { if (!stopped) progressError.set(S.progress.failed) }
  })
  reload = load
  ask()
  effect(() => { if (progressAvailable()) untracked(load) })
  const timer = setInterval(() => { if (appActive() && connection() !== 'offline') load() }, 5000)
  cleanup(() => { stopped = true; clearInterval(timer); reload = undefined })
  return null
}
export const refreshProgress = () => untracked(() => reload?.())

/** The header's switch between the chat list and Progress, with how many jobs need you. */
export function HomeTabs(props: { tab: () => 'chats' | 'progress'; onTab: (t: 'chats' | 'progress') => void }) {
  const tab = (id: 'chats' | 'progress', label: () => string) => (
    <View role="tab" testID={`tab-${id}`} accessibilityState={{ selected: props.tab() === id }}
      accessibilityLabel={id === 'progress' && needsYou() ? `${label()}, ${S.progress.needYou(needsYou())}` : label()} onPress={() => props.onTab(id)}
      class={`h-[34px] px-[14px] rounded-[9px] flex-row items-center gap-[6px] ${props.tab() === id ? 'bg-background shadow-sm' : 'active:opacity-70'}`}>
      <Text class={`text-[15px] ${props.tab() === id ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{label()}</Text>
      <If when={id === 'progress' && needsYou() > 0}>
        <View class="min-w-[18px] h-[18px] px-[5px] rounded-full bg-[#F54E00] items-center justify-center"><Text class="text-white text-[11px] font-semibold tabular-nums">{String(needsYou())}</Text></View>
      </If>
    </View>
  )
  return <View role="tablist" class="flex-row rounded-[12px] bg-secondary p-[3px] self-start">{tab('chats', () => S.chats)}{tab('progress', () => S.progress.tab)}</View>
}

function Centered(props: { text: string; retry?: () => void }) {
  return (
    <View class="flex-1 items-center justify-center px-8 gap-3">
      <Text class="text-muted-foreground text-[15px] text-center leading-[21px]">{props.text}</Text>
      <If when={props.retry}><View role="button" testID="progress-retry" onPress={() => props.retry!()} hitSlop={8} class="active:opacity-60"><Text class="text-primary text-[15px] font-medium">{S.retry}</Text></View></If>
    </View>
  )
}

/** One line of a card: a job that needs you (its question in orange) or one done for you to check (its result's first line). */
function CardLine(props: { job: Job; kind: 'ask' | 'check'; onOpen: (j: Job) => void }) {
  const ask = () => props.job.ask ? askText(props.job.ask) : ''
  return (
    <View role="button" testID={`job-${props.job.sessionId}-${props.job.index}`} onPress={() => props.onOpen(props.job)}
      accessibilityLabel={props.kind === 'ask' ? `${props.job.title}, ${S.progress.sections.ask}, ${ask()}` : `${props.job.title}, ${S.progress.toCheck}, ${props.job.result?.text ?? ''}`}
      class="flex-row gap-3 px-4 py-[7px] active:bg-secondary">
      <View class="w-[16px] pt-[5px] items-center">
        <If when={props.kind === 'ask'} else={<Icon name="check" size={16} class="tint-foreground" />}><View class="w-[11px] h-[11px] rounded-full bg-[#F54E00]" /></If>
      </View>
      <View class="flex-1">
        <View class="flex-row flex-wrap items-baseline gap-x-[6px]">
          <Text class="text-[15px] leading-[21px] text-foreground font-medium">{props.job.title}</Text>
          <If when={props.kind === 'check'}><Text class="text-[15px] leading-[21px] text-muted-foreground">{S.progress.toCheck}</Text></If>
        </View>
        <If when={props.kind === 'ask'} else={<Text class="text-muted-foreground text-[14px] leading-[20px] line-clamp-1">{props.job.result?.text ?? ''}</Text>}>
          <Text class="text-[#F54E00] text-[14px] leading-[20px]">{ask()}</Text>
        </If>
      </View>
    </View>
  )
}

function ProjectCard(props: { project: Project; onProject: (p: Project) => void; onOpen: (j: Job) => void }) {
  const card = () => cardOf(props.project, seen().chats, seen().baseline)
  return (
    <View class="mx-4 mb-3 rounded-[16px] bg-card border border-border overflow-hidden">
      <View role="button" testID={`project-${props.project.id}`} accessibilityLabel={`${props.project.title}, ${S.progress.jobsIn(card().jobs, card().chats)}`} onPress={() => props.onProject(props.project)}
        class="flex-row items-center gap-2 px-4 pt-[13px] pb-[6px] active:bg-secondary">
        <Icon name="folder" size={16} class="tint-muted-foreground" />
        <Text class="flex-1 text-foreground text-[17px] font-semibold tracking-[-0.2px] line-clamp-1">{props.project.title}</Text>
        <Text class="text-muted-foreground text-[13px] tabular-nums">{S.progress.jobsIn(card().jobs, card().chats)}</Text>
      </View>
      <Each of={card().asks} key={(j) => `${j.sessionId}-${j.index}`}>{(j) => <CardLine job={j()} kind="ask" onOpen={props.onOpen} />}</Each>
      <Each of={card().checks} key={(j) => `${j.sessionId}-${j.index}`}>{(j) => <CardLine job={j()} kind="check" onOpen={props.onOpen} />}</Each>
      <If when={card().working + card().idle > 0}>
        <View role="button" testID={`project-rest-${props.project.id}`} onPress={() => props.onProject(props.project)} class="flex-row items-center gap-3 px-4 pt-[6px] pb-[12px] active:bg-secondary">
          <View class="w-[16px] items-center"><Icon name="chevronRight" size={14} class="tint-muted-foreground" /></View>
          <Text class="text-muted-foreground text-[14px]">{S.progress.rest(card().working, card().idle)}</Text>
        </View>
      </If>
      <If when={card().working + card().idle === 0}><View class="h-[6px]" /></If>
    </View>
  )
}

export function ProgressScreen(props: { onProject: (p: Project) => void; onOpen: (j: Job) => void }) {
  effect(() => { if (progressAvailable()) refreshProgress() })
  const view = () => progressView()
  const allOne = () => { const v = view(); return !!v && !v.judge && v.projects.some((p) => p.jobs.length) }
  return (
    <View class="flex-1 bg-background">
      <ConnectionBar />
      <If when={view()} else={<Centered text={progressError() || S.progress.loading} {...(progressError() ? { retry: () => { progressError.set(''); refreshProgress() } } : {})} />}>
        <If when={view()!.projects.length} else={<Centered text={S.empty} />}>
          <Scroll class="flex-1" contentClass="pb-8" testID="progress">
            <View class="flex-row items-center px-5 pt-2 pb-3">
              <Text class="flex-1 text-muted-foreground text-[14px]">{S.progress.summary(view()!.projects.length, view()!.chats)}</Text>
              <If when={view()!.needsYou}><Text class="text-muted-foreground text-[14px]">{S.progress.needYou(view()!.needsYou)}</Text></If>
            </View>
            <If when={progressError()}><Text class="mx-5 mb-2 text-destructive text-[13px]">{progressError()}</Text></If>
            <Each of={view()!.projects} key={(p) => p.id}>{(p) => <ProjectCard project={p()} onProject={props.onProject} onOpen={props.onOpen} />}</Each>
            <If when={allOne()}><Text class="mx-5 mt-1 text-muted-foreground text-[13px] leading-[18px]">{S.progress.oneJob}</Text></If>
          </Scroll>
        </If>
      </If>
    </View>
  )
}

/** One job on a project's page. */
function JobRow(props: { job: Job; kind: Kind; first: boolean; onOpen: (j: Job) => void }) {
  const j = props.job
  const lines = () => jobLines(j)
  const right = () => (props.kind === 'run' ? S.progress.runningNow : j.at ? ago(j.at) : '')
  const label = () => [j.title, S.progress.sections[props.kind], j.ask ? askText(j.ask) : '', ...lines(), j.result ? `${S.progress.result(j.result.turn)}: ${j.result.text}` : ''].filter(Boolean).join(', ')
  return (
    <View role="button" testID={`job-${j.sessionId}-${j.index}`} accessibilityLabel={label()} onPress={() => props.onOpen(j)}
      class={`flex-row gap-3 px-4 py-3 active:bg-secondary ${props.first ? '' : 'border-t border-border'}`}>
      <View class="w-[14px] pt-[7px] items-center">
        <View class={props.kind === 'run' ? 'w-[8px] h-[8px] rounded-full bg-foreground' : 'w-[8px] h-[8px] rounded-full border-[1.5px] border-muted-foreground'} />
      </View>
      <View class="flex-1 gap-[3px]">
        <View class="flex-row items-start gap-2">
          <Text class="flex-1 text-foreground text-[16px] leading-[22px]">{j.title}</Text>
          <Text class="text-muted-foreground text-[13px] leading-[22px] tabular-nums">{right()}</Text>
        </View>
        <If when={j.ask}><Text class="text-[#F54E00] text-[14px] leading-[20px]">{j.ask ? askText(j.ask) : ''}</Text></If>
        <Each of={lines()} key={(l) => l}>{(line) => <Text class="text-muted-foreground text-[14px] leading-[20px]">{line()}</Text>}</Each>
        <If when={j.result && props.kind !== 'ask'}>
          <View class="mt-[6px] rounded-[12px] bg-secondary px-3 py-[10px] gap-[3px]">
            <Text class="text-muted-foreground text-[12px]">{j.result ? S.progress.result(j.result.turn) : ''}</Text>
            <Text class="text-foreground text-[15px] leading-[21px]">{j.result?.text ?? ''}</Text>
          </View>
        </If>
      </View>
    </View>
  )
}

export function ProjectPage(props: { projectId: string; onOpen: (j: Job) => void }) {
  effect(() => { refreshProgress() })
  const project = () => progressView()?.projects.find((p) => p.id === props.projectId)
  const sections = () => (project() ? sectionsOf(project()!, seen().chats, seen().baseline) : [])
  const running = () => project()?.jobs.filter((j) => j.status === 'running').length ?? 0
  return (
    <View class="flex-1 bg-background">
      <ConnectionBar />
      <If when={project()} else={<Centered text={progressError() || (progressView() ? S.empty : S.progress.loading)} />}>
        <Scroll class="flex-1" contentClass="pb-8" testID="project">
          <Text class="px-5 pt-2 pb-1 text-muted-foreground text-[14px]">{[S.progress.jobsIn(project()!.jobs.length, project()!.chats), running() ? S.progress.running(running()) : ''].filter(Boolean).join(' · ')}</Text>
          <Each of={sections()} key={(s) => s.kind}>{(s) => (
            <View>
              <View class="flex-row items-center px-5 pt-5 pb-2">
                <Text role="header" class={`flex-1 text-[15px] font-medium ${s().kind === 'ask' ? 'text-[#F54E00]' : 'text-muted-foreground'}`}>{S.progress.sections[s().kind]}</Text>
                <Text class={`text-[15px] font-medium tabular-nums ${s().kind === 'ask' ? 'text-[#F54E00]' : 'text-muted-foreground'}`}>{String(s().jobs.length)}</Text>
              </View>
              <View class="mx-4 rounded-[16px] bg-card border border-border overflow-hidden">
                <Each of={s().jobs} key={(j) => `${j.sessionId}-${j.index}`}>{(j) => <JobRow job={j()} kind={s().kind} first={s().jobs[0] === j()} onOpen={props.onOpen} />}</Each>
              </View>
            </View>
          )}</Each>
        </Scroll>
      </If>
    </View>
  )
}

/** Settings: whether the computer splits chats into jobs, which spends the owner's own DeepSeek balance. */
export function ProgressSetting() {
  const judge = signal<boolean | undefined>(undefined)
  const error = signal('')
  const busy = signal(false)
  dsh().companion<{ judge?: boolean }>('progress/settings', {}).then((v) => judge.set(v?.judge === true), () => {})
  const set = async (on: boolean) => {
    if (busy()) return
    busy.set(true); error.set(''); judge.set(on)
    try {
      const l = language()
      const v = await dsh().companion<{ judge?: boolean }>('progress/settings', { judge: on, language: judgeLanguage(l === 'system' ? locale() : l) })
      judge.set(v?.judge === true); refreshProgress()
    } catch { judge.set(!on); error.set(S.progress.settingError) } finally { busy.set(false) }
  }
  return (
    <View class="rounded-[14px] bg-card border border-border overflow-hidden">
      <View class="flex-row items-center gap-3 px-[14px] py-3">
        <View class="flex-1 gap-[2px]">
          <Text class="text-foreground text-[15px]">{S.progress.setting}</Text>
          <Text class="text-muted-foreground text-[13px] leading-[18px]">{S.progress.settingHint}</Text>
          <If when={error()}><Text class="text-destructive text-[13px] leading-[18px]">{error()}</Text></If>
        </View>
        <Switch testID="progress-judge" accessibilityLabel={S.progress.setting} checked={judge() === true} onChange={(e) => set(e.checked)}
          class="w-[46px] h-[28px]" trackClass="w-full h-full rounded-full bg-input checked:bg-primary justify-center px-[3px] transition-colors duration-150"
          thumbClass="w-[22px] h-[22px] rounded-full bg-background shadow-sm checked:translate-x-[18px] transition-transform duration-150" />
      </View>
    </View>
  )
}
