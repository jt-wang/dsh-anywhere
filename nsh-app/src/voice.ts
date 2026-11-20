// Extends rc.5's speech capability; no provider credentials, Session calls or automatic send.
export interface VoiceClient { rpc<T = any>(method: string, args: Record<string, unknown>): Promise<T> }
export interface VoiceCatalog {
  maxAudioBytes: number; maxDurationSeconds: number
  selection: { providerId: string; language: string }
  providers: { id: string; location: 'host-local' | 'cloud'; languages: string[]; preparation: { phase: string } }[]
}
export interface VoiceAudio { audioBase64: string }
export type VoicePhase = 'idle' | 'checking' | 'recording' | 'transcribing'
export interface VoiceIo {
  client: () => VoiceClient
  call: <T>(method: string, args: Record<string, unknown>) => Promise<T>
  phase: (phase: VoicePhase) => void
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

let sequence = 0
/** Cancellation invalidates all late replies, including permission prompts and recognition. The shared Dsh RPC
 * cannot cancel an individual request: after upload, cancel discards its result; host work may finish (or timeout).
 * A recording is never retried, and its pinned provider/language cannot silently change mid-recording. */
export function createVoice(io: VoiceIo) {
  let generation = 0, phase: VoicePhase = 'idle', id = ''
  const set = (p: VoicePhase) => { phase = p; io.phase(p) }
  const cancel = () => {
    generation++
    if (id) void io.call('voice.cancel', { id }).catch(() => {})
    id = ''; set('idle')
  }
  return {
    cancel,
    stop: async () => {
      if (phase !== 'recording') return
      const mine = generation
      try { await io.call('voice.stop', { id }) } catch { if (mine === generation) { cancel(); io.onError('voice/recording') } }
    },
    start: async () => {
      if (phase !== 'idle') return
      const mine = ++generation
      set('checking')
      try {
        const client = io.client()
        const catalog = await client.rpc<VoiceCatalog>('speech/catalog', {})
        if (mine !== generation) return
        const limits = voiceLimits(catalog)
        // Never inherit a desktop cloud default. Catalog has no credential-readiness proof, so cloud is not
        // eligible here, even when registered. Prefer the selected local provider, else the first advertised local.
        const locals = catalog.providers.filter(p => p.location === 'host-local')
        const provider = locals.find(p => p.id === catalog.selection.providerId) ?? locals[0]
        if (!provider) throw new Error('voice/unavailable')
        const language = provider.languages.includes(catalog.selection.language) ? catalog.selection.language : 'auto'
        if (!provider.languages.includes(language)) throw new Error('voice/unavailable')
        const selection = { providerId: provider.id, language }
        if (!['ready', 'standby'].includes(provider.preparation.phase)) throw new Error('voice/not-ready')
        id = `voice-${++sequence}`
        set('recording')
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
          io.onError(message.includes('voice/permission') ? 'voice/permission' : message.startsWith('voice/') ? message : code === 'network' || code === 'timeout' || code === 'unauthorized' ? code : 'voice/transcription')
        }
      } finally { if (mine === generation) { id = ''; set('idle') } }
    },
  }
}
