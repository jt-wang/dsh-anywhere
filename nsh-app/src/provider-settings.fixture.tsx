// Runnable native/headless fixture: nsh test nsh-app/src/provider-settings.fixture.tsx
import { mount, Scroll } from 'nsh'
import { Dsh } from './dsh.ts'
import { ProviderSettings } from './provider-settings.tsx'
export default function ProviderFixture() {
  const client = new Dsh('https://synthetic.invalid/dsh', 'synthetic')
  return <Scroll class="flex-1 bg-background" contentClass="p-4 pb-10"><ProviderSettings client={() => client} /></Scroll>
}
mount(ProviderFixture)
