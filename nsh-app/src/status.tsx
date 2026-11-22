// The connection to the computer, on screen all the time: a row on the chats page, a dot in a chat's header, and under
// each header what is wrong: why, and whether it retries, with a way to try at once. A connection lost and found again
// within a few seconds of being on screen says nothing (back from the background, the connection of before has often
// died); a phone without a network says so at once. The bar and the dot open a sheet that goes through each part.
// Pairing again is a step of that sheet the person opens with a button. A scan or paste replaces the old link only
// after the computer takes the new one (link.pair).
import { cleanup, effect, signal, Text, View } from 'nsh'
import type { ConnectionState } from './dsh.ts'
import { PairEmoji, PastePairingCode } from './pairing.tsx'
import { causeOf, offersPairAgain, partsOf, type Cause, type Check } from './reach.ts'
import { appActive, check as lastCheck, connection as reachState, linkError, linking, network as phoneNetwork, pairWith, reconnect, retryAt as nextTry, routeText as route, scan, trying } from './state.ts'
import { S } from './strings.ts'
import { BottomSheet, Grabber, LiveDot, sheetBottom } from './ui.tsx'

export interface Reach { connection: () => ConnectionState; network: () => boolean; active: () => boolean; check: () => Check | undefined; retryAt: () => number | undefined; routeText: () => string; open: { (): boolean; set(v: boolean): void }; retry: () => void; scan: () => Promise<boolean>; /** Try it: sample data on this phone, no computer to reach. */ sample?: () => boolean }
const open = signal(false)
/** The sheet shows the pair-again step instead of the parts. */
const pairing = signal(false)
const live: Reach = { connection: reachState, network: phoneNetwork, active: appActive, check: lastCheck, retryAt: nextTry, routeText: route, open, retry: reconnect, scan, sample: trying }

const dotClass: Record<Cause, string> = { connected: 'bg-muted-foreground', slow: 'bg-muted-foreground', trying: 'bg-muted-foreground', 'no-network': 'bg-destructive', blocked: 'bg-destructive', computer: 'bg-destructive', companion: 'bg-destructive', refused: 'bg-destructive', 'not-running': 'bg-destructive', 'no-answer': 'bg-destructive', 'relay-down': 'bg-muted-foreground' }

/** The state to show: what was last shown holds for the few seconds a short drop gets. */
function shownCause(r: Reach) {
  const late = signal(false)
  const everOnline = signal(r.connection() === 'online')
  let timer: ReturnType<typeof setTimeout> | undefined
  // The few seconds count while the app is on screen: a connection that failed while it was away starts them again.
  effect(() => {
    if (r.connection() === 'online') everOnline.set(true)
    if (r.connection() === 'online' || !r.active()) { clearTimeout(timer); timer = undefined; late.set(false) }
    else if (!timer) timer = setTimeout(() => late.set(true), 3000)
  })
  cleanup(() => clearTimeout(timer))
  return (): Cause => {
    const cause = causeOf({ connection: r.connection(), network: r.network(), check: r.check() })
    return r.connection() !== 'online' && r.network() && !late() ? (everOnline() ? 'connected' : 'trying') : cause
  }
}

const titleOf = (cause: Cause, r: Reach) => (cause === 'trying' ? (r.connection() === 'offline' ? S.offline : S.slowConnect)
  : cause === 'no-network' ? S.noNetwork : S.reach[cause])

/** When it tries again, ticking; empty while it says nothing about trying. */
function retryText(r: Reach, cause: Cause, now: () => number) {
  if (cause === 'refused') return S.reach.noRetry
  if (cause === 'connected' || cause === 'slow' || cause === 'no-network' || r.connection() === 'online') return ''
  const at = r.retryAt()
  return at === undefined ? S.reach.retrying : S.reach.retryIn(String(Math.max(1, Math.ceil((at - now()) / 1000))))
}

function Dot(props: { cause: Cause }) {
  // Reactive both ways: the bar's dot is made once and follows the cause from then on (a plain ternary kept the first one).
  return <If when={props.cause === 'trying'} else={<View testID="dot" class={`w-[8px] h-[8px] rounded-full ${dotClass[props.cause]}`} />}><LiveDot /></If>
}

