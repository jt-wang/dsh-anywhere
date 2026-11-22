// Computer settings › Plugins: DSH Desktop's Plugins page on the phone (plugins.ts). Each switch changes the computer at
// once; installing a plugin and turning one off ask first; updating or uninstalling one (⋯) asks twice: which, then DSH
// Desktop's own confirmation. DSH Anywhere itself is not listed: turning it off would cut this phone off, so it lives in
// Computer settings' danger zone (computer-settings.tsx). A phone that may only read sees the list without controls.
import { cleanup, locale, Scroll, signal, Text, View } from 'nsh'
import { Switch } from 'nsh/base'
import type { Dsh } from './dsh.ts'
import { dsh } from './state.ts'
import { language } from './strings.ts'
import { chooseAction, haptic, IconButton } from './ui.tsx'
import { diagnostics } from './diagnostics.ts'
import { descriptionOf, listed, outcomeOf, setBundle, titleOf, type Bundle, type Change } from './plugins.ts'
import { fill, pluginStrings, reasonOf } from './plugins-strings.ts'
import { computerStrings } from './computer-settings-strings.ts'
import { createComputerStore, updateTarget, type ComputerStore, type VersionList } from './computer-settings.ts'

const lang = () => (language() === 'system' ? locale() : language())
const words = () => pluginStrings(lang())
const more = () => computerStrings(lang())

