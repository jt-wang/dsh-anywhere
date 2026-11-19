// Opt-in OS metadata; dedicated atomic journal, no network, wake lock or sampling timer.
package dev.dshmobile.nsh;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.AtomicFile;
import com.longbridge.nsh.NshView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

final class Diagnostics {
    private final Activity activity;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private NshView view;
    private boolean wanted, active;
    private BroadcastReceiver battery;
    private PowerManager.OnThermalStatusChangedListener heat;
    private int thermal = -1;
    private final PowerManager power;
    Diagnostics(Activity activity) { this.activity = activity; power = activity.getSystemService(PowerManager.class); }

    private AtomicFile journal(String name) throws Exception {
        File dir = new File(activity.getNoBackupFilesDir(), "diagnostics");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("diagnostics/storage");
        return new AtomicFile(new File(dir, name));
    }
    static File exported(Context context) { return new File(context.getCacheDir(), "DSH Anywhere Diagnostics.json"); }

    // Native file sinks accept only this schema, never arbitrary diagnostic text.
    private static boolean keys(JSONObject value, String... allowed) {
        Set<String> names = new HashSet<>(); value.keys().forEachRemaining(names::add);
        return names.equals(new HashSet<>(Arrays.asList(allowed)));
    }
    private static boolean subset(JSONObject value, String... allowed) {
        Set<String> names = new HashSet<>(); value.keys().forEachRemaining(names::add);
        return new HashSet<>(Arrays.asList(allowed)).containsAll(names);
    }
    private static boolean number(Object v, double max) { return v instanceof Number && Double.isFinite(((Number) v).doubleValue()) && ((Number) v).doubleValue() >= 0 && ((Number) v).doubleValue() <= max; }
    private static boolean choice(Object v, String... options) { return v instanceof String && Arrays.asList(options).contains(v); }
    private static boolean event(JSONObject e) {
        if (!keys(e, "at", "category", "event", "fields") || !number(e.opt("at"), 1e15)) return false;
        JSONObject f = e.optJSONObject("fields");
        if (f == null) return false;
        String type = e.optString("category") + ":" + e.optString("event");
        switch (type) {
            case "interaction:ui.action": return keys(f, "action") && choice(f.opt("action"), "menu", "new_chat", "settings", "back", "refresh");
            case "interaction:app.lifecycle": return keys(f, "state") && choice(f.opt("state"), "foreground", "background");
            case "performance:ui.callback_gap": return keys(f, "durationMs", "method") && number(f.opt("durationMs"), 3600000) && choice(f.opt("method"), "next_task_not_fps");
            case "network:rpc.complete":
                return subset(f, "operation", "outcome", "durationMs", "status", "bytesReceived", "bytesSource")
                    && choice(f.opt("operation"), "list", "history", "projects", "capabilities", "progress", "command", "other")
                    && choice(f.opt("outcome"), "ok", "timeout", "unauthorized", "http_error", "rpc_error", "network_error")
                    && number(f.opt("durationMs"), 3600000) && (!f.has("status") || number(f.opt("status"), 599))
                    && (f.has("bytesReceived") ? number(f.opt("bytesReceived"), 1e12) && choice(f.opt("bytesSource"), "content_length") : !f.has("bytesSource"));
            case "resources:os.snapshot":
                return f.length() > 0 && subset(f, "batteryPercent", "charging", "thermal", "lowPower")
                    && (!f.has("batteryPercent") || number(f.opt("batteryPercent"), 100))
                    && (!f.has("charging") || choice(f.opt("charging"), "charging", "full", "unplugged", "unknown"))
                    && (!f.has("thermal") || choice(f.opt("thermal"), "nominal", "fair", "serious", "critical", "unknown"))
                    && (!f.has("lowPower") || f.opt("lowPower") instanceof Boolean);
            default: return false;
        }
    }
    private static boolean allowed(String text, boolean exported) {
        try {
            JSONArray events;
            if (!exported) events = new JSONArray(text);
            else {
                JSONObject root = new JSONObject(text);
                if (!keys(root, "schemaVersion", "exportId", "app", "range", "actualRange", "categories", "events") || root.getInt("schemaVersion") != 1) return false;
                java.util.UUID.fromString(root.getString("exportId"));
                JSONObject app = root.getJSONObject("app");
                if (!keys(app, "version", "build", "platform", "os", "deviceClass", "runtime") || !app.isNull("runtime")
                    || !choice(app.opt("platform"), "ios", "android", "unknown") || !choice(app.opt("deviceClass"), "phone", "tablet", "unknown")) return false;
                for (String key : new String[]{"version", "build", "os"}) if (!app.isNull(key) && (!(app.opt(key) instanceof String) || app.getString(key).length() > 32 || !app.getString(key).matches("\\d+(?:\\.\\d+){0,3}"))) return false;
                for (String key : new String[]{"range", "actualRange"}) {
                    if (key.equals("actualRange") && root.isNull(key)) continue;
                    JSONObject range = root.getJSONObject(key);
                    if (!keys(range, "from", "to")) return false;
                    for (String bound : new String[]{"from", "to"}) if (!number(range.opt(bound), 1e15)) return false;
                }
                JSONArray categories = root.getJSONArray("categories");
                if (categories.length() > 4) return false;
                for (int i = 0; i < categories.length(); i++) if (!choice(categories.get(i), "interaction", "performance", "network", "resources")) return false;
                events = root.getJSONArray("events");
            }
            if (events.length() > 800) return false;
            for (int i = 0; i < events.length(); i++) if (!event(events.getJSONObject(i))) return false;
            return true;
        } catch (Exception e) { return false; }
    }

