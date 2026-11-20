import type { SettingsNamespace } from './desktop-settings.ts'
// Minimal Schemastery envelope matching the installed owner's toJSON contract; real owner schema tested by Gateway fixture.
export function providerFixtureNamespace(): SettingsNamespace {
  return { ns: 'llm-pi-ai', revision: 7, autoGenerate: false, applies: 'live', secrets: [],
    schema: { uid: 1, refs: {
      1: { type: 'object', dict: { providers: 2 } }, 2: { type: 'dict', inner: 3 },
      3: { type: 'object', dict: { displayName: 4, api: 5, baseURL: 4, apiKeyEnv: 4, models: 8, retryPolicy: 10, modelOverrides: 10 } },
      4: { type: 'string' }, 5: { type: 'union', list: [6, 7] }, 6: { type: 'const', value: 'openai-completions' }, 7: { type: 'const', value: 'google-generative-ai' },
      8: { type: 'array', inner: 9 }, 9: { type: 'object', dict: { id: 4, name: 4, contextWindow: 11, maxTokens: 11, input: 8, reasoningEfforts: 10 } }, 10: { type: 'object', dict: {} }, 11: { type: 'number' },
    } },
    value: { providers: { local: { displayName: 'Synthetic local', api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1', apiKeyEnv: 'LOCAL_API_KEY', models: [{ id: 'alpha', name: 'Alpha', contextWindow: 8192, maxTokens: 1024, input: ['text'], compat: { supportsStore: false } }], compat: { supportsStore: false } } } },
    user: { providers: { local: { apiKeyEnv: 'LOCAL_API_KEY', baseURL: 'https://synthetic.invalid/v1', models: [{ id: 'alpha', name: 'Alpha', contextWindow: 8192, maxTokens: 1024, input: ['text'], compat: { supportsStore: false } }] } } }, base: { providers: {} },
  }
}
export const providerFixtureDirectory = [{ provider: 'local', displayName: 'Synthetic local', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'local'], declared: true, nativeAuth: { env: ['LOCAL_AMBIENT_TOKEN'], oauth: false } }, { provider: 'dormant', displayName: 'Dormant provider', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant'], declared: false }]
