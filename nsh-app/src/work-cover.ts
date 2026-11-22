// Local modal surfaces can cover a chat without changing its navigation route. Event-driven, never a frame loop.
import { cleanup, effect, signal, untracked } from 'nsh'

const covers = new Set<symbol>()
const covered = signal(false)
export const workIsCovered = () => covered()

/** Owned by the surface, so closing one nested sheet cannot resume work behind another. */
export function coverWorkingText(visible: () => boolean) {
  const token = Symbol()
  const update = (on: boolean) => {
    if (on) covers.add(token)
    else covers.delete(token)
    covered.set(covers.size > 0)
  }
  effect(() => { const on = visible(); untracked(() => update(on)) })
  cleanup(() => update(false))
}
