import { mount, signal, Text, View } from 'nsh'
import { BottomSheet, HeaderMenu } from '../ui.tsx'
import { WorkingText } from '../working.tsx'

function App() {
  const first = signal(false), second = signal(false), menu = signal(false), mounted = signal(true)
  const button = (id: string, press: () => void) => <View role="button" testID={id} onPress={press} class="h-12"><Text>{id}</Text></View>
  return <View class="flex-1">
    <WorkingText title={() => 'Analyzing the reference request'} active={() => true} />
    {button('open-sheet', () => first.set(true))}
    {button('open-menu', () => menu.set(true))}
    <If when={mounted()}>
      <BottomSheet open={first()} onOpenChange={(e) => first.set(e.open)}>
        <View>
          {button('open-nested', () => second.set(true))}
          {button('unmount-sheet', () => mounted.set(false))}
        </View>
      </BottomSheet>
    </If>
    <BottomSheet open={second()} onOpenChange={(e) => second.set(e.open)}>
      <View>
        {button('close-parent', () => first.set(false))}
        {button('close-nested', () => second.set(false))}
      </View>
    </BottomSheet>
    <HeaderMenu open={menu} onClose={() => menu.set(false)} actions={[{ id: 'done', label: 'Close menu' }]} onChoose={() => {}} />
  </View>
}
mount(App)
