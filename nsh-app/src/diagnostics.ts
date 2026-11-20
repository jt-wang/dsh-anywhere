// Local opt-in metadata only. Never pass business objects, text, URLs or errors to this module.
// The journal uses its own native atomic file: writing it must not rewrite the chat cache in NSH Storage.
import { host, signal } from 'nsh'

export const CATEGORIES = ['interaction', 'performance', 'network', 'resources'] as const
export type Category = typeof CATEGORIES[number]
export interface DiagnosticPrefs { enabled: boolean; categories: Record<Category, boolean> }
export interface DiagnosticEvent { at: number; category: Category; event: string; fields: Record<string, string | number | boolean> }
const DEFAULTS: DiagnosticPrefs = { enabled: false, categories: { interaction: false, performance: false, network: false, resources: false } }
export const JOURNAL_BYTES = 131072, JOURNAL_EVENTS = 800, RETAIN_MS = 86400000
const enumValue = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v) ? v : undefined
const numeric = (v: unknown, max = 1e12) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined

/** Event-specific source allowlists, also applied when loading a journal and exporting it. No regex redaction. */
export function diagnosticEvent(category: unknown, event: unknown, input: unknown, at: number): DiagnosticEvent | undefined {
  if (!CATEGORIES.includes(category as Category) || numeric(at, 1e15) === undefined) return
  const v = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const fields: DiagnosticEvent['fields'] = {}
  const put = (key: string, value: string | number | boolean | undefined) => { if (value !== undefined) fields[key] = value }
  if (category === 'interaction' && event === 'ui.action') {
    const action = enumValue(v.action, ['menu', 'new_chat', 'settings', 'back', 'refresh'])
    if (!action) return
    fields.action = action
  } else if (category === 'interaction' && event === 'app.lifecycle') {
    const state = enumValue(v.state, ['foreground', 'background'])
    if (!state) return
    fields.state = state
  } else if (category === 'performance' && event === 'ui.callback_gap') {
    const duration = numeric(v.durationMs, 3600000)
    if (duration === undefined) return
    fields.durationMs = duration; fields.method = 'next_task_not_fps'
  } else if (category === 'network' && event === 'rpc.complete') {
    const operation = enumValue(v.operation, ['list', 'history', 'projects', 'capabilities', 'progress', 'command', 'other'])
    const outcome = enumValue(v.outcome, ['ok', 'timeout', 'unauthorized', 'http_error', 'rpc_error', 'network_error'])
    const duration = numeric(v.durationMs, 3600000)
    if (!operation || !outcome || duration === undefined) return
    fields.operation = operation; fields.outcome = outcome; fields.durationMs = duration
    put('status', numeric(v.status, 599)); put('bytesReceived', numeric(v.bytesReceived))
    if (fields.bytesReceived !== undefined) fields.bytesSource = 'content_length'
  } else if (category === 'resources' && event === 'os.snapshot') {
    put('batteryPercent', numeric(v.batteryPercent, 100))
    put('charging', enumValue(v.charging, ['charging', 'full', 'unplugged', 'unknown']))
    put('thermal', enumValue(v.thermal, ['nominal', 'fair', 'serious', 'critical', 'unknown']))
    if (typeof v.lowPower === 'boolean') fields.lowPower = v.lowPower
    if (!Object.keys(fields).length) return
  } else return
  return { at: Math.round(at), category: category as Category, event: event as string, fields }
}

