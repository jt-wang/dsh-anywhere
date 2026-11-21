import { expect, test } from 'nsh/test'
import { createVoice, voiceLimits, type VoiceCatalog } from './voice.ts'
import { voicePolicy, voiceStrings } from './voice-strings.ts'

const catalog = (): VoiceCatalog => ({ maxAudioBytes: 4194304, maxDurationSeconds: 120, selection: { providerId: 'local', language: 'auto' }, providers: [{ id: 'local', location: 'host-local', languages: ['auto'], preparation: { phase: 'ready' } }] })
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve } }
const tick = async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }
function setup(options: { catalog?: VoiceCatalog; audio?: any; reply?: any; error?: string; code?: string } = {}) {
  const calls: any[] = [], texts: string[] = [], errors: string[] = [], phases: string[] = [], sheets: any[] = []
  const audio = deferred()
  const voice = createVoice({
    client: () => ({ rpc: async (name, args) => { calls.push([name, args]); if (name === 'speech/catalog') return (options.catalog ?? catalog()) as any; if (options.error) throw Object.assign(new Error(options.error), { code: options.code }); return (options.reply ?? { text: 'editable transcript' }) as any } }),
    call: async (name, args) => { if (name === 'voice.permission') return { state: 'granted' } as any; calls.push([name, args]); if (name === 'voice.record') return options.audio === undefined ? audio.promise : options.audio; if (name === 'voice.stop') audio.resolve({ audioBase64: 'UklGRg==' }); if (name === 'voice.cancel') audio.resolve(null); return null as any },
    phase: p => phases.push(p), sheet: v => sheets.push(v?.kind), onText: t => texts.push(t), onError: e => errors.push(e),
  })
  return { voice, calls, texts, errors, phases, audio, sheets }
}

test('voice uses official speech args, stops, and only returns editable draft text', async () => {
  const s = setup(), started = s.voice.start()
  await tick(); await s.voice.stop(); await started
  expect(s.calls.map(c => c[0])).toEqual(['speech/catalog', 'voice.record', 'voice.stop', 'speech/transcribe'])
  expect(s.calls[3][1]).toEqual({ request: { audioBase64: 'UklGRg==', providerId: 'local', language: 'auto' } })
  expect(s.texts).toEqual(['editable transcript'])
  expect(s.phases).toEqual(['checking', 'requesting', 'transcribing', 'idle'])
  expect(s.errors).toEqual([])
})

test('voice clamps duration and bytes to host limits and phone ceiling', () => {
  expect(voiceLimits(catalog())).toEqual({ maxAudioBytes: 1920044, maxDurationSeconds: 60 })
  expect(voiceLimits({ ...catalog(), maxAudioBytes: 32045, maxDurationSeconds: 7 }).maxDurationSeconds).toBe(1)
  expect(voiceLimits({ ...catalog(), maxDurationSeconds: 0.5 }).maxDurationSeconds).toBe(0.5)
})

test('voice does not inherit desktop cloud default or infer cloud credential readiness', async () => {
  const c = catalog(); c.selection.providerId = 'cloud'
  c.providers.unshift({ id: 'cloud', location: 'cloud', languages: ['auto'], preparation: { phase: 'ready' } })
  const s = setup({ catalog: c, audio: { audioBase64: 'AA==' } }); await s.voice.start()
  expect(s.calls[2][1].request.providerId).toBe('local')
  const cloudOnly = setup({ catalog: { ...c, providers: c.providers.slice(0, 1) } }); await cloudOnly.voice.start()
  expect(cloudOnly.calls.length).toBe(1)
  expect(cloudOnly.sheets).toEqual(['cloud']); expect(cloudOnly.errors).toEqual([])
})

test('voice explains an unprepared or preparing model before microphone permission', async () => {
  for (const [phase, sheet] of [['unprepared', 'download'], ['failed', 'download'], ['downloading', 'preparing'], ['loading', 'preparing']]) {
    const c = catalog(); c.providers[0].preparation.phase = phase
    const s = setup({ catalog: c }); await s.voice.start()
    expect(s.calls.length).toBe(1); expect(s.sheets).toEqual([sheet]); expect(s.errors).toEqual([])
  }
  // A plugin that is off answers 404; a computer out of reach does not answer at all.
  const off = createVoice({ client: () => ({ rpc: async () => { throw Object.assign(new Error('HTTP 404'), { code: 'http/404' }) } }), call: async () => null as any,
    phase: () => {}, sheet: v => sheets.push(v?.kind), onText: () => {}, onError: () => {} })
  const sheets: any[] = []; await off.start(); expect(sheets).toEqual(['missing'])
})

