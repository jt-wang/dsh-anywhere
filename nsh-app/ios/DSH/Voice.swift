import AVFoundation
import NativeShell
import UIKit

/// Foreground-only PCM16/16 kHz/mono. AVAudioRecorder's file header is NOT the wire format: normalize it to
/// the exact 44-byte header rc.5 validates. Delete the protected temporary file on normal settlement, and
/// sweep only this module's files on launch (the OS cannot run cleanup after a force kill).
final class Voice: NSObject, AVAudioRecorderDelegate {
    private var pending: NshHostReply?
    private var id: String?
    private var recorder: AVAudioRecorder?
    private var file: URL?
    private var timer: Timer?
    private var meter: Timer?
    private var maxSamples = 0
    private var active = true
    private weak var view: NshAppView?

    @MainActor
    func attach(_ view: NshAppView) {
        self.view = view
        if let stale = try? FileManager.default.contentsOfDirectory(at: FileManager.default.temporaryDirectory, includingPropertiesForKeys: nil) {
            for url in stale where url.lastPathComponent.hasPrefix("dsh-voice-") && url.pathExtension == "wav" { try? FileManager.default.removeItem(at: url) }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(foreground), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        view.handle("voice.record") { [self] data, reply in
            guard active, pending == nil else { return reply.reject("voice/busy") }
            guard let args = data as? [String: Any], let id = args["id"] as? String, !id.isEmpty,
                  let bytes = args["maxAudioBytes"] as? Double, let seconds = args["maxDurationSeconds"] as? Double,
                  bytes.isFinite, seconds.isFinite else { return reply.reject("voice/limits") }
            let samples = min(960_000, min(floor((bytes - 44) / 2), floor(seconds * 16000)))
            guard samples >= 1 else { return reply.reject("voice/limits") }
            self.id = id; pending = reply; maxSamples = Int(samples)
            AVAudioApplication.requestRecordPermission { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, self.id == id else { return }
                    guard granted else { return self.finish(cancel: false, error: "voice/permission") }
                    guard self.active else { return self.finish(cancel: true) }
                    self.begin()
                }
            }
        }
        // Asked before the system prompt, so the phone explains it first and, once refused, offers Settings instead.
        view.handle("voice.permission") { _, reply in
            let state: String
            switch AVAudioApplication.shared.recordPermission {
            case .granted: state = "granted"
            case .denied: state = "denied"
            default: state = "undetermined"
            }
            reply.resolve(["state": state])
        }
        view.handle("voice.settings") { _, reply in
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            reply.resolve(nil)
        }
        view.handle("voice.stop") { [self] data, reply in
            if matches(data) { finish(cancel: recorder == nil) }
            reply.resolve(nil)
        }
        view.handle("voice.cancel") { [self] data, reply in
            if matches(data) { finish(cancel: true) }
            reply.resolve(nil)
        }
    }

    private func matches(_ data: Any?) -> Bool { id != nil && (data as? [String: Any])?["id"] as? String == id }
    @objc private func background() { active = false; finish(cancel: true) }
    @objc private func foreground() { active = true }
    /// A call, Siri or another app's recording took the microphone: the take ends and says why, instead of vanishing.
    @objc private func interrupted(_ note: Notification) {
        guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .began else { return }
        DispatchQueue.main.async { self.finish(cancel: false, error: "voice/interrupted") }
    }

    private func begin() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default, options: [])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-voice-\(UUID().uuidString).wav")
            file = url
            let r = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
            recorder = r; r.delegate = self; r.isMeteringEnabled = true
            guard r.prepareToRecord() else { throw NSError(domain: "voice", code: 5) }
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            guard r.record(forDuration: Double(maxSamples) / 16000) else { throw NSError(domain: "voice", code: 1) }
            // Also bound wall time if an audio route stalls sample delivery.
            timer = Timer.scheduledTimer(withTimeInterval: Double(maxSamples) / 16000 + 0.1, repeats: false) { [weak self] _ in self?.finish(cancel: false) }
            // The first level says the microphone is live: the phone's timer starts from it, not from the permission prompt.
            level(0)
            meter = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                guard let self, let r = self.recorder else { return }
                r.updateMeters()
                self.level(max(0, min(1, (Double(r.averagePower(forChannel: 0)) + 50) / 50)))
            }
        } catch { finish(cancel: false, error: "voice/microphone") } // the session or recorder would not start: in use elsewhere
    }

    private func level(_ value: Double) {
        guard let id else { return }
        MainActor.assumeIsolated { view?.send("voice.level", ["id": id, "level": value]) }
    }

    private func finish(cancel: Bool, error: String? = nil) {
        guard let reply = pending else { return }
        pending = nil; id = nil
        timer?.invalidate(); timer = nil
        meter?.invalidate(); meter = nil
        recorder?.delegate = nil; recorder?.stop(); recorder = nil
        defer {
            if let file { try? FileManager.default.removeItem(at: file) }; file = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        if cancel { reply.resolve(nil); return }
        if let error { reply.reject(error); return }
        do {
            guard let file else { throw NSError(domain: "voice", code: 2) }
            let audio = try AVAudioFile(forReading: file, commonFormat: .pcmFormatInt16, interleaved: true)
            guard audio.processingFormat.sampleRate == 16000, audio.processingFormat.channelCount == 1,
                  let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: 16000) else { throw NSError(domain: "voice", code: 3) }
            // One read hands over at most a chunk, not the file (30720 of 32421 frames on the iOS 27 simulator).
            let frames = min(Int64(maxSamples), audio.length)
            var pcm = Data()
            while audio.framePosition < frames {
                try audio.read(into: buffer, frameCount: AVAudioFrameCount(min(Int64(buffer.frameCapacity), frames - audio.framePosition)))
                guard buffer.frameLength > 0, let samples = buffer.int16ChannelData?[0] else { break }
                pcm.append(Data(bytes: samples, count: Int(buffer.frameLength) * 2))
            }
            // Not one sample: the microphone never delivered (held by another app, a call or a screen recording).
            guard !pcm.isEmpty else { reply.reject("voice/microphone"); return }
            reply.resolve(["audioBase64": Self.wave(pcm).base64EncodedString()])
        } catch { reply.reject("voice/recording") }
    }

    static func wave(_ pcm: Data) -> Data {
        var data = Data()
        func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
        func u16(_ value: UInt16) { var n = value.littleEndian; withUnsafeBytes(of: &n) { data.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var n = value.littleEndian; withUnsafeBytes(of: &n) { data.append(contentsOf: $0) } }
        ascii("RIFF"); u32(UInt32(pcm.count + 36)); ascii("WAVEfmt "); u32(16); u16(1); u16(1)
        u32(16000); u32(32000); u16(2); u16(16); ascii("data"); u32(UInt32(pcm.count)); data.append(pcm)
        return data
    }

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) { finish(cancel: false, error: flag ? nil : "voice/recording") }
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) { finish(cancel: false, error: "voice/recording") }
    deinit { NotificationCenter.default.removeObserver(self); timer?.invalidate(); meter?.invalidate(); recorder?.stop(); if let file { try? FileManager.default.removeItem(at: file) } }
}
