// The chats page's connection bar and the Settings page on one screen, over the app's real state (state.ts boot) and a
// controllable socket, for src/pathsync.test.tsx: both say how the phone reaches the computer.
import '../cached/socket.ts'
import { mount, Scroll, View } from 'nsh'
import { loadPrefs } from '../../prefs.ts'
import { SettingsPage } from '../../settings.tsx'
import { boot, settings } from '../../state.ts'
import { ConnectionBar } from '../../status.tsx'

function App() {
  loadPrefs()
  boot()
  return (
    <View class="flex-1 bg-background pt-[60px]">
      <View testID="home"><ConnectionBar always /></View>
      {/* Settings opens once the link is known, as in the app (it is under the chats page). */}
      <If when={settings()}><Scroll class="flex-1" testID="settings"><SettingsPage onDiagnostics={() => {}} /></Scroll></If>
    </View>
  )
}
mount(App)
