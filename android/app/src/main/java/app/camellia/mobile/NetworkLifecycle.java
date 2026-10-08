package app.camellia.mobile;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.function.LongSupplier;

/** One worker owns the native resource; the lock protects only its published state. */
final class NetworkLifecycle<N> {
    interface Backend<N> {
        N create() throws Exception;
        void close(N node) throws Exception;
        void saveMode(boolean enabled) throws Exception;
        void forget() throws Exception;
    }

    private static final long RETENTION_MS = 5 * 60_000;
    private final Object lock = new Object();
    private final Backend<N> backend;
    private final ExecutorService worker;
    private final LongSupplier clock;
    private final LongSupplier route;
    private boolean enabled;
    private boolean savedMode;
    private long modeRevision;
    private long generation;
    private long routeRevision;
    private long backgroundDeadline;
    private int transfers;
    private N ready;
    private Creation<N> creation;
    private CompletableFuture<Void> modeSave = CompletableFuture.completedFuture(null);
    // Accessed only by the worker. Detaching ready never releases ownership of the directory.
    private N owned;

    NetworkLifecycle(Backend<N> backend, ExecutorService worker, LongSupplier clock, LongSupplier route, boolean enabled) {
        this.backend = backend; this.worker = worker; this.clock = clock; this.route = route;
        this.enabled = enabled; savedMode = enabled; routeRevision = route.getAsLong();
    }

    boolean enabled() { synchronized (lock) { return enabled; } }
    long backgroundDeadline() { synchronized (lock) { return backgroundDeadline; } }
    int transfers() { synchronized (lock) { return transfers; } }

    CompletableFuture<N> node() {
        Creation<N> cancelled;
        CompletableFuture<N> result;
        synchronized (lock) {
            cancelled = refreshRouteLocked();
            if (!enabled) result = failed(new IOException("Embedded network is disabled"));
            else if (expiredLocked()) result = failed(new IOException("Cancelled"));
            else if (ready != null) result = CompletableFuture.completedFuture(ready);
            else {
                if (creation == null) {
                    creation = new Creation<>(generation, routeRevision);
                    Creation<N> pending = creation;
                    worker.execute(() -> create(pending));
                }
                // Each caller owns its wait; cancelling it must not cancel another caller's initialization.
                result = creation.future.thenApply(value -> value);
            }
        }
        cancel(cancelled);
        return result;
    }

    CompletableFuture<Void> routeChanged() {
        Creation<N> cancelled;
        CompletableFuture<Void> result;
        synchronized (lock) {
            cancelled = refreshRouteLocked();
            // A barrier lets the debounced recovery notification follow any queued close.
            result = submitLocked(() -> {});
        }
        cancel(cancelled);
        return result;
    }

    private Creation<N> refreshRouteLocked() {
        long revision = route.getAsLong();
        if (revision == routeRevision) return null;
        routeRevision = revision;
        Creation<N> cancelled = invalidateLocked();
        submitLocked(this::closeOwned);
        return cancelled;
    }

    CompletableFuture<Void> setEnabled(boolean value) {
        Creation<N> cancelled;
        CompletableFuture<Void> result;
        synchronized (lock) {
            if (value == enabled) return modeSave;
            enabled = value;
            long revision = ++modeRevision;
            cancelled = invalidateLocked();
            result = new CompletableFuture<>();
            modeSave = result;
            worker.execute(() -> saveMode(value, revision, result));
        }
        cancel(cancelled);
        return result;
    }

