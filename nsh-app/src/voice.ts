// Extends rc.5's speech capability; no provider credentials, Session calls or automatic send.
export interface VoiceClient {
  rpc<T = any>(method: string, args: Record<string, unknown>): Promise<T>
  stream?(endpoint: string, args: unknown, onItem: (v: unknown) => void, onError?: (e: unknown) => void): () => void
}
export interface VoiceProvider {
  id: string; name?: string; location: 'host-local' | 'cloud'; languages: string[]
  setupEstimate?: { recommendedDiskBytes: number; minimumMinutes: number; maximumMinutes: number }
  preparation: { phase: string; completedBytes?: number; totalBytes?: number; message?: string; steps?: { kind: string; status: string }[] }
}
export interface VoiceCatalog {
  maxAudioBytes: number; maxDurationSeconds: number
  selection: { providerId: string; language: string }
  providers: VoiceProvider[]
}
export interface VoiceAudio { audioBase64: string }
/** checking: reading the computer; requesting: the microphone is being opened (or the system asks); recording: the
 * first level arrived; transcribing: the take is on the computer. */
export type VoicePhase = 'idle' | 'checking' | 'requesting' | 'recording' | 'transcribing'
/** What a tap on the microphone explains instead of recording (src/voice-design.md). */
export type VoiceSheet =
  | { kind: 'sample' | 'offline' | 'missing' | 'cloud' | 'primer' | 'denied' }
  | { kind: 'download' | 'preparing' | 'ready'; provider: VoiceProvider }
export interface VoiceIo {
  client: () => VoiceClient
  call: <T>(method: string, args: Record<string, unknown>) => Promise<T>
  phase: (phase: VoicePhase) => void
  /** A take went live: when, and its longest length in seconds. */
  live?: (at: number, seconds: number) => void
  level?: (level: number) => void
  sheet: (sheet: VoiceSheet | undefined) => void
  onText: (text: string) => void
  onError: (code: string) => void
}

/** Clamp to a phone-side memory/privacy ceiling, even if the host advertises larger limits. */
export function voiceLimits(c: VoiceCatalog) {
  if (!Number.isFinite(c.maxAudioBytes) || !Number.isFinite(c.maxDurationSeconds) || c.maxAudioBytes < 46 || c.maxDurationSeconds <= 0) throw new Error('voice/limits')
  const maxAudioBytes = Math.min(1_920_044, Math.floor(c.maxAudioBytes))
  const maxDurationSeconds = Math.min(60, c.maxDurationSeconds, Math.floor((maxAudioBytes - 44) / 2) / 16000)
  if (maxDurationSeconds < 1 / 16000) throw new Error('voice/limits')
  return { maxAudioBytes, maxDurationSeconds }
}

const READY = ['ready', 'standby', 'waking']
/** The local provider the phone records for, and whether it can transcribe now. Never a desktop cloud default: the
 * catalog cannot prove its credentials, so cloud is not eligible even when registered and selected. */
export function voiceReadiness(c: VoiceCatalog): { provider: VoiceProvider; state: 'ready' | 'download' | 'preparing' } | { state: 'cloud' | 'missing' } {
  const locals = c.providers.filter(p => p.location === 'host-local')
  const provider = locals.find(p => p.id === c.selection.providerId) ?? locals[0]
  if (!provider) return { state: c.providers.length ? 'cloud' : 'missing' }
  const phase = provider.preparation.phase
  return { provider, state: READY.includes(phase) ? 'ready' : ['unprepared', 'cancelled', 'failed'].includes(phase) ? 'download' : 'preparing' }
}

/** A catalog read that failed: the Voice input plugin is off (or DSH predates it), or the computer is out of reach. */
const unreachable = (e: unknown): 'missing' | 'offline' => {
  const code = String((e as { code?: string })?.code ?? '')
  return code === 'http/404' || /not[-_ ]?found/i.test(code) || /not found/i.test(String((e as { message?: string })?.message ?? '')) ? 'missing' : 'offline'
}

let sequence = 0
/** Cancellation invalidates all late replies, including permission prompts and recognition. The shared Dsh RPC
 * cannot cancel an individual request: after upload, cancel discards its result; host work may finish (or timeout).
 * A recording is never retried, and its pinned provider/language cannot silently change mid-recording. */
