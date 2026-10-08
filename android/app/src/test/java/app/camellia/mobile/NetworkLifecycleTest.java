package app.camellia.mobile;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

public class NetworkLifecycleTest {
    private final ExecutorService worker = Executors.newSingleThreadExecutor(action -> new Thread(action, "lifecycle-unit"));
    private final ExecutorService ui = Executors.newSingleThreadExecutor();
    private final AtomicLong clock = new AtomicLong(1000);
    private final AtomicLong route = new AtomicLong();
    private final Backend backend = new Backend();
    private final NetworkLifecycle<Token> lifecycle = new NetworkLifecycle<>(backend, worker, clock::get, route::get, true);
    private CountDownLatch queueRelease;

    @After public void stop() throws Exception {
        backend.createRelease.countDown(); backend.closeRelease.countDown(); backend.modeRelease.countDown();
        if (queueRelease != null) queueRelease.countDown();
        lifecycle.close().get(3, TimeUnit.SECONDS);
        worker.shutdownNow(); ui.shutdownNow();
        assertTrue(worker.awaitTermination(3, TimeUnit.SECONDS));
    }

    @Test public void concurrentWaitersShareCreationAndOwnTheirCancellation() throws Exception {
        backend.blockCreation();
        CompletableFuture<Token> first = lifecycle.node();
        assertTrue(backend.createStarted.await(1, TimeUnit.SECONDS));
        CompletableFuture<Token> second = lifecycle.node();
        CompletableFuture<Token> third = lifecycle.node();
        assertTrue(first.cancel(true));
        backend.createRelease.countDown();
        assertSame(second.get(2, TimeUnit.SECONDS), third.get(2, TimeUnit.SECONDS));
        assertEquals(1, backend.created);
    }

    @Test public void slowCreationDoesNotHoldUiStateLock() throws Exception {
        backend.blockCreation();
        CompletableFuture<Token> pending = lifecycle.node();
        assertTrue(backend.createStarted.await(1, TimeUnit.SECONDS));
        responsive(() -> {
            lifecycle.background(); lifecycle.foreground();
            lifecycle.retainTransfer(); lifecycle.releaseTransfer();
            lifecycle.close();
        });
        cancelled(pending);
        backend.createRelease.countDown();
        lifecycle.close().get(2, TimeUnit.SECONDS);
        assertEquals(1, backend.closed);
    }

    @Test public void routeChangeDiscardsInFlightNodeBeforeReplacementUsesDirectory() throws Exception {
        backend.blockCreation();
        CompletableFuture<Token> old = lifecycle.node();
        assertTrue(backend.createStarted.await(1, TimeUnit.SECONDS));
        route.incrementAndGet();
        responsive(() -> lifecycle.routeChanged());
        cancelled(old);
        CompletableFuture<Token> next = lifecycle.node();
        assertFalse(next.isDone());
        backend.createRelease.countDown();
        assertEquals(2, next.get(2, TimeUnit.SECONDS).id);
        assertEquals(List.of("create:1", "close:1", "create:2"), backend.events);
    }

    @Test public void slowCloseKeepsUiResponsiveAndBlocksOnlyTheNextCreation() throws Exception {
        Token old = lifecycle.node().get(2, TimeUnit.SECONDS);
        backend.blockClose();
        CompletableFuture<Void> closed = lifecycle.close();
        assertTrue(backend.closeStarted.await(1, TimeUnit.SECONDS));
        responsive(() -> {
            lifecycle.background(); lifecycle.foreground();
            lifecycle.retainTransfer(); lifecycle.releaseTransfer();
        });
        CompletableFuture<Token> next = lifecycle.node();
        assertFalse(next.isDone()); assertEquals(1, backend.created);
        backend.closeRelease.countDown(); closed.get(2, TimeUnit.SECONDS);
        assertNotSame(old, next.get(2, TimeUnit.SECONDS));
        assertTrue(old.closed);
    }

    @Test public void forgettingDuringCreationCannotRepublishOldIdentity() throws Exception {
        backend.blockCreation();
        CompletableFuture<Token> old = lifecycle.node();
        assertTrue(backend.createStarted.await(1, TimeUnit.SECONDS));
        CompletableFuture<Void> forgotten = lifecycle.forget();
        cancelled(old);
        CompletableFuture<Token> next = lifecycle.node();
        backend.createRelease.countDown();
        forgotten.get(2, TimeUnit.SECONDS);
        assertEquals("new", next.get(2, TimeUnit.SECONDS).identity);
        assertEquals(List.of("create:1", "close:1", "forget", "create:2"), backend.events);
    }

