# Native voice input — rc.5 extension

## Official alignment (2026-11-20)

This extends DSH's existing speech service and draft-only voice UI; it does not create a recognizer, cloud API,
credentials store, or Session event. Sources inspected in the isolated **0.2.2-rc.5** packages:

- `@deepseek-ai/dsh-experimental-api-speech-to-text/lib/index.js:136-139,148-153,193-214`: catalog limits,
  canonical base64 admission, WAV validation, provider resolution and transcription, without submitting a message.
- The same package's `lib/typert.remote-client.js`, `speech/catalog` and `speech/transcribe`: direct RPCs with
  `{}` and `{request:{audioBase64,providerId,language}}` respectively, returning `{text,audioSeconds,inferenceSeconds}`.
- `@deepseek-ai/dsh-experimental-speech-to-text/lib/types/wave.js:8-23`: exact 44-byte WAV header,
  **16000 Hz, mono, signed PCM16 little-endian**, no extra chunks, consistent RIFF/data lengths and duration.
- `@deepseek-ai/dsh-experimental-speech-to-text/lib/types/types.d.ts`: provider `location`, preparation phases,
  language catalog, provider-pinned routing. Catalog has **no cloud key readiness proof**.
- `@deepseek-ai/dsh-experimental-client-ui-voice-input@0.2.2-rc.5/package.json`: official product direction is
  “Record speech and insert editable text into the conversation draft”.
- [rc.5 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)
  contain search billing changes, not a replacement speech protocol. The public plans/Discussions check already
  recorded in `.dev/dsh-official-alignment.md` found no authoritative complete future roadmap. The existing
  ASR inspection is `.dev/dsh-settings-asr.md`; this work does not change its owner/settings implementation.

## Boundaries

`VoiceInput` defaults to the paired `dsh()` client and native `host.call`. It reads `speech/catalog` **before**
requesting microphone permission, selects only an advertised `host-local` provider (selected local first, otherwise
first local), pins its id/language for that take and refuses unprepared providers. A desktop cloud default is
never inherited. Cloud is disabled, including registered cloud providers, because authoritative configured-user-key
readiness cannot be verified. Policy/error copy explains this in all eight app languages. No key is bundled or
stored on the phone. “Local” means on the linked computer, not on the phone.

Native capture additionally clamps host limits to **60 seconds / 1,920,044 WAV bytes**. Android captures PCM with
`AudioRecord` into bounded memory; iOS uses `AVAudioRecorder` in the private temporary directory, then reads PCM
with `AVAudioFile` and rebuilds the canonical header. Its protected temporary file is removed on completion,
cancellation, error, background or interruption; a launch sweep removes this module's files left by force kill.
No audio, transcript or raw provider error is logged. No background recording service is declared.

`voice.record {id,maxAudioBytes,maxDurationSeconds}` stays pending until stop/limit and returns
`{audioBase64}` or `null` for cancellation. `voice.stop {id}` and `voice.cancel {id}` affect only that take.
Denied permission rejects `voice/permission`; cancellation during a permission prompt prevents a late grant from
starting recording. AudioRecord release belongs to its capture thread and occurs before settling. iOS stops,
deletes its file and deactivates the audio session. Android also has a wall-time watchdog for stalled capture.

Component unmount, disabled composer and `app.state {active:false}` invalidate late callbacks. **After upload,
cancel only discards the result**: the shared `Dsh.rpc` has no per-request cancellation handle and a 20-second
timeout. The host may finish recognition; UI says so. We do not retry recording or transcription automatically,
and do not claim remote cancellation or exactly-once inference.

## The flow (0.1.13)

DSH's own plugin is the reference (`client-ui-voice-input@0.2.2-rc.5`: README "an outline microphone icon between the
model selector and Send"; `VoiceInput.tsx:161` and `VoiceSetupDialog.tsx`: an unprepared local provider opens a setup
dialog, Go to setup / Later; `Waveform.tsx`: a level waveform while recording, Cancel and Stop; `readiness.ts`:
readiness is the host's `speech/follow` stream; `PreparationCard.tsx`: per-step progress and bytes, `setupEstimate`).
The phone extends it, with the same calls (`speech/catalog`, `speech/prepare`, `speech/follow`, `speech/transcribe`):

1. **Entry**: a 36 pt outline mic in the composer toolbar, immediately before Send, tinted like the attach and
   controls buttons. A child chat has none.
2. **Readiness before any microphone use** (`voiceReadiness`): a tap reads the catalog first. A sheet explains instead
   of recording when the plugin is off or DSH predates it (catalog 404: "In DSH Desktop, open Plugins and turn on
   Voice input"), only cloud is offered (choose the local service), the model is not prepared (size and time from
   `setupEstimate`, a one-tap **Download on computer** = `speech/prepare`, then live steps and MB from `speech/follow`
   until it turns into **Record**), the computer is out of reach, or the app is the sample (Try it).
