// The existing current-step line only. NSH paints the sweep natively; no JS frame loop or layout animation.
import { colorScheme, Text } from 'nsh'
import { workIsCovered } from './work-cover.ts'

export function WorkingText(props: { title: () => string; active: () => boolean }) {
  const active = () => props.active() && !workIsCovered()
  return <Text testID={active() ? 'current-working-text' : undefined} shimmer={active()}
    shimmerColor={colorScheme() === 'dark' ? '#B8B8B8' : '#444444'}
    class="shrink text-muted-foreground text-[12px] leading-5 line-clamp-1">{props.title()}</Text>
}
