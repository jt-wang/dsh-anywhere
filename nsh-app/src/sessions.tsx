// The chat list, as DSH Desktop's sidebar shows it: chats under their workspaces (workspace/follow), pinned first,
// archived hidden, a "+" to start a chat in a workspace. Subagent and blank chats stay out of the list.
import { cleanup, createAnimatedValue, effect, LayoutAnimation, List, locale, PanResponder, signal, Text, untracked, View } from 'nsh'
import { Input } from 'nsh/base'
import { chatAction, chatMenu, RenameSheet, type ChatAction } from './manage.tsx'
import { dragTo, release, swipeThresholds } from './swipe.ts'
import { DECELERATE } from './motion.ts'
import { Chevron, haptic, Icon, IconButton, LiveDot } from './ui.tsx'
import { ConnectionBar, SavedCopy } from './status.tsx'
import { NewChat } from './newchat.tsx'
import { appActive, asks, connection, dsh, network, offlineCache, pending, pollForeground, trying } from './state.ts'
import { oneAtATime } from './progress.ts'
import { ago, language, readable, S } from './strings.ts'
import { problemOf } from './files.ts'
import { archivedChats, searchChats, summaries, Workspaces, type ChatSummary } from './workspaces.ts'
import { moveLocalSession, rememberWorkspaceOrders, setWorkspaceView, syncWorkspaceOrders, workspaceView } from './prefs.ts'
import { visibleWorkspaceChat, workspaceAccounts, workspaceViewRows, type WorkspaceViewRow } from './workspace-settings-view.ts'
import { workspaceViewStrings } from './workspace-settings-view-strings.ts'

export type Summary = ChatSummary

type Item =
  | Extract<WorkspaceViewRow, { kind: 'header' }>
  | { kind: 'chat'; id: string; chat: Summary; snippet?: string; account?: string; depth?: number }
  | { kind: 'toggle'; id: string; count: number }