export function createVoice(io: VoiceIo) {
  let generation = 0, phase: VoicePhase = 'idle', id = ''
  const set = (p: VoicePhase) => { phase = p; io.phase(p) }
  let limit = 60
  const cancel = () => {
    generation++
    if (id) void io.call('voice.cancel', { id }).catch(() => {})
    id = ''; set('idle')
  }
  const permission = async () => {
    try { return (await io.call<{ state?: string }>('voice.permission', {}))?.state ?? 'unknown' } catch { return 'unknown' }
  }
  return {
    cancel,
    /** A `voice.level` event from the native recorder: the first one says the microphone is live. */
    level: (data: unknown) => {
      const d = data as { id?: unknown; level?: unknown } | undefined
      if (!id || d?.id !== id || typeof d.level !== 'number' || (phase !== 'requesting' && phase !== 'recording')) return
      if (phase === 'requesting') { set('recording'); io.live?.(Date.now(), limit) }
      io.level?.(Math.max(0, Math.min(1, d.level)))
    },
    stop: async () => {
      if (phase !== 'recording' && phase !== 'requesting') return
      const mine = generation
      try { await io.call('voice.stop', { id }) } catch { if (mine === generation) { cancel(); io.onError('voice/recording') } }
    },
    /** `primed`: the person read the explanation and asked to continue to the system's microphone prompt. */
    start: async (options: { primed?: boolean } = {}) => {
      if (phase !== 'idle') return
      const mine = ++generation
      set('checking')
      try {
        const client = io.client()
        let catalog: VoiceCatalog
        try { catalog = await client.rpc<VoiceCatalog>('speech/catalog', {}) }
        catch (e) { if (mine === generation) io.sheet({ kind: unreachable(e) }); return }
        if (mine !== generation) return
        const limits = voiceLimits(catalog)
        const ready = voiceReadiness(catalog)
        if (!('provider' in ready)) { io.sheet({ kind: ready.state }); return }
        if (ready.state !== 'ready') { io.sheet({ kind: ready.state, provider: ready.provider }); return }
        const language = ready.provider.languages.includes(catalog.selection.language) ? catalog.selection.language : 'auto'
        if (!ready.provider.languages.includes(language)) { io.sheet({ kind: 'cloud' }); return }
        const selection = { providerId: ready.provider.id, language }
        const allowed = await permission()
        if (mine !== generation) return
        if (allowed === 'denied') { io.sheet({ kind: 'denied' }); return }
        if (allowed === 'undetermined' && !options.primed) { io.sheet({ kind: 'primer' }); return }
        io.sheet(undefined)
        id = `voice-${++sequence}`; limit = limits.maxDurationSeconds
        set('requesting')
        const audio = await io.call<VoiceAudio | null>('voice.record', { id, ...limits })
        if (mine !== generation || !audio) return
        if (typeof audio.audioBase64 !== 'string' || !audio.audioBase64.length || audio.audioBase64.length > Math.ceil(limits.maxAudioBytes / 3) * 4) throw new Error('voice/limits')
        set('transcribing')
        const transcript = await client.rpc<{ text: string }>('speech/transcribe', { request: { audioBase64: audio.audioBase64, ...selection } })
        if (mine !== generation) return
        if (typeof transcript?.text !== 'string') throw new Error('voice/transcription')
        if (transcript.text.trim()) io.onText(transcript.text)
        else io.onError('voice/empty')
      } catch (e) {
        if (mine === generation) {
          const message = String((e as { message?: string })?.message ?? e)
          const code = (e as { code?: string })?.code
          // The system's prompt answered no: say how to turn it on, not that something failed.
          if (message.includes('voice/permission')) io.sheet({ kind: 'denied' })
          // DSH's own speech errors (speech/invalid-audio, speech/transcription-failed) mean the computer got the take.
          else io.onError(message.match(/voice\/[a-z-]+/)?.[0]
            ?? (code === 'network' || code === 'timeout' || code?.startsWith('http/') ? 'voice/offline'
              : code?.startsWith('speech/') ? 'voice/transcription' : 'voice/failed'))
        }
      } finally { if (mine === generation) { id = ''; set('idle') } }
    },
  }
}
