// The Plugins page (src/plugins.tsx) over a synthetic DSH plugin manager, for src/plugins.test.tsx. host.params.mode:
// 'forbidden' | 'old' | 'down' says how listBundles answers; `answer` how a change ends ('restart' | 'fail').
// Each call is posted as fixture.rpc.
import { host, mount, View } from 'nsh'
import { PluginsPage } from '../../plugins.tsx'
import { ActionSheetHost } from '../../ui.tsx'

const params = (host.params ?? {}) as Record<string, any>
let mode: string | undefined = params.mode
host.on('fixture.mode', (v) => { mode = (v as { mode?: string }).mode })
// Shaped as DSH 0.2.2-rc.5 lists them: `meta` holds each bundle's locale/*.json text by language (dsh-app-boot
// readPluginMeta), here trimmed to en and zh. Computer use stands for a bundle whose metadata DSH couldn't read.
const bundles = [
  { name: '@deepseek-ai/dsh-experimental-voice-input-bundle', official: true, availability: 'installation', enabled: false, installed: true, optional: true, removable: false, description: 'Experimental voice input with local SenseVoice; downloads its runtime on first use', meta: { title: { en: 'Voice input', zh: '语音输入' }, description: { en: 'Transcribe recordings locally with SenseVoice; first use requires installing dependencies.', zh: '在本机使用 SenseVoice 转写录音，首次使用需安装依赖。' } }, rows: [], overrides: [] },
  { name: '@deepseek-ai/dsh-experimental-auto-review', official: true, availability: 'missing', installTarget: { spec: '@deepseek-ai/dsh-experimental-auto-review@0.2.2', version: '0.2.2' }, enabled: false, installed: false, optional: false, removable: true, listedByDefault: true, meta: { title: { en: 'Auto authorization review', zh: '自动授权审查' }, description: { en: 'Adds an Auto review access mode.', zh: '提供“自动审查”访问模式。' } }, rows: [], overrides: [] },
  { name: '@deepseek-ai/dsh-cua-bundle', official: true, availability: 'installation', enabled: true, installed: true, optional: true, removable: false, listedByDefault: true, description: 'Optional macOS Computer Use and permission setup', rows: [], overrides: [] },
]
const error = (code: string) => Object.assign(new Error(code), { code })
const client = () => ({
  rpc: async (name: string, args: any) => {
    host.post('fixture.rpc', { name, args })
    if (name === 'pluginManager/listBundles') {
      if (mode === 'forbidden') throw error('http/403')
      if (mode === 'old') throw error('http/404')
      if (mode === 'down') throw error('network')
      return bundles
    }
    const b = bundles.find(x => x.name === (args.name ?? args.options?.expected?.name))!
    if (params.answer === 'fail') return { changed: false, application: 'failed', stage: 'enable', target: b.name, error: { code: params.code ?? 'incompatible-version' } }
    b.enabled = name === 'pluginManager/installBundle' ? true : args.enabled
    if (name === 'pluginManager/installBundle') { b.availability = 'profile'; b.installed = true }
    return { changed: true, application: params.answer === 'restart' ? 'restart-required' : 'applied', stage: 'enable', target: b.name, enabled: b.enabled }
  },
}) as any

mount(() => <View class="flex-1 bg-background pt-[60px]"><PluginsPage client={client} /><ActionSheetHost /></View>)
