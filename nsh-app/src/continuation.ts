// Manual generation continuation extends DSH's conversationContinuation projection, not a local failure taxonomy.
// Only rc.5 has been exercised here. Never probe an unknown host with an empty prompt.
export interface ContinuationClient {
  computer(): Promise<{ dshVersion: string }>
  rpc<T = any>(method: string, args: Record<string, unknown>): Promise<T>
}
export type ContinuationStatus = 'loading' | 'ready' | 'unsupported' | 'unknown' | 'unavailable' | 'sending' | 'queued' | 'unconfirmed'
export interface ContinuationView { status: ContinuationStatus; requestId?: string }
export const continuationSeq = (v: unknown): number | null | undefined => v === null ? null : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0) ? v : undefined
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined

/** Exact authoritative reads only. A migration cache and a truthy object are not capabilities. */
export function continuationAvailable(projection: unknown, state: unknown, ending: number): boolean {
  const p = object(projection), s = object(state), inbox = object(p?.values?.inbox)
  return p?.kind === 'sequenced' && continuationSeq(p.values?.conversationContinuation) === ending
    && Number.isSafeInteger(p.asOfSeq) && p.asOfSeq >= ending
    && s?.running === false && Number.isSafeInteger(s.cursor) && s.cursor >= ending
    && Array.isArray(inbox?.['next-turn']) && inbox['next-turn'].length === 0
    && Array.isArray(inbox?.['next-step']) && !inbox['next-step'].some((m: unknown) => object(object(m)?.source)?.kind === 'user')
}

let sequence = 0
export function continuationRequestId(): string { return `phone-continue-${Date.now().toString(36)}-${sequence++}` }

/** One screen-owned outbox item. No timers or automatic writes. An unclear response retains its requestId;
 * only an explicit tap may resend it, after fresh authoritative reads. Durable retry receipts settle it even
 * if the HTTP response failed. This is request correlation, not an exactly-once execution claim. */
export class Continuation {
  view: ContinuationView = { status: 'loading' }
  private revision = 0
  private disposed = false
  private inFlight = false
  private pending: { id: string; ending: number; state: 'sending' | 'queued' | 'unconfirmed' } | undefined
  constructor(private client: ContinuationClient, private sessionId: string, private changed: (v: ContinuationView) => void) {}
  private show(status: ContinuationStatus) { if (!this.disposed) { this.view = { status, ...(this.pending ? { requestId: this.pending.id } : {}) }; this.changed(this.view) } }
  invalidate() { this.revision++; this.show(this.pending?.state ?? 'loading') }
  dispose() { this.disposed = true; this.revision++ }
  receipt(rpcId: string | undefined) {
    if (rpcId && rpcId === this.pending?.id) { this.pending = undefined; this.revision++; this.show('unavailable') }
  }
  private async check(ending: number): Promise<ContinuationStatus> {
    const { dshVersion } = await this.client.computer()
    if (dshVersion !== '0.2.2-rc.5') return /^(0\.2\.[01](?:-rc\.\d+|-alpha\.\d+)?|0\.2\.2-rc\.[0-4])$/.test(dshVersion) ? 'unsupported' : 'unknown'
    const [projection, state] = await Promise.all([
      this.client.rpc('session/projections', { request: { sessionId: this.sessionId } }),
      this.client.rpc('session/state', { request: { sessionId: this.sessionId } }),
    ])
    if (object(projection)?.kind !== 'sequenced' || continuationSeq(object(projection)?.values?.conversationContinuation) === undefined) return 'unknown'
    return continuationAvailable(projection, state, ending) ? 'ready' : 'unavailable'
  }
  async refresh(ending: number) {
    const revision = ++this.revision
    this.show(this.pending?.state ?? 'loading')
    try {
      const status = await this.check(ending)
      if (!this.disposed && revision === this.revision) this.show(this.pending?.state ?? status)
    } catch { if (!this.disposed && revision === this.revision) this.show(this.pending?.state ?? 'unknown') }
  }
  async send(ending: number, allowed: () => boolean, id = continuationRequestId): Promise<void> {
    if (this.disposed || this.inFlight || !allowed() || this.pending?.state === 'queued') return
    if (this.pending && this.pending.ending !== ending) return // unresolved old delivery must not become a new request
    this.inFlight = true
    const revision = ++this.revision
    this.show('loading')
    try {
      const status = await this.check(ending)
      if (this.disposed || revision !== this.revision || !allowed()) return
      if (status !== 'ready') { this.show(this.pending?.state ?? status); return }
      this.pending ??= { id: id(), ending, state: 'sending' }
      const request = this.pending
      request.state = 'sending'; this.show('sending')
      try {
        const result = await this.client.rpc('session/prompt', { request: { requestId: request.id, sessionId: this.sessionId, mode: 'queue', content: [] } })
        if (this.pending !== request) return
        request.state = result?.accepted === true ? 'queued' : 'unconfirmed'
      } catch { if (this.pending === request) request.state = 'unconfirmed' }
      if (this.pending === request) this.show(request.state)
    } catch { this.show(this.pending?.state ?? 'unknown') }
    finally { this.inFlight = false }
  }
}