    @Test public void rapidModesDuringStartupLeaveOnlyTheFinalModeAndNoLiveNode() throws Exception {
        backend.blockCreation();
        CompletableFuture<Token> old = lifecycle.node();
        assertTrue(backend.createStarted.await(1, TimeUnit.SECONDS));
        CompletableFuture<Void> off = lifecycle.setEnabled(false);
        CompletableFuture<Void> on = lifecycle.setEnabled(true);
        CompletableFuture<Void> finalOff = lifecycle.setEnabled(false);
        cancelled(old); assertFalse(lifecycle.enabled());
        backend.createRelease.countDown();
        off.get(2, TimeUnit.SECONDS); on.get(2, TimeUnit.SECONDS); finalOff.get(2, TimeUnit.SECONDS);
        assertFalse(backend.savedMode); assertEquals(0, backend.live);
        assertEquals(1, backend.created);
        failed(lifecycle.node(), "disabled");
    }

    @Test public void modeSaveRunsOnWorkerAndPrecedesTheNextStartup() throws Exception {
        backend.blockMode();
        CompletableFuture<Void> off = lifecycle.setEnabled(false);
        assertTrue(backend.modeStarted.await(1, TimeUnit.SECONDS));
        responsive(() -> { lifecycle.background(); lifecycle.foreground(); lifecycle.setEnabled(true); });
        CompletableFuture<Token> next = lifecycle.node();
        assertFalse(next.isDone()); assertEquals(0, backend.created);
        backend.modeRelease.countDown(); off.get(2, TimeUnit.SECONDS);
        next.get(2, TimeUnit.SECONDS);
        assertEquals(List.of("mode:false", "mode:true", "create:1"), backend.events);
    }

    @Test public void failedModeSaveRestoresCommittedModeAndSurfacesFailure() throws Exception {
        Token old = lifecycle.node().get(2, TimeUnit.SECONDS);
        backend.failNextMode = true;
        failed(lifecycle.setEnabled(false), "save failed");
        assertTrue(lifecycle.enabled()); assertTrue(backend.savedMode); assertTrue(old.closed);
        assertNotSame(old, lifecycle.node().get(2, TimeUnit.SECONDS));
    }

    @Test public void olderSaveFailureCannotRollBackANewerChoice() throws Exception {
        backend.blockMode(); backend.failNextMode = true;
        CompletableFuture<Void> off = lifecycle.setEnabled(false);
        assertTrue(backend.modeStarted.await(1, TimeUnit.SECONDS));
        CompletableFuture<Void> on = lifecycle.setEnabled(true);
        CompletableFuture<Void> latest = lifecycle.setEnabled(false);
        backend.modeRelease.countDown();
        failed(off, "save failed"); on.get(2, TimeUnit.SECONDS); latest.get(2, TimeUnit.SECONDS);
        assertFalse(lifecycle.enabled()); assertFalse(backend.savedMode);
    }

    @Test public void queuedExpiryRechecksForegroundBeforeDetaching() throws Exception {
        Token old = lifecycle.node().get(2, TimeUnit.SECONDS);
        lifecycle.background(); blockQueue();
        CompletableFuture<Void> expiry = lifecycle.expire();
        lifecycle.foreground(); clock.addAndGet(300_001);
        queueRelease.countDown(); expiry.get(2, TimeUnit.SECONDS);
        assertSame(old, lifecycle.node().get(2, TimeUnit.SECONDS)); assertFalse(old.closed);
    }

    @Test public void queuedExpiryRechecksDownloadLeaseAndClosesAfterRelease() throws Exception {
        Token old = lifecycle.node().get(2, TimeUnit.SECONDS);
        lifecycle.background(); blockQueue();
        CompletableFuture<Void> expiry = lifecycle.expire();
        lifecycle.retainTransfer(); clock.addAndGet(300_001);
        queueRelease.countDown(); expiry.get(2, TimeUnit.SECONDS);
        assertSame(old, lifecycle.node().get(2, TimeUnit.SECONDS));
        lifecycle.releaseTransfer(); lifecycle.expire().get(2, TimeUnit.SECONDS);
        assertTrue(old.closed);
        lifecycle.foreground(); assertNotSame(old, lifecycle.node().get(2, TimeUnit.SECONDS));
    }

    @Test public void foregroundAfterExpiredRetentionReplacesNodeButActiveDownloadPreservesIt() throws Exception {
        Token first = lifecycle.node().get(2, TimeUnit.SECONDS);
        lifecycle.background(); clock.addAndGet(300_001); lifecycle.foreground();
        Token second = lifecycle.node().get(2, TimeUnit.SECONDS);
        assertTrue(first.closed); assertNotSame(first, second);
        lifecycle.background(); lifecycle.retainTransfer(); clock.addAndGet(300_001); lifecycle.foreground();
        assertSame(second, lifecycle.node().get(2, TimeUnit.SECONDS)); lifecycle.releaseTransfer();
    }

    @Test public void startupFinishingAfterRetentionExpiryIsClosedWithoutPublication() throws Exception {
        backend.blockCreation(); CompletableFuture<Token> old = lifecycle.node();
        assertTrue(backend.createStarted.await(1, TimeUnit.SECONDS));
        lifecycle.background(); clock.addAndGet(300_001); backend.createRelease.countDown();
        cancelled(old); assertEquals(1, backend.closed);
        lifecycle.foreground(); assertEquals(2, lifecycle.node().get(2, TimeUnit.SECONDS).id);
    }