/** A local copy is useful before reconnecting, but its activity is not a live status. */
export function SavedCopy(props: { at: number; failed: boolean }) {
  return <If when={props.at || props.failed}>
    <Text testID="saved-copy" class="mx-5 mb-2 text-muted-foreground text-[12px] leading-[17px]">
      {props.failed ? S.cacheFailed : S.savedCopy(new Date(props.at).toLocaleString())}
    </Text>
  </If>
}

/** Under a header. `always` (the chats page) also shows a connection without a problem. */
export function ConnectionBar(props: { reach?: Reach; always?: boolean }) {
  const r = props.reach ?? live
  const cause = shownCause(r)
  const now = signal(Date.now())
  effect(() => {
    if (!r.active() || r.connection() === 'online' || r.retryAt() === undefined) return
    now.set(Date.now())
    const tick = setInterval(() => now.set(Date.now()), 1000)
    cleanup(() => clearInterval(tick))
  })
  const quiet = () => cause() === 'connected'
  const line = () => [titleOf(cause(), r), cause() === 'connected' ? r.routeText() : ''].filter(Boolean).join(' · ')
  const sub = () => retryText(r, cause(), now)
  // The sample reaches no computer: the bar says what the banner says, with no dot that means a connection.
  const sample = () => (
    <If when={props.always}>
      <View testID="connection" accessibilityLabel={S.tryIt.onPhone} class="mx-[22px] mb-1 flex-row items-center gap-2 border-b border-border min-h-[35px] py-[5px]">
        <View class="w-[8px] h-[8px] rounded-full bg-muted-foreground" />
        <Text class="flex-1 text-muted-foreground text-[12px] leading-[18px]">{S.tryIt.onPhone}</Text>
      </View>
    </If>
  )
  return (
    <If when={!r.sample?.()} else={sample()}>
    <If when={!quiet() || props.always}>
      <View role="button" testID="connection" accessibilityLabel={`${S.reach.title}: ${line()}`} onPress={() => r.open.set(true)}
        class={`mx-[22px] mb-1 flex-row items-center gap-2 min-h-[35px] py-[5px] active:opacity-70 ${quiet() ? 'border-b border-border' : 'rounded-[10px] bg-secondary px-3'}`}>
        <Dot cause={cause()} />
        <View class="flex-1">
          <Text class="text-muted-foreground text-[12px] leading-[18px] line-clamp-2">{line()}</Text>
          <If when={sub()}><Text class="text-muted-foreground text-[12px] leading-[16px]">{sub()}</Text></If>
        </View>
        <If when={cause() === 'refused'}
          else={<If when={r.connection() === 'offline' && r.network()}>
            <View role="button" testID="reconnect" onPress={r.retry} hitSlop={8} class="active:opacity-60"><Text class="text-foreground text-[13px] font-medium">{S.retry}</Text></View>
          </If>}>
          <View role="button" testID="relink" onPress={() => { pairing.set(true); r.open.set(true) }} hitSlop={8} class="active:opacity-60"><Text class="text-foreground text-[13px] font-medium">{S.reach.relink}</Text></View>
        </If>
      </View>
    </If>
    </If>
  )
}

/** In a chat's header, where a row would take the chat's room. */
export function ConnectionDot(props: { reach?: Reach }) {
  const r = props.reach ?? live
  const cause = shownCause(r)
  return (
    <If when={!r.sample?.()}>
    <View role="button" testID="connection-dot" accessibilityLabel={`${S.reach.title}: ${titleOf(cause(), r)}`} onPress={() => r.open.set(true)} hitSlop={8}
      class="w-[32px] h-[36px] items-center justify-center active:opacity-60">
      <Dot cause={cause()} />
    </View>
    </If>
  )
}

