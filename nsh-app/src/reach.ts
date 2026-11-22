// Why the phone can't reach the computer, read from which part answers: TailPocket's lastFailure (how the last attempt
// to reach the computer ended, over every route), DSH's own link.diagnose (the Tailcat relay and the computer), then the
// companion itself. A computer that is off and one that no longer allows this phone look the same to Tailcat: it gives
// a client it does not allow no reply (tailcat v0.6.0), so 'computer' says both.
// lastFailure is not authenticated (anything on the network can refuse a connection or pose as the relay, TailPocket
// SECURITY.md §6b): its causes only choose the words. Nothing here, or anything that reads a Cause, may unpair the
// phone, forget the link or start a pairing; pairing again stays a button the person presses.
import type { ConnectionState } from './dsh.ts'

/** TailPocket's reason for the last failed attempt (connectmobile LastFailure, through link.lastFailure). */
export type Failure = 'refused' | 'handshake-closed' | 'no-answer' | 'relay-down'
export type Cause = 'connected' | 'slow' | 'trying' | 'no-network' | 'blocked' | 'computer' | 'companion' | 'refused'
  | 'not-running' | 'no-answer' | 'relay-down'
export interface Check { relay?: 'reachable' | 'unreachable'; computer?: 'reachable' | 'unreachable'; access?: 'ok' | 'refused' | 'failed'; latencyMs?: number; failure?: Failure }

/** An answer slower than this reads as a slow connection. The first answer on a fresh connection takes several round trips. */
export const SLOW_MS = 2000

export const failureOf = (reason: unknown): Failure | undefined =>
  reason === 'refused' || reason === 'handshake-closed' || reason === 'no-answer' || reason === 'relay-down' ? reason : undefined

export function causeOf(s: { connection: ConnectionState; network: boolean; check?: Check }): Cause {
  const c = s.check
  if (!s.network) return 'no-network'
  if (c?.access === 'refused') return 'refused' // the companion itself, over the pinned TLS, said this phone is not allowed
  if (s.connection === 'online') return (c?.latencyMs ?? 0) >= SLOW_MS ? 'slow' : 'connected'
  // Something answered for the computer and did not take the phone, or only the relay answered: TailPocket knows best.
  if (c?.failure === 'refused' || c?.failure === 'handshake-closed') return 'not-running'
  if (c?.failure === 'relay-down') return 'relay-down'
  if (c?.relay === 'unreachable') return 'blocked' // nothing answered, and this network can't reach a relay either
  if (c?.failure === 'no-answer') return 'no-answer'
  if (c?.computer === 'unreachable') return 'computer'
  if (c?.access === 'failed') return 'companion'
  return 'trying'
}

/** Whether a cause offers pairing again: only as a button the person presses, keeping the link until a new one works. */
export const offersPairAgain = (cause: Cause) => cause === 'refused' || cause === 'not-running' || cause === 'computer' || cause === 'no-answer'

/** What each part answered, for the sheet's rows, from the cause: a part is "not working" (false) only where the cause
 * says that part did not answer, "OK" (true) only where it answered, and "not known" (undefined) behind the first part
 * that did not answer (with the relay down, nothing is known of the computer). */
export interface Parts { phone: boolean; relay?: boolean; computer?: boolean; pairing?: boolean }
export function partsOf(cause: Cause, check: Check | undefined): Parts {
  switch (cause) {
    case 'no-network': return { phone: false }
    case 'connected': case 'slow': return { phone: true, relay: true, computer: true, pairing: true }
    case 'blocked': case 'relay-down': return { phone: true, relay: false }
    case 'computer': case 'no-answer': case 'not-running': return { phone: true, relay: check?.relay === 'reachable' ? true : undefined, computer: false }
    case 'companion': return { phone: true, relay: true, computer: true }
    case 'refused': return { phone: true, relay: true, computer: true, pairing: false }
    case 'trying': return { phone: true, ...(check?.relay === 'reachable' ? { relay: true } : {}), ...(check?.computer === 'reachable' ? { computer: true } : {}) }
  }
}
