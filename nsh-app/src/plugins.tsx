// Settings › Plugins on your computer: DSH Desktop's Plugins page on the phone (plugins.ts). Each switch changes the
// computer at once; installing a plugin and turning one off ask first. A phone that may only read is told why it
// cannot (the companion's relay is for phones allowed to run tasks: host/src/server.ts ownerRelay).
import { cleanup, locale, Scroll, signal, Text, View } from 'nsh'
import { Switch } from 'nsh/base'
import type { Dsh } from './dsh.ts'
import { dsh } from './state.ts'
import { language } from './strings.ts'
import { chooseAction, haptic } from './ui.tsx'
import { diagnostics } from './diagnostics.ts'
import { descriptionOf, listBundles, listed, setBundle, titleOf, type Bundle } from './plugins.ts'
import { fill, pluginStrings, reasonOf } from './plugins-strings.ts'

const lang = () => (language() === 'system' ? locale() : language())
const words = () => pluginStrings(lang())

type Load = { kind: 'loading' } | { kind: 'ready'; bundles: Bundle[] } | { kind: 'failed' | 'unsupported' | 'readOnly' }

export function PluginsPage(props: { client?: () => Pick<Dsh, 'rpc'> } = {}) {
  const client = props.client ?? dsh
  const load = signal<Load>({ kind: 'loading' })
  // Per plugin: a change under way, or how the last one ended ('restart' or 'failed:<DSH's code>').
  const notes = signal<Record<string, string>>({})
  let alive = true
  cleanup(() => { alive = false })
  const read = async () => {
    load.set({ kind: 'loading' })
    try { const bundles = await listBundles(client()); if (alive) load.set({ kind: 'ready', bundles }) }
    catch (e) {
      if (!alive) return
      const code = (e as { code?: string })?.code ?? ''
      load.set({ kind: code === 'http/403' ? 'readOnly' : code === 'http/404' || /not[-_ ]?found|unknown[-_ ]?method/i.test(code) ? 'unsupported' : 'failed' })
    }
  }
  void read()

  const change = async (b: Bundle, on: boolean) => {
    const w = words(), name = titleOf(b, lang())
    if (on && b.availability === 'missing' && b.installTarget) {
      const yes = await chooseAction({ title: fill(w.installTitle, { name }), message: fill(w.installBody, { name, version: b.installTarget.version }), actions: [{ id: 'yes', label: fill(w.install, { name }) }, { id: 'no', label: w.cancel }] })
      if (yes !== 'yes') return
    } else if (!on) {
      const yes = await chooseAction({ title: fill(w.offTitle, { name }), message: w.offBody, actions: [{ id: 'yes', label: fill(w.off, { name }), destructive: true }, { id: 'no', label: w.cancel }] })
      if (yes !== 'yes') return
    }
    notes.set({ ...notes(), [b.name]: 'busy' }); haptic('tick')
    let note = ''
    try {
      const r = await setBundle(client(), b, on)
      note = r.kind === 'restart' ? 'restart' : r.kind === 'failed' ? `failed:${r.code}` : ''
    } catch (e) { note = `failed:${(e as { code?: string })?.code || 'network'}` }
    // DSH's reason code goes to diagnostics; the page says what to do.
    if (note.startsWith('failed:')) diagnostics.record('interaction', 'computer.change_failed', { target: 'plugin', code: note.slice(7) })
    if (!alive) return
    haptic(note.startsWith('failed') ? 'reject' : 'confirm')
    notes.set({ ...notes(), [b.name]: note })
    // The computer's own answer is what the page shows, as DSH Desktop's page reads it again after a change.
    try { const bundles = await listBundles(client()); if (alive) load.set({ kind: 'ready', bundles }) } catch {}
  }

  const Row = (p: { b: Bundle; first: boolean }) => {
    const w = words(), b = p.b, id = b.name.replace(/^@[^/]+\//, '')
    const note = () => notes()[b.name] ?? ''
    const sub = () => {
      const n = note()
      if (n === 'busy') return w.working
      if (n === 'restart') return w.restart
      if (n.startsWith('failed:')) return reasonOf(w, n.slice(7)) ?? w.changeFailed
      if (b.readOnlyReason) return w.managed
      if (b.availability === 'missing' && b.installTarget) return fill(w.notInstalled, { version: b.installTarget.version })
      return descriptionOf(b, lang())
    }
    const locked = () => !!b.readOnlyReason || note() === 'busy' || (b.availability === 'missing' && !b.installTarget)
    return (
      <View testID={`plugin-${id}`} class={`flex-row items-center gap-3 px-[14px] py-3 ${p.first ? '' : 'border-t border-border'}`}>
        <View class="flex-1 gap-[2px]">
          <Text class="text-foreground text-[15px]">{titleOf(b, lang())}</Text>
          <If when={sub()}><Text testID={`plugin-${id}-note`} class={`text-[13px] leading-[18px] line-clamp-3 ${note().startsWith('failed:') ? 'text-destructive' : 'text-muted-foreground'}`}>{sub()}</Text></If>
        </View>
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
  const state = () => load()
  return (
    <Scroll testID="plugins" class="flex-1 bg-background" contentClass="px-4 pb-10">
      <View class="px-2 pt-3"><Text class="text-muted-foreground text-[13px] leading-[18px]">{words().hint}</Text></View>
      <If when={state().kind === 'loading'}><Text testID="plugins-loading" class="px-2 pt-5 text-muted-foreground text-[15px]">{words().loading}</Text></If>
      <If when={state().kind === 'failed' || state().kind === 'unsupported' || state().kind === 'readOnly'}>
        <View testID={`plugins-${state().kind}`} class="mt-5 rounded-[14px] bg-card border border-border px-[14px] py-3 gap-3">
          <Text class="text-foreground text-[15px] leading-[21px]">{state().kind === 'readOnly' ? words().readOnly : state().kind === 'unsupported' ? words().unsupported : words().failed}</Text>
          <If when={state().kind === 'failed'}>
            <View role="button" testID="plugins-retry" onPress={() => void read()} class="self-start rounded-full bg-primary px-4 h-[36px] justify-center active:opacity-80"><Text class="text-primary-foreground text-[14px] font-medium">{words().retry}</Text></View>
          </If>
        </View>
      </If>
      <If when={state().kind === 'ready'}>
        {(() => { const s = state() as { kind: 'ready'; bundles: Bundle[] }; const g = listed(s.bundles); return g.extensions.length + g.more.length === 0
          ? <Text testID="plugins-empty" class="px-2 pt-5 text-muted-foreground text-[15px]">{words().empty}</Text>
          : <><Group label={words().extensions} items={g.extensions} /><Group label={words().more} items={g.more} /></> })()}
      </If>
    </Scroll>
  )
}