export function SessionsScreen(props: { onOpen: (s: Summary) => void; newChat: () => boolean; onNewChatClosed: () => void }) {
  const cache = offlineCache()
  const saved = cache?.data.list
  const chats = signal<Summary[]>(saved?.value ?? [])
  const workspaces = new Workspaces()
  if (cache?.data.workspaces) workspaces.apply({ type: 'baseline', value: cache.data.workspaces.value })
  const copiedAt = signal(saved?.at ?? 0)
  const fresh = signal(false)
  effect(() => { if (connection() !== 'online') fresh.set(false) })
  const known = signal(Boolean(saved))
  const version = signal(0)
  const error = signal('')
  const refreshing = signal(false)
  const loading = signal(!saved)
  effect(() => { if (!network() && !trying()) loading.set(false) })
  const startIn = signal<string | undefined>(undefined)
  const showArchived = signal(false)
  const renaming = signal<Summary | undefined>(undefined)
  const query = signal('')
  const hits = signal<{ sessionId: string; snippet: string }[]>([])
  // A connection the phone kept while the app was away can be dead on its first use; reading the list again once is
  // safe, and the list on screen stays as it was until the second try fails too.
  const list = () => dsh().rpc('session/list', { _request: {} })
  let stopped = false
  const load = oneAtATime(async () => {
    if (stopped || !appActive() || (!network() && !trying())) { loading.set(false); return }
    // A refresh that cannot reach the computer keeps the chats it has: the connection bar speaks for the connection
    // (back from the background, the first refresh often goes out before the connection is back).
    try {
      const value = summaries(await list().catch(async (e) => {
        await new Promise((r) => setTimeout(r, 400))
        if (stopped || !appActive() || (!network() && !trying())) throw e
        return list()
      }))
      if (stopped) return
      chats.set(value); known.set(true); fresh.set(true); copiedAt.set(Date.now()); error.set(''); cache?.list(value)
    } catch (e) { if (!stopped) error.set(problemOf(e) === 'offline' ? '' : readable(e)) } finally { if (!stopped) loading.set(false) }
  })
  const pull = async () => { refreshing.set(true); await load(); refreshing.set(false) }
  pollForeground(load)
  cleanup(() => { stopped = true; cache?.flush() })
  // After the first frame, a change (a chat pinned, archived, brought back) moves the rows rather than jumping them.
  let followed = false
  cleanup(dsh().stream('workspace/follow', {}, (frame) => {
    if (followed) LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'))
    followed = true; workspaces.apply(frame); version.update((n) => n + 1)
    if (workspaces.loaded) cache?.workspaces(workspaces.snapshot())
  }, (e) => error.set(readable(e))))
  effect(() => {
    version()
    const orders = workspaceAccounts(workspaces, chats(), workspaceView())
    rememberWorkspaceOrders(orders)
    // A bounded/offline cached list is not complete membership, and must not prune saved manual slots.
    if (workspaces.loaded && followed && fresh()) syncWorkspaceOrders(orders)
  })
  // Titles match at once; DSH's full-text search adds hits when the install has its index (it can be turned off).
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const search = (text: string) => {
    query.set(text); hits.set([]); clearTimeout(searchTimer)
    if (!text.trim()) return
    searchTimer = setTimeout(async () => {
      try {
        const v = await dsh().rpc<{ items?: { sessionId: string; snippet?: string }[] }>('session/search', { request: { query: text.trim() } })
        if (query() === text) hits.set((v.items ?? []).map((r) => ({ sessionId: r.sessionId, snippet: r.snippet ?? '' })))
      } catch { /* Titles still match locally; the next query can try the computer again. */ }
    }, 300)
  }
  cleanup(() => clearTimeout(searchTimer))
  const searching = () => Boolean(query().trim())
  const items = (): Item[] => {
    version()
    const prefs = workspaceView()
    if (searching()) return searchChats(chats().filter(c => visibleWorkspaceChat(workspaces, c.sessionId, prefs.archivedFilter)), query(), hits().filter(h => visibleWorkspaceChat(workspaces, h.sessionId, prefs.archivedFilter))).map((c) => ({ kind: 'chat' as const, id: `r:${c.sessionId}`, chat: { ...c, title: c.title || S.untitled }, snippet: c.snippet }))
    const row = (c: Summary): Item => ({ kind: 'chat', id: c.sessionId, chat: c })
    const archived = archivedChats(workspaces, chats())
    return [
      ...workspaceViewRows(workspaces, chats(), prefs),
      // Archived is a header of its own that opens and closes, its chats under it.
      ...(prefs.archivedFilter === 'default' && archived.length ? [{ kind: 'toggle' as const, id: 'toggle', count: archived.length }, ...(showArchived() ? archived.map(row) : [])] : []),
    ]
  }
  const localMove = (item: Extract<Item, { kind: 'chat' }>, down: boolean) => {
    if (item.account === undefined) return
    const pinned = (id: string) => workspaces.pinned.includes(id) && !workspaces.archived.has(id)
    const members = workspaceViewRows(workspaces, chats(), workspaceView()).filter((r): r is Extract<WorkspaceViewRow, { kind: 'chat' }> => r.kind === 'chat' && r.account === item.account && pinned(r.id) === pinned(item.chat.sessionId)).map(r => r.id)
    const at = members.indexOf(item.chat.sessionId)
    if ((!down && at <= 0) || (down && at >= members.length - 1)) return
    moveLocalSession(item.account, item.chat.sessionId, members[at + (down ? 2 : -1)])
  }
  const menu = (chat: Summary) => chatMenu(chat, { pinned: workspaces.pinned.includes(chat.sessionId), archived: workspaces.archived.has(chat.sessionId) }, () => renaming.set(chat), (m) => error.set(m), props.onOpen)
  const sheetOpen = () => props.newChat() || startIn() !== undefined
  return (
    <View class="flex-1 bg-background">
      <ConnectionBar always />
      <SavedCopy at={!fresh() || connection() !== 'online' ? copiedAt() : 0} failed={cache?.failed() ?? false} />
      <View class="mx-4 mt-1 mb-1 flex-row items-center gap-2 rounded-[10px] bg-secondary px-[10px]">
        <Icon name="search" size={16} />
        <Input testID="search" placeholder={S.search} value={query()} onChange={(e) => search(e.value)} returnKeyType="search" autoCapitalize="none"
          class="flex-1 bg-transparent py-[8px] text-foreground placeholder:text-muted-foreground text-[15px]" />
        <If when={query()}><IconButton name="x" label={S.clear} onPress={() => search('')} size={16} class="w-[28px] h-[28px]" iconClass="tint-muted-foreground" /></If>
      </View>
      <If when={error() && connection() !== 'offline'}>
        <View class="mx-4 my-2 rounded-[10px] bg-secondary px-3 py-2"><Text class="text-destructive text-[13px] leading-[18px]">{error()}</Text></View>
      </If>
      <List each={items()} keyExtractor={(i) => i.id} estimatedItemSize={56} refreshing={refreshing()} onRefresh={pull} testID="sessions" style={{ flex: 1 }} contentStyle={{ paddingBottom: 24 }}>
        {(i) => (
          <>
            <If when={i().kind === 'chat'}><View style={{ marginLeft: ((i() as Extract<Item, { kind: 'chat' }>).depth ?? 0) * 12 }}><ChatRow chat={() => (i() as Extract<Item, { kind: 'chat' }>).chat} snippet={() => (i() as Extract<Item, { kind: 'chat' }>).snippet} onOpen={props.onOpen} onMenu={menu}
              pinned={() => (version(), workspaces.pinned.includes((i() as Extract<Item, { kind: 'chat' }>).chat.sessionId))}
              archived={() => (version(), workspaces.archived.has((i() as Extract<Item, { kind: 'chat' }>).chat.sessionId))} onError={(m) => error.set(m)} />
              <If when={workspaceView().orderBy === 'manual' && (i() as Extract<Item, { kind: 'chat' }>).account !== undefined && !searching()}><View class="flex-row justify-end px-3">
                <IconButton name="arrowUp" testID={`local-chat-up-${(i() as Extract<Item, { kind: 'chat' }>).chat.sessionId}`} label={workspaceViewStrings(language() === 'system' ? locale() : language()).up} onPress={() => localMove(i() as Extract<Item, { kind: 'chat' }>, false)} />
                <IconButton name="chevronDown" testID={`local-chat-down-${(i() as Extract<Item, { kind: 'chat' }>).chat.sessionId}`} label={workspaceViewStrings(language() === 'system' ? locale() : language()).down} onPress={() => localMove(i() as Extract<Item, { kind: 'chat' }>, true)} />
              </View></If>
            </View></If>
            <If when={i().kind === 'toggle'}>
              <View role="button" testID="toggle-archived" accessibilityState={{ expanded: showArchived() }} onPress={() => { haptic('tick'); showArchived.update((v) => !v) }}
                class="self-start flex-row items-center gap-[5px] ml-2 mt-4 pl-3 pr-2 py-2 rounded-[8px] active:bg-secondary">
                <Text class="text-muted-foreground text-[13px] font-medium">{S.showArchived((i() as Extract<Item, { kind: 'toggle' }>).count)}</Text>
                <If when={showArchived()}><Chevron dir="down" font={13} /></If>
                <If when={!showArchived()}><Chevron dir="right" font={13} /></If>
              </View>
            </If>
            <If when={i().kind === 'header'}>
              <View class="flex-row items-center gap-[6px] pl-5 pr-3 pt-4 pb-[2px]" style={{ marginLeft: (i() as Extract<Item, { kind: 'header' }>).depth * 12 }}>
                <View role="button" testID={`workspace-group-${(i() as Extract<Item, { kind: 'header' }>).id}`} accessibilityLabel={(i() as Extract<Item, { kind: 'header' }>).title} accessibilityState={{ expanded: (i() as Extract<Item, { kind: 'header' }>).expanded }} class="flex-1 min-h-[44px] flex-row items-center gap-2" onPress={() => { const g = i() as Extract<Item, { kind: 'header' }>; setWorkspaceView({ groupExpansion: { ...workspaceView().groupExpansion, [g.workspaceId ?? '']: !g.expanded } }) }}>
                  <Chevron dir={(i() as Extract<Item, { kind: 'header' }>).expanded ? 'down' : 'right'} font={13} />
                  <If when={(i() as Extract<Item, { kind: 'header' }>).workspaceId}><Icon name="folder" size={14} /></If>
                  <Text class="flex-1 text-muted-foreground text-[13px] font-medium line-clamp-1">{(i() as Extract<Item, { kind: 'header' }>).title}</Text>
                </View>
                <If when={(i() as Extract<Item, { kind: 'header' }>).workspaceId}>
                  <IconButton name="plus" label={S.newChat} testID={`new-in-${(i() as Extract<Item, { kind: 'header' }>).workspaceId}`} onPress={() => { const id = (i() as Extract<Item, { kind: 'header' }>).workspaceId!; setWorkspaceView({ groupExpansion: { ...workspaceView().groupExpansion, [id]: true } }); startIn.set(id) }}
                    size={16} class="w-[28px] h-[28px]" iconClass="tint-muted-foreground" />
                </If>
              </View>
            </If>
          </>
        )}
      </List>
      <If when={searching() && !items().length}><View class="absolute inset-0 items-center justify-center pointer-events-none"><Text class="text-muted-foreground text-[15px]">{S.noResults}</Text></View></If>
      <If when={!chats().length && !loading() && (!error() || connection() === 'offline') && !searching()}><View class="absolute inset-0 items-center justify-center px-6 pointer-events-none"><Text class="text-muted-foreground text-[15px] text-center">{known() ? S.empty : S.noSavedChats}</Text></View></If>
      <NewChat open={sheetOpen} workspaces={() => (version(), workspaces.list())} chats={chats} workspaceId={startIn}
        onClose={() => { startIn.set(undefined); props.onNewChatClosed() }}
        onCreated={(sessionId, where) => { startIn.set(undefined); props.onNewChatClosed(); props.onOpen({ sessionId, title: S.untitled, updatedAt: Date.now(), running: false, ...(where ? { cwd: where.path, project: where.title } : {}) }) }} />
      <RenameSheet chat={renaming} onClose={() => renaming.set(undefined)} onRenamed={(id, title) => chats.update((l) => l.map((c) => (c.sessionId === id ? { ...c, title } : c)))} />
    </View>
  )
}

