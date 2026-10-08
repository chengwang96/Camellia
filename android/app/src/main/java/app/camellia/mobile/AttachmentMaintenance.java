package app.camellia.mobile;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** One process-owned collector for private attachments shared by all chat modes. */
final class AttachmentMaintenance {
    static final long GRACE_MS = TimeUnit.HOURS.toMillis(24);
    private static final Object gate = new Object();
    private static final ThreadLocal<Lease> imports = new ThreadLocal<>();
    private static final java.util.regex.Pattern FILE_ID = java.util.regex.Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    private static AttachmentMaintenance shared;
    private static long revision;
    private static int writers;
    private final Context context;
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1,
        task -> new Thread(task, "camellia-attachment-cleanup"));
    private final Set<Lease> leases = new HashSet<>();
    private final Set<String> released = new LinkedHashSet<>();
    private ScheduledFuture<?> scheduled;
    private boolean scanPending;

    private AttachmentMaintenance(Context context) {
        this.context = context.getApplicationContext();
        worker.setRemoveOnCancelPolicy(true);
        worker.execute(this::cleanupOfficeImports);
    }

    static AttachmentMaintenance get(Context context) {
        synchronized (gate) {
            if (shared == null) shared = new AttachmentMaintenance(context);
            return shared;
        }
    }

    static final class Write implements AutoCloseable {
        private boolean closed;
        private Write() { synchronized (gate) { writers++; revision++; } }
        @Override public void close() { synchronized (gate) { if (!closed) { closed = true; writers--; revision++; } } }
    }

    // No disk access takes place under the gate except deletion of one attachment and its companions.
    static Write writing() { return new Write(); }

    static Lease protect(Context context, Object... values) {
        Lease lease = new Lease(get(context)); lease.replace(values); return lease;
    }

    static final class Lease implements AutoCloseable {
        private final AttachmentMaintenance owner;
        private Set<String> ids = Set.of();
        private boolean closed;
        private Lease(AttachmentMaintenance owner) { this.owner = owner; }
        void replace(Object... values) {
            Set<String> next = new HashSet<>();
            for (Object value : values) for (String reference : AttachmentStore.references(value)) next.add(id(reference));
            synchronized (gate) {
                if (closed || ids.equals(next)) return;
                Set<String> removed = new HashSet<>(ids); removed.removeAll(next);
                ids = next; owner.leases.add(this); revision++;
                owner.releaseLocked(removed);
            }
        }
        private void created(String reference) {
            synchronized (gate) {
                if (closed) throw new IllegalStateException("Attachment import already closed");
                Set<String> next = new HashSet<>(ids); next.add(id(reference)); ids = next;
                owner.leases.add(this); revision++;
            }
        }
        Import captureImports() { return new Import(this); }
        @Override public void close() {
            synchronized (gate) {
                if (closed) return;
                closed = true; owner.leases.remove(this);
                if (!ids.isEmpty()) { revision++; owner.releaseLocked(ids); ids = Set.of(); }
            }
        }
    }

    static final class Import implements AutoCloseable {
        private final Lease previous;
        private Import(Lease lease) { previous = imports.get(); imports.set(lease); }
        @Override public void close() { if (previous == null) imports.remove(); else imports.set(previous); }
    }

    static void created(String reference) { Lease lease = imports.get(); if (lease != null) lease.created(reference); }

    static void release(Context context, Object... values) {
        Set<String> ids = new HashSet<>();
        for (Object value : values) for (String reference : AttachmentStore.references(value)) ids.add(id(reference));
        AttachmentMaintenance owner = get(context);
        synchronized (gate) { owner.releaseLocked(ids); }
    }

    private void releaseLocked(Set<String> ids) { if (released.addAll(ids)) scheduleLocked(); }
    private void scheduleLocked() {
        if (scheduled == null) scheduled = worker.schedule(() -> {
            boolean scan;
            synchronized (gate) { scheduled = null; scan = scanPending; }
            collect(scan);
        }, 250, TimeUnit.MILLISECONDS);
    }

    static void foreground(Context context) {
        AttachmentMaintenance owner = get(context);
        synchronized (gate) {
            long last = owner.context.getSharedPreferences("attachment-maintenance", Context.MODE_PRIVATE).getLong("lastSweep", 0);
            if (System.currentTimeMillis() - last >= GRACE_MS) owner.scanPending = true;
            if (owner.scanPending || !owner.released.isEmpty()) owner.scheduleLocked();
        }
    }

    static final class Result {
        int files, failed;
        long bytes;
        boolean deferred;
        Exception error;
    }

    // Also used by instrumentation to wait for the actual background pass.
    Future<Result> collectNow(boolean scan) {
        synchronized (gate) {
            scanPending |= scan;
            if (scheduled != null) { scheduled.cancel(false); scheduled = null; }
            return worker.submit(() -> collect(scan));
        }
    }

    private Result collect(boolean scan) {
        if (scan) cleanupOfficeImports();
        Result result = new Result();
        long stamp;
        Set<String> candidates, retained = new HashSet<>(), garbage = new HashSet<>();
        synchronized (gate) {
            stamp = revision;
            if (writers > 0) { result.deferred = true; scheduleLocked(); return result; }
            candidates = new LinkedHashSet<>(released);
            for (Lease lease : leases) retained.addAll(lease.ids);
        }
        try {
            for (String name : new String[]{"remote-private", "remote-discussions-private", "local-chat-private"})
                for (String reference : AttachmentStore.references(new CredentialStore(context, name).load())) retained.add(id(reference));
            databaseReferences(retained, garbage);
            Map<String, Set<String>> garbageById = new HashMap<>();
            for (String reference : garbage) {
                String id = id(reference); candidates.add(id);
                garbageById.computeIfAbsent(id, key -> new HashSet<>()).add(reference);
            }
            if (scan) oldFiles(candidates, System.currentTimeMillis());
            Set<String> acknowledged = new HashSet<>();
            for (String candidate : candidates) {
                synchronized (gate) {
                    if (stamp != revision || writers > 0) { result.deferred = true; scheduleLocked(); break; }
                    if (retained.contains(candidate) || delete(candidate, result)) {
                        released.remove(candidate);
                        acknowledged.addAll(garbageById.getOrDefault(candidate, Set.of()));
                    } else { result.failed++; released.add(candidate); }
                }
            }
            if (!acknowledged.isEmpty()) LocalChatWriter.get(context).acknowledgeAttachments(acknowledged);
            if (scan && !result.deferred) {
                synchronized (gate) {
                    if (stamp == revision && writers == 0) {
                        context.getSharedPreferences("attachment-maintenance", Context.MODE_PRIVATE).edit()
                            .putLong("lastSweep", System.currentTimeMillis()).apply();
                        scanPending = false;
                    } else { result.deferred = true; scheduleLocked(); }
                }
            }
        } catch (Exception error) {
            result.error = error;
            Log.w("CamelliaAttachments", "Attachment cleanup deferred; reference state could not be read", error);
        }
        return result;
    }

    private void cleanupOfficeImports() {
        try { OfficeImports.cleanup(new File(context.getCacheDir(), OfficeImports.DIRECTORY)); }
        catch (IOException error) { Log.w("CamelliaAttachments", "Could not remove interrupted Office imports", error); }
    }

    private void databaseReferences(Set<String> retained, Set<String> garbage) throws IOException {
        File file = LocalChatDatabase.file(context);
        if (!file.exists()) return;
        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY)) {
            if (database.getVersion() != 2) throw new IOException("Local attachment index is not verified");
            try (Cursor flag = database.rawQuery("SELECT value FROM flags WHERE name='migrated'", null)) {
                if (!flag.moveToFirst() || flag.getInt(0) != 1) throw new IOException("Local attachment migration is not verified");
            }
            try (Cursor rows = database.rawQuery("SELECT DISTINCT reference FROM refs", null)) {
                while (rows.moveToNext()) retained.add(id(rows.getString(0)));
            }
            try (Cursor rows = database.rawQuery("SELECT reference FROM garbage", null)) {
                while (rows.moveToNext()) garbage.add(rows.getString(0));
            }
        }
    }

    private static String id(String reference) {
        if (!AttachmentStore.isReference(reference)) throw new IllegalArgumentException("Invalid private attachment reference");
        return reference.substring(reference.indexOf(':') + 1);
    }
    private File directory() { return new File(context.getNoBackupFilesDir(), "chat-attachments"); }

    private void oldFiles(Set<String> candidates, long now) throws IOException {
        File directory = directory();
        if (!directory.exists()) return;
        try (var files = Files.newDirectoryStream(directory.toPath())) {
            for (var path : files) {
                String name = path.getFileName().toString();
                String candidate = name;
                for (String suffix : AttachmentStore.SUFFIXES) if (!suffix.isEmpty() && name.endsWith(suffix)) { candidate = name.substring(0, name.length() - suffix.length()); break; }
                if (!FILE_ID.matcher(candidate).matches()) continue;
                if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) continue;
                long modified = 0;
                for (String suffix : AttachmentStore.SUFFIXES) modified = Math.max(modified, new File(directory, candidate + suffix).lastModified());
                if (now - modified >= GRACE_MS) candidates.add(candidate);
            }
        }
    }

    private boolean delete(String id, Result result) throws IOException {
        File directory = directory().getCanonicalFile();
        boolean success = true;
        for (String suffix : AttachmentStore.SUFFIXES) {
            File file = new File(directory, id + suffix);
            if (!file.exists()) continue;
            if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)
                    || !file.getCanonicalFile().getParentFile().equals(directory)) throw new IOException("Unexpected private attachment path");
            long bytes = file.length();
            if (file.delete()) { result.files++; result.bytes += bytes; } else success = false;
        }
        return success;
    }
}