test('voice cancellation during capture drops audio and never uploads', async () => {
  const s = setup(), started = s.voice.start(); await tick(); s.voice.cancel(); await started
  expect(s.calls.map(c => c[0])).toEqual(['speech/catalog', 'voice.record', 'voice.cancel'])
  expect(s.texts).toEqual([]); expect(s.errors).toEqual([])
})

test('voice double start never opens two microphones', async () => {
  const s = setup(), started = s.voice.start(); await s.voice.start(); await tick(); s.voice.cancel(); await started
  expect(s.calls.filter(c => c[0] === 'voice.record').length).toBe(1)
})

test('voice rejects oversize audio, reports empty transcription and never overwrites draft on failure', async () => {
  const c = { ...catalog(), maxAudioBytes: 46 }
  const large = setup({ catalog: c, audio: { audioBase64: 'A'.repeat(65) } }); await large.voice.start()
  expect(large.errors).toEqual(['voice/limits']); expect(large.calls.length).toBe(2)
  const empty = setup({ audio: { audioBase64: 'AA==' }, reply: { text: '  ' } }); await empty.voice.start()
  expect(empty.errors).toEqual(['voice/empty']); expect(empty.texts).toEqual([])
  const failed = setup({ audio: { audioBase64: 'AA==' }, error: 'synthetic failure', code: 'speech/transcription-failed' }); await failed.voice.start()
  expect(failed.errors).toEqual(['voice/transcription']); expect(failed.calls.length).toBe(3); expect(failed.texts).toEqual([])
  // Each failure names its side: the computer not answering is not the recognizer failing.
  const late = setup({ audio: { audioBase64: 'AA==' }, error: 'The computer did not answer', code: 'timeout' }); await late.voice.start()
  expect(late.errors).toEqual(['voice/offline'])
  const busy = setup({ audio: Promise.reject(new Error('voice/microphone')) }); await busy.voice.start()
  expect(busy.errors).toEqual(['voice/microphone']); expect(busy.calls.length).toBe(2)
})

test('voice permission denial never uploads; cancel discards late recognition result', async () => {
  const calls: string[] = [], errors: string[] = [], texts: string[] = [], recognition = deferred()
  let deny = true
  const v = createVoice({ client: () => ({ rpc: async (name) => { calls.push(name); return name === 'speech/catalog' ? catalog() as any : recognition.promise } }),
    call: async (name) => { if (name === 'voice.permission') return { state: 'granted' } as any; if (deny) throw new Error('native: voice/permission'); return { audioBase64: 'AA==' } as any },
    phase: () => {}, sheet: v => sheets.push(v?.kind), onText: t => texts.push(t), onError: e => errors.push(e) })
  const sheets: any[] = []
  await v.start(); expect(sheets).toEqual([undefined, 'denied']); expect(errors).toEqual([]); expect(calls).toEqual(['speech/catalog'])
  deny = false; const started = v.start(); await tick(); v.cancel(); recognition.resolve({ text: 'must not insert' }); await started
  expect(texts).toEqual([])
})

test('voice ignores a cancelled take’s late stop error after a new recording starts', async () => {
  const records = new Map<string, ReturnType<typeof deferred>>(), late = deferred(), errors: string[] = []
  let phase = ''
  const voice = createVoice({ client: () => ({ rpc: async () => catalog() as any }),
    call: async (name, args) => {
      const id = args.id as string
      if (name === 'voice.permission') return { state: 'granted' } as any
      if (name === 'voice.record') { const d = deferred(); records.set(id, d); return d.promise }
      if (name === 'voice.stop') { await late.promise; throw new Error('stale native error') }
      records.get(id)?.resolve(null); return null as any
    }, phase: p => { phase = p }, sheet: () => {}, onText: () => {}, onError: e => errors.push(e) })
  const first = voice.start(); await tick(); const stop = voice.stop(); voice.cancel(); await first
  const second = voice.start(); await tick(); late.resolve(null); await stop
  expect(phase).toBe('requesting'); expect(errors).toEqual([])
  voice.cancel(); await second
})

test('voice words cover eight languages with English fallback', () => {
  const en = voiceStrings('en')
  for (const l of ['zh-CN', 'zh-TW', 'es', 'fr', 'ko', 'ja', 'ru']) {
    const w = voiceStrings(l); expect(Object.keys(w)).toEqual(Object.keys(en)); expect(w.start === en.start).toBe(false)
    for (const v of Object.values(w)) expect(typeof v === 'string' && v.length > 0).toBe(true)
    expect(voicePolicy(l) === voicePolicy('en')).toBe(false)
  }
  expect(voiceStrings('de-DE')).toEqual(en); expect(voiceStrings('zh_HK')).toEqual(voiceStrings('zh-Hant'))
  expect(voicePolicy('de-DE')).toBe(voicePolicy('en'))
})
