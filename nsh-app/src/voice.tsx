import { cleanup, effect, host, locale, signal, Text, View } from 'nsh'
import { language } from './strings.ts'
import { dsh } from './state.ts'
import { createVoice, type VoiceIo, type VoicePhase } from './voice.ts'
import { voicePolicy, voiceStrings } from './voice-strings.ts'

/** onText appends to the CURRENT draft; never wire it to send. Mount per chat (unmount cancels late replies).
 * `io` is only for deterministic component tests; production uses the paired Dsh and native microphone. */
export function VoiceInput(props: { disabled: boolean; onText: (text: string) => void; onError: (message: string) => void; io?: Pick<VoiceIo, 'client' | 'call'> }) {
  const phase = signal<VoicePhase>('idle')
  const words = () => voiceStrings(language() === 'system' ? locale() : language())
  const voice = createVoice({ client: props.io?.client ?? dsh, call: props.io?.call ?? ((name, args) => host.call(name, args)), phase: p => phase.set(p),
    onText: text => { if (!props.disabled) props.onText(text) },
    onError: code => { const w = words(); props.onError(code === 'voice/permission' ? w.permission : code === 'voice/unavailable' ? `${w.unavailable} ${voicePolicy(language() === 'system' ? locale() : language())}` : code === 'voice/not-ready' ? w.notReady : code === 'voice/empty' ? w.empty : w.failed) },
  })
  effect(() => { if (props.disabled) voice.cancel() })
  cleanup(voice.cancel)
  try { cleanup(host.on('app.state', (v) => { if ((v as { active?: boolean })?.active === false) voice.cancel() })) } catch {}
  return <View testID="voice-input" class="gap-1">
    <If when={phase() === 'idle'} else={<View class="gap-1">
      <Text class="text-[12px] text-muted-foreground">{voicePolicy(language() === 'system' ? locale() : language())}</Text>
      <Text class="text-[12px] text-muted-foreground">{phase() === 'checking' ? words().checking : phase() === 'recording' ? words().recording : words().transcribing}</Text>
      <If when={phase() === 'recording'}><View role="button" testID="voice-stop" accessibilityLabel={words().stop} onPress={() => void voice.stop()} class="min-h-[44px] justify-center px-2"><Text class="text-foreground">{words().stop}</Text></View></If>
      <View role="button" testID="voice-cancel" accessibilityLabel={words().cancel} onPress={voice.cancel} class="min-h-[44px] justify-center px-2"><Text class="text-foreground">{words().cancel}</Text></View>
    </View>}>
      <View role="button" testID="voice-start" accessibilityLabel={words().start} accessibilityState={{ disabled: props.disabled }} onPress={() => { if (!props.disabled) void voice.start() }} class={`min-h-[44px] justify-center px-2 ${props.disabled ? 'opacity-40' : ''}`}><Text class="text-foreground">{words().start}</Text></View>
    </If>
  </View>
}
