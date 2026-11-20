import type { DesktopConfiguration } from './desktop-settings.ts'
import type { TranslationLimits, WebCatalog } from './capability-settings.ts'
export function capabilityFixture() {
  const configuration: DesktopConfiguration = { writable: true, hasDocument: true, namespaces: [
    { ns: 'mounted-web', revision: 3, applies: 'live', autoGenerate: false, secrets: [],
      schema: { uid: 1, refs: { 1: { type: 'object', dict: { searchProvider: 2, fetchProvider: 2 } }, 2: { type: 'string' } } },
      value: { searchProvider: 'removed-search', fetchProvider: 'fetch-local' }, user: { searchProvider: 'removed-search', fetchProvider: 'fetch-local' }, base: {},
    },
    { ns: 'mounted-translation', revision: 9, applies: 'live', autoGenerate: false, secrets: [],
      schema: { uid: 1, refs: { 1: { type: 'object', dict: { provider: 2, targetLanguage: 3 } }, 2: { type: 'union', list: [4, 5, 6, 7] }, 3: { type: 'string' }, 4: { type: 'const', value: 'bing' }, 5: { type: 'const', value: 'google' }, 6: { type: 'const', value: 'deepseek-account' }, 7: { type: 'const', value: 'deepseek-official' } } },
      value: { provider: 'deepseek-account', targetLanguage: 'auto' }, base: { provider: 'bing', targetLanguage: 'auto' }, user: { provider: 'deepseek-account' },
    },
  ] }
  const web: WebCatalog = { search: [{ id: 'search-local', title: 'Synthetic search', description: { en: 'Registered synthetic search, not a readiness check.', zh: '已注册的合成搜索，不代表可用。' } }], fetch: [{ id: 'fetch-local', description: 'Synthetic fetch provider' }] }
  const translation: TranslationLimits = { preferences: { provider: 'deepseek-account', targetLanguage: 'auto' }, maxTextChars: 4000, availableProviders: ['bing', 'google'] }
  return { configuration, web, translation }
}
