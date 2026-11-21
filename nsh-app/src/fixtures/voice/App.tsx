// Synthetic audio/recognizer only. Exercises draft insertion, never microphone or a real ASR model.
// host.params.native: voice.record/stop/cancel go through host.call to the test's host handlers, as in the app.
// `fixture.set` events change the computer and the phone: { phase, catalog: 'missing' | 'offline', permission, record,
// transcribe, blocked }.
import { host, mount, signal, Text, View } from 'nsh'
import { createVoiceInput } from '../../voice.tsx'
import type { VoiceIo } from '../../voice.ts'

const params = (host.params ?? {}) as Record<string, any>
const world = signal<Record<string, any>>({ phase: 'ready', permission: 'granted', ...params })
host.on('fixture.set', (v) => world.set({ ...world(), ...(v as object) }))

function App() {
  const draft = signal('Existing draft'), disabled = signal(false)
  let complete: ((value: any) => void) | undefined, follow: ((v: unknown) => void) | undefined
  const catalog = () => ({ maxAudioBytes: 4194304, maxDurationSeconds: 120, selection: { providerId: 'local', language: 'auto' },
    providers: [{ id: 'local', name: 'SenseVoiceSmall (INT8)', location: 'host-local', languages: ['auto'],
      setupEstimate: { recommendedDiskBytes: 1e9, expectedMemoryBytes: 1e9, minimumMinutes: 1, maximumMinutes: 10 },
      preparation: world().phase === 'downloading' ? { phase: 'downloading', completedBytes: 96e6, totalBytes: 240e6, steps: [{ kind: 'check', status: 'complete' }, { kind: 'model', status: 'running' }] } : { phase: world().phase } }] })
  host.on('fixture.follow', () => follow?.(catalog()))
  const error = (code: string) => Object.assign(new Error(code), { code })
  const io: Pick<VoiceIo, 'client' | 'call'> = {
    client: () => ({
      rpc: async (name) => {
        try { host.post('fixture.rpc', { name }) } catch {}
        if (name === 'speech/catalog') {
          if (world().catalog === 'missing') throw error('http/404')
          if (world().catalog === 'offline') throw error('network')
          return catalog() as any
        }
        if (name === 'speech/prepare') { world.set({ ...world(), phase: 'downloading' }); setTimeout(() => follow?.(catalog()), 0); return null as any }
        if (world().transcribe === 'hang') return new Promise(() => {})
        if (world().transcribe) throw error(world().transcribe)
        return { text: 'Synthetic transcript' } as any
      },
      stream: (_endpoint, _args, onItem) => { follow = onItem; return () => { follow = undefined } },
    }),
    call: async (name, args) => {
      try { host.post('fixture.call', { name }) } catch {}
      if (name === 'voice.permission') return { state: world().permission } as any
      if (name === 'voice.settings') return null as any
      if (name === 'voice.record') {
        if (world().permission === 'refuse') throw new Error('voice/permission')
        if (world().record) throw new Error(world().record)
        const id = args.id
        // The microphone goes live: levels arrive, as the native recorder sends them.
        setTimeout(() => { for (const l of [0.2, 0.6, 0.9, 0.4, 0.7, 0.3, 0.8, 0.5]) voice.level({ id, level: l }) }, 0)
        return new Promise<any>(resolve => { complete = resolve })
      }
      complete?.(name === 'voice.stop' ? { audioBase64: 'AA==' } : null)
      return null as any
    },
  }
  const native = params.native === true
  const voice = createVoiceInput({ disabled, blocked: () => world().blocked, io: native ? { client: io.client } : io, onText: t => draft.set(`${draft()} ${t}`) })
  return <View class="flex-1 bg-background p-4 gap-2 justify-end pb-[40px]">
    <Text testID="voice-draft" class="text-foreground">{draft()}</Text>
    <View role="button" testID="voice-disable" onPress={() => disabled.set(!disabled())}><Text class="text-muted-foreground">Toggle disabled</Text></View>
    <View class="rounded-[16px] border border-border bg-card">
      <Text class="px-[14px] pt-[10px] pb-[6px] text-foreground text-[15px] leading-[22px]">{draft()}</Text>
      <voice.Status />
      <View class="flex-row items-center px-[6px] pb-[6px] gap-[2px] min-h-[42px]">
        <If when={voice.active()} else={<><View class="flex-1" /><voice.Button /><View class="ml-[6px] w-[32px] h-[32px] rounded-full bg-secondary" /></>}><voice.Bar /></If>
      </View>
    </View>
    <voice.Sheet />
  </View>
}
mount(App)