// One row open at a time: a row starting a swipe closes the one left open.
let closeOpen: (() => void) | undefined
const ACTION = 58 // t3code's action width
const spring = { damping: 26, stiffness: 330, mass: 0.7 } // t3code's: settles without overshoot

/** A chat row; swiped left it shows Pin and Archive, and a full swipe archives it (t3code's swipe actions). */
function ChatRow(props: { chat: () => Summary; snippet: () => string | undefined; onOpen: (s: Summary) => void; onMenu: (s: Summary) => void; pinned: () => boolean; archived: () => boolean; onError: (m: string) => void }) {
  const x = createAnimatedValue(0)
  let width = 360, start = 0, offset = 0, armed = false
  // NSH still fires the row's long press 400 ms in after a slow swipe took the touch: a swipe silences it.
  let swiping = false
  const actions = () => (props.archived() ? 0 : 2 * ACTION)
  const close = () => { offset = 0; x.spring(0, spring); if (closeOpen === close) closeOpen = undefined }
  // The list reuses the cell for another chat: it starts closed.
  effect(() => { props.chat().sessionId; offset = 0; x.set(0); if (closeOpen === close) closeOpen = undefined })
  const act = async (action: ChatAction) => {
    haptic(action === 'archive' ? 'confirm' : 'tick')
    if (action === 'archive') { offset = -width; x.timing(-width, { duration: 220, easing: DECELERATE }) } else close()
    try { await chatAction(action, props.chat()) } catch (e) { close(); props.onError(readable(e)) }
  }
  const responder = PanResponder.create({
    onPanResponderGrant: () => { if (closeOpen && closeOpen !== close) closeOpen(); start = offset; armed = false; swiping = true },
    onPanResponderMove: (_, g) => {
      offset = dragTo(start, g.dx, width); x.set(offset)
      const past = -offset >= swipeThresholds(width, actions()).full
      if (past !== armed) { armed = past; haptic(past ? 'threshold' : 'unthreshold') }
    },
    onPanResponderRelease: (_, g) => {
      setTimeout(() => { swiping = false }, 0)
      const t = swipeThresholds(width, actions()), end = release(offset, g.vx, t)
      if (end === 'act') act('archive')
      else if (end === 'open') { offset = -t.actions; x.spring(offset, { ...spring, velocity: g.vx }); closeOpen = close }
      else close()
    },
    onPanResponderTerminate: () => { swiping = false; close() },
  })
  const swipes = () => actions() > 0
  return (
    <View class="mx-2 rounded-[10px] overflow-hidden" onLayout={(e) => { width = e.bounds.size.width }}>
      <If when={swipes()}>
        <View class="absolute inset-y-0 right-0 flex-row" style={{ width: actions(), opacity: x.interpolate({ inputRange: [-24, 0], outputRange: [1, 0] }) }}>
          <View role="button" accessibilityLabel={props.pinned() ? S.unpin : S.pin} testID="swipe-pin" onPress={() => act(props.pinned() ? 'unpin' : 'pin')} class="flex-1 items-center justify-center bg-secondary active:opacity-80">
            <Icon name="pin" size={18} class="tint-foreground" />
          </View>
          <View role="button" accessibilityLabel={S.archive} testID="swipe-archive" onPress={() => act('archive')} class="flex-1 items-center justify-center bg-destructive active:opacity-80">
            <Icon name="archive" size={18} class="tint-white" />
          </View>
        </View>
      </If>
      <View role="button" testID={`session-${props.chat().sessionId}`} onPress={() => (offset < 0 ? close() : props.onOpen(props.chat()))} onLongPress={() => { if (!swiping && offset === 0) { haptic('press'); props.onMenu(props.chat()) } }}
        {...(swipes() ? { panActivation: { activeOffsetX: 12, failOffsetY: 10 }, ...responder.panHandlers } : {})}
        style={{ translate: [x, 0] }} class="px-3 py-[9px] rounded-[10px] bg-background active:bg-secondary transition-colors duration-150">
      <View class="flex-row items-center gap-2">
        <If when={props.chat().running}><LiveDot /></If>
        <Text class="flex-1 text-foreground text-[15px] leading-5 line-clamp-1">{props.chat().title}</Text>
        <If when={(asks(), pending.sessionsWaiting().includes(props.chat().sessionId))} else={<Text class="text-muted-foreground text-[12px] tabular-nums">{props.chat().updatedAt ? ago(props.chat().updatedAt) : ''}</Text>}>
          <Text class="text-[#F54E00] text-[12px] font-medium">{S.waiting}</Text>
        </If>
      </View>
      <If when={props.snippet()}><Text class="mt-1 text-muted-foreground text-[13px] leading-[18px] line-clamp-2">{props.snippet()}</Text></If>
      </View>
    </View>
  )
}