    private static boolean preferences(String text) {
        try {
            JSONObject v = new JSONObject(text), categories = v.getJSONObject("categories");
            if (!keys(v, "enabled", "categories") || !(v.opt("enabled") instanceof Boolean) || !keys(categories, "interaction", "performance", "network", "resources")) return false;
            for (String key : new String[]{"interaction", "performance", "network", "resources"}) if (!(categories.opt(key) instanceof Boolean)) return false;
            return true;
        } catch (Exception e) { return false; }
    }
    private static String read(AtomicFile file, int limit) throws Exception {
        try (java.io.InputStream in = file.openRead()) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = in.read(chunk)) != -1) {
                if (bytes.size() + count > limit) throw new java.io.IOException("diagnostics/size");
                bytes.write(chunk, 0, count);
            }
            return bytes.toString(StandardCharsets.UTF_8.name());
        } catch (java.io.FileNotFoundException e) { return null; }
    }

    void attach(NshView view) {
        this.view = view;
        view.handle("diagnostics.preferences.read", (data, reply) -> io.execute(() -> {
            try {
                String text = read(journal("preferences.json"), 1024);
                if (text != null && !preferences(text)) throw new java.io.IOException("diagnostics/format");
                reply.resolve(text);
            } catch (Exception e) { reply.reject("diagnostics/preferences"); }
        }));
        view.handle("diagnostics.preferences.write", (data, reply) -> {
            String text = text(data);
            if (text == null || text.length() > 1024 || !preferences(text)) { reply.reject("diagnostics/format"); return; }
            io.execute(() -> {
                try {
                    AtomicFile file = journal("preferences.json"); FileOutputStream out = file.startWrite();
                    try { out.write(text.getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
                    catch (Exception e) { file.failWrite(out); throw e; }
                    reply.resolve(null);
                } catch (Exception e) { reply.reject("diagnostics/preferences"); }
            });
        });
        view.handle("diagnostics.read", (data, reply) -> io.execute(() -> {
            try {
                // openRead recovers an interrupted atomic write's backup.
                reply.resolve(read(journal("journal.json"), 131072));
            } catch (Exception e) { reply.reject("diagnostics/read"); }
        }));
        view.handle("diagnostics.write", (data, reply) -> {
            String text = text(data);
            if (text == null || text.getBytes(StandardCharsets.UTF_8).length > 131072 || !allowed(text, false)) { reply.reject("diagnostics/format"); return; }
            io.execute(() -> {
                try {
                    AtomicFile file = journal("journal.json"); FileOutputStream out = file.startWrite();
                    try { out.write(text.getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
                    catch (Exception e) { file.failWrite(out); throw e; }
                    reply.resolve(null);
                } catch (Exception e) { reply.reject("diagnostics/write"); }
            });
        });
        view.handle("diagnostics.clear", (data, reply) -> io.execute(() -> {
            try {
                journal("journal.json").delete();
                if (journal("journal.json").getBaseFile().exists()) throw new java.io.IOException("diagnostics/clear");
                File file = exported(activity);
                if (file.exists() && !file.delete()) throw new java.io.IOException("diagnostics/clear");
                reply.resolve(null);
            } catch (Exception e) { reply.reject("diagnostics/clear"); }
        }));
        view.handle("diagnostics.resources", (data, reply) -> activity.runOnUiThread(() -> {
            wanted = data instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) data).get("enabled"));
            watch(); reply.resolve(null);
        }));
        view.handle("diagnostics.share", (data, reply) -> {
            String text = text(data);
            if (text == null || text.getBytes(StandardCharsets.UTF_8).length > 262144 || !allowed(text, true)) { reply.reject("diagnostics/format"); return; }
            io.execute(() -> {
                try {
                    Files.write(exported(activity).toPath(), text.getBytes(StandardCharsets.UTF_8));
                    activity.runOnUiThread(() -> {
                        try {
                            Uri uri = Uri.parse("content://" + activity.getPackageName() + ".diagnostics/diagnostics.json");
                            Intent send = new Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TITLE, "DSH Anywhere Diagnostics")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            send.setClipData(android.content.ClipData.newRawUri("DSH Anywhere Diagnostics", uri));
                            activity.startActivity(Intent.createChooser(send, "DSH Anywhere Diagnostics")); reply.resolve(null);
                        } catch (RuntimeException e) { reply.reject("diagnostics/share"); }
                    });
                } catch (Exception e) { reply.reject("diagnostics/share"); }
            });
        });
    }
    private static String text(Object data) { Object v = data instanceof Map ? ((Map<?, ?>) data).get("text") : null; return v instanceof String ? (String) v : null; }
    void active(boolean value) { active = value; watch(); }
    private void watch() {
        if (battery != null) { activity.unregisterReceiver(battery); battery = null; }
        if (Build.VERSION.SDK_INT >= 29 && heat != null) { power.removeThermalStatusListener(heat); heat = null; }
        if (!wanted || !active) return;
        if (Build.VERSION.SDK_INT >= 29) {
            thermal = power.getCurrentThermalStatus();
            heat = value -> { thermal = value; snapshot(null); };
            power.addThermalStatusListener(activity.getMainExecutor(), heat);
        }
        battery = new BroadcastReceiver() { @Override public void onReceive(Context context, Intent intent) { snapshot(intent); } };
        // System-only sticky battery broadcast; no exported receiver or background service.
        activity.registerReceiver(battery, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    }
    private void snapshot(Intent batteryState) {
        if (!wanted || !active) return;
        Map<String, Object> out = new HashMap<>();
        out.put("thermal", thermal < 0 ? "unknown" : thermal == 0 ? "nominal" : thermal == 1 ? "fair" : thermal == 2 ? "serious" : "critical");
        out.put("lowPower", power.isPowerSaveMode());
        if (batteryState != null) {
            int level = batteryState.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = batteryState.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) out.put("batteryPercent", Math.round(100f * level / scale));
            int status = batteryState.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            out.put("charging", status == BatteryManager.BATTERY_STATUS_FULL ? "full" : status == BatteryManager.BATTERY_STATUS_CHARGING ? "charging" : status == -1 ? "unknown" : "unplugged");
        }
        view.send("diagnostics.resource", out);
    }
    void detach() { wanted = false; watch(); io.shutdown(); }
}
