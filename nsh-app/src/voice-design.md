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

## Chat integration (owned by caller)

```tsx
import { VoiceInput } from './voice.tsx'

<VoiceInput disabled={/* offline, read-only, sample mode, or composer unavailable */}
  onText={text => draft.set(draft() + (draft().trim() ? ' ' : '') + text)}
  onError={message => error.set(message)} />
```

Use the **current** draft when the callback runs, not its value when recording began. Mount per chat and unmount
on chat switch; otherwise explicitly disable before switching. Do not wire `onText` to prompt/send. Empty
recognition and failures leave the draft alone. Optional `io` is for synthetic component tests only.

## Verification and remaining acceptance

- `nsh test src/voice.test.ts`: 10 passed; `nsh test src/voice.test.tsx`: 3 passed (headless synthetic UI).
- Full `nsh test`: 478 passed / 0 failed during shared-worktree development. `nsh check`: exit 0 on the later run.
  An earlier check caught unrelated in-progress continuation fixture API/type errors; those were not edited here.
- Java 17 compile of `Voice.java` against Android SDK 36 and the real pinned NSH Java source: passed.
  `VoiceWaveTest` on JUnit 4.13.2: 2 passed. This is not an APK/device microphone test.
- `.amp/in/orb-backup/voice-gateway/real-speech.mjs` runs the official Gateway + SpeechController + SpeechToText
  in a fresh isolated composition. Actual `Dsh` frames/path and **production Android WAV encoder output** reach
  an explicitly synthetic local PCM-verifier provider. It covers draft insertion, cloud-default avoidance,
  provider failure, empty text, invalid WAV/base64, size/permission rejection, late-result cancellation, and official
  transport cancellation propagation. Zero cloud calls, agent/model calls, external network/subprocess/outside
  writes/listeners. Receipt: `/tmp/voice-real-gateway.json`. This uses an in-memory fetch transport adapter, not TLS.
- No Android devices were attached. Xcode/iOS SDK are unavailable in the orb; no Mac satellite was touched.
  Native permission flows, real microphone samples, interruptions/routes, WAV output from AVFoundation, SenseVoice
  model accuracy/latency, physical devices, signed release/store permission declarations remain **unaccepted**.

Mac owner: run `NSH_SOURCE=<the existing patched pinned NSH checkout> nsh-app/ios/build.sh`, then an unsigned
Release device build if desired using the generated `nsh-app/ios/DSH.xcodeproj`. Check generated/built Info.plist
for `NSMicrophoneUsageDescription` and all eight localized `InfoPlist.strings`. Run on a fresh simulator for
permission allow/deny/cancel, background and interruption behavior (simulator is not a physical mic acceptance),
then use a physical iPhone and Android with a prepared official local model: speak, stop, confirm only draft
insertion; test cancel during permission/capture/transcription, 60-second limit, no-speech, offline, background,
repeat recording and chat switch. Ensure microphone indicators stop and no audio file remains after settlement.
The release owner must perform real ASR/device acceptance before claiming this feature release-ready.
