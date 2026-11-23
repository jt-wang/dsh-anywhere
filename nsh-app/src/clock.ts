// The phone's 12- or 24-hour clock, from its own settings (the shell's app.clock), for every time of day the app
// shows. Read at start and each time the app is back on screen, since it can change in the phone's settings meanwhile.
// Undefined where the shell does not say: the language's own default.
import { host, signal } from 'nsh'

export type HourCycle = 'h12' | 'h23'
export const hourCycle = signal<HourCycle | undefined>(undefined)

export function readClock() {
  host.call<{ hourCycle?: string }>('app.clock').then(
    (v) => hourCycle.set(v?.hourCycle === 'h12' || v?.hourCycle === 'h23' ? v.hourCycle : undefined), () => {})
}

/** The phone's hour cycle as Intl options, to spread into a format that shows hours. */
export const clockOptions = (): { hourCycle?: HourCycle } => { const c = hourCycle(); return c ? { hourCycle: c } : {} }

/** A time of day as DSH writes one ("09:00:00.000", "09:00") the way the phone shows it: "09:00" or "9:00 AM";
 * seconds only when they are not zero. Anything else is shown as it came. */
export function timeOfDay(time: string, locale: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(time)
  if (!m) return time
  const seconds = Number(m[3] ?? 0)
  return new Date(2000, 0, 1, Number(m[1]), Number(m[2]), seconds)
    .toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), ...clockOptions() })
}
