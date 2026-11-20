import { mount, signal, Text, View } from 'nsh'
import type { Dsh } from '../dsh.ts'
import { SpeechSettings, type SpeechCatalog } from '../speech-settings.tsx'

function App() {
  let listener: ((value: unknown) => void) | undefined
  const trace = signal(''), lost = signal(false)
  const catalog: SpeechCatalog = {
    maxAudioBytes: 4194304, maxDurationSeconds: 120,
    selection: { providerId: 'local', language: 'auto' },
    providers: [{ id: 'local', name: 'SenseVoice · synthetic state', location: 'host-local', languages: ['auto', 'en', 'zh'], downloadSources: ['https://huggingface.co', 'https://hf-mirror.com'], preparation: { phase: 'unprepared' } }],
  }
  const client: Pick<Dsh, 'rpc' | 'stream'> = {
    stream: (_method, _args, receive) => { listener = receive; return () => { listener = undefined } },
    rpc: async <T,>(method: string, args: any) => {
      if (method === 'speech/catalog') return JSON.parse(JSON.stringify(catalog)) as T
      trace.set(`${trace()}${method}:${JSON.stringify(args)}\n`)
      if (method === 'speech/configure') Object.assign(catalog.selection, args.patch)
      else if (method === 'speech/prepare') catalog.providers[0].preparation = { phase: 'downloading', completedBytes: 120000000, totalBytes: 241357257 }
      else if (method === 'speech/cancelPreparation') catalog.providers[0].preparation = { phase: 'cancelled' }
      listener?.(JSON.parse(JSON.stringify(catalog)))
      if (lost()) throw new Error('Synthetic lost acknowledgement')
      return null as T
    },
  }
  return <View class="flex-1 bg-background p-4 pt-[env(safe-area-inset-top)] gap-2">
    <View role="button" testID="speech-lost" onPress={() => lost.set(!lost())}><Text>Toggle lost acknowledgement</Text></View>
    <SpeechSettings client={() => client} />
    <Text testID="speech-trace" class="text-muted-foreground text-[11px]">{trace()}</Text>
  </View>
}
mount(App)
