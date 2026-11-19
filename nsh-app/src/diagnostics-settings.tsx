// Explicit local controls and an immutable export preview; only Share opens the OS sheet.
import { effect, host, platform, signal, Text, View } from 'nsh'
import { Switch } from 'nsh/base'
import { CATEGORIES, diagnosticExport, diagnostics, setDiagnostics, type Category } from './diagnostics.ts'
import { S } from './strings.ts'

export function DiagnosticsSettings() {
  const range = signal(86400000)
  const preview = signal<{ text: string; from: number | null; to: number | null; count: number; categories: Category[] } | undefined>(undefined)
  const busy = signal(false)
  const error = signal(false)
  diagnostics.load()
  effect(() => { diagnostics.prefs(); range(); preview.set(undefined) })
  const prefs = diagnostics.prefs
  const toggle = (id: string, label: string, checked: () => boolean, change: (value: boolean) => void) => (
    <View class="flex-row items-center gap-3 px-[14px] py-3 border-b border-border">
      <Text class="flex-1 text-foreground text-[15px]">{label}</Text>
      <Switch testID={`diagnostics-${id}`} accessibilityLabel={label} checked={checked()} onChange={(e) => change(e.checked)}
        class="w-[46px] h-[28px]" trackClass="w-full h-full rounded-full bg-input checked:bg-primary justify-center px-[3px]"
        thumbClass="w-[22px] h-[22px] rounded-full bg-background shadow-sm checked:translate-x-[18px]" />
    </View>
  )
  const prepare = async () => {
    if (busy()) return
    busy.set(true); error.set(false)
    try {
      await diagnostics.load()
      await diagnostics.flush()
      const info = await host.call<{ version: string; build: string; os?: string; deviceClass?: string }>('app.info')
      const selected = { ...prefs().categories }, to = Date.now(), from = to - range()
      const events = diagnostics.snapshot(from, selected)
      const text = diagnosticExport(events, selected, info, platform.os, from, to)
      const summary = JSON.parse(text)
      preview.set({ text, from: summary.actualRange?.from ?? null, to: summary.actualRange?.to ?? null, count: events.length, categories: CATEGORIES.filter((c) => selected[c]) })
    } catch { error.set(true) } finally { busy.set(false) }
  }
  const clear = async () => {
    if (busy()) return
    busy.set(true); preview.set(undefined); error.set(false)
    try { await diagnostics.clear() } catch { error.set(true) } finally { busy.set(false) }
  }
  const share = async () => {
    const value = preview()
    if (!value || busy()) return
    busy.set(true); error.set(false)
    try { await host.call('diagnostics.share', { text: value.text }) } catch { error.set(true) } finally { busy.set(false) }
  }
  return (
    <View testID="diagnostics" class="gap-2">
      <Text class="px-2 pt-5 text-muted-foreground text-[13px] font-medium">{S.diagnostics.title}</Text>
      <View class="rounded-[14px] bg-card border border-border overflow-hidden">
        {toggle('enabled', S.diagnostics.enabled, () => prefs().enabled, (enabled) => { setDiagnostics({ ...prefs(), enabled }) })}
        {CATEGORIES.map((category) => toggle(category, S.diagnostics[category], () => prefs().categories[category], (value) => { setDiagnostics({ ...prefs(), categories: { ...prefs().categories, [category]: value } }) }))}
        <Text testID="diagnostics-state" class="px-[14px] py-3 text-muted-foreground text-[13px] leading-[18px]">{prefs().enabled ? S.diagnostics.recording : S.diagnostics.off}</Text>
      </View>
      <Text class="px-2 text-muted-foreground text-[13px] leading-[18px]">{S.diagnostics.privacy}</Text>
      <Text class="px-2 text-muted-foreground text-[13px] leading-[18px]">{S.diagnostics.retention}</Text>
      <Text class="px-2 text-muted-foreground text-[13px] leading-[18px]">{S.diagnostics.power}</Text>
      <Text class="px-2 pt-2 text-foreground text-[14px]">{S.diagnostics.range}</Text>
      <View class="flex-row flex-wrap gap-2">
        {[{ ms: 900000, label: S.diagnostics.recent }, { ms: 3600000, label: S.diagnostics.hour }, { ms: 86400000, label: S.diagnostics.day }].map((option) => (
          <View role="radio" testID={`diagnostics-range-${option.ms}`} accessibilityLabel={option.label} accessibilityState={{ selected: range() === option.ms }} onPress={() => range.set(option.ms)} class={`rounded-[10px] px-3 py-2 ${range() === option.ms ? 'bg-secondary' : 'bg-card border border-border'}`}><Text class="text-foreground text-[14px]">{option.label}</Text></View>
        ))}
      </View>
      <View class="flex-row gap-3 py-2">
        <View role="button" testID="diagnostics-preview" onPress={prepare} class="rounded-[10px] px-3 py-3 bg-secondary"><Text class="text-foreground text-[14px]">{busy() ? S.loading : S.diagnostics.export}</Text></View>
        <View role="button" testID="diagnostics-clear" onPress={clear} class="rounded-[10px] px-3 py-3 bg-card border border-border"><Text class="text-destructive text-[14px]">{S.diagnostics.clear}</Text></View>
      </View>
      <If when={preview()}>
        <View testID="diagnostics-export-preview" class="rounded-[14px] bg-card border border-border p-[14px] gap-2">
          <Text class="text-foreground text-[15px] font-medium">{S.diagnostics.preview}</Text>
          <Text class="text-muted-foreground text-[13px]">{preview()?.categories.map((c) => S.diagnostics[c]).join(' · ') || '—'}</Text>
          <Text testID="diagnostics-export-range" class="text-muted-foreground text-[13px]">{preview()?.count ? `${new Date(preview()!.from!).toLocaleString()} — ${new Date(preview()!.to!).toLocaleString()}` : S.diagnostics.empty}</Text>
          <Text class="text-muted-foreground text-[13px]">{S.diagnostics.count(preview()?.count ?? 0)}</Text>
          <Text class="text-muted-foreground text-[13px] leading-[18px]">{S.diagnostics.privacy}</Text>
          <View role="button" testID="diagnostics-share" onPress={share} class="rounded-[10px] bg-primary px-3 py-3 items-center"><Text class="text-primary-foreground text-[14px]">{S.diagnostics.share}</Text></View>
        </View>
      </If>
      <If when={error() || diagnostics.failed()}><Text testID="diagnostics-error" class="px-2 text-destructive text-[13px] leading-[18px]">{S.diagnostics.failed}</Text></If>
    </View>
  )
}
