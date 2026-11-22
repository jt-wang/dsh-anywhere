// Settings › Computer settings: DSH Desktop's settings on the phone, in DSH Desktop's own order and groups (Settings:
// General, Models, Agent presets, Account; the Plugins page: the plugin list and its built-in plugin pages), one row per
// group with what it is set to, each opening a page of native controls. Read automatically from one store
// (computer-settings.ts); every change goes through DSH's own calls and is read back. At the bottom, the danger zone:
// what disconnects every phone, each behind two confirmations (danger.tsx). A phone that may only read sees no controls.
import { cleanup, effect, locale, Scroll, signal, Text, View, type JSX } from 'nsh'
import { Input, NumberInput, Switch } from 'nsh/base'
import { language } from './strings.ts'
import { chooseAction, haptic, Icon, type IconName } from './ui.tsx'
import { confirmDanger } from './danger.tsx'
import { fill, reasonOf, pluginStrings } from './plugins-strings.ts'
import { computerStrings, DSH_LANGUAGES, type ComputerWords } from './computer-settings-strings.ts'
import { BUILT_IN, current, GENERAL, nsOf, pluginForms, SELF, updateTarget, valueAt, type ComputerStore, type FieldSpec, type VersionList } from './computer-settings.ts'
import { settingFields, type Json, type SettingsNamespace } from './desktop-settings.ts'
import { outcomeOf, type Change } from './plugins.ts'
import { PluginsPage } from './plugins.tsx'
import { ProviderSettings } from './provider-settings.tsx'
import { HostSettings } from './host-settings.tsx'
import { WorkspaceSettings } from './workspace-settings.tsx'
import { SpeechSettings } from './speech-settings.tsx'
import { CapabilitySettings } from './capability-settings.tsx'
import type { Dsh } from './dsh.ts'

const lang = () => (language() === 'system' ? locale() : language())
const W = () => computerStrings(lang())

export type ComputerPageId = 'general' | 'models' | 'presets' | 'account' | 'workspaces' | 'inventory' | 'plugins' | 'subagent' | 'web' | 'loop' | 'shell' | 'cua' | 'voice' | 'other'
export const pageTitle = (id: ComputerPageId) => W()[id]

const SWITCH = {
  class: 'w-[46px] h-[28px] disabled:opacity-50',
  trackClass: 'w-full h-full rounded-full bg-input checked:bg-primary justify-center px-[3px] transition-colors duration-150',
  thumbClass: 'w-[22px] h-[22px] rounded-full bg-background shadow-sm checked:translate-x-[18px] transition-transform duration-150',
}
function Label(props: { text: string; hint?: string }) {
  return <View class="px-2 pt-5 pb-[6px] gap-[2px]">
    <Text class="text-muted-foreground text-[13px] font-medium">{props.text}</Text>
    <If when={props.hint}><Text class="text-muted-foreground text-[12px] leading-[16px]">{props.hint}</Text></If>
  </View>
}
function Group(props: { children?: JSX.Element | JSX.Element[] }) { return <View class="rounded-[14px] bg-card border border-border overflow-hidden">{props.children}</View> }
function Line(props: { first?: boolean; children?: JSX.Element | JSX.Element[] }) { return <View class={`px-[14px] py-[11px] gap-[2px] ${props.first ? '' : 'border-t border-border'}`}>{props.children}</View> }

/** One group on the list: its icon, its name, what it is set to; opens its page. */
function GroupRow(props: { id: string; icon: IconName; title: string; sub: () => string; first?: boolean; onPress: () => void }) {
  return (
    <View role="button" testID={`computer-${props.id}`} accessibilityLabel={`${props.title}, ${props.sub()}`} onPress={props.onPress}
      class={`flex-row items-center gap-3 pl-[14px] pr-[10px] py-[10px] active:bg-secondary ${props.first ? '' : 'border-t border-border'}`}>
      <View class="w-[30px] h-[30px] rounded-[8px] bg-secondary items-center justify-center"><Icon name={props.icon} size={18} class="tint-foreground" /></View>
      <View class="flex-1 gap-[1px]">
        <Text class="text-foreground text-[15px]">{props.title}</Text>
        <Text testID={`computer-${props.id}-sub`} class="text-muted-foreground text-[13px] leading-[18px] line-clamp-1">{props.sub()}</Text>
      </View>
      <Icon name="chevronRight" size={18} class="tint-muted-foreground" />
    </View>
  )
}

