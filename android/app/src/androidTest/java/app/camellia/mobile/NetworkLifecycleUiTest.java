package app.camellia.mobile;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.widget.Switch;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import tailnet.Node;

/** Block the real EmbeddedNetwork adapter before JNI or persistence, then exercise Android's main looper. */
public class NetworkLifecycleUiTest extends InstrumentationTestCase {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor(action -> new Thread(action, "tailnet-ui-fixture"));
    private final Backend backend = new Backend();
    private NetworkLifecycle<Node> fixture;
    private NetworkLifecycle<?> original;
    private java.lang.reflect.Field lifecycleField;
    private MainActivity activity;

    @Override protected void setUp() throws Exception {
        super.setUp();
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext());
        lifecycleField = EmbeddedNetwork.class.getDeclaredField("lifecycle"); lifecycleField.setAccessible(true);
        original = (NetworkLifecycle<?>) lifecycleField.get(null);
        original.close().get(10, TimeUnit.SECONDS);
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        fixture = new NetworkLifecycle<>(backend, worker, SystemClock::elapsedRealtime,
            () -> { try { return ((NetworkRoute) routeField.get(null)).revision(); } catch (Exception error) { throw new AssertionError(error); } }, true);
        getInstrumentation().runOnMainSync(() -> {
            try { lifecycleField.set(null, fixture); EmbeddedNetwork.foreground(); }
            catch (Exception error) { throw new AssertionError(error); }
        });
    }

    @Override protected void tearDown() throws Exception {
        backend.createRelease.countDown(); backend.closeRelease.countDown(); backend.modeRelease.countDown();
        try {
            if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
            fixture.close().get(10, TimeUnit.SECONDS);
        } finally {
            getInstrumentation().runOnMainSync(() -> {
                try { lifecycleField.set(null, original); EmbeddedNetwork.setNetworkListener(null); EmbeddedNetwork.foreground(); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            worker.shutdownNow(); assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS));
            super.tearDown();
        }
    }

    public void testSlowNativeStartupDoesNotBlockForegroundOrDownloadLease() throws Exception {
        backend.createStarted = new CountDownLatch(1); backend.createRelease = new CountDownLatch(1);
        CompletableFuture<Node> old = fixture.node();
        assertTrue(backend.createStarted.await(3, TimeUnit.SECONDS));
        responsive(() -> {
            EmbeddedNetwork.background(); EmbeddedNetwork.foreground();
            EmbeddedNetwork.retainTransfer(); EmbeddedNetwork.releaseTransfer();
            EmbeddedNetwork.setEnabled(false);
        });
        cancelled(old);
        backend.createRelease.countDown(); fixture.close().get(10, TimeUnit.SECONDS);
        assertEquals(1, backend.closed); assertFalse(EmbeddedNetwork.enabled());
    }

    public void testSlowNativeCloseDoesNotBlockUiAndReplacementWaitsForClose() throws Exception {
        Node old = EmbeddedNetwork.node();
        backend.closeStarted = new CountDownLatch(1); backend.closeRelease = new CountDownLatch(1);
        CompletableFuture<Void> close = EmbeddedNetwork.close();
        assertTrue(backend.closeStarted.await(3, TimeUnit.SECONDS));
        responsive(() -> {
            EmbeddedNetwork.background(); EmbeddedNetwork.foreground();
            EmbeddedNetwork.retainTransfer(); assertEquals(1, fixture.transfers()); EmbeddedNetwork.releaseTransfer();
        });
        CompletableFuture<Node> next = fixture.node();
        assertFalse(next.isDone()); assertEquals(1, backend.created);
        backend.closeRelease.countDown(); close.get(10, TimeUnit.SECONDS);
        assertNotSame(old, next.get(10, TimeUnit.SECONDS));
        try { old.prepare("GET", "http://100.64.0.1:43127/v1/status", "", ""); fail("Old native node remains open"); }
        catch (Exception expected) { assertTrue(expected.getMessage().contains("closed")); }
    }

    public void testModeSaveFailureRestoresSwitchWithoutBlockingMainLooper() throws Exception {
        openNetwork(); EmbeddedNetwork.node();
        backend.modeStarted = new CountDownLatch(1); backend.modeRelease = new CountDownLatch(1); backend.failMode = true;
        AtomicReference<Switch> control = new AtomicReference<>();
        responsive(() -> {
            Switch toggle = activity.findViewById(android.R.id.content).findViewWithTag("networkMode");
            control.set(toggle); assertTrue(toggle.isChecked()); toggle.setChecked(false); assertFalse(toggle.isEnabled());
        });
        assertTrue(backend.modeStarted.await(3, TimeUnit.SECONDS));
        responsive(() -> { EmbeddedNetwork.background(); EmbeddedNetwork.foreground(); });
        backend.modeRelease.countDown();
        await(() -> control.get().isEnabled() && control.get().isChecked());
        responsive(() -> assertTrue(EmbeddedNetwork.enabled()));
        assertEquals("tailnet-ui-fixture", backend.modeThread);
    }

    public void testLeavingNetworkPageDuringModeSaveKeepsTheNewPageIntact() throws Exception {
        openNetwork(); EmbeddedNetwork.node();
        backend.modeStarted = new CountDownLatch(1); backend.modeRelease = new CountDownLatch(1);
        responsive(() -> {
            Switch toggle = activity.findViewById(android.R.id.content).findViewWithTag("networkMode");
            toggle.setChecked(false);
        });
        assertTrue(backend.modeStarted.await(3, TimeUnit.SECONDS));
        responsive(() -> activity.onBackPressed());
        backend.modeRelease.countDown(); fixture.close().get(10, TimeUnit.SECONDS);
        getInstrumentation().waitForIdleSync();
        responsive(() -> assertNull(activity.findViewById(android.R.id.content).findViewWithTag("networkMode")));
    }

    public void testSynchronousNodeAccessOnMainThreadFailsBeforeJniStarts() throws Exception {
        responsive(() -> {
            try { EmbeddedNetwork.node(); fail("Main thread must never wait for native startup"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("background thread")); }
        });
        assertEquals(0, backend.created);
    }

    private void openNetwork() throws Exception {
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        var show = MainActivity.class.getDeclaredMethod("showNetwork"); show.setAccessible(true);
        responsive(() -> { try { show.invoke(activity); } catch (Exception error) { throw new AssertionError(error); } });
    }
    private void responsive(Runnable action) throws Exception {
        AtomicReference<Throwable> error = new AtomicReference<>(); CountDownLatch completed = new CountDownLatch(1);
        long started = SystemClock.elapsedRealtime();
        main.post(() -> { try { action.run(); } catch (Throwable failure) { error.set(failure); } finally { completed.countDown(); } });
        assertTrue("Main looper blocked by native lifecycle", completed.await(1, TimeUnit.SECONDS));
        if (error.get() != null) throw new AssertionError(error.get());
        android.util.Log.i("NetworkLifecycleUiTest", "Main action completed in " + (SystemClock.elapsedRealtime() - started) + " ms");
    }
    private void await(java.util.function.BooleanSupplier check) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while (SystemClock.elapsedRealtime() < deadline) {
            AtomicReference<Boolean> done = new AtomicReference<>(false);
            responsive(() -> done.set(check.getAsBoolean()));
            if (done.get()) return;
            Thread.sleep(25);
        }
        fail("UI did not finish updating");
    }
    private void cancelled(CompletableFuture<?> future) throws Exception {
        try { future.get(2, TimeUnit.SECONDS); fail("Outdated startup was published"); }
        catch (ExecutionException expected) { assertEquals("Cancelled", expected.getCause().getMessage()); }
    }
    private final class Backend implements NetworkLifecycle.Backend<Node> {
        CountDownLatch createStarted = new CountDownLatch(0), createRelease = new CountDownLatch(0);
        CountDownLatch closeStarted = new CountDownLatch(0), closeRelease = new CountDownLatch(0);
        CountDownLatch modeStarted = new CountDownLatch(0), modeRelease = new CountDownLatch(0);
        volatile int created, closed;
        volatile boolean failMode;
        volatile String modeThread;
        @Override public Node create() throws Exception {
            createStarted.countDown(); assertTrue(createRelease.await(20, TimeUnit.SECONDS));
            assertNotSame(Looper.getMainLooper(), Looper.myLooper());
            var create = EmbeddedNetwork.class.getDeclaredMethod("createNode"); create.setAccessible(true);
            Node value = (Node) create.invoke(null); created++; return value;
        }
        @Override public void close(Node value) throws Exception {
            closeStarted.countDown(); assertTrue(closeRelease.await(20, TimeUnit.SECONDS));
            assertNotSame(Looper.getMainLooper(), Looper.myLooper()); value.close(); closed++;
        }
        @Override public void saveMode(boolean value) throws Exception {
            modeThread = Thread.currentThread().getName(); modeStarted.countDown();
            assertTrue(modeRelease.await(20, TimeUnit.SECONDS));
            if (failMode) throw new IOException("fixture mode save failed");
        }
        @Override public void forget() { fail("Identity must not be cleared by ordinary lifecycle changes"); }
    }
}
