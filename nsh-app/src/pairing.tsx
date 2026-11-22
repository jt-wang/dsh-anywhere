import { Keyboard, signal, Text, View } from 'nsh'
import { Input } from 'nsh/base'
import { linking, pairEmoji } from './state.ts'
import { S } from './strings.ts'

export function PairEmoji() {
  return (
    <If when={pairEmoji().length > 0}>
      <View testID="pair-emoji" class="items-center gap-2 py-2">
        <Text class="text-[34px] leading-[44px] tracking-[6px]">{pairEmoji().join(' ')}</Text>
        <Text class="text-muted-foreground text-[13px] leading-[18px] text-center">{S.pairEmoji}</Text>
      </View>
    </If>
  )
}

export function PastePairingCode(props: { pair: (text: string) => void; scanning?: boolean }) {
  const pasting = signal(false)
  const code = signal('')
  const focused = signal(false)
  const ready = () => !!code().trim() && !linking() && !props.scanning
  const link = () => { if (ready()) { Keyboard.dismiss(); props.pair(code().trim()) } }
  return (
    <If when={pasting()} else={
      <View role="button" testID="paste" onPress={() => pasting.set(true)} class="py-3 items-center active:opacity-60"><Text class="text-muted-foreground text-[15px]">{S.paste}</Text></View>
    }>
      <View class="gap-3">
        <Input testID="code" placeholder="dshm1:…" value={code()} onChange={(e) => code.set(e.value)} autoCapitalize="none" autoCorrect={false} submitBehavior="submit"
          onSubmit={link} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
          class={`rounded-[10px] border ${focused() ? 'border-ring' : 'border-input'} bg-card px-3 py-3 text-foreground caret-foreground placeholder:text-muted-foreground font-mono text-[13px]`} />
        <View role="button" testID="link-code" accessibilityLabel={S.linkCode} onPress={link}
          class={`rounded-[10px] border border-border py-3 items-center ${ready() ? 'active:bg-secondary' : 'opacity-50'}`}>
          <Text class="text-foreground text-[15px] font-medium">{linking() ? S.linking : S.linkCode}</Text>
        </View>
      </View>
    </If>
  )
}
