// The phone's link to the owner's computer, as host functions for the app:
//   link.state   → { paired: false } or { paired: true, origin, token } (origin = this phone's bridge to /dsh)
//   link.scan    → the text of a scanned QR (Google's code scanner: no camera permission for this app)
//   link.pair    { text } → as link.state; the one-time QR (or a dshm1: link) to a paired device
//   link.forget  → unpairs this phone on the computer (best effort) and forgets the link
//   link.tailcatOnly { on? } → { on }: reach the computer over Tailcat only (no relay, no local network), kept on the phone
//   event link.emoji { emoji } → an emoji pairing (bootstrap v2) waits for the computer's user to compare and confirm
// Pairing follows docs/TAILCAT.md: the QR opens a short-lived pairing node; TailPocket's connectmobile pairs this phone's
// durable Tailcat key there and returns its Link, whose payload is invitation v4; then the normal node, pinned TLS and
// POST /v1/pairings. The tunnel is connectmobile's (Connect, Path, Sync); Diagnose is DSH's own (dshtailcat).
package dev.dshmobile.nsh;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Build;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.longbridge.nsh.NshView;
import dev.dshmobile.tailcat.connectmobile.Connectmobile;
import dev.dshmobile.tailcat.dshtailcat.Dshtailcat;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

final class Link {
    private final Activity activity;
    private final Vault vault;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final SharedPreferences prefs;
    private NshView view;
    // One tunnel per process: an activity recreated in the same process (back, then reopen) must reuse it, since a
    // second Tailcat node with the same key leaves the new bridge's connections reset.
    private static long tunnel = -1;
    private static Bridge bridge;
    private static final long PAIR_OP = 1; // connectmobile's cancellable-operation number; one pairing at a time

    Link(Activity activity) {
        this.activity = activity;
        this.vault = new Vault(activity.getApplicationContext());
        this.prefs = activity.getApplicationContext().getSharedPreferences("dsh-link", Activity.MODE_PRIVATE);
        Connectmobile.setTailcatOnly(prefs.getBoolean("tailcatOnly", false));
    }

    void attach(NshView view) {
        this.view = view;
        // A new tunnel takes the setting (connectmobile reads it at Connect), so the app asks link.state again after.
        view.handle("link.tailcatOnly", (data, reply) -> work.execute(() -> {
            Object on = data instanceof Map ? ((Map<?, ?>) data).get("on") : null;
            if (on instanceof Boolean && (Boolean) on != prefs.getBoolean("tailcatOnly", false)) {
                prefs.edit().putBoolean("tailcatOnly", (Boolean) on).apply();
                Connectmobile.setTailcatOnly((Boolean) on);
                disconnect();
            }
            Map<String, Object> out = new HashMap<>();
            out.put("on", prefs.getBoolean("tailcatOnly", false));
            reply.resolve(out);
        }));
        view.handle("link.state", (data, reply) -> work.execute(() -> {
            try { reply.resolve(state()); } catch (Exception e) { reply.reject(message(e)); }
        }));
        view.handle("link.pair", (data, reply) -> work.execute(() -> {
            try { reply.resolve(pair(data instanceof Map ? String.valueOf(((Map<?, ?>) data).get("text")) : "")); } catch (Exception e) { reply.reject(message(e)); }
        }));
        // The app found the link dead (calls unanswered, the socket not opening): a new tunnel and bridge.
        view.handle("link.reset", (data, reply) -> work.execute(() -> {
            try { disconnect(); reply.resolve(state()); } catch (Exception e) { reply.reject(message(e)); }
        }));
        view.handle("link.forget", (data, reply) -> work.execute(() -> { forget(); reply.resolve(null); }));
        // Which part answers, for saying why the computer can't be reached: Dshtailcat.diagnose's answer (up to eight
        // seconds, so off the link's own thread) or {error}.
        view.handle("link.diagnose", (data, reply) -> new Thread(() -> {
            java.util.Map<String, Object> out = new java.util.HashMap<>();
            long handle = tunnel;
            if (handle < 0) { out.put("error", "no-tunnel"); reply.resolve(out); return; }
            try {
                JSONObject o = new JSONObject(Dshtailcat.diagnose(handle));
                for (java.util.Iterator<String> keys = o.keys(); keys.hasNext();) { String k = keys.next(); out.put(k, o.get(k)); }
            } catch (Exception e) { out.put("error", "unreadable"); }
            reply.resolve(out);
        }).start());
        // TailPocket's current route kind and DERP/relay metadata, or {route: "unknown"}.
        // Off the link's own thread: the answer may take up to three seconds (Connectmobile.path).
        view.handle("link.path", (data, reply) -> new Thread(() -> {
            long handle = tunnel;
            java.util.Map<String, Object> out = new java.util.HashMap<>();
            out.put("route", "unknown");
            if (handle >= 0) {
                try {
                    JSONObject o = new JSONObject(Connectmobile.path(handle, 3000));
                    if (o.has("route")) {
                        for (java.util.Iterator<String> keys = o.keys(); keys.hasNext();) { String k = keys.next(); out.put(k, o.get(k)); }
                    }
                } catch (Exception e) { /* unknown */ }
            }
            reply.resolve(out);
        }).start());
        view.handle("link.scan", (data, reply) -> activity.runOnUiThread(() ->
            GmsBarcodeScanning.getClient(activity, new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
                .startScan()
                .addOnSuccessListener(code -> reply.resolve(code.getRawValue()))
                .addOnCanceledListener(() -> reply.reject("cancelled"))
                .addOnFailureListener(e -> reply.reject(message(e)))));
    }

    /** Where the app's requests go: the bridge's /dsh origin and this phone's device token. */
    static final class Endpoint { final String origin, token; Endpoint(String origin, String token) { this.origin = origin; this.token = token; } }

    Endpoint endpoint() throws Exception {
        Map<String, Object> s = state();
        if (!Boolean.TRUE.equals(s.get("paired"))) throw new IOException("link/not-linked");
        return new Endpoint((String) s.get("origin"), (String) s.get("token"));
    }

    /** The paired computer's origin through the bridge, starting the tunnel if needed. */
    private Map<String, Object> state() throws Exception {
        String saved = vault.read();
        Map<String, Object> out = new HashMap<>();
        JSONObject link = saved == null ? null : new JSONObject(saved);
        if (link == null || !link.has("token")) { out.put("paired", false); return out; }
        Invite.Invitation inv = Invite.invitation(link.getString("invitation"));
        int port = connect(inv, link.getString("clientKey"), link.optString("tailpocket", null), this::saveSynced);
        out.put("paired", true);
        out.put("origin", "http://127.0.0.1:" + port + "/dsh");
        out.put("token", link.getString("token"));
        StringBuilder cacheId = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(link.getString("token").getBytes(StandardCharsets.UTF_8)))
            cacheId.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        out.put("cacheId", cacheId.toString());
        return out;
    }