    @Test public void failedCloseRetainsDirectoryOwnershipUntilASuccessfulClose() throws Exception {
        Token old = lifecycle.node().get(2, TimeUnit.SECONDS);
        backend.failNextClose = true;
        failed(lifecycle.close(), "close failed");
        assertFalse(old.closed); assertEquals(1, backend.live);
        Token next = lifecycle.node().get(2, TimeUnit.SECONDS);
        assertTrue(old.closed); assertNotSame(old, next); assertEquals(1, backend.live);
    }

    @Test public void futureCallbacksDoNotExecuteUnderTheStateLock() throws Exception {
        backend.blockCreation();
        CompletableFuture<Token> node = lifecycle.node();
        CountDownLatch callbackStarted = new CountDownLatch(1), callbackRelease = new CountDownLatch(1);
        CompletableFuture<Void> callback = node.thenRun(() -> {
            callbackStarted.countDown();
            try { assertTrue(callbackRelease.await(3, TimeUnit.SECONDS)); }
            catch (InterruptedException error) { throw new AssertionError(error); }
        });
        backend.createRelease.countDown();
        try {
            assertTrue(callbackStarted.await(1, TimeUnit.SECONDS));
            responsive(() -> { lifecycle.foreground(); lifecycle.retainTransfer(); lifecycle.releaseTransfer(); lifecycle.close(); });
        } finally { callbackRelease.countDown(); }
        callback.get(2, TimeUnit.SECONDS);
    }

    private void responsive(Runnable action) throws Exception { ui.submit(action).get(1, TimeUnit.SECONDS); }
    private static void cancelled(CompletableFuture<?> future) throws Exception { failed(future, "Cancelled"); }
    private static void failed(CompletableFuture<?> future, String message) throws Exception {
        try { future.get(2, TimeUnit.SECONDS); fail("Expected failure: " + message); }
        catch (ExecutionException error) { assertTrue(error.getCause().toString(), error.getCause().getMessage().contains(message)); }
    }
    private void blockQueue() throws Exception {
        CountDownLatch started = new CountDownLatch(1); queueRelease = new CountDownLatch(1);
        worker.execute(() -> { started.countDown(); try { queueRelease.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } });
        assertTrue(started.await(1, TimeUnit.SECONDS));
    }

    private static final class Token {
        final int id;
        final String identity;
        boolean closed;
        Token(int id, String identity) { this.id = id; this.identity = identity; }
    }
    private static final class Backend implements NetworkLifecycle.Backend<Token> {
        final List<String> events = new CopyOnWriteArrayList<>();
        CountDownLatch createStarted = new CountDownLatch(0), createRelease = new CountDownLatch(0);
        CountDownLatch closeStarted = new CountDownLatch(0), closeRelease = new CountDownLatch(0);
        CountDownLatch modeStarted = new CountDownLatch(0), modeRelease = new CountDownLatch(0);
        volatile int created, closed, live;
        volatile boolean savedMode = true, failNextMode, failNextClose;
        String identity = "old";
        void blockCreation() { createStarted = new CountDownLatch(1); createRelease = new CountDownLatch(1); }
        void blockClose() { closeStarted = new CountDownLatch(1); closeRelease = new CountDownLatch(1); }
        void blockMode() { modeStarted = new CountDownLatch(1); modeRelease = new CountDownLatch(1); }
        @Override public Token create() throws Exception {
            assertEquals("lifecycle-unit", Thread.currentThread().getName());
            createStarted.countDown(); assertTrue(createRelease.await(3, TimeUnit.SECONDS));
            assertEquals("Two nodes would share the native state directory", 0, live);
            live++; Token token = new Token(++created, identity); events.add("create:" + token.id); return token;
        }
        @Override public void close(Token node) throws Exception {
            assertEquals("lifecycle-unit", Thread.currentThread().getName());
            closeStarted.countDown(); assertTrue(closeRelease.await(3, TimeUnit.SECONDS));
            if (failNextClose) { failNextClose = false; throw new IOException("close failed"); }
            assertFalse(node.closed); node.closed = true; live--; closed++; events.add("close:" + node.id);
        }
        @Override public void saveMode(boolean value) throws Exception {
            assertEquals("lifecycle-unit", Thread.currentThread().getName());
            modeStarted.countDown(); assertTrue(modeRelease.await(3, TimeUnit.SECONDS));
            if (failNextMode) { failNextMode = false; throw new IOException("save failed"); }
            savedMode = value; events.add("mode:" + value);
        }
        @Override public void forget() {
            assertEquals("lifecycle-unit", Thread.currentThread().getName()); assertEquals(0, live);
            identity = "new"; events.add("forget");
        }
    }
}