3. **Permission**: `voice.permission` (iOS `AVAudioApplication.recordPermission`; Android `checkSelfPermission` plus a
   remembered "asked" and `shouldShowRequestPermissionRationale`, since Android has no "never asked") is read before
   recording. Undetermined: an explanation sheet, Continue goes on to the system prompt, Not now never asks. Denied
   (or refused at the prompt): a sheet with **Open Settings** (`voice.settings`).
4. **Recording**: the toolbar becomes Cancel, a red dot and `m:ss / 1:00`, a 32-bar level meter (native
   `voice.level {id, level}` events, 0–1 on a 50 dB scale, every 80 ms on iOS and every buffer on Android) and a
   primary Done (check) in Send's place. The timer starts at the first level, when the microphone is live, not at
   the permission prompt. Recording stops itself at the limit (min of 60 s and the host's catalog limits).
5. **Transcribing**: the bar says "Transcribing on your computer…"; the text is appended to the **current** draft for
   editing. Nothing is sent: `onText` is never wired to send.
6. **Failures** under the text field, each with its reason and next step, in eight languages, dismissable:
   `microphone`, `interrupted`, `offline`, `transcription`, `empty`, `limits`, `busy`, else generic. The native take
   ends, so the microphone is released, on every path (stop, cancel, failure, interruption, background, disabled).

```tsx
const voice = createVoiceInput({ disabled: () => !!child || !appActive(),
  blocked: () => trying() ? 'sample' : connection() !== 'online' || !live() ? 'offline' : undefined,
  onText: text => draft.set(draft() + (draft().trim() ? ' ' : '') + text) })
// under the text field: <voice.Status />; the toolbar: <If when={voice.active()} else={…, <voice.Button />, Send}><voice.Bar /></If>
// anywhere in the screen: <voice.Sheet />
```

## 0.1.13: why 0.1.12 failed and what each failure says

`host.call` rejects after **30 s** unless the call passes `timeout` (NSH `nsh-core/src/runtime/host.rs:23`,
`DEFAULT_TIMEOUT`). `voice.record` answers only when the take ends, so any take longer than 30 s, the first
permission prompt included, showed "Voice input failed", while the native recorder kept the microphone and refused
the next take with `voice/busy`. `voice.record` now passes `{ timeout: 0 }`; the native side bounds the take (60 s
timer on iOS, watchdog on Android). Regression: `voice.test.tsx` "a take that ends after 30 seconds" (real time: a
headless step waits for the native answer, so a manual clock cannot pass it); it fails on 0.1.12 with the screenshot's
text.

Failures name their side, as DSH's own kinds do (`interrupted`, `deviceMissing`, `failed: {message}`): native
`voice/microphone` (session or recorder would not start, or not one sample arrived), `voice/interrupted` (iOS
interruption began: a call, Siri or another app's recording), `voice/offline` (Dsh `network`, `timeout`, `http/*`),
`voice/transcription` (DSH's `speech/*` errors), else the generic text. iOS also reads the recorded file in a loop:
one `AVAudioFile.read` returned 30720 of 32421 frames on the iOS 27 simulator, cutting the end off.

Measured 2026-11-21 on an isolated DSH 0.2.2-rc.5 web host with the official voice bundle (scratch HOME): SenseVoice
answers in 0.08 s warm and 0.61 s from `standby` for a 2.8 s clip, so the phone's 20 s RPC timeout was not the cause;
the WAV the real `Voice.swift` produced on the iOS 27 simulator passes `speech/transcribe`'s validation. On the
simulator (with a NativeShell stub and permission granted in the test), stop returns the whole canonical WAV, an
interruption ends the take with `voice/interrupted`, and the next take records. Physical-device microphone, route and
screen-recording behavior remain unaccepted.

## Verification (0.1.13)

- `nsh test src/voice.test.tsx`: 11 passed, one per state (ready → timer and level → draft; cancel; download sheet →
  prepare → progress → Record; plugin off; offline and sample; primer; denied and Open Settings; each failure's text;
  localized copy; background and disabled cancel; the >30 s take). `src/voice.test.ts`: 10 passed.
- iOS SwiftPM probe on the iOS 27 simulator (NativeShell stub, permission granted in the test): whole WAV returned,
  interruption → `voice/interrupted` then a new take, 12 takes in a row, levels stream (18 in 1.5 s) and stop with the take.
- Screenshots of every state, light and dark, on the iOS simulator and the Android emulator: release acceptance report.
- Physical-device microphone, routes and screen recording remain device acceptance, not simulator evidence.