/** How reading the computer went, the same on every page: reading, why it failed (with Try again), or only viewing. */
export function LoadState(props: { store: ComputerStore }) {
  const s = props.store, kind = () => s.config().kind
  return <>
    <If when={kind() === 'loading'}><Text testID="computer-loading" class="px-2 pt-5 text-muted-foreground text-[15px]">{W().loading}</Text></If>
    <If when={kind() === 'failed' || kind() === 'unsupported' || kind() === 'forbidden'}>
      <View testID={`computer-${kind()}`} class="mt-5 rounded-[14px] bg-card border border-border px-[14px] py-3 gap-3">
        <Text class="text-foreground text-[15px] leading-[21px]">{kind() === 'unsupported' ? W().unsupported : kind() === 'forbidden' ? W().readOnly : W().failed}</Text>
        <If when={kind() === 'failed'}>
          <View role="button" testID="computer-retry" onPress={() => s.ensure()} class="self-start rounded-full bg-primary px-4 h-[36px] justify-center active:opacity-80"><Text class="text-primary-foreground text-[14px] font-medium">{W().retry}</Text></View>
        </If>
      </View>
    </If>
    <If when={kind() === 'ready' && !s.control()}>
      <View testID="computer-read-only" class="mt-3 flex-row gap-2 rounded-[12px] bg-secondary px-3 py-[10px]">
        <Icon name="info" size={16} class="tint-muted-foreground" />
        <Text class="flex-1 text-foreground text-[13px] leading-[18px]">{W().readOnly}</Text>
      </View>
    </If>
  </>
}

type Outcome = 'saved' | 'uncertain' | 'conflict' | 'rejected'
const said = (o: Outcome | '') => (o === 'uncertain' ? W().uncertain : o === 'conflict' ? W().conflict : o === 'rejected' ? W().rejected : '')

/** A choice shown as DSH Desktop names it. */
type Choices = { value: string; label: string }[]
/** One setting as a native control: a switch, a choice opening a sheet, a number with steps, or text with Save. It
 * writes the exact path DSH serves and shows the computer's answer; a phone that may only read sees it dimmed. */