    private Map<String, Object> pair(String text) throws Exception {
        Invite.Bootstrap boot = Invite.bootstrap(text.trim(), System.currentTimeMillis());
        JSONObject link = vault.read() == null ? new JSONObject() : new JSONObject(vault.read());
        if (!link.has("clientKey")) { link.put("clientKey", Connectmobile.newKey()); vault.write(link.toString()); }
        String clientKey = link.getString("clientKey");
        // 1. The pairing node: trade the QR's proof and this phone's public key for the computer's Link; its payload is
        // the invitation. The reply's address is the normal node's, so it replaces the payload's.
        // Bootstrap v2 (an emoji pairing): both screens show four emoji and the computer's user confirms there; the Link
        // then already carries the computer's routes (PairV2 syncs), so the tunnel starts from it.
        JSONObject paired;
        String pairedText = null;
        if (boot.invite2 != null) {
            String first = Connectmobile.pair2(PAIR_OP, boot.invite2, clientKey, Build.MODEL, "", 90_000);
            JSONObject shown = new JSONObject(first);
            if (shown.has("emoji")) {
                emoji(shown.getJSONArray("emoji"));
                try { first = Connectmobile.pair2Finish(PAIR_OP, 180_000); } finally { emoji(new org.json.JSONArray()); }
            }
            paired = linked(first);
            pairedText = first;
        } else {
            JSONObject invite = new JSONObject().put("v", 1).put("address", boot.address).put("port", Invite.PAIRING_PORT)
                .put("key", boot.key).put("proof", boot.proof).put("expiresAt", boot.expiresAtMs / 1000);
            paired = linked(Connectmobile.pair(PAIR_OP, invite.toString(), clientKey, Build.MODEL, "", 90_000));
        }
        JSONObject payload = new JSONObject(paired.optString("payload", "{}"));
        if (payload.has("tailcat")) payload.getJSONObject("tailcat").put("address", paired.getString("address"));
        Invite.Invitation inv = Invite.invitation(payload.toString());
        // 2. The computer itself, over pinned TLS: the one-time pairing token becomes this phone's device token.
        int port = connect(inv, clientKey, pairedText, this::saveSynced);
        JSONObject device = new JSONObject(http("POST", "http://127.0.0.1:" + port + "/v1/pairings", null,
            new JSONObject().put("pairingToken", inv.pairingToken).put("deviceName", Build.MODEL).toString()));
        link.put("invitation", inv.json).put("token", device.getString("deviceToken"));
        if (pairedText != null) link.put("tailpocket", pairedText);
        vault.write(link.toString());
        return state();
    }

