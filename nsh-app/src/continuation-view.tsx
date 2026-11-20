import { Text, View } from 'nsh'
import type { ContinuationView as State } from './continuation.ts'
import { C } from './continuation-strings.ts'

/** Rendered immediately under the latest failed turn, never as a human message. */
export function ContinuationView(props: { state: () => State; blocked: () => 'offline' | 'draft' | undefined; send: () => void; refresh: () => void }) {
  const status = () => props.state().status
  const action = () => status() === 'ready' || status() === 'unconfirmed'
  const refreshable = () => ['unknown', 'unavailable', 'unsupported'].includes(status())
  return <View testID="continuation" class="gap-2 pt-3">
    <If when={props.blocked() || status() !== 'ready'}><Text testID="continuation-status" class="text-muted-foreground text-[13px] leading-5">{props.blocked() ? C[props.blocked()!] : C[status()]}</Text></If>
    <If when={!props.blocked() && (action() || refreshable())}>
      <View role="button" testID={action() ? 'continue-generation' : 'continuation-refresh'} accessibilityLabel={status() === 'unconfirmed' ? C.retry : action() ? C.ready : C.refresh}
        onPress={() => { if (!props.blocked()) action() ? props.send() : props.refresh() }} class="self-start rounded-[10px] border border-border bg-secondary px-3 py-3 active:opacity-60">
        <Text class="text-foreground text-[14px] font-medium">{status() === 'unconfirmed' ? C.retry : action() ? C.ready : C.refresh}</Text>
      </View>
    </If>
  </View>
}