function Field(props: {
  store: ComputerStore; ns: () => SettingsNamespace | undefined; path: string[]; control: FieldSpec['control']; value: () => Json | undefined
  label: string; hint?: string; first?: boolean; choices?: () => Choices; testID: string
  /** A choice DSH guards (Full access): the confirmation to pass first. */
  guard?: (value: string) => Promise<boolean>
}) {
  const s = props.store, outcome = signal<Outcome | ''>('')
  const disabled = () => !s.writable() || s.busy()
  const save = async (value: Json | undefined) => {
    const n = props.ns(); if (!n || disabled()) return
    outcome.set('')
    const r = await s.save(n.ns, value === undefined ? { op: 'unset', path: props.path } : { op: 'set', path: props.path, value })
    haptic(r === 'saved' ? 'confirm' : 'reject')
    outcome.set(r === 'saved' ? '' : r)
  }
  const choices = () => props.choices?.() ?? (props.control.kind === 'choice' ? props.control.options.map(v => ({ value: v, label: v })) : [])
  const chosen = () => { const v = props.value(); return choices().find(c => c.value === (v === undefined || v === null ? '' : String(v)))?.label ?? String(v ?? '') }
  const choose = async () => {
    if (disabled()) return
    const id = await chooseAction({ title: props.label, actions: choices().map((c, i) => ({ id: String(i), label: c.label, checked: chosen() === c.label })) })
    const c = id === undefined ? undefined : choices()[Number(id)]
    if (!c || c.label === chosen()) return
    if (props.guard && !(await props.guard(c.value))) return
    await save(c.value === '' ? undefined : c.value)
  }
  // Number and text: a draft the person edits, saved on Return, on leaving the field, or (steps) a moment after.
  const scale = props.control.kind === 'number' ? props.control.scale ?? 1 : 1
  const text = () => { const v = props.value(); return v === undefined || v === null ? '' : scale === 1 ? String(v) : String(Math.round(Number(v) / scale * 10) / 10) }
  const draft = signal(text()), focused = signal(false)
  effect(() => { const t = text(); if (!focused()) draft.set(t) })
  let timer: ReturnType<typeof setTimeout> | undefined
  cleanup(() => clearTimeout(timer))
  const commit = () => { clearTimeout(timer); if (draft() === text()) return; void save(props.control.kind === 'number' ? Math.round(Number(draft()) * scale) : draft().trim()) }
  const Message = () => <If when={outcome()}><Text testID={`${props.testID}-outcome`} class="pt-1 text-destructive text-[13px] leading-[18px]">{said(outcome())}</Text></If>
  const head = <View class="flex-1 gap-[2px]">
    <Text class="text-foreground text-[15px]">{props.label}</Text>
    <If when={props.hint}><Text class="text-muted-foreground text-[13px] leading-[18px]">{props.hint}</Text></If>
  </View>
  if (props.control.kind === 'switch') return <Line first={props.first}>
    <View class="flex-row items-center gap-3">{head}
      <Switch testID={props.testID} accessibilityLabel={props.label} checked={props.value() === true} disabled={disabled()} onChange={(e) => void save(e.checked)} {...SWITCH} />
    </View><Message />
  </Line>
  if (props.control.kind === 'choice') return <View role="button" testID={props.testID} accessibilityLabel={`${props.label}, ${chosen()}`} accessibilityState={{ disabled: disabled() }} onPress={() => void choose()}
    class={`px-[14px] py-[11px] ${props.first ? '' : 'border-t border-border'} ${disabled() ? '' : 'active:bg-secondary'}`}>
    <View class="flex-row items-center gap-3">{head}
      <Text testID={`${props.testID}-value`} class={`text-muted-foreground text-[15px] text-right shrink ${disabled() ? 'opacity-60' : ''}`}>{chosen()}</Text>
      <If when={!disabled()}><Icon name="chevronDown" size={16} class="tint-muted-foreground" /></If>
    </View><Message />
  </View>
  const c = props.control
  return <Line first={props.first}>
    <View class="flex-row items-center gap-3">{head}
      <If when={c.kind === 'number'} else={
        <Input testID={props.testID} accessibilityLabel={props.label} value={draft()} disabled={disabled()} placeholder={W().fontDefault} returnKeyType="done"
          onChange={(e) => draft.set(e.value)} onFocus={() => focused.set(true)} onBlur={() => { focused.set(false); commit() }} onSubmit={commit} autoCapitalize="none" autoCorrect={false}
          class="w-[150px] min-h-[36px] rounded-[8px] bg-secondary px-[10px] text-foreground text-[15px] text-right placeholder:text-muted-foreground disabled:opacity-60" />
      }>
        <NumberInput testID={props.testID} accessibilityLabel={props.label} value={draft() === '' ? null : Number(draft())} disabled={disabled()}
          min={c.kind === 'number' ? c.min : undefined} max={c.kind === 'number' ? c.max : undefined} step={c.kind === 'number' ? c.step ?? 1 : 1}
          onChange={(e) => { draft.set(e.value === null ? '' : String(e.value)); clearTimeout(timer); if (!focused()) timer = setTimeout(commit, 700) }}
          onFocus={() => focused.set(true)} onBlur={() => { focused.set(false); commit() }} onSubmit={commit}
          class={`flex-row items-center rounded-[8px] bg-secondary h-[36px] disabled:opacity-60 ${c.kind === 'number' && c.unit ? 'w-[150px] justify-between' : ''}`} inputClass={`${c.kind === 'number' && c.unit ? 'w-[52px] text-right pr-[4px]' : 'w-[64px] text-center'} text-foreground text-[15px]`}
          decrementButtonClass="w-[34px] h-[36px] items-center justify-center active:opacity-60 disabled:opacity-30" incrementButtonClass="w-[34px] h-[36px] items-center justify-center active:opacity-60 disabled:opacity-30"
          decrementButton={<Text class="text-foreground text-[18px]">−</Text>} incrementButton={<Text class="text-foreground text-[18px]">+</Text>}
          suffix={c.kind === 'number' && c.unit ? <Text testID={`${props.testID}-unit`} class="text-muted-foreground text-[15px] pr-1">{W()[c.unit]}</Text> : undefined} />
      </If>
    </View>
    <If when={c.kind === 'text' && focused()}><Text class="pt-1 text-muted-foreground text-[12px] leading-[16px]">{W().fontHint}</Text></If>
    <Message />
  </Line>
}

