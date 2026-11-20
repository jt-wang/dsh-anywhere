import { mount, Scroll } from 'nsh'
import { Dsh } from './dsh.ts'
import { CapabilitySettings } from './capability-settings.tsx'
const client = new Dsh('https://synthetic.invalid/dsh', 'synthetic')
mount(() => <Scroll class="flex-1 bg-background" contentClass="p-4 pb-10"><CapabilitySettings client={() => client} /></Scroll>)
