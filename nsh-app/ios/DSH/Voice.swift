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
    private var maxSamples = 0
    private var active = true

    @MainActor
    func attach(_ view: NshAppView) {
        if let stale = try? FileManager.default.contentsOfDirectory(at: FileManager.default.temporaryDirectory, includingPropertiesForKeys: nil) {
            for url in stale where url.lastPathComponent.hasPrefix("dsh-voice-") && url.pathExtension == "wav" { try? FileManager.default.removeItem(at: url) }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(foreground), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
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
    @objc private func interrupted() { finish(cancel: true) }

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
            recorder = r; r.delegate = self
            guard r.prepareToRecord() else { throw NSError(domain: "voice", code: 5) }
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            guard r.record(forDuration: Double(maxSamples) / 16000) else { throw NSError(domain: "voice", code: 1) }
            // Also bound wall time if an audio route stalls sample delivery.
            timer = Timer.scheduledTimer(withTimeInterval: Double(maxSamples) / 16000 + 0.1, repeats: false) { [weak self] _ in self?.finish(cancel: false) }
        } catch { finish(cancel: false, error: "voice/recording") }
    }

    private func finish(cancel: Bool, error: String? = nil) {
        guard let reply = pending else { return }
        pending = nil; id = nil
        timer?.invalidate(); timer = nil
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
                  let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(maxSamples)) else { throw NSError(domain: "voice", code: 3) }
            try audio.read(into: buffer, frameCount: AVAudioFrameCount(min(Int64(maxSamples), audio.length)))
            guard buffer.frameLength > 0, let samples = buffer.int16ChannelData?[0] else { throw NSError(domain: "voice", code: 4) }
            let pcm = Data(bytes: samples, count: Int(buffer.frameLength) * 2)
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
    deinit { NotificationCenter.default.removeObserver(self); timer?.invalidate(); recorder?.stop(); if let file { try? FileManager.default.removeItem(at: file) } }
}