/** A field at DSH's own key, labelled from the copy table. Not rendered when the computer has no such setting. */
function Known(props: { store: ComputerStore; spec: FieldSpec; label: keyof ComputerWords; hint?: keyof ComputerWords; first?: boolean; choices?: () => Choices; guard?: (v: string) => Promise<boolean> }) {
  const ns = () => nsOf(props.store, props.spec)
  return <If when={ns()}>
    <Field store={props.store} ns={ns} path={props.spec.path} control={props.spec.control} value={() => current(props.store, props.spec)} first={props.first}
      label={W()[props.label]} hint={props.hint ? W()[props.hint] : undefined} choices={props.choices} guard={props.guard} testID={`field-${props.spec.id}`} />
  </If>
}

/** A row DSH Desktop keeps to itself: shown, marked "Only on the computer", with why. */
function OnlyOnComputer(props: { id: string; title: string; why: string; first?: boolean }) {
  return <Line first={props.first}>
    <View testID={`computer-only-${props.id}`} class="flex-row items-center gap-3">
      <Text class="flex-1 text-foreground text-[15px]">{props.title}</Text>
      <Text class="text-muted-foreground text-[13px]">{W().onlyComputer}</Text>
    </View>
    <Text class="text-muted-foreground text-[13px] leading-[18px]">{props.why}</Text>
  </Line>
}

/** DSH's permission presets, by the names DSH Desktop gives the built-in three (dsh-client-ui-permission-presets presentation.ts). */
const FULL_ACCESS = 'danger-full-access'
const presetName = (value: string, name: string) => {
  const own: Record<string, keyof ComputerWords> = { 'read-only': 'readOnlyPreset', 'workspace-write': 'workspaceWrite', [FULL_ACCESS]: 'fullAccess' }
  const english: Record<string, string> = { 'read-only': 'Read Only', 'workspace-write': 'Workspace Write', [FULL_ACCESS]: 'Full access' }
  const k = own[value]
  if (k && (name === value || name === english[value])) return W()[k]
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? name.split('-').map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ') : name
}
const PERMISSION: FieldSpec = { id: 'permission', ns: ['permission'], path: ['defaultPreset'], control: { kind: 'choice', options: [] } }
const permissionChoices = (s: ComputerStore): Choices => (s.catalog()?.defaultOptions ?? []).map(o => ({ value: o.value, label: presetName(o.value, o.name) }))
const permissionNow = (s: ComputerStore) => { const v = valueAt(s.namespace('permission'), ['defaultPreset']); return typeof v === 'string' ? v : s.catalog()?.defaultPreset }
const fullAccess = (v: string) => v !== FULL_ACCESS ? Promise.resolve(true) : confirmDanger({ title: W().fullTitle, body: W().fullBody, action: W().fullEnable, confirm: { ack: W().fullAck } })

const languageChoices = (): Choices => [{ value: '', label: W().languageSystem }, ...Object.entries(DSH_LANGUAGES).map(([value, label]) => ({ value, label }))]
const languageNow = (s: ComputerStore) => { const v = current(s, GENERAL.look[0]!); return typeof v === 'string' && v ? (v.split('-')[0]!.toLowerCase()) : '' }
const appearanceChoices = (): Choices => [{ value: 'light', label: W().light }, { value: 'dark', label: W().dark }, { value: 'system', label: W().system }]

