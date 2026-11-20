// Synthetic audio/recognizer only. Exercises draft insertion, never microphone or a real ASR model.
import { mount, signal, Text, View } from 'nsh'
import { VoiceInput } from '../voice.tsx'
import type { VoiceIo } from '../voice.ts'

function App() {
  const draft = signal('Existing draft'), error = signal(''), disabled = signal(false), mode = signal('ok')
  let complete: ((value: any) => void) | undefined
  const io: Pick<VoiceIo, 'client' | 'call'> = {
    client: () => ({ rpc: async (name) => (name === 'speech/catalog'
      ? { maxAudioBytes: 4194304, maxDurationSeconds: 120, selection: { providerId: 'local', language: 'auto' }, providers: [{ id: 'local', location: 'host-local', languages: ['auto'], preparation: { phase: 'ready' } }] }
      : { text: 'Synthetic transcript' }) as any }),
    call: async (name) => {
      if (name === 'voice.record') {
        if (mode() === 'denied') throw new Error('voice/permission')
        return new Promise<any>(resolve => { complete = resolve })
      }
      complete?.(name === 'voice.stop' ? { audioBase64: 'AA==' } : null)
      return null as any
    },
  }
  return <View class="flex-1 bg-background p-4 gap-2">
    <Text testID="voice-draft">{draft()}</Text><Text testID="voice-error">{error()}</Text>
    <View role="button" testID="voice-disable" onPress={() => disabled.set(!disabled())}><Text>Toggle disabled</Text></View>
    <View role="button" testID="voice-denied" onPress={() => mode.set('denied')}><Text>Deny permission</Text></View>
    <VoiceInput disabled={disabled()} io={io} onText={t => draft.set(`${draft()} ${t}`)} onError={e => error.set(e)} />
  </View>
}
mount(App)
