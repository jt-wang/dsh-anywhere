// The person's messages in the chat: a bubble, and while one is on its way, where it is (outbox.ts says which:
// sending, delivered, queued, or not sent and why). Once a turn starts and before its first step shows, a row says
// the agent is on it, so a quiet screen is not mistaken for a lost message.
import { cleanup, createMotion, Image, signal, Text, View } from 'nsh'
import { outgoingStatus, type Outgoing } from './outbox.ts'
import { Icon, IconButton } from './ui.tsx'
import { S } from './strings.ts'
import { rise } from './motion.ts'
import { messageMenu } from './copy.tsx'
import { WorkingText } from './working.tsx'

export function Bubble(props: { text: string; dim?: boolean }) {
  return (
    <View testID="bubble" onLongPress={() => messageMenu(props.text)} class={`max-w-[88%] bg-secondary rounded-[18px] rounded-br-[5px] px-[14px] py-[11px] transition-opacity duration-200 ${props.dim ? 'opacity-60' : 'opacity-100'}`}>
      <Text class="text-foreground text-[15px] leading-[22px]">{props.text}</Text>
    </View>
  )
}

/** A message on its way: shown at once, dimmed, with where it is; a failed one says why and sends again on a press. */
export function OutgoingView(props: { message: () => Outgoing; busy: () => boolean; retry: () => void; discard?: () => void }) {
  const o = props.message
  const photos = () => o().drafts.filter((d) => d.kind === 'image' && d.preview)
  const files = () => o().drafts.filter((d) => d.kind === 'file')
  const m = createMotion({ enter: rise })
  // The words change with time (still sending; delivered but not started): look again every second.
  const now = signal(Date.now())
  const tick = setInterval(() => now.set(Date.now()), 1000)
  cleanup(() => clearInterval(tick))
  const status = () => outgoingStatus(o(), props.busy(), now())
  return (
    <View class="items-end gap-[4px]" testID={`outgoing-${o().state}`} style={m.style}>
      <If when={photos().length || files().length}>
        <View class="flex-row flex-wrap justify-end gap-2 max-w-[85%] opacity-60">
          {photos().map((d) => <Image src={(d as { preview: string }).preview} class="w-[120px] h-[120px] rounded-[12px] object-cover" />)}
          {files().map((d) => <View class="flex-row items-center gap-[6px] rounded-[12px] border border-border bg-card px-[10px] h-[38px]"><Icon name="file" size={15} /><Text class="text-foreground text-[13px] line-clamp-1 max-w-[200px]">{d.name}</Text></View>)}
        </View>
      </If>
      <If when={o().text}><Bubble text={o().text} dim /></If>
      <If when={status().failed} else={
        <Text testID="outgoing-status" class="text-muted-foreground text-[12px] leading-4 pr-1 text-right max-w-[85%]">{status().text}</Text>
      }>
        <View class="flex-row items-center gap-4 max-w-[85%]">
          <View role="button" testID="retry" onPress={props.retry} hitSlop={8} class="shrink items-end justify-center min-h-[44px] gap-[2px] pr-1 active:opacity-60">
            <Text class="text-destructive text-[12px] leading-4">{status().text}</Text>
            <If when={status().reason}><Text testID="not-sent-reason" class="text-muted-foreground text-[12px] leading-4 text-right">{status().reason}</Text></If>
          </View>
          <If when={props.discard}><IconButton name="x" label={S.remove} testID="discard-outgoing" onPress={() => props.discard?.()} size={14} class="w-[44px] h-[44px]" iconClass="tint-muted-foreground" /></If>
        </View>
      </If>
    </View>
  )
}

/** The agent has started on the message and no step shows yet: what it is on (fold.ts `liveText`). */
export function WorkingRow(props: { title: () => string; active?: () => boolean }) {
  return (
    <View testID="working" class="flex-row items-center py-[2px]">
      <WorkingText title={props.title} active={() => props.active?.() ?? false} />
    </View>
  )
}
