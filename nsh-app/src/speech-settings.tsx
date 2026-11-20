import { cleanup, locale, signal, Text, View } from 'nsh'
import { Dsh } from './dsh.ts'
import { language, S } from './strings.ts'
import { desktopSettingsStrings } from './desktop-settings-strings.ts'
import { voicePolicy } from './voice-strings.ts'
import type { VoiceCatalog } from './voice.ts'

export interface SpeechCatalog extends Omit<VoiceCatalog, 'providers'> {
  providers: { id: string; name: string; location: 'host-local' | 'cloud'; languages: string[]; downloadSources?: string[];
    preparation: { phase: string; completedBytes?: number; totalBytes?: number; message?: string; steps?: { kind: string; status: string }[] } }[]
}
const labels: Record<string, string[]> = {
  en: ['Speech recognition', 'Recognition language', 'Download source', 'Automatic source', 'Use this local provider', 'Cancel preparation', 'Unavailable on this host'],
  zh: ['语音识别', '识别语言', '下载源', '自动选择下载源', '使用此本地服务', '取消准备', '此宿主不提供此功能'],
  'zh-Hant': ['語音辨識', '辨識語言', '下載來源', '自動選擇來源', '使用此本機服務', '取消準備', '此主機未提供此功能'],
  es: ['Reconocimiento de voz', 'Idioma de reconocimiento', 'Origen de descarga', 'Origen automático', 'Usar este proveedor local', 'Cancelar preparación', 'No disponible en este host'],
  fr: ['Reconnaissance vocale', 'Langue de reconnaissance', 'Source de téléchargement', 'Source automatique', 'Utiliser ce fournisseur local', 'Annuler la préparation', 'Indisponible sur cet hôte'],
  ko: ['음성 인식', '인식 언어', '다운로드 소스', '자동 소스 선택', '이 로컬 제공업체 사용', '준비 취소', '이 호스트에서 사용할 수 없음'],
  ja: ['音声認識', '認識言語', 'ダウンロード元', 'ダウンロード元を自動選択', 'このローカルサービスを使う', '準備をキャンセル', 'このホストでは利用できません'],
  ru: ['Распознавание речи', 'Язык распознавания', 'Источник загрузки', 'Автовыбор источника', 'Использовать локального провайдера', 'Отменить подготовку', 'Недоступно на этом хосте'],
}
function copy() { const l = (language() === 'system' ? locale() : language()).replace(/_/g, '-'); return labels[l.startsWith('zh') ? /hant|tw|hk|mo/i.test(l) ? 'zh-Hant' : 'zh' : l.split('-')[0]] ?? labels.en }
const words = () => desktopSettingsStrings(language() === 'system' ? locale() : language())