interface JournalIo { read(): Promise<string | null>; write(text: string): Promise<unknown>; clear(): Promise<unknown> }
export class DiagnosticJournal {
  readonly prefs = signal<DiagnosticPrefs>(DEFAULTS)
  readonly failed = signal(false)
  readonly count = signal(0)
  private events: DiagnosticEvent[] = []
  private bytes = 2
  private active = true
  private generation = 0
  private dirty = false
  private loaded = false
  private loading: Promise<void> | undefined
  private clearing = false
  private writing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly io: JournalIo) {}

  accepts(category: Category) { return this.active && this.prefs().enabled && this.prefs().categories[category] }
  configure(value: DiagnosticPrefs) {
    this.generation++
    this.prefs.set({ enabled: value.enabled === true, categories: Object.fromEntries(CATEGORIES.map((c) => [c, value.categories[c] === true])) as Record<Category, boolean> })
    if (!value.enabled) this.flush()
  }
  foreground(active: boolean) {
    if (this.active === active) return
    if (!active) this.record('interaction', 'app.lifecycle', { state: 'background' })
    this.active = active; this.generation++
    if (active) this.record('interaction', 'app.lifecycle', { state: 'foreground' })
    if (!active) this.flush()
  }
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    return this.loading ??= this.read().finally(() => { this.loading = undefined })
  }
  private async read() {
    try {
      const text = await this.io.read()
      if (text && text.length > JOURNAL_BYTES) throw new Error('diagnostics/size')
      const saved: unknown = text ? JSON.parse(text) : []
      if (!Array.isArray(saved)) throw new Error('diagnostics/format')
      const pending = this.events
      this.events = []; this.bytes = 2
      for (const raw of saved) {
        const e = diagnosticEvent(raw?.category, raw?.event, raw?.fields, raw?.at)
        if (e) this.append(e)
      }
      for (const e of pending) this.append(e)
      this.trim(); this.count.set(this.events.length); this.loaded = true
    } catch { this.failed.set(true) }
  }
  record(category: Category, event: string, fields: unknown) {
    if (!this.accepts(category)) return
    const e = diagnosticEvent(category, event, fields, Date.now())
    if (!e) return
    this.append(e); this.trim(); this.dirty = true; this.count.set(this.events.length)
    // One pending write per burst, never a periodic collector or an unbounded queue.
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 2000)
  }
  private append(e: DiagnosticEvent) { this.events.push(e); this.bytes += JSON.stringify(e).length + 1 }
  private trim() {
    const before = Date.now() - RETAIN_MS
    while (this.events.length && (this.events.length > JOURNAL_EVENTS || this.bytes > JOURNAL_BYTES || this.events[0]!.at < before)) this.bytes -= JSON.stringify(this.events.shift()!).length + 1
  }
  flush(): Promise<unknown> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.dirty && !this.writing && !this.clearing) {
      this.writing = true
      this.dirty = false
      const text = JSON.stringify(this.events)
      this.writes = this.writes.then(() => this.io.write(text)).then(() => this.failed.set(false), () => { this.failed.set(true); this.dirty = true; this.configure({ ...this.prefs(), enabled: false }) }).finally(() => {
        this.writing = false
        if (this.dirty && !this.failed()) this.flush()
      })
    }
    return this.writes
  }
  async clear() {
    await this.load()
    clearTimeout(this.timer); this.timer = undefined; this.generation++; this.clearing = true
    this.events = []; this.bytes = 2; this.dirty = false; this.loaded = true; this.count.set(0)
    await this.writes
    try { await this.io.clear(); this.failed.set(false) } catch { this.failed.set(true); throw new Error('diagnostics/clear') }
    finally { this.clearing = false; if (this.dirty) await this.flush() }
  }
  snapshot(since: number, categories: Record<Category, boolean>) {
    this.trim()
    return this.events.filter((e) => e.at >= since && categories[e.category]).map((e) => diagnosticEvent(e.category, e.event, e.fields, e.at)!).filter(Boolean)
  }
  callback() {
    if (!this.accepts('performance')) return
    const epoch = this.generation, start = performance.now()
    setTimeout(() => { if (epoch === this.generation) this.record('performance', 'ui.callback_gap', { durationMs: performance.now() - start }) }, 0)
  }
  /** Only the fixed operation class enters the journal, never the method, URL, args, result or error. */
  request(method: string) {
    if (!this.accepts('network')) return (_outcome: string, _status?: number, _bytes?: number) => {}
    const epoch = this.generation, start = performance.now()
    const operation = method === 'session/list' ? 'list' : method === 'session/follow' ? 'history' : method.startsWith('workspaces/') ? 'projects' : method === 'capabilities' ? 'capabilities' : method.startsWith('progress/') ? 'progress' : ['session/prompt', 'session/cancel'].includes(method) ? 'command' : 'other'
    return (outcome: string, status?: number, bytesReceived?: number) => {
      if (epoch === this.generation) this.record('network', 'rpc.complete', { operation, outcome, status, bytesReceived, durationMs: performance.now() - start })
    }
  }
}

export const diagnostics = new DiagnosticJournal({
  read: () => host.call<string | null>('diagnostics.read'),
  write: (text) => host.call('diagnostics.write', { text }),
  clear: () => host.call('diagnostics.clear'),
})

export async function loadDiagnostics() {
  try {
    const raw = await host.call<string | null>('diagnostics.preferences.read')
    const v = raw ? JSON.parse(raw) : DEFAULTS
    if (v.enabled === true) await diagnostics.load()
    diagnostics.configure({ enabled: v.enabled === true, categories: Object.fromEntries(CATEGORIES.map((c) => [c, v.categories?.[c] === true])) as Record<Category, boolean> })
  } catch { diagnostics.configure({ ...diagnostics.prefs(), enabled: false }); diagnostics.failed.set(true) }
}
let preferenceGeneration = 0
export async function setDiagnostics(value: DiagnosticPrefs) {
  const generation = ++preferenceGeneration
  // Stop immediately even if persisting the opt-out fails. Start only after opt-in is durable.
  if (!value.enabled) diagnostics.configure(value)
  try {
    await diagnostics.load()
    await host.call('diagnostics.preferences.write', { text: JSON.stringify(value) })
    if (generation === preferenceGeneration) diagnostics.configure(value)
  } catch { if (generation === preferenceGeneration) { diagnostics.configure({ ...value, enabled: false }); diagnostics.failed.set(true) } }
}

/** Export exactly the selected metadata. No identifiers survive between exports; none are needed in this client. */
export function diagnosticExport(events: DiagnosticEvent[], categories: Record<Category, boolean>, info: { version: string; build: string; os?: string; deviceClass?: string; runtime?: string | null }, platform: string, from = Date.now() - RETAIN_MS, to = Date.now()) {
  const clean = events.map((e) => diagnosticEvent(e.category, e.event, e.fields, e.at)).filter((e): e is DiagnosticEvent => !!e && categories[e.category])
  const version = (v: unknown) => typeof v === 'string' && /^\d+(?:\.\d+){0,3}$/.test(v) && v.length <= 32 ? v : null
  return JSON.stringify({ schemaVersion: 1, exportId: crypto.randomUUID(), app: { version: version(info.version), build: version(info.build), platform: enumValue(platform, ['ios', 'android']) ?? 'unknown', os: version(info.os), deviceClass: enumValue(info.deviceClass, ['phone', 'tablet']) ?? 'unknown', runtime: null }, range: { from, to }, actualRange: clean.length ? { from: clean[0]!.at, to: clean.at(-1)!.at } : null, categories: CATEGORIES.filter((c) => categories[c]), events: clean })
}
