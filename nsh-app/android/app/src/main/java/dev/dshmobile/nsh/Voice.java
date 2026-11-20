package dev.dshmobile.nsh;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Map;

/** Foreground-only native PCM capture, bounded in memory. No audio files, credentials or networking. */
final class Voice {
    static final int REQUEST = 0x5D7;
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Take take;
    private boolean active = true, permissionPending;
    private static final class Take {
        final String id;
        final int samples;
        final NshHostReply reply;
        volatile boolean stop, cancel;
        Runnable deadline;
        AudioRecord recorder;
        Take(String id, int samples, NshHostReply reply) { this.id = id; this.samples = samples; this.reply = reply; }
    }
    Voice(Activity activity) { this.activity = activity; }

    void attach(NshView view) {
        view.handle("voice.record", (data, reply) -> activity.runOnUiThread(() -> {
            if (!active || take != null || permissionPending) { reply.reject("voice/busy"); return; }
            try {
                Map<?, ?> args = (Map<?, ?>) data;
                String id = (String) args.get("id");
                double bytes = ((Number) args.get("maxAudioBytes")).doubleValue();
                double seconds = ((Number) args.get("maxDurationSeconds")).doubleValue();
                if (id == null || id.isEmpty() || !Double.isFinite(bytes) || !Double.isFinite(seconds)) throw new IllegalArgumentException();
                int samples = (int) Math.min(960000, Math.min(Math.floor((bytes - 44) / 2), Math.floor(seconds * 16000)));
                if (samples < 1) throw new IllegalArgumentException();
                take = new Take(id, samples, reply);
                if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    permissionPending = true;
                    activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST);
                } else begin(take);
            } catch (RuntimeException e) {
                permissionPending = false;
                if (take != null) { take.reply.reject("voice/recording"); take = null; }
                else reply.reject("voice/limits");
            }
        }));
        view.handle("voice.stop", (data, reply) -> activity.runOnUiThread(() -> {
            if (matches(data)) {
                if (take.recorder == null) cancel(); // stopped during permission prompt: never start later
                else take.stop = true;
            }
            reply.resolve(null);
        }));
        view.handle("voice.cancel", (data, reply) -> activity.runOnUiThread(() -> {
            if (matches(data)) cancel();
            reply.resolve(null);
        }));
    }

    private boolean matches(Object data) { return take != null && data instanceof Map && take.id.equals(((Map<?, ?>) data).get("id")); }
    void active(boolean value) { active = value; if (!active) cancel(); }
    void permissionResult(int request) {
        if (request != REQUEST) return;
        permissionPending = false;
        Take t = take;
        if (t == null) return;
        if (!active) { cancel(); return; }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            take = null; t.reply.reject("voice/permission");
        } else begin(t);
    }

    @SuppressWarnings("MissingPermission")
    private void begin(Take t) {
        try {
            int min = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) throw new IllegalStateException();
            t.recorder = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 4096));
            if (t.recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException();
            t.recorder.startRecording();
            if (t.recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException();
            t.deadline = () -> { if (take == t) cancel(); };
            main.postDelayed(t.deadline, (long) Math.ceil(t.samples / 16.0) + 500);
            new Thread(() -> capture(t), "voice-pcm").start();
        } catch (RuntimeException e) {
            if (t.recorder != null) { t.recorder.release(); t.recorder = null; }
            if (take == t) take = null;
            t.reply.reject("voice/recording");
        }
    }

    private void capture(Take t) {
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        String error = null;
        try {
            short[] buffer = new short[1024];
            while (!t.stop && !t.cancel && pcm.size() / 2 < t.samples) {
                int n = t.recorder.read(buffer, 0, Math.min(buffer.length, t.samples - pcm.size() / 2), AudioRecord.READ_BLOCKING);
                if (n <= 0) { if (!t.cancel) error = "voice/recording"; break; }
                for (int i = 0; i < n; i++) { pcm.write(buffer[i] & 255); pcm.write((buffer[i] >> 8) & 255); }
            }
        } catch (RuntimeException e) { error = "voice/recording"; }
        finally {
            try { t.recorder.stop(); } catch (RuntimeException ignored) {}
            t.recorder.release();
        }
        String failure = error;
        main.post(() -> {
            if (t.deadline != null) main.removeCallbacks(t.deadline);
            if (take != t) return;
            take = null;
            if (t.cancel) t.reply.resolve(null);
            else if (failure != null || pcm.size() == 0) t.reply.reject("voice/recording");
            else t.reply.resolve(Map.of("audioBase64", Base64.encodeToString(wave(pcm.toByteArray()), Base64.NO_WRAP)));
        });
    }

    private void cancel() {
        Take t = take;
        if (t == null) return;
        t.cancel = true;
        // stop() unblocks read; release is exclusively the capture thread's responsibility.
        if (t.recorder != null) { try { t.recorder.stop(); } catch (RuntimeException ignored) {} }
        else { take = null; t.reply.resolve(null); }
    }

    static byte[] wave(byte[] pcm) {
        ByteBuffer b = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        b.put(new byte[] { 'R','I','F','F' }).putInt(36 + pcm.length).put(new byte[] { 'W','A','V','E','f','m','t',' ' });
        b.putInt(16).putShort((short) 1).putShort((short) 1).putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16);
        b.put(new byte[] { 'd','a','t','a' }).putInt(pcm.length).put(pcm);
        return b.array();
    }
}