function GeneralPage(props: { store: ComputerStore }) {
  const s = props.store, [busyEnter] = GENERAL.sessions, [lang_, appearance, fontSize, codeSize, termSize, textFont, codeFont, termFont, coding] = GENERAL.look, [sessionLog] = GENERAL.privacy
  return <>
    <Label text={W().sessions} />
    <Group>
      <If when={s.namespace('permission')}>
        <Field store={s} ns={() => s.namespace('permission')} path={PERMISSION.path} control={PERMISSION.control} value={() => permissionNow(s)} first
          label={W().permission} hint={W().permissionHint} choices={() => permissionChoices(s)} guard={fullAccess} testID="field-permission" />
      </If>
      <Known store={s} spec={busyEnter!} label="busyEnter" first={!s.namespace('permission')} choices={() => [{ value: 'queue', label: W().queue }, { value: 'steer', label: W().steer }]} />
    </Group>
    <Label text={W().look} hint={W().sharedHint} />
    <Group>
      <If when={nsOf(s, lang_!)}>
        <Field store={s} ns={() => nsOf(s, lang_!)} path={lang_!.path} control={lang_!.control} value={() => languageNow(s)} first label={W().language} choices={languageChoices} testID="field-language" />
      </If>
      <Known store={s} spec={appearance!} label="appearance" choices={appearanceChoices} />
      <Known store={s} spec={fontSize!} label="fontSize" />
      <Known store={s} spec={codeSize!} label="codeFontSize" />
      <Known store={s} spec={termSize!} label="terminalFontSize" />
      <Known store={s} spec={textFont!} label="textFont" />
      <Known store={s} spec={codeFont!} label="codeFont" />
      <Known store={s} spec={termFont!} label="terminalFont" />
      <Known store={s} spec={coding!} label="codingView" hint="codingViewHint" />
    </Group>
    <If when={nsOf(s, sessionLog!)}>
      <Label text={W().privacy} />
      <Group><Known store={s} spec={sessionLog!} label="sessionLog" hint="sessionLogHint" first /></Group>
    </If>
    <Label text={W().computerOnly} />
    <Group>
      <OnlyOnComputer id="shortcuts" first title={W().shortcuts} why={W().shortcutsWhy} />
      <OnlyOnComputer id="channel" title={W().channel} why={W().channelWhy} />
      <OnlyOnComputer id="restart" title={W().restart} why={W().restartWhy} />
    </Group>
    <If when={s.info()?.dshVersion}>
      <Label text={W().about} />
      <Group><Line first><View class="flex-row items-center gap-3"><Text class="flex-1 text-foreground text-[15px]">{W().version}</Text><Text testID="computer-dsh-version" class="text-muted-foreground text-[15px]">{s.info()?.dshVersion}</Text></View></Line></Group>
    </If>
  </>
}

const BUILT_IN_LABELS: Record<string, [keyof ComputerWords, (keyof ComputerWords)?]> = {
  maxDepth: ['maxDepth', 'maxDepthHint'], maxActive: ['maxActive'], modelChoice: ['modelChoice', 'modelChoiceHint'],
  searchCount: ['searchCount'], maxUses: ['maxUses'], parallel: ['parallel'], timeout: ['timeout'], maxOutput: ['maxOutput'],
}
/** A Built-in plugin settings page (Subagent, Web search and fetch, Agent loop, Shell): the fields DSH Desktop's page edits. */
function BuiltInPage(props: { store: ComputerStore; id: keyof typeof BUILT_IN }) {
  const s = props.store, specs = BUILT_IN[props.id], here = () => specs.filter(x => nsOf(s, x))
  return <If when={here().length} else={<If when={s.config().kind === 'ready' && props.id !== 'web'}><Missing /></If>}>
    <View class="pt-5"><Group>
      {specs.map((spec) => <Known store={s} spec={spec} label={BUILT_IN_LABELS[spec.id]![0]} hint={BUILT_IN_LABELS[spec.id]![1]} first={here()[0]?.id === spec.id} />)}
    </Group></View>
  </If>
}
function Missing() {
  return <View testID="computer-missing" class="mt-5 rounded-[14px] bg-card border border-border px-[14px] py-3 gap-1">
    <Text class="text-foreground text-[15px] font-medium">{W().missing}</Text>
    <Text class="text-muted-foreground text-[13px] leading-[18px]">{W().missingBody}</Text>
  </View>
}

/** A label for a plugin's own key: its words ("maxRetries" → "Max retries"). */
const words = (key: string) => { const t = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1) }
/** Settings plugins declare for themselves (their volatile Config fields, as settings/describe serves them). */
function OtherPage(props: { store: ComputerStore }) {
  const s = props.store
  const forms = () => { const c = s.config(); return pluginForms(c.kind === 'ready' ? c.value : undefined) }
  return <>
    <Text class="px-2 pt-3 text-muted-foreground text-[13px] leading-[18px]">{W().otherHint}</Text>
    <Each of={forms()} key={n => n.ns}>{n => {
      const fields = () => settingFields(n()).filter(x => !x.add && !x.secret && x.path.length > 0)
      return <>
        <Label text={words(n().ns)} />
        <Group>{fields().map((x, i) => <Field store={s} ns={() => s.namespace(n().ns)} path={x.path} first={i === 0} testID={`field-${n().ns}-${x.path.join('.')}`}
          control={x.type === 'boolean' ? { kind: 'switch' } : x.type === 'choice' ? { kind: 'choice', options: x.choices.map(String) } : x.type === 'number' ? { kind: 'number' } : { kind: 'text' }}
          value={() => valueAt(s.namespace(n().ns), x.path)} label={x.path.map(words).join(' › ')} />)}</Group>
      </>
    }}</Each>
  </>
}