/** Host owns model preparation beyond this component's lifetime. Closing only stops observation. */
export function SpeechSettings(props: { client: () => Pick<Dsh, 'rpc' | 'stream'> }) {
  const catalog = signal<SpeechCatalog | undefined>(undefined), error = signal(''), busy = signal(false), source = signal(''), unavailable = signal(false)
  let alive = true
  const receive = (value: unknown) => { if (alive) { catalog.set(value as SpeechCatalog); unavailable.set(false) } }
  const stop = props.client().stream('speech/follow', {}, receive, () => { if (alive) error.set(words().failed) })
  const read = async () => {
    try { receive(await props.client().rpc<SpeechCatalog>('speech/catalog', {})); if (alive) error.set('') }
    catch { if (alive) { unavailable.set(true); error.set(words().failed) } }
  }
  void read()
  cleanup(() => { alive = false; stop() })
  const run = async (endpoint: string, args: Record<string, unknown>, expected?: { providerId?: string; language?: string }) => {
    if (busy()) return
    busy.set(true); error.set('')
    try {
      let failed = false
      try { await props.client().rpc(endpoint, args) } catch { failed = true }
      const actual = await props.client().rpc<SpeechCatalog>('speech/catalog', {})
      receive(actual)
      if ((expected && Object.entries(expected).some(([key, value]) => actual.selection[key as keyof typeof actual.selection] !== value)) || (failed && !expected)) error.set(words().uncertain)
    } catch { if (alive) error.set(words().uncertain) }
    finally { if (alive) busy.set(false) }
  }
  const button = (id: string, label: string, press: () => void, disabled = false) => <View role="button" testID={id} accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy() }} onPress={() => { if (!disabled && !busy()) press() }} class={`min-h-[44px] rounded-[9px] justify-center px-3 bg-secondary ${disabled || busy() ? 'opacity-40' : 'active:opacity-60'}`}><Text class="text-foreground text-[14px]">{label}</Text></View>
  return <View testID="speech-settings" class="rounded-[14px] border border-border bg-card p-[14px] gap-3">
    <Text class="text-foreground text-[15px] font-medium">{copy()[0]}</Text>
    <Text class="text-muted-foreground text-[13px]">{words().speechHint}</Text>
    <Text class="text-muted-foreground text-[12px]">{voicePolicy(language() === 'system' ? locale() : language())}</Text>
    <If when={unavailable()}><Text class="text-muted-foreground text-[13px]">{copy()[6]}</Text></If>
    <Each of={catalog()?.providers.filter(p => p.location === 'host-local') ?? []} key={p => p.id}>{p => <View class="gap-2 border-t border-border pt-3">
      <Text class="text-foreground text-[14px] font-medium">{p().name}</Text>
      <Text testID={`speech-phase-${p().id}`} class="text-muted-foreground text-[13px]">{p().preparation.phase === 'ready' || p().preparation.phase === 'standby' ? words().prepared : p().preparation.phase === 'unprepared' || p().preparation.phase === 'cancelled' ? words().notConfigured : p().preparation.phase === 'failed' ? words().rejected : words().preparing}</Text>
      <If when={p().preparation.completedBytes !== undefined}><Text class="text-muted-foreground text-[13px]">{`${((p().preparation.completedBytes ?? 0) / 1e6).toFixed(1)} / ${p().preparation.totalBytes === undefined ? '?' : ((p().preparation.totalBytes ?? 0) / 1e6).toFixed(1)} MB`}</Text></If>
      <If when={p().preparation.phase === 'failed' && p().preparation.message}><Text class="text-destructive text-[13px]">{p().preparation.message}</Text></If>
      {button(`speech-provider-${p().id}`, `${catalog()?.selection.providerId === p().id ? '✓ ' : ''}${copy()[4]}`, () => void run('speech/configure', { patch: { providerId: p().id, language: p().languages.includes(catalog()?.selection.language ?? '') ? catalog()!.selection.language : p().languages[0] } }, { providerId: p().id }))}
      <If when={catalog()?.selection.providerId === p().id}>
        <Text class="text-muted-foreground text-[13px]">{copy()[1]}</Text><View class="flex-row flex-wrap gap-2">{p().languages.map(l => button(`speech-language-${p().id}-${l}`, `${catalog()?.selection.language === l ? '✓ ' : ''}${l}`, () => void run('speech/configure', { patch: { language: l } }, { language: l })))}</View>
      </If>
      <If when={['unprepared', 'cancelled', 'failed'].includes(p().preparation.phase)} else={['ready', 'standby'].includes(p().preparation.phase) ? null : button(`speech-cancel-${p().id}`, copy()[5], () => void run('speech/cancelPreparation', { providerId: p().id }), p().preparation.phase === 'cancelling')}>
        <Text class="text-muted-foreground text-[13px]">{copy()[2]}</Text><View class="gap-2">{button(`speech-source-${p().id}-auto`, `${source() === '' ? '✓ ' : ''}${copy()[3]}`, () => source.set(''))}{(p().downloadSources ?? []).map((s, i) => button(`speech-source-${p().id}-${i}`, `${source() === s ? '✓ ' : ''}${s}`, () => source.set(s)))}</View>
        {button(`speech-prepare-${p().id}`, words().prepare, () => void run('speech/prepare', { providerId: p().id, ...(source() && p().downloadSources?.includes(source()) ? { options: { downloadSource: source() } } : {}) }))}
      </If>
    </View>}</Each>
    <If when={error()}><Text testID="speech-settings-error" class="text-destructive text-[13px]">{error()}</Text></If>
    {button('speech-settings-refresh', S.retry, () => void read())}
  </View>
}
