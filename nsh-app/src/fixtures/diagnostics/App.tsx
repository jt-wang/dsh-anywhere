import { effect, host, mount, signal } from 'nsh'
import { diagnostics, loadDiagnostics } from '../../diagnostics.ts'
import { DiagnosticsSettings } from '../../diagnostics-settings.tsx'

function App() {
  const active = signal(true)
  loadDiagnostics()
  host.on('fixture.action', (v) => diagnostics.record('interaction', 'ui.action', v))
  host.on('app.state', (v) => active.set((v as { active: boolean }).active))
  host.on('diagnostics.resource', (v) => diagnostics.record('resources', 'os.snapshot', v))
  effect(() => { diagnostics.foreground(active()); const p = diagnostics.prefs(); host.call('diagnostics.resources', { enabled: active() && p.enabled && p.categories.resources }).catch(() => {}) })
  return <DiagnosticsSettings />
}
mount(App)