/** One Computer settings page under its group. Pages DSH draws with its own owners keep those cards; a phone that may
 * only read sees them without controls. */
export function ComputerPage(props: { id: ComputerPageId; store: ComputerStore }) {
  const s = props.store
  s.ensure()
  const client = () => s.client() as Dsh
  const view = (children: JSX.Element) => <View style={{ pointerEvents: s.control() ? 'auto' : 'none' }} class={s.control() ? '' : 'opacity-60'}>{children}</View>
  return (
    <Scroll testID={`computer-page-${props.id}`} class="flex-1 bg-background" contentClass="px-4 pb-10" keyboardDismissMode="interactive">
      <If when={props.id !== 'plugins'}><LoadState store={s} /></If>
      <If when={s.config().kind === 'ready' || props.id === 'plugins'}>
        {props.id === 'general' ? <GeneralPage store={s} />
          : props.id === 'subagent' || props.id === 'loop' || props.id === 'shell' ? <BuiltInPage store={s} id={props.id} />
          : props.id === 'web' ? <><BuiltInPage store={s} id="web" />{view(<CapabilitySettings client={client} auto />)}</>
          : props.id === 'other' ? <OtherPage store={s} />
          : props.id === 'plugins' ? <PluginsPage store={s} embedded />
          : props.id === 'models' ? view(<ProviderSettings client={client} auto />)
          : props.id === 'workspaces' ? view(<WorkspaceSettings client={client} auto />)
          : props.id === 'voice' ? <View class="pt-5">{view(<SpeechSettings client={client} />)}</View>
          : view(<HostSettings client={client} section={props.id === 'presets' ? 'presets' : props.id === 'cua' ? 'cua' : props.id === 'account' ? 'account' : 'inventory'} />)}
      </If>
    </Scroll>
  )
}

/** Settings › Computer settings: one row per group, then the danger zone. */
export function ComputerSettingsPage(props: { store: ComputerStore; onOpen: (id: ComputerPageId) => void }) {
  const s = props.store
  s.ensure()
  const ready = () => s.config().kind === 'ready'
  const n = (spec: FieldSpec) => current(s, spec)
  const listed = () => { const b = s.bundles(); return b.kind === 'ready' ? b.value.filter(x => x.name !== SELF && (x.listedByDefault || x.enabled || x.installed)) : [] }
  const general = () => [presetName(permissionNow(s) ?? '', s.catalog()?.defaultOptions.find(o => o.value === permissionNow(s))?.name ?? permissionNow(s) ?? ''), appearanceChoices().find(c => c.value === n(GENERAL.look[1]!))?.label].filter(Boolean).join(' · ')
  // A group whose settings this computer's DSH doesn't have (an older DSH, another platform) is not listed.
  const absent = (...specs: FieldSpec[]) => ready() && specs.every(x => !nsOf(s, x))
  const forms = () => { const c = s.config(); return pluginForms(c.kind === 'ready' ? c.value : undefined) }
  return (
    <Scroll testID="computer-settings" class="flex-1 bg-background" contentClass="px-4 pb-10">
      <LoadState store={s} />
      <If when={ready()}>
        <Text testID="computer-intro" class="px-2 pt-3 text-muted-foreground text-[13px] leading-[18px]">{fill(W().intro, { computer: s.info()?.name || W().rowValue })}</Text>
        <Label text={W().sectionDesktop} />
        <Group>
          <GroupRow id="general" icon="sliders" first title={W().general} sub={general} onPress={() => props.onOpen('general')} />
          <GroupRow id="models" icon="bot" title={W().models} sub={() => W().modelsSub} onPress={() => props.onOpen('models')} />
          <GroupRow id="presets" icon="listChecks" title={W().presets} sub={() => W().presetsSub} onPress={() => props.onOpen('presets')} />
          <GroupRow id="account" icon="user" title={W().account} sub={() => W().accountSub} onPress={() => props.onOpen('account')} />
          <GroupRow id="workspaces" icon="folder" title={W().workspaces} sub={() => W().workspacesSub} onPress={() => props.onOpen('workspaces')} />
          <GroupRow id="inventory" icon="archive" title={W().inventory} sub={() => W().inventorySub} onPress={() => props.onOpen('inventory')} />
        </Group>
        <Label text={W().sectionPlugins} />
        <Group>
          <GroupRow id="plugins" icon="puzzle" first title={W().plugins} sub={() => s.bundles().kind === 'ready' ? fill(W().pluginsSub, { on: String(listed().filter(b => b.enabled).length), all: String(listed().length) }) : W().loading.replace(/…$/, '')} onPress={() => props.onOpen('plugins')} />
          <If when={!absent(...BUILT_IN.subagent)}><GroupRow id="subagent" icon="layers" title={W().subagent} sub={() => fill(W().subagentSub, { depth: String(n(BUILT_IN.subagent[0]!)), count: String(n(BUILT_IN.subagent[1]!)) })} onPress={() => props.onOpen('subagent')} /></If>
          <GroupRow id="web" icon="globe" title={W().web} sub={() => W().webSub} onPress={() => props.onOpen('web')} />
          <If when={!absent(...BUILT_IN.loop)}><GroupRow id="loop" icon="repeat" title={W().loop} sub={() => fill(W().loopSub, { n: String(n(BUILT_IN.loop[0]!)) })} onPress={() => props.onOpen('loop')} /></If>
          <If when={!absent(...BUILT_IN.shell)}><GroupRow id="shell" icon="terminal" title={W().shell} sub={() => fill(W().shellSub, { s: String(Math.round(Number(n(BUILT_IN.shell[0]!)) / 1000)) })} onPress={() => props.onOpen('shell')} /></If>
          <GroupRow id="cua" icon="monitor" title={W().cua} sub={() => W().cuaSub} onPress={() => props.onOpen('cua')} />
          <GroupRow id="voice" icon="mic" title={W().voice} sub={() => W().voiceSub} onPress={() => props.onOpen('voice')} />
          <If when={forms().length}><GroupRow id="other" icon="sliders" title={W().other} sub={() => forms().map(f => words(f.ns)).join(', ')} onPress={() => props.onOpen('other')} /></If>
        </Group>
        <SelfSection store={s} />
        <If when={s.control()}><DangerZone store={s} /></If>
      </If>
    </Scroll>
  )
}

