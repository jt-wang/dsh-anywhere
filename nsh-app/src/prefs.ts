// The phone's own settings (Settings page): appearance, language and which news it tells. Kept on the phone in
// Storage under one key and applied at launch; DSH's own settings stay on the computer.
import { host, setColorScheme, signal, Storage } from 'nsh'
import { language, type Language } from './strings.ts'
import { DEFAULT_WORKSPACE_VIEW, workspaceViewOf, type WorkspaceViewPrefs } from './workspace-settings-view.ts'

export type Theme = 'system' | 'light' | 'dark'
/** `answers`: an answer is ready or a turn stopped; `decisions`: the agent waits on the person; `banners`: news of
 * another chat while the app is open; `background`: the shell keeps watching running agents while the app is away. */
export interface NotifyPrefs { answers: boolean; decisions: boolean; banners: boolean; background: boolean }
/** `synced`: the language was handed to Android's per-app language once, so from then on that setting speaks for it. */
export interface Prefs { theme: Theme; language: Language; notify: NotifyPrefs; workspaceView: WorkspaceViewPrefs; synced: boolean }

const KEY = 'prefs'
const THEMES: readonly Theme[] = ['system', 'light', 'dark']
const LANGUAGES: readonly Language[] = ['system', 'zh', 'zh-Hant', 'en', 'es', 'fr', 'ko', 'ja', 'ru']
const DEFAULT_NOTIFY: NotifyPrefs = { answers: true, decisions: true, banners: true, background: true }

/** What was kept, field by field: a value that is not one of the choices is the default. */
export function prefsOf(raw: string | null): Prefs {
  let v: Record<string, any> = {}
  try { const o = raw ? JSON.parse(raw) : {}; if (o && typeof o === 'object') v = o } catch {}
  const n = v.notify && typeof v.notify === 'object' ? v.notify : {}
  const notify = Object.fromEntries(Object.entries(DEFAULT_NOTIFY).map(([k, d]) => [k, typeof n[k] === 'boolean' ? n[k] : d])) as unknown as NotifyPrefs
  return { theme: THEMES.includes(v.theme) ? v.theme : 'system', language: LANGUAGES.includes(v.language) ? v.language : 'system', notify, workspaceView: workspaceViewOf(v.workspaceView), synced: v.synced === true }
}

export const theme = signal<Theme>('system')
export const notifyPrefs = signal<NotifyPrefs>(DEFAULT_NOTIFY)
export const workspaceView = signal<WorkspaceViewPrefs>(DEFAULT_WORKSPACE_VIEW)
let currentWorkspaceOrders: Record<string, string[]> = {}
/** Current complete accounts include hidden archives, so filters never erase their manual slots. */
export function rememberWorkspaceOrders(orders: Record<string, string[]>) { currentWorkspaceOrders = orders }
export function setWorkspaceView(change: Partial<WorkspaceViewPrefs>) {
  const previous = workspaceView()
  const sessionOrderByAccount = change.orderBy && change.orderBy !== previous.orderBy
    ? change.orderBy === 'manual' ? currentWorkspaceOrders : {}
    : previous.sessionOrderByAccount
  workspaceView.set(workspaceViewOf({ ...previous, sessionOrderByAccount, ...change })); save()
}
export function syncWorkspaceOrders(orders: Record<string, string[]>) {
  rememberWorkspaceOrders(orders)
  if (workspaceView().orderBy === 'manual' && JSON.stringify(workspaceView().sessionOrderByAccount) !== JSON.stringify(orders)) setWorkspaceView({ sessionOrderByAccount: orders })
}
export function moveLocalSession(account: string, id: string, before?: string) {
  const members = currentWorkspaceOrders[account] ?? []
  if (!members.includes(id) || before === id || (before !== undefined && !members.includes(before))) return
  const order = members.filter(member => member !== id)
  order.splice(before === undefined ? order.length : order.indexOf(before), 0, id)
  setWorkspaceView({ orderBy: 'manual', sessionOrderByAccount: { ...currentWorkspaceOrders, [account]: order } })
}

/** The tag the strings follow: the picked language, else the phone's. */
export const tagFor = (choice: Language, system: string) => (choice === 'system' ? system : choice === 'zh' ? 'zh-Hans' : choice)

/** A language tag's choice: Taiwan, Hong Kong and Macau write Traditional Chinese; '' is the phone's own. */
export function choiceOf(tag: string): Language | undefined {
  const t = tag.replace(/_/g, '-').toLowerCase()
  if (!t) return 'system'
  if (t.startsWith('zh')) return /hant|tw|hk|mo/.test(t) ? 'zh-Hant' : 'zh'
  const base = t.split('-')[0] as Language
  return base !== 'system' && LANGUAGES.includes(base) ? base : undefined
}

// Android 13+ has a per-app language in the phone's settings (res/xml/locales_config.xml): it and the choice here are
// one setting. The phone's answer wins once the two were synced; before that (a first launch, or an app older than
// this), the choice here is handed over. `app.language` is Android's; elsewhere the call fails and nothing changes.
let synced = false
const handOver = (l: Language) => host.call<{ supported?: boolean; tag?: string }>('app.language', { tag: l === 'system' ? '' : tagFor(l, '') })
async function followSystemLanguage() {
  let r: { supported?: boolean; tag?: string } | undefined
  try { r = await host.call('app.language', {}) } catch { return }
  if (!r?.supported) return
  const theirs = choiceOf(r.tag ?? '')
  if (synced && theirs && theirs !== language()) { language.set(theirs); save() }
  else if (!synced || theirs !== language()) { try { await handOver(language()); synced = true; save() } catch {} }
}

const save = () => { Storage.setItem(KEY, JSON.stringify({ theme: theme(), language: language(), notify: notifyPrefs(), workspaceView: workspaceView(), synced })).catch(() => {}) }
export function setTheme(t: Theme) { theme.set(t); setColorScheme(t); save() }
export function setLanguage(l: Language) { language.set(l); save(); if (synced) handOver(l).catch(() => {}) }
export function setNotify(change: Partial<NotifyPrefs>) { notifyPrefs.set({ ...notifyPrefs(), ...change }); save() }

/** Reads what was kept and applies it (the appearance at once; the strings follow `language`). */
export async function loadPrefs() {
  let raw: string | null = null
  try { raw = await Storage.getItem(KEY) } catch {}
  const p = prefsOf(raw)
  theme.set(p.theme); language.set(p.language); notifyPrefs.set(p.notify)
  workspaceView.set(p.workspaceView); synced = p.synced
  if (p.theme !== 'system') setColorScheme(p.theme)
  void followSystemLanguage()
  // The per-app language is changed in the phone's settings, away from the app: coming back reads it again.
  try { host.on('app.state', (v) => { if ((v as { active?: boolean } | undefined)?.active !== false) void followSystemLanguage() }) } catch {}
}

/** Whether a piece of news is told there: its kind left on, and banners left on for a banner. */
export function allowsNotice(p: NotifyPrefs, kind: 'answer' | 'failed' | 'decision', place: 'banner' | 'system'): boolean {
  if (!(kind === 'decision' ? p.decisions : p.answers)) return false
  return place !== 'banner' || p.banners
}