export function PluginsPage(props: { client?: () => Pick<Dsh, 'rpc'>; store?: ComputerStore; embedded?: boolean } = {}) {
  const store = props.store ?? createComputerStore(props.client ?? dsh)
  store.ensure()
  // Per plugin: a change under way, or how the last one ended ('restart', 'failed:<DSH's code>', 'updated:<version>', …).
  const notes = signal<Record<string, string>>({})
  const note = (name: string, value: string) => notes.set({ ...notes(), [name]: value })
  let alive = true
  cleanup(() => { alive = false })
  const control = () => store.control()

  const change = async (b: Bundle, on: boolean) => {
    const w = words(), name = titleOf(b, lang())
    if (on && b.availability === 'missing' && b.installTarget) {
      const yes = await chooseAction({ title: fill(w.installTitle, { name }), message: fill(w.installBody, { name, version: b.installTarget.version }), actions: [{ id: 'yes', label: fill(w.install, { name }) }, { id: 'no', label: w.cancel }] })
      if (yes !== 'yes') return
    } else if (!on) {
      const yes = await chooseAction({ title: fill(w.offTitle, { name }), message: w.offBody, actions: [{ id: 'yes', label: fill(w.off, { name }), destructive: true }, { id: 'no', label: w.cancel }] })
      if (yes !== 'yes') return
    }
    note(b.name, 'busy'); haptic('tick')
    let n = ''
    try {
      const r = await setBundle(store.client(), b, on)
      n = r.kind === 'restart' ? 'restart' : r.kind === 'failed' ? `failed:${r.code}` : ''
    } catch (e) { n = `failed:${(e as { code?: string })?.code || 'network'}` }
    finish(b, n)
  }
  // DSH's reason code goes to diagnostics; the page says what to do. The computer's own answer is what the page shows,
  // as DSH Desktop's page reads it again after a change.
  const finish = (b: Bundle, n: string) => {
    if (n.startsWith('failed:')) diagnostics.record('interaction', 'computer.change_failed', { target: 'plugin', code: n.slice(7) })
    if (!alive) return
    haptic(n.startsWith('failed') || n === 'lost' ? 'reject' : 'confirm')
    note(b.name, n)
    void store.readBundles()
  }

  /** ⋯: update (when DSH lists a newer stable, compatible version) and uninstall (when DSH may remove it), each confirmed. */
  const manage = async (b: Bundle) => {
    const w = words(), c = more(), name = titleOf(b, lang())
    let target: string | undefined, registry: unknown
    if (b.update === 'registry') {
      note(b.name, 'checking')
      try { const l = await store.client().rpc<VersionList>('pluginManager/listVersions', { name: b.name }); target = updateTarget(l); registry = l.registry } catch {}
      if (!alive) return
      note(b.name, '')
    }
    const actions = [...(target ? [{ id: 'update', label: fill(c.pluginUpdate, { version: target }) }] : []), ...(b.removable ? [{ id: 'uninstall', label: c.pluginUninstall, destructive: true }] : [])]
    if (!actions.length) { note(b.name, 'latest'); return }
    const id = await chooseAction({ title: name, actions })
    if (id === 'update' && target) {
      const yes = await chooseAction({ title: fill(c.pluginUpdateTitle, { name }), message: fill(c.pluginUpdateBody, { from: b.version ?? '', to: target }), actions: [{ id: 'yes', label: fill(c.pluginUpdate, { version: target }) }, { id: 'no', label: w.cancel }] })
      if (yes !== 'yes') return
      note(b.name, 'busy')
      let n: string
      try {
        const r = await store.client().rpc<{ from: string; to: string; result: Change; restore?: Change }>('pluginManager/updateBundle', { name: b.name, version: target, ...(registry ? { options: { registry } } : {}) })
        const o = outcomeOf(r.result)
        n = r.restore ? `restored:${r.from}` : o.kind === 'applied' ? `updated:${r.to}` : o.kind === 'restart' ? 'restart' : `failed:${o.code}`
      } catch { n = 'lost' } // never retried: DSH may have replaced it; the list read next says which version runs
      finish(b, n)
    } else if (id === 'uninstall') {
      const yes = await chooseAction({ title: fill(c.pluginUninstallTitle, { name }), message: c.pluginUninstallBody, actions: [{ id: 'yes', label: c.pluginUninstall, destructive: true }, { id: 'no', label: w.cancel }] })
      if (yes !== 'yes') return
      note(b.name, 'busy')
      let n: string
      try { const o = outcomeOf(await store.client().rpc<Change>('pluginManager/removeBundle', { name: b.name })); n = o.kind === 'applied' ? 'removed' : o.kind === 'restart' ? 'restart' : `failed:${o.code}` }
      catch (e) { n = `failed:${(e as { code?: string })?.code || 'network'}` }
      finish(b, n)
    }
  }

  const Row = (p: { b: Bundle; first: boolean }) => {
    const w = words(), c = more(), b = p.b, id = b.name.replace(/^@[^/]+\//, '')
    const n = () => notes()[b.name] ?? ''
    const sub = () => {
      const v = n()
      if (v === 'busy') return w.working
      if (v === 'checking') return c.pluginChecking
      if (v === 'latest') return c.pluginNoUpdate
      if (v === 'restart') return w.restart
      if (v === 'lost') return c.pluginLost
      if (v === 'removed') return c.pluginRemoved
      if (v.startsWith('updated:')) return fill(c.pluginUpdated, { version: v.slice(8) })
      if (v.startsWith('restored:')) return fill(c.pluginRestored, { from: v.slice(9) })
      if (v.startsWith('failed:')) return reasonOf(w, v.slice(7)) ?? w.changeFailed
      if (b.readOnlyReason) return w.managed
      if (b.availability === 'missing' && b.installTarget) return fill(w.notInstalled, { version: b.installTarget.version })
      return descriptionOf(b, lang())
    }
    const bad = () => n().startsWith('failed:') || n() === 'lost' || n().startsWith('restored:')
    const locked = () => !control() || !!b.readOnlyReason || n() === 'busy' || n() === 'checking' || (b.availability === 'missing' && !b.installTarget)
    return (
      <View testID={`plugin-${id}`} class={`flex-row items-center gap-2 pl-[14px] pr-[10px] py-3 ${p.first ? '' : 'border-t border-border'}`}>
        <View class="flex-1 gap-[2px]">
          <Text class="text-foreground text-[15px]">{titleOf(b, lang())}{b.version ? <Text class="text-muted-foreground text-[13px]">{`  ${b.version}`}</Text> : null}</Text>
          <If when={sub()}><Text testID={`plugin-${id}-note`} class={`text-[13px] leading-[18px] line-clamp-3 ${bad() ? 'text-destructive' : 'text-muted-foreground'}`}>{sub()}</Text></If>
        </View>
        <If when={control() && b.installed && (b.removable || b.update === 'registry')}>
          <IconButton name="more" label={fill(c.pluginMore, { name: titleOf(b, lang()) })} testID={`plugin-${id}-more`} onPress={() => { if (!locked()) void manage(b) }} />
        </If>
        <Switch testID={`plugin-${id}-switch`} accessibilityLabel={titleOf(b, lang())} checked={b.enabled} disabled={locked()} onChange={(e) => { void change(b, e.checked) }}
          class="w-[46px] h-[28px] disabled:opacity-50" trackClass="w-full h-full rounded-full bg-input checked:bg-primary justify-center px-[3px] transition-colors duration-150"
          thumbClass="w-[22px] h-[22px] rounded-full bg-background shadow-sm checked:translate-x-[18px] transition-transform duration-150" />
      </View>
    )
  }
  const Group = (p: { label: string; items: Bundle[] }) => (
    <If when={p.items.length}>
      <Text class="px-2 pt-5 pb-[6px] text-muted-foreground text-[13px] font-medium">{p.label}</Text>
      <View class="rounded-[14px] bg-card border border-border overflow-hidden">
        {p.items.map((b, i) => <Row b={b} first={i === 0} />)}
      </View>
    </If>
  )
  const state = () => store.bundles()
  const body = (
    <>
      <View class="px-2 pt-3"><Text class="text-muted-foreground text-[13px] leading-[18px]">{words().hint}</Text></View>
      <If when={state().kind === 'ready' && !control()}>
        <View testID="plugins-view-only" class="mt-3 rounded-[12px] bg-secondary px-3 py-[10px]"><Text class="text-foreground text-[13px] leading-[18px]">{more().readOnly}</Text></View>
      </If>
      <If when={state().kind === 'loading'}><Text testID="plugins-loading" class="px-2 pt-5 text-muted-foreground text-[15px]">{words().loading}</Text></If>
      <If when={state().kind === 'failed' || state().kind === 'unsupported' || state().kind === 'forbidden'}>
        <View testID={`plugins-${state().kind === 'forbidden' ? 'readOnly' : state().kind}`} class="mt-5 rounded-[14px] bg-card border border-border px-[14px] py-3 gap-3">
          <Text class="text-foreground text-[15px] leading-[21px]">{state().kind === 'forbidden' ? words().readOnly : state().kind === 'unsupported' ? words().unsupported : words().failed}</Text>
          <If when={state().kind === 'failed'}>
            <View role="button" testID="plugins-retry" onPress={() => void store.readBundles()} class="self-start rounded-full bg-primary px-4 h-[36px] justify-center active:opacity-80"><Text class="text-primary-foreground text-[14px] font-medium">{words().retry}</Text></View>
          </If>
        </View>
      </If>
      <If when={state().kind === 'ready'}>
        {(() => { const s = state() as { kind: 'ready'; value: Bundle[] }; const g = listed(s.value); return g.extensions.length + g.more.length === 0
          ? <Text testID="plugins-empty" class="px-2 pt-5 text-muted-foreground text-[15px]">{words().empty}</Text>
          : <><Group label={words().extensions} items={g.extensions} /><Group label={words().more} items={g.more} /></> })()}
      </If>
    </>
  )
  return props.embedded ? <View testID="plugins">{body}</View> : <Scroll testID="plugins" class="flex-1 bg-background" contentClass="px-4 pb-10">{body}</Scroll>
}