    /** The four emoji to show while the computer's user compares them (none: the comparison is over). */
    private void emoji(org.json.JSONArray list) {
        NshView v = view;
        if (v == null) return;
        java.util.List<String> out = new java.util.ArrayList<>();
        for (int i = 0; i < list.length(); i++) out.add(list.optString(i));
        Map<String, Object> data = new HashMap<>();
        data.put("emoji", out);
        v.post(() -> v.send("link.emoji", data));
    }

    private void forget() {
        try {
            String saved = vault.read();
            Bridge b = bridge;
            if (saved != null && new JSONObject(saved).has("token") && b != null)
                http("DELETE", "http://127.0.0.1:" + b.port() + "/v1/device", "Bearer " + new JSONObject(saved).getString("token"), null);
        } catch (Exception ignored) {
            // offline: the computer keeps the device until its owner revokes it
        }
        disconnect();
        vault.clear();
    }

    /** Keeps the Link Sync returned, with the routes the computer added, for when Tailcat cannot be reached. */
    private void saveSynced(String synced) {
        work.execute(() -> {
            try {
                String saved = vault.read();
                if (saved == null) return;
                JSONObject link = new JSONObject(saved);
                if (!link.has("token")) return;
                vault.write(link.put("tailpocket", synced).toString());
            } catch (Exception ignored) {
                // the next start syncs again
            }
        });
    }

    private static synchronized int connect(Invite.Invitation inv, String clientKey, String saved, java.util.function.Consumer<String> onSynced) throws Exception {
        if (bridge != null && bridge.serves(inv)) return bridge.port();
        // Pairing with another computer: the old tunnel and bridge reach the old one.
        disconnect();
        // connectmobile's Link: the invitation's node and this phone's key (all a phone paired before TailPocket has),
        // or the one the last Sync stored for that same node and key, which also names the computer's opaque relay.
        JSONObject linkJson = new JSONObject().put("address", inv.address).put("port", inv.port).put("name", "").put("key", clientKey);
        try {
            JSONObject s = saved == null ? null : new JSONObject(saved);
            if (s != null && inv.address.equals(s.optString("address")) && clientKey.equals(s.optString("key"))) linkJson = s;
        } catch (Exception ignored) { /* the plain Link */ }
        JSONObject normal = started(Connectmobile.connect(linkJson.toString(), ""));
        tunnel = normal.getLong("handle");
        try {
            bridge = new Bridge(inv, normal.getInt("port"), normal.getString("token"));
        } catch (Exception e) {
            disconnect();
            throw e;
        }
        long handle = tunnel;
        new Thread(() -> {
            // Over Tailcat only, best effort: registers this phone's end-to-end key and fetches the computer's routes.
            String synced = Connectmobile.sync(handle, 30_000);
            try { if (!new JSONObject(synced).has("error")) onSynced.accept(synced); } catch (Exception ignored) { /* unsynced */ }
        }).start();
        return bridge.port();
    }

    private static synchronized void disconnect() {
        if (bridge != null) { bridge.close(); bridge = null; }
        if (tunnel >= 0) { Connectmobile.stop(tunnel); tunnel = -1; }
    }

    /** Connectmobile.connect's answer: {"handle":n,"port":p,"token":t,"base":b} or {"error":code}. */
    private static JSONObject started(String answer) throws Exception {
        JSONObject o = new JSONObject(answer);
        if (o.has("error")) throw new IOException("link/tunnel:" + o.getString("error"));
        return o;
    }

    /** Connectmobile.pair's answer: the Link, or {"error":code} worded as the app's link/ codes. */
    private static JSONObject linked(String answer) throws Exception {
        JSONObject o = new JSONObject(answer);
        if (!o.has("error")) return o;
        switch (o.getString("error")) {
            case "expired": throw new IOException("link/expired");
            case "invalid-invite": throw new IOException("link/invalid");
            case "unauthorized": throw new IOException("link/refused:401");
            case "taken": throw new IOException("link/refused:409");
            case "denied": throw new IOException("link/refused:403");
            default: throw new IOException("link/tunnel:" + o.getString("error"));
        }
    }

    private static String http(String method, String url, String auth, String body) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30_000);
        c.setReadTimeout(30_000);
        if (auth != null) c.setRequestProperty("Authorization", auth);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        int status = c.getResponseCode();
        try (InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream()) {
            String text = in == null ? "" : read(in);
            if (status == 410) throw new IOException("link/expired");
            if (status >= 400) throw new IOException("link/refused:" + status);
            return text;
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static String message(Throwable e) { return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); }
}
