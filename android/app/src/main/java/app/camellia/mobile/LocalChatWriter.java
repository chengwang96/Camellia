package app.camellia.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Process-owned storage queue; a destroyed Activity cannot cancel committed work. */
final class LocalChatWriter implements AutoCloseable {
    interface Work<T> { T run(LocalChatDatabase database) throws Exception; }
    private static LocalChatWriter shared;
    private final Context context;
    final ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, task -> new Thread(task, "camellia-local-storage"));
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LinkedHashMap<String, Pending> pending = new LinkedHashMap<>(), failed = new LinkedHashMap<>();
    private ScheduledFuture<?> drain;
    private LocalChatDatabase database;
    private boolean recovered;

    private static final class Pending {
        final Work<Void> work;
        final JSONObject snapshot;
        final AttachmentMaintenance.Lease attachments;
        final String run;
        LocalChatStore.Callback<Void> callback;
        Exception error;
        Pending(Work<Void> work, JSONObject snapshot, String run, LocalChatStore.Callback<Void> callback, AttachmentMaintenance.Lease attachments) { this.work = work; this.snapshot = snapshot; this.run = run; this.callback = callback; this.attachments = attachments; }
    }

    static synchronized LocalChatWriter get(Context context) {
        if (shared == null) shared = new LocalChatWriter(context);
        return shared;
    }

    private LocalChatWriter(Context context) {
        this.context = context.getApplicationContext();
        executor.setRemoveOnCancelPolicy(true);
        executor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    private LocalChatDatabase database() throws Exception {
        if (database == null) database = new LocalChatDatabase(context);
        return database;
    }

    <T> Future<T> call(Work<T> work) {
        return executor.submit(() -> { drainPending(false); return work.run(database()); });
    }

    <T> void submit(Work<T> work, LocalChatStore.Callback<T> callback) {
        executor.execute(() -> {
            try {
                drainPending(false);
                T value = work.run(database());
                main.post(() -> callback.done(value));
            } catch (Exception error) { main.post(() -> callback.failed(error)); }
        });
    }

    void coalesce(String key, Work<Void> work, JSONObject snapshot, String run, long delay, LocalChatStore.Callback<Void> callback) {
        AttachmentMaintenance.Lease attachments = AttachmentMaintenance.protect(context, snapshot);
        synchronized (pending) {
            Pending previous = pending.put(key, new Pending(work, snapshot, run, callback, attachments));
            if (previous != null) previous.attachments.close();
            if (drain == null || delay == 0 && drain.getDelay(TimeUnit.MILLISECONDS) > 0) {
                if (drain != null) drain.cancel(false);
                drain = executor.schedule(() -> drainPending(false), delay, TimeUnit.MILLISECONDS);
            }
        }
    }

    void discard(String prefix) {
        synchronized (pending) {
            pending.entrySet().removeIf(entry -> { if (!entry.getKey().startsWith(prefix)) return false; entry.getValue().attachments.close(); return true; });
            failed.entrySet().removeIf(entry -> { if (!entry.getKey().startsWith(prefix)) return false; entry.getValue().attachments.close(); return true; });
        }
    }

    void retryFailed() throws Exception {
        drainPending(true);
        synchronized (pending) {
            if (!failed.isEmpty()) throw new java.io.IOException("部分聊天数据尚未保存，请重试 / Some chat data is not saved; retry", failed.values().iterator().next().error);
        }
    }

    void recover(String notice) throws Exception {
        if (recovered) return;
        database().recover(notice); recovered = true;
    }

    void restorePending(LocalChatDatabase database, String id, JSONObject conversation) throws Exception {
        LinkedHashMap<String, Pending> snapshots = new LinkedHashMap<>();
        synchronized (pending) {
            for (var entry : failed.entrySet()) if (entry.getKey().equals(id + "/draft") || entry.getKey().startsWith(id + "/message/")) snapshots.put(entry.getKey(), entry.getValue());
        }
        Pending draft = snapshots.get(id + "/draft");
        if (draft != null) {
            for (String key : LocalChatRecord.DRAFT) conversation.remove(key);
            var keys = draft.snapshot.keys();
            while (keys.hasNext()) { String key = keys.next(); conversation.put(key, LocalChatRecord.copy(draft.snapshot.get(key))); }
        }
        String prefix = id + "/message/";
        for (var entry : snapshots.entrySet()) {
            if (!entry.getKey().startsWith(prefix)) continue;
            int position = Integer.parseInt(entry.getKey().substring(prefix.length()));
            try (android.database.Cursor row = database.db.rawQuery("SELECT run_id FROM records WHERE kind='message' AND owner=? AND position=?", new String[]{id, String.valueOf(position)})) {
                if (row.moveToFirst() && entry.getValue().run.equals(row.getString(0)))
                    conversation.getJSONArray("messages").put(position, LocalChatRecord.object(entry.getValue().snapshot));
            }
        }
    }

    private void drainPending(boolean retry) {
        LinkedHashMap<String, Pending> batch = new LinkedHashMap<>();
        synchronized (pending) {
            if (drain != null) { drain.cancel(false); drain = null; }
            if (retry) { batch.putAll(failed); failed.clear(); }
            for (var entry : pending.entrySet()) {
                Pending previous = batch.put(entry.getKey(), entry.getValue());
                if (previous != null) previous.attachments.close();
            }
            pending.clear();
        }
        for (var item : batch.entrySet()) {
            Pending value = item.getValue();
            LocalChatStore.Callback<Void> callback = value.callback; value.callback = null;
            try {
                value.work.run(database());
                synchronized (pending) { Pending previous = failed.remove(item.getKey()); if (previous != null) previous.attachments.close(); }
                value.attachments.close();
                if (callback != null) main.post(() -> callback.done(null));
            } catch (Exception error) {
                value.error = error;
                synchronized (pending) { Pending previous = failed.put(item.getKey(), value); if (previous != null) previous.attachments.close(); }
                if (callback != null) main.post(() -> callback.failed(error));
            }
        }
    }

    @Override public void close() throws Exception {
        executor.submit(() -> {
            synchronized (pending) {
                if (drain != null) drain.cancel(false);
                for (Pending value : pending.values()) value.attachments.close();
                for (Pending value : failed.values()) value.attachments.close();
                pending.clear(); failed.clear();
            }
            if (database != null) database.close();
        }).get(10, TimeUnit.SECONDS);
        executor.shutdown();
        synchronized (LocalChatWriter.class) { if (shared == this) shared = null; }
    }

    void acknowledgeAttachments(java.util.Set<String> references) {
        if (executor.isShutdown()) return;
        executor.execute(() -> {
            try {
                if (database != null) {
                    for (String reference : references) database.db.delete("garbage", "reference=?", new String[]{reference});
                } else if (LocalChatDatabase.file(context).exists()) {
                    try (var db = android.database.sqlite.SQLiteDatabase.openDatabase(LocalChatDatabase.file(context).getPath(), null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE)) {
                        for (String reference : references) db.delete("garbage", "reference=?", new String[]{reference});
                    }
                }
            } catch (Exception error) { android.util.Log.w("CamelliaAttachments", "Could not acknowledge collected attachments", error); }
        });
    }
}
