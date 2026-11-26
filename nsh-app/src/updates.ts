// Which side to update when this app and the computer's plugin come from different DSH Anywhere releases. The
// companion says its release in /v1/capabilities (`release`, from 0.8.1), and DSH lists the plugin versions it can install
// (pluginManager/listVersions); the phone asks no one else. The plugin
// itself is updated by DSH Desktop's own plugin manager (Plugins in the sidebar), the Android app from the release's
// APK, and the iPhone app in TestFlight. The panel's name in each language is Desktop's own (dsh-client-ui-plugin-manager
// 0.2.2-rc.5 src/client/locales.ts `panel`; Desktop has no Korean or Traditional Chinese copy and shows English or Chinese).
import { locale } from 'nsh'
import { language } from './strings.ts'

export const APK_URL = 'https://github.com/jt-wang/dsh-anywhere/releases/latest/download/dsh-anywhere.apk'
export const UPDATE_GUIDE_URL = 'https://github.com/jt-wang/dsh-anywhere/blob/main/AGENT-INSTALL.md#5-update'

/** computer: its plugin is older than this app. apk / testflight: the computer's release is newer than this app. */
export type UpdateNotice = { kind: 'computer' | 'apk' | 'testflight'; version: string }

const parts = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** a comes after b; a version that isn't three numbers, such as a developer's build, is neither newer nor older. */
export function newer(a: string, b: string): boolean {
  const x = parts(a), y = parts(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}

/** @param app this app's version. @param release the computer's DSH Anywhere release, '' from a plugin before 0.8.1,
 *  which every release up to 0.1.10 shipped, so it is older than any app that reads this. @param installable whether
 *  DSH on the computer lists a newer DSH Anywhere it can install (pluginManager/listVersions, from npm). npm gets a
 *  release last, after its APK is Latest and its iPhone build is on TestFlight (docs/RELEASE.md), so until then the
 *  computer is not asked for an update it cannot install (0.1.20's app asked for companion 0.8.10, never on npm). */
export function updateNotice(app: string, release: string, os: string, installable: boolean): UpdateNotice | null {
  if (!parts(app)) return null
  if (!release || newer(app, release)) return installable ? { kind: 'computer', version: app } : null
  if (!newer(release, app)) return null
  return os === 'android' ? { kind: 'apk', version: release } : os === 'ios' ? { kind: 'testflight', version: release } : null
}

const en = {
  computerTitle: (v: string) => `Update DSH Anywhere on your computer to ${v}`,
  computerBody: 'The plugin on your computer is older than this app, so some features may not work. In DSH Desktop, open Plugins in the sidebar and update @jt-wang/dsh-anywhere.',
  guide: 'How to update',
  appTitle: (v: string) => `DSH Anywhere ${v} is available`,
  apkBody: 'Your computer runs a newer version than this app. Download the new app to keep them matched.',
  download: 'Download',
  testflightBody: 'Your computer runs a newer version than this app. Update DSH Anywhere in TestFlight.',
}
type Copy = typeof en
const copies: Record<string, Copy> = {
  en,
  zh: { computerTitle: (v) => `请把电脑上的 DSH Anywhere 更新到 ${v}`, computerBody: '电脑上的插件比这个 app 旧，部分功能可能用不了。在 DSH Desktop 侧边栏打开「插件」，更新 @jt-wang/dsh-anywhere。', guide: '更新方法', appTitle: (v) => `DSH Anywhere ${v} 已发布`, apkBody: '电脑上运行的版本比这个 app 新。下载新版 app，让两边版本一致。', download: '下载', testflightBody: '电脑上运行的版本比这个 app 新。请在 TestFlight 里更新 DSH Anywhere。' },
  'zh-Hant': { computerTitle: (v) => `請把電腦上的 DSH Anywhere 更新到 ${v}`, computerBody: '電腦上的外掛程式比這個 app 舊，部分功能可能無法使用。在 DSH Desktop 側邊欄開啟「插件」，更新 @jt-wang/dsh-anywhere。', guide: '更新方法', appTitle: (v) => `DSH Anywhere ${v} 已發布`, apkBody: '電腦上執行的版本比這個 app 新。下載新版 app，讓兩邊版本一致。', download: '下載', testflightBody: '電腦上執行的版本比這個 app 新。請在 TestFlight 中更新 DSH Anywhere。' },
  es: { computerTitle: (v) => `Actualiza DSH Anywhere en tu computadora a ${v}`, computerBody: 'El complemento de tu computadora es más antiguo que esta app, así que algunas funciones pueden no funcionar. En DSH Desktop, abre Complementos en la barra lateral y actualiza @jt-wang/dsh-anywhere.', guide: 'Cómo actualizar', appTitle: (v) => `DSH Anywhere ${v} está disponible`, apkBody: 'Tu computadora usa una versión más reciente que esta app. Descarga la nueva app para que coincidan.', download: 'Descargar', testflightBody: 'Tu computadora usa una versión más reciente que esta app. Actualiza DSH Anywhere en TestFlight.' },
  fr: { computerTitle: (v) => `Mettez à jour DSH Anywhere sur votre ordinateur vers ${v}`, computerBody: 'Le module de votre ordinateur est plus ancien que cette app : certaines fonctions peuvent ne pas marcher. Dans DSH Desktop, ouvrez Plugins dans la barre latérale et mettez à jour @jt-wang/dsh-anywhere.', guide: 'Comment mettre à jour', appTitle: (v) => `DSH Anywhere ${v} est disponible`, apkBody: 'Votre ordinateur utilise une version plus récente que cette app. Téléchargez la nouvelle app pour qu’elles correspondent.', download: 'Télécharger', testflightBody: 'Votre ordinateur utilise une version plus récente que cette app. Mettez à jour DSH Anywhere dans TestFlight.' },
  ko: { computerTitle: (v) => `컴퓨터의 DSH Anywhere를 ${v}(으)로 업데이트하세요`, computerBody: '컴퓨터의 플러그인이 이 앱보다 오래되어 일부 기능이 작동하지 않을 수 있습니다. DSH Desktop 사이드바에서 Plugins를 열고 @jt-wang/dsh-anywhere를 업데이트하세요.', guide: '업데이트 방법', appTitle: (v) => `DSH Anywhere ${v} 출시`, apkBody: '컴퓨터에서 이 앱보다 새 버전이 실행 중입니다. 새 앱을 다운로드해 버전을 맞추세요.', download: '다운로드', testflightBody: '컴퓨터에서 이 앱보다 새 버전이 실행 중입니다. TestFlight에서 DSH Anywhere를 업데이트하세요.' },
  ja: { computerTitle: (v) => `コンピュータの DSH Anywhere を ${v} に更新してください`, computerBody: 'コンピュータのプラグインがこのアプリより古いため、一部の機能が動かない場合があります。DSH Desktop のサイドバーで「プラグイン」を開き、@jt-wang/dsh-anywhere を更新してください。', guide: '更新方法', appTitle: (v) => `DSH Anywhere ${v} が利用可能です`, apkBody: 'コンピュータではこのアプリより新しいバージョンが動いています。新しいアプリをダウンロードしてそろえてください。', download: 'ダウンロード', testflightBody: 'コンピュータではこのアプリより新しいバージョンが動いています。TestFlight で DSH Anywhere を更新してください。' },
  ru: { computerTitle: (v) => `Обновите DSH Anywhere на компьютере до ${v}`, computerBody: 'Плагин на компьютере старее этого приложения, поэтому часть функций может не работать. В DSH Desktop откройте «Плагины» на боковой панели и обновите @jt-wang/dsh-anywhere.', guide: 'Как обновить', appTitle: (v) => `Доступна DSH Anywhere ${v}`, apkBody: 'На компьютере работает версия новее этого приложения. Скачайте новое приложение, чтобы версии совпадали.', download: 'Скачать', testflightBody: 'На компьютере работает версия новее этого приложения. Обновите DSH Anywhere в TestFlight.' },
}
export function updateStrings(tag: string): Copy {
  const lang = tag.toLowerCase().split('-')[0]!
  return copies[lang === 'zh' && /-(hant|tw|hk|mo)(-|$)/i.test(tag) ? 'zh-Hant' : lang] ?? en
}
export const U: Copy = new Proxy({} as Copy, { get: (_, key) => { const l = language(); return updateStrings(l === 'system' ? locale() : l === 'zh' ? 'zh-Hans' : l)[key as keyof Copy] } })
