import { cleanup, computed, effect, host, locale, safeAreaInsets, signal, Text, untracked, View } from 'nsh'
import { Sheet } from 'nsh/base'
import { language } from './strings.ts'
import { dsh } from './state.ts'
import { Grabber, haptic, Icon, SCRIM, SHEET } from './ui.tsx'
import { createVoice, voiceReadiness, type VoiceCatalog, type VoiceIo, type VoicePhase, type VoiceProvider, type VoiceSheet } from './voice.ts'
import { voiceStrings } from './voice-strings.ts'

const BARS = 32
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Voice input for a composer (src/voice-design.md). `Button` is the microphone beside Send; while a take is under way
 * `Bar` takes the toolbar's place (Cancel, timer, level, Done); `Status` is a failure's reason and next step under the
 * text field; `Sheet` explains what a tap on the microphone needs first (the computer, the speech model, the
 * microphone permission). onText appends to the CURRENT draft; never wire it to send. Create it per chat: its owner's
 * cleanup cancels late replies. `blocked` names why a tap cannot record now; `io` is only for deterministic component
 * tests. */
export function createVoiceInput(props: { disabled: () => boolean; blocked?: () => 'sample' | 'offline' | undefined; onText: (text: string) => void; io?: Pick<VoiceIo, 'client'> & Partial<Pick<VoiceIo, 'call'>> }) {
  const phase = signal<VoicePhase>('idle'), sheet = signal<VoiceSheet | undefined>(undefined), shown = signal(false)
  const error = signal(''), levels = signal<number[]>(Array(BARS).fill(0)), started = signal(0), limit = signal(60), now = signal(0)
  const insets = safeAreaInsets()
  const lang = () => language() === 'system' ? locale() : language()
  const words = () => voiceStrings(lang())
  const client = () => (props.io?.client ?? dsh)()
  // voice.record answers when the take ends, so it must not get host.call's 30-second budget (nsh/host).
  const call = props.io?.call ?? (<T,>(name: string, args: Record<string, unknown>) => host.call<T>(name, args, name === 'voice.record' ? { timeout: 0 } : undefined))
  const open = (s: VoiceSheet | undefined) => { if (s) { sheet.set(s); shown.set(true) } else shown.set(false) }
  const voice = createVoice({ client, call,
    phase: p => { phase.set(p); if (p === 'idle') levels.set(Array(BARS).fill(0)) },
    live: (at, seconds) => { started.set(at); now.set(at); limit.set(seconds); haptic('press') },
    level: l => levels.set([...levels().slice(1), l]),
    sheet: open,
    onText: text => { if (!props.disabled()) props.onText(text) },
    onError: code => { const w = words() as Record<string, string>; error.set(w[code.replace('voice/', '')] ?? w.failed) },
  })
  const tick = setInterval(() => { if (phase() === 'recording') now.set(Date.now()) }, 250)
  effect(() => { if (props.disabled() || props.blocked?.()) voice.cancel() })
  cleanup(() => { clearInterval(tick); voice.cancel() })
  try { cleanup(host.on('app.state', (v) => { if ((v as { active?: boolean })?.active === false) voice.cancel() })) } catch {}
  try { cleanup(host.on('voice.level', voice.level)) } catch {}
  const begin = (primed = false) => {
    error.set('')
    const why = props.blocked?.()
    if (why) { open({ kind: why }); return }
    void voice.start({ primed })
  }

  // While the computer prepares the model, the sheet follows it (speech/follow) and turns into Record once it is ready.
  const preparing = computed(() => { const k = sheet()?.kind; return shown() && (k === 'download' || k === 'preparing') })
  effect(() => {
    if (!preparing()) return
    const c = untracked(client)
    if (!c.stream) return
    const stop = c.stream('speech/follow', {}, (value) => {
      const r = voiceReadiness(value as VoiceCatalog)
      if (!shown() || !('provider' in r)) return
      const kind = sheet()?.kind
      if (r.state === 'ready') sheet.set({ kind: 'ready', provider: r.provider })
      else if (kind === 'preparing' || r.state === 'preparing') sheet.set({ kind: r.state, provider: r.provider })
      else sheet.set({ kind: 'download', provider: r.provider })
    }, () => {})
    cleanup(stop)
  })
  const prepareError = signal('')
  const prepare = async (provider: VoiceProvider) => {
    prepareError.set('')
    sheet.set({ kind: 'preparing', provider: { ...provider, preparation: { phase: 'checking' } } })
    try { await client().rpc('speech/prepare', { providerId: provider.id }) }
    catch { prepareError.set(words().prepareFailed); sheet.set({ kind: 'download', provider }) }
  }

  const primary = (id: string, label: string, press: () => void) => (
    <View role="button" testID={id} accessibilityLabel={label} onPress={press}
      class="h-[50px] rounded-[14px] bg-primary items-center justify-center active:opacity-80">
      <Text class="text-primary-foreground text-[16px] font-medium">{label}</Text>
    </View>
  )
  const secondary = (id: string, label: string, press: () => void) => (
    <View role="button" testID={id} accessibilityLabel={label} onPress={press}
      class="h-[50px] rounded-[14px] items-center justify-center active:bg-secondary">
      <Text class="text-foreground text-[16px]">{label}</Text>
    </View>
  )
  const close = () => open(undefined)
  const progress = (p: VoiceProvider) => {
    const s = p.preparation
    const step = s.steps?.find(x => x.status === 'running')?.kind
    const w = words()
    const label = step === 'model' ? w.stepModel : step === 'vad' ? w.stepVad : step === 'verify' ? w.stepVerify : step === 'load' ? w.stepLoad : w.stepCheck
    const bytes = s.completedBytes !== undefined ? ` ${(s.completedBytes / 1e6).toFixed(0)}${s.totalBytes ? ` / ${(s.totalBytes / 1e6).toFixed(0)}` : ''} MB` : ''
    return { label: label + bytes, fraction: s.totalBytes ? Math.min(1, (s.completedBytes ?? 0) / s.totalBytes) : undefined }
  }
  const content = () => {
    const s = sheet(), w = words()
    if (!s) return { icon: 'mic' as const, title: '', body: '' }
    switch (s.kind) {
      case 'sample': return { icon: 'mic' as const, title: w.sampleTitle, body: w.sampleBody }
      case 'offline': return { icon: 'info' as const, title: w.offlineTitle, body: w.offlineBody }
      case 'missing': return { icon: 'sliders' as const, title: w.missingTitle, body: w.missingBody }
      case 'cloud': return { icon: 'sliders' as const, title: w.cloudTitle, body: w.cloudBody }
      case 'primer': return { icon: 'mic' as const, title: w.primerTitle, body: w.primerBody }
      case 'denied': return { icon: 'mic' as const, title: w.deniedTitle, body: w.deniedBody }
      case 'download': return { icon: 'mic' as const, title: w.downloadTitle, body: w.downloadBody }
      case 'preparing': return { icon: 'clock' as const, title: w.preparingTitle, body: w.preparingBody }
      case 'ready': return { icon: 'check' as const, title: w.readyTitle, body: w.readyBody }
    }
  }
  const estimate = () => {
    const s = sheet(), e = s && 'provider' in s ? s.provider.setupEstimate : undefined
    return e ? words().estimate.replace('{gb}', String(Math.round(e.recommendedDiskBytes / 1e8) / 10)).replace('{min}', String(e.minimumMinutes)).replace('{max}', String(e.maximumMinutes)) : ''
  }
  const actions = () => {
    const s = sheet(), w = words()
    if (!s) return null
    switch (s.kind) {
      case 'sample': return primary('voice-sheet-ok', w.ok, close)
      case 'offline': case 'missing': case 'cloud':
        return [primary('voice-sheet-check', w.checkAgain, () => { close(); begin() }), secondary('voice-sheet-later', w.notNow, close)]
      case 'primer': return [primary('voice-sheet-continue', w.continue, () => { close(); begin(true) }), secondary('voice-sheet-later', w.notNow, close)]
      case 'denied': return [primary('voice-sheet-settings', w.openSettings, () => { close(); void call('voice.settings', {}).catch(() => {}) }), secondary('voice-sheet-later', w.notNow, close)]
      case 'download': return [primary('voice-sheet-download', w.download, () => void prepare(s.provider)), secondary('voice-sheet-later', w.notNow, close)]
      case 'preparing': return secondary('voice-sheet-close', w.close, close)
      case 'ready': return [primary('voice-sheet-record', w.record, () => { close(); begin() }), secondary('voice-sheet-later', w.notNow, close)]
    }
  }

  return {
    active: () => phase() !== 'idle',
    level: voice.level,
    Button: () => (
      <View role="button" testID="voice-start" accessibilityLabel={words().start} accessibilityState={{ disabled: props.disabled() }} hitSlop={6}
        onPress={() => { if (!props.disabled()) begin() }}
        class={`w-[36px] h-[36px] rounded-full items-center justify-center active:bg-secondary ${props.disabled() ? 'opacity-40' : ''}`}>
        <Icon name="mic" size={20} class="tint-muted-foreground" />
      </View>
    ),
    /** The toolbar while a take is under way: Cancel, what is happening (timer and level while recording), Done. */
    Bar: () => (
      <View testID="voice-bar" class="flex-1 flex-row items-center gap-[8px]">
        <View role="button" testID="voice-cancel" accessibilityLabel={words().cancel} onPress={() => { error.set(''); voice.cancel() }} hitSlop={6}
          class="w-[36px] h-[36px] rounded-full items-center justify-center active:bg-secondary">
          <Icon name="x" size={20} class="tint-muted-foreground" />
        </View>
        <If when={phase() === 'recording'} else={
          <Text testID="voice-status" class="flex-1 text-[14px] text-muted-foreground line-clamp-1">
            {phase() === 'checking' ? words().checking : phase() === 'requesting' ? words().requesting : words().transcribing}
          </Text>}>
          <View class="w-[8px] h-[8px] rounded-full bg-destructive" />
          <Text testID="voice-timer" accessibilityLabel={words().recording} class="text-[14px] text-foreground">
            {`${clock(Math.min(limit(), (now() - started()) / 1000))} / ${clock(limit())}`}
          </Text>
          <View testID="voice-level" class="flex-1 h-[28px] flex-row items-center justify-end gap-[2px] overflow-hidden">
            {levels().map(l => <View class="w-[3px] rounded-full bg-muted-foreground" style={{ height: 3 + Math.round(l * 22) }} />)}
          </View>
        </If>
        {/* While the computer transcribes, Done stays where it was, dimmed: the tap was taken and the take is on its way. */}
        <If when={phase() === 'recording' || phase() === 'requesting'} else={
          <View testID="voice-busy" class="ml-[6px] w-[32px] h-[32px] rounded-full bg-primary items-center justify-center opacity-40">
            <Icon name="check" size={18} class="tint-primary-foreground" />
          </View>}>
          <View role="button" testID="voice-stop" accessibilityLabel={words().stop} onPress={() => { haptic('confirm'); void voice.stop() }} hitSlop={6}
            class="ml-[6px] w-[32px] h-[32px] rounded-full bg-primary items-center justify-center active:opacity-80">
            <Icon name="check" size={18} class="tint-primary-foreground" />
          </View>
        </If>
      </View>
    ),
    Status: () => (
      <If when={error() && phase() === 'idle'}>
        <View testID="voice-error" class="flex-row items-start gap-[8px] mx-[10px] mb-[4px] px-[10px] py-[8px] rounded-[10px] bg-secondary">
          <Text class="flex-1 text-[13px] leading-[18px] text-foreground">{error()}</Text>
          <View role="button" testID="voice-error-dismiss" accessibilityLabel={words().dismiss} onPress={() => error.set('')} hitSlop={8}>
            <Icon name="x" size={16} class="tint-muted-foreground" />
          </View>
        </View>
      </If>
    ),
    Sheet: () => (
      <Sheet open={shown()} onOpenChange={(e) => { if (!e.open) close() }} closeOnSwipe popupClass={SHEET} backdropStyle={SCRIM}>
        <View testID={`voice-sheet-${sheet()?.kind ?? 'none'}`} class="pt-[10px] px-5 gap-[14px]" style={{ paddingBottom: insets().bottom + 12 }}>
          <Grabber />
          <View class="w-[48px] h-[48px] rounded-full bg-secondary items-center justify-center"><Icon name={content().icon} size={20} class="tint-foreground" /></View>
          <View class="gap-[6px]">
            <Text class="text-foreground text-[19px] leading-[25px] font-semibold">{content().title}</Text>
            <Text class="text-muted-foreground text-[15px] leading-[22px]">{content().body}</Text>
          </View>
          <If when={sheet()?.kind === 'download' && estimate()}><Text testID="voice-sheet-estimate" class="text-muted-foreground text-[13px]">{estimate()}</Text></If>
          <If when={sheet()?.kind === 'download' && (prepareError() || (sheet() as { provider?: VoiceProvider })?.provider?.preparation.phase === 'failed')}>
            <Text testID="voice-sheet-failed" class="text-destructive text-[13px] leading-[18px]">{prepareError() || words().prepareFailed}</Text>
          </If>
          <If when={sheet()?.kind === 'preparing'}>
            <View class="gap-[8px]">
              <Text testID="voice-sheet-step" class="text-foreground text-[14px]">{progress((sheet() as { provider: VoiceProvider }).provider).label}</Text>
              <View class="h-[6px] rounded-full bg-secondary overflow-hidden">
                <View class="h-full rounded-full bg-primary" style={{ width: `${Math.round((progress((sheet() as { provider: VoiceProvider }).provider).fraction ?? 0.08) * 100)}%` }} />
              </View>
            </View>
          </If>
          <View class="gap-[4px] pt-[4px]">{actions()}</View>
        </View>
      </Sheet>
    ),
  }
}