    private void saveMode(boolean value, long revision, CompletableFuture<Void> result) {
        Exception failure = null;
        Creation<N> cancelled = null;
        try {
            backend.saveMode(value);
            synchronized (lock) { savedMode = value; }
        } catch (Exception error) {
            failure = error;
            synchronized (lock) {
                if (revision == modeRevision) {
                    enabled = savedMode;
                    cancelled = invalidateLocked();
                    modeSave = CompletableFuture.completedFuture(null);
                }
            }
        }
        cancel(cancelled);
        try { closeOwned(); }
        catch (Exception error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        if (failure == null) result.complete(null); else result.completeExceptionally(failure);
    }

    CompletableFuture<Void> close() { return invalidate(false); }
    CompletableFuture<Void> forget() { return invalidate(true); }

    private CompletableFuture<Void> invalidate(boolean forget) {
        Creation<N> cancelled;
        CompletableFuture<Void> result;
        synchronized (lock) {
            cancelled = invalidateLocked();
            result = submitLocked(() -> { closeOwned(); if (forget) backend.forget(); });
        }
        cancel(cancelled);
        return result;
    }

    void foreground() {
        Creation<N> cancelled = null;
        synchronized (lock) {
            if (expiredLocked()) {
                cancelled = invalidateLocked();
                submitLocked(this::closeOwned);
            }
            backgroundDeadline = 0;
        }
        cancel(cancelled);
    }

    void background() { synchronized (lock) { backgroundDeadline = clock.getAsLong() + RETENTION_MS; } }
    void endBackground() { synchronized (lock) { backgroundDeadline = clock.getAsLong(); } }
    void retainTransfer() { synchronized (lock) { transfers++; } }
    void releaseTransfer() { synchronized (lock) { if (transfers > 0) transfers--; } }

    CompletableFuture<Void> expire() {
        synchronized (lock) {
            return submitLocked(() -> {
                Creation<N> cancelled;
                synchronized (lock) {
                    // Foreground or a download may have arrived while this task was waiting in the queue.
                    if (!expiredLocked()) return;
                    cancelled = invalidateLocked();
                }
                cancel(cancelled);
                closeOwned();
            });
        }
    }

    private boolean expiredLocked() {
        return transfers == 0 && backgroundDeadline > 0 && clock.getAsLong() >= backgroundDeadline;
    }

    private Creation<N> invalidateLocked() {
        generation++;
        ready = null;
        Creation<N> cancelled = creation;
        creation = null;
        return cancelled;
    }

    private boolean currentLocked(Creation<N> pending) {
        return creation == pending && generation == pending.generation && enabled
            && route.getAsLong() == pending.routeRevision && !expiredLocked();
    }

    private void create(Creation<N> pending) {
        try {
            boolean current;
            synchronized (lock) { current = currentLocked(pending); }
            if (!current) { pending.future.completeExceptionally(new IOException("Cancelled")); return; }
            closeOwned();
            synchronized (lock) { current = currentLocked(pending); }
            if (!current) { pending.future.completeExceptionally(new IOException("Cancelled")); return; }
            N candidate = backend.create();
            owned = candidate;
            boolean publish;
            synchronized (lock) {
                publish = currentLocked(pending);
                if (publish) ready = candidate;
            }
            if (publish) pending.future.complete(candidate);
            else { closeOwned(); pending.future.completeExceptionally(new IOException("Cancelled")); }
        } catch (Exception error) { pending.future.completeExceptionally(error); }
        finally { synchronized (lock) { if (creation == pending) creation = null; } }
    }

    private void closeOwned() throws Exception {
        if (owned == null) return;
        backend.close(owned);
        owned = null;
    }

    private CompletableFuture<Void> submitLocked(Operation operation) {
        CompletableFuture<Void> result = new CompletableFuture<>();
        worker.execute(() -> {
            try { operation.run(); result.complete(null); }
            catch (Exception error) { result.completeExceptionally(error); }
        });
        return result;
    }

    private static void cancel(Creation<?> pending) {
        if (pending != null) pending.future.completeExceptionally(new IOException("Cancelled"));
    }

    private static <T> CompletableFuture<T> failed(Exception error) {
        CompletableFuture<T> result = new CompletableFuture<>();
        result.completeExceptionally(error);
        return result;
    }

    private interface Operation { void run() throws Exception; }
    private static final class Creation<N> {
        final long generation, routeRevision;
        final CompletableFuture<N> future = new CompletableFuture<>();
        Creation(long generation, long routeRevision) { this.generation = generation; this.routeRevision = routeRevision; }
    }
}
