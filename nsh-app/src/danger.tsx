// The confirmation for an action that cuts phones off (Computer settings' danger zone, Unlink, Tailcat only) or that
// DSH itself guards (Full access): what happens, then a second step before the red button works. As iOS Settings'
// "Erase All Content" and GitHub's "type the name to confirm" do, the second step is typing a word; DSH's Full access
// keeps its own acknowledge switch (dsh-client-ui-permission-presets PermissionRow.tsx).
import { locale, signal, Text, View } from 'nsh'
import { Input, Switch } from 'nsh/base'
import { BottomSheet, Grabber, haptic, sheetBottom } from './ui.tsx'
import { language } from './strings.ts'
import { computerStrings } from './computer-settings-strings.ts'
import { fill } from './plugins-strings.ts'

export interface Danger {
  title: string
  body: string
  /** The red button: names the action and what it costs ("Turn off DSH Anywhere and disconnect"). */
  action: string
  /** The second step: type this word, or turn on DSH's acknowledgement. */
  confirm: { word: string } | { ack: string }
}
interface Asked extends Danger { resolve: (yes: boolean) => void }
const asked = signal<Asked | undefined>(undefined)
const open = signal(false)
const typed = signal('')
const acked = signal(false)

/** Resolves true only after both steps: the sheet's consequence read, then the word typed or the risk acknowledged. */
export function confirmDanger(d: Danger): Promise<boolean> {
  asked()?.resolve(false)
  typed.set(''); acked.set(false)
  return new Promise((resolve) => { asked.set({ ...d, resolve }); open.set(true) })
}

const words = () => computerStrings(language() === 'system' ? locale() : language())
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Where `confirmDanger` shows its sheet: once, at the app's root. */
export function DangerSheetHost() {
  const d = () => asked()
  const ready = () => { const c = d()?.confirm; return !!c && ('word' in c ? same(typed(), c.word) : acked()) }
  const answer = (yes: boolean) => { const a = d(); if (!a) return; a.resolve(yes); asked.set({ ...a, resolve: () => {} }); open.set(false); typed.set('') }
  return (
    <BottomSheet open={open()} onOpenChange={(e) => { if (!e.open) answer(false) }} onClose={() => asked.set(undefined)}>
      <View testID="danger-sheet" class="px-5 pt-3 gap-3" style={{ paddingBottom: sheetBottom() }}>
        <Grabber />
        <Text testID="danger-title" class="text-foreground text-[17px] leading-[22px] font-semibold">{d()?.title}</Text>
        <Text testID="danger-body" class="text-muted-foreground text-[14px] leading-[20px]">{d()?.body}</Text>
        <If when={d() && 'word' in d()!.confirm} else={
          <View class="flex-row items-center gap-3 py-1">
            <Text class="flex-1 text-foreground text-[15px] leading-[20px]">{(d()?.confirm as { ack?: string } | undefined)?.ack}</Text>
            <Switch testID="danger-ack" accessibilityLabel={(d()?.confirm as { ack?: string } | undefined)?.ack ?? ''} checked={acked()} onChange={(e) => acked.set(e.checked)}
              class="w-[46px] h-[28px]" trackClass="w-full h-full rounded-full bg-input checked:bg-destructive justify-center px-[3px] transition-colors duration-150"
              thumbClass="w-[22px] h-[22px] rounded-full bg-background shadow-sm checked:translate-x-[18px] transition-transform duration-150" />
          </View>
        }>
          <View class="gap-2">
            <Text class="text-foreground text-[14px]">{fill(words().typeToConfirm, { word: (d()?.confirm as { word?: string } | undefined)?.word ?? '' })}</Text>
            <Input testID="danger-word" accessibilityLabel={fill(words().typeToConfirm, { word: (d()?.confirm as { word?: string } | undefined)?.word ?? '' })} value={typed()} onChange={(e) => typed.set(e.value)}
              autoCapitalize="none" autoCorrect={false} returnKeyType="done" placeholder={(d()?.confirm as { word?: string } | undefined)?.word ?? ''}
              class="rounded-[10px] bg-secondary px-3 py-[10px] text-foreground text-[15px] placeholder:text-muted-foreground" />
          </View>
        </If>
        <View role="button" testID="danger-confirm" accessibilityLabel={d()?.action ?? ''} accessibilityState={{ disabled: !ready() }}
          onPress={() => { if (!ready()) return; haptic('confirm'); answer(true) }}
          class={`rounded-[12px] h-[48px] justify-center items-center ${ready() ? 'bg-destructive active:opacity-80' : 'bg-secondary'}`}>
          <Text class={`text-[15px] font-semibold ${ready() ? 'text-white' : 'text-muted-foreground'}`}>{d()?.action}</Text>
        </View>
        <View role="button" testID="danger-cancel" onPress={() => answer(false)} class="h-[44px] justify-center items-center mb-1 active:opacity-60">
          <Text class="text-foreground text-[15px]">{words().cancel}</Text>
        </View>
      </View>
    </BottomSheet>
  )
}