/** DSH Anywhere as DSH lists it (pluginManager/listBundles), the one bundle the plugin list leaves out. */
const selfOf = (s: ComputerStore) => { const b = s.bundles(); return b.kind === 'ready' ? b.value.find(x => x.name === SELF) : undefined }
const Note = (p: { id: string; text: string }) => <If when={p.text}><Text testID={p.id} class="px-2 pt-2 text-foreground text-[13px] leading-[18px]">{p.text}</Text></If>

/** The DSH Anywhere group: its version and, when DSH lists a newer stable, compatible release from the registry it came
 * from, the update. Updating only interrupts phones for a moment (they reconnect once the new version runs, and DSH keeps
 * or reinstalls the old one if it can't), so it asks once, as a plugin update does, and is not in the danger zone. */
export function SelfSection(props: { store: ComputerStore }) {
  const s = props.store, self = () => selfOf(s)
  const target = signal<{ version: string; registry?: unknown } | undefined>(undefined)
  const note = signal(''), working = signal(false)
  let alive = true
  cleanup(() => { alive = false })
  effect(() => {
    const b = self()
    if (!b?.version || b.update !== 'registry' || !s.control()) return
    s.client().rpc<VersionList>('pluginManager/listVersions', { name: SELF }).then(l => {
      const v = updateTarget(l); if (alive) target.set(v ? { version: v, registry: l.registry } : undefined)
    }, () => {})
  })
  const update = async () => {
    const w = W(), b = self(), t = target(); if (!b || !t || working()) return
    const yes = await chooseAction({ title: fill(w.updateRow, { version: t.version }), message: fill(w.updateBody, { from: b.version ?? '', to: t.version }), actions: [{ id: 'yes', label: w.updateAction }, { id: 'no', label: pluginStrings(lang()).cancel }] })
    if (yes !== 'yes' || !alive) return
    working.set(true); note.set(w.working)
    let failed: string | undefined
    try {
      const r = await s.client().rpc<{ result: Change }>('pluginManager/updateBundle', { name: SELF, version: t.version, ...(t.registry ? { options: { registry: t.registry } } : {}) })
      const o = outcomeOf(r.result); if (o.kind === 'failed') failed = o.code
    } catch { /* DSH Anywhere restarts while it answers: no answer is the expected end */ }
    if (!alive) return
    working.set(false)
    note.set(failed ? `${w.selfFailed} ${reasonOf(pluginStrings(lang()), failed) ?? ''}`.trim() : w.updateDone)
  }
  return <If when={self()}>
    <Label text={W().sectionSelf} />
    <View testID="computer-self"><Group>
      <Line first><View class="flex-row items-center gap-3">
        <Text class="flex-1 text-foreground text-[15px]">{W().selfVersion}</Text>
        <Text testID="computer-self-version" class="text-muted-foreground text-[15px]">{self()?.version ?? ''}</Text>
      </View></Line>
      <If when={target()}>
        <View role="button" testID="computer-self-update" accessibilityLabel={fill(W().updateNew, { version: target()?.version ?? '' })} accessibilityState={{ disabled: working() }} onPress={() => void update()}
          class={`px-[14px] py-[11px] gap-[3px] border-t border-border ${working() ? 'opacity-50' : 'active:bg-secondary'}`}>
          <View class="flex-row items-center gap-3">
            <Text class="flex-1 text-foreground text-[15px] font-medium">{fill(W().updateNew, { version: target()?.version ?? '' })}</Text>
            <Icon name="chevronRight" size={18} class="tint-muted-foreground" />
          </View>
          <Text class="text-muted-foreground text-[13px] leading-[18px]">{W().updateHint}</Text>
        </View>
      </If>
    </Group></View>
    <Note id="self-note" text={note()} />
  </If>
}