/** Each part in turn, what is wrong, what to do. */
export function ReachSheet(props: { reach?: Reach }) {
  const r = props.reach ?? live
  const cause = () => causeOf({ connection: r.connection(), network: r.network(), check: r.check() })
  const online = () => r.connection() === 'online'
  const state = (ok: boolean | undefined) => (ok === undefined ? S.reach.partUnknown : ok ? S.reach.partOk : S.reach.partFailed)
  const parts = (): [string, boolean | undefined][] => {
    const p = partsOf(cause(), r.check())
    return [[S.reach.partPhone, p.phone], [S.reach.partRelay, p.relay], [S.reach.partComputer, p.computer], [S.reach.partPairing, p.pairing]]
  }
  const latency = () => { const ms = r.check()?.latencyMs; return ms === undefined ? '' : S.reach.latency(String(ms)) }
  const close = () => { r.open.set(false); pairing.set(false) }
  const scanning = signal(false)
  const pairingBusy = () => pairing() && (scanning() || linking())
  const scanCode = async () => {
    if (scanning() || linking()) return
    linkError.set('')
    scanning.set(true)
    try { if (await r.scan()) close() } finally { scanning.set(false) }
  }
  return (
    <BottomSheet open={r.open()} closeOnEscape={!pairingBusy()} closeOnBackdropPress={!pairingBusy()} closeOnSwipe={!pairingBusy()}
      onOpenChange={(e) => { if (!e.open && !pairingBusy()) close() }}>
      <View class="pt-3 px-5" style={{ paddingBottom: sheetBottom() }} testID="reach-sheet">
        <Grabber />
        <If when={pairing()} else={<>
        <Text class="text-foreground text-[15px] font-semibold mb-2">{S.reach.title}</Text>
        <View class="flex-row items-center gap-2"><Dot cause={cause()} /><Text class="flex-1 text-foreground text-[15px]">{titleOf(cause(), r)}</Text></View>
        <If when={S.reach.why[cause()]}><Text testID="reach-why" class="mt-1 text-muted-foreground text-[13px] leading-[18px]">{S.reach.why[cause()]}</Text></If>
        <View class="mt-3 rounded-[12px] border border-border">
          {parts().map(([name, ok], i) => (
            <View class={`flex-row items-center justify-between px-3 py-[9px] ${i ? 'border-t border-border' : ''}`}>
              <Text class="text-foreground text-[14px]">{name}</Text>
              <Text class={`text-[13px] ${ok === false ? 'text-destructive' : 'text-muted-foreground'}`}>{state(ok)}</Text>
            </View>
          ))}
        </View>
        <If when={online() && (r.routeText() || latency())}><Text class="mt-2 text-muted-foreground text-[13px]">{r.routeText()}</Text><If when={latency()}><Text class="text-muted-foreground text-[13px]">{latency()}</Text></If></If>
        <Text testID="relay-privacy" class="mt-2 text-muted-foreground text-[13px] leading-[18px]">{S.relayPrivacy}</Text>
        <If when={cause() === 'refused'} else={<If when={!online() && r.network()}>
          <View role="button" testID="reach-retry" onPress={() => { r.retry(); close() }} class="mt-3 rounded-[12px] h-[44px] justify-center items-center bg-primary active:opacity-80"><Text class="text-primary-foreground text-[15px] font-medium">{S.retry}</Text></View>
        </If>}>
          <View role="button" testID="reach-relink" onPress={() => pairing.set(true)} class="mt-3 rounded-[12px] h-[44px] justify-center items-center bg-primary active:opacity-80"><Text class="text-primary-foreground text-[15px] font-medium">{S.reach.relink}</Text></View>
        </If>
        <If when={cause() !== 'refused' && offersPairAgain(cause())}>
          <View role="button" testID="reach-relink" onPress={() => pairing.set(true)} class="mt-1 h-[40px] justify-center items-center active:opacity-60"><Text class="text-muted-foreground text-[14px]">{S.reach.relink}</Text></View>
        </If>
        </>}>
          <Text class="text-foreground text-[15px] font-semibold mb-2">{S.reach.relink}</Text>
          <Text testID="pair-own" class="text-foreground text-[15px] leading-[21px]">{S.pairAgainOwn}</Text>
          <Text class="mt-1 text-muted-foreground text-[13px] leading-[18px]">{S.linkHow}</Text>
          <View role="button" testID="reach-scan" onPress={scanCode} class="mt-3 rounded-[12px] h-[44px] justify-center items-center bg-primary active:opacity-80"><Text class="text-primary-foreground text-[15px] font-medium">{linking() ? S.linking : S.scan}</Text></View>
          <PairEmoji />
          <PastePairingCode scanning={scanning()} pair={async (text) => { if (await pairWith(text)) close() }} />
          <If when={linkError()}><Text testID="reach-link-error" class="text-destructive text-[15px] leading-[21px]">{linkError()}</Text></If>
          <If when={!pairingBusy()}>
            <View role="button" testID="reach-back" onPress={() => { if (!pairingBusy()) pairing.set(false) }} class="mt-1 h-[40px] justify-center items-center active:opacity-60"><Text class="text-muted-foreground text-[14px]">{S.cancel}</Text></View>
          </If>
        </If>
      </View>
    </BottomSheet>
  )
}