/** The bottom of Computer settings: what turns DSH Anywhere itself off or removes it. Each asks twice (the sheet with
 * the full consequence, then the typed word) before the call goes to DSH. */
export function DangerZone(props: { store: ComputerStore }) {
  const s = props.store, self = () => selfOf(s)
  const note = signal(''), working = signal(false)
  let alive = true
  cleanup(() => { alive = false })
  const run = async (kind: 'off' | 'uninstall') => {
    const w = W(), b = self(); if (!b || working()) return
    const d = kind === 'off' ? { title: w.offRow, body: w.offBody, action: w.offAction } : { title: w.uninstallRow, body: w.uninstallBody, action: w.uninstallAction }
    if (!(await confirmDanger({ ...d, confirm: { word: 'DSH Anywhere' } }))) return
    working.set(true); note.set(w.working)
    let failed: string | undefined
    try {
      const r = kind === 'off' ? await s.client().rpc<Change>('pluginManager/setBundleEnabled', { name: SELF, enabled: false })
        : await s.client().rpc<Change>('pluginManager/removeBundle', { name: SELF })
      const o = outcomeOf(r); if (o.kind === 'failed') failed = o.code
    } catch { /* DSH Anywhere stops while it answers: no answer is the expected end */ }
    if (!alive) return
    working.set(false)
    note.set(failed ? `${w.selfFailed} ${reasonOf(pluginStrings(lang()), failed) ?? ''}`.trim() : w.offDone)
  }
  // As iOS and Android Settings show destructive actions: an untitled group of one-line rows, only the action's name in
  // red, the consequence in a grey footer; the full consequence is in the confirmation sheet.
  const Action = (p: { id: string; title: string; first?: boolean; press: () => void }) => (
    <View role="button" testID={`danger-${p.id}`} accessibilityLabel={p.title} accessibilityState={{ disabled: working() }} onPress={() => { if (!working()) p.press() }}
      class={`px-[14px] h-[46px] justify-center ${p.first ? '' : 'border-t border-border'} ${working() ? 'opacity-50' : 'active:bg-secondary'}`}>
      <Text class="text-destructive text-[15px]">{p.title}</Text>
    </View>
  )
  return <If when={self()}>
    <View testID="danger-zone" class="pt-6"><Group>
      <Action id="off" first title={W().offRow} press={() => void run('off')} />
      <If when={self()?.removable}><Action id="uninstall" title={W().uninstallRow} press={() => void run('uninstall')} /></If>
    </Group></View>
    <Text testID="danger-footer" class="px-2 pt-[6px] text-muted-foreground text-[12px] leading-[16px]">{W().dangerFooter}</Text>
    <Note id="danger-note" text={note()} />
  </If>
}
