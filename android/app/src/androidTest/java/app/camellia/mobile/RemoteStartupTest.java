package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

public class RemoteStartupTest extends InstrumentationTestCase {
    private Activity activity;
    private final CountDownLatch shutdown = new CountDownLatch(1), releaseReads = new CountDownLatch(1);
    private final String address = "http://100.80.1.2:43127", token = "a".repeat(43);
    private boolean downgraded;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        releaseReads.countDown(); shutdown.countDown();
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        getInstrumentation().waitForIdleSync();
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        super.tearDown();
    }

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }
    private void call(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }

    private void startup(boolean known, boolean sameAddress, boolean sameToken, boolean busyReads) throws Exception {
        AtomicInteger statusReads = new AtomicInteger(), otherReads = new AtomicInteger(), eventCalls = new AtomicInteger();
        CountDownLatch opened = new CountDownLatch(1), readWorkersEntered = new CountDownLatch(2);
        JSONObject info = new JSONObject().put("protocol", 1).put("permission", "control")
            .put("capabilities", new JSONArray().put("incremental-snapshots"))
            .put("engines", new JSONArray().put("codex"));
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("foreground", false);
                field("credentials", new JSONObject().put("address", address).put("token", token));
                field("conversationId", "00000000-0000-0000-0000-000000000001");
                field("conversationTitle", "Startup");
                call("detailScreen");
                field("remoteClientFactory", (Function<String, RemoteApi>) target -> new RemoteApi(target) {
                    private void hold() throws IOException {
                        try { shutdown.await(); }
                        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
                    }
                    @Override public JSONObject json(String path, String credential, JSONObject payload) {
                        if (path.equals("/v1/status")) statusReads.incrementAndGet(); else otherReads.incrementAndGet();
                        return info;
                    }
                    @Override public void events(String id, String credential, SnapshotListener listener) throws IOException {
                        eventCalls.incrementAndGet();
                        if (downgraded && incremental()) throw new Failure(400);
                        opened.countDown(); hold();
                    }
                    @Override public void listEvents(String credential, SnapshotListener listener) throws IOException { hold(); }
                    @Override public void cancel() { shutdown.countDown(); }
                });
                field("capabilityAddress", known ? sameAddress ? address : "http://100.80.1.3:43127" : "");
                field("capabilityToken", known ? sameToken ? token : "b".repeat(43) : "");
                field("canIncremental", known);
                if (busyReads) {
                    // Isolate the read pool from any Activity-startup work so
                    // the test controls exactly which two calls occupy it.
                    ((ExecutorService) field("worker")).shutdownNow();
                    ExecutorService reads = java.util.concurrent.Executors.newFixedThreadPool(2);
                    field("worker", reads);
                    for (int index = 0; index < 2; index++) reads.submit(() -> {
                        readWorkersEntered.countDown();
                        try { releaseReads.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                    });
                }
                field("foreground", true);
                call("connectEvents");
            } catch (Exception error) { throw new AssertionError(error); }
        });
        if (busyReads) assertTrue("Both controlled read workers should be occupied", readWorkersEntered.await(3, TimeUnit.SECONDS));
        assertTrue("The chat stream must open without waiting for history workers", opened.await(3, TimeUnit.SECONDS));
        assertEquals(known && sameAddress && sameToken ? 0 : 1, statusReads.get());
        assertEquals("Opening chat should not download a duplicate sidebar or transcript", 0, otherReads.get());
        assertEquals(downgraded ? 2 : 1, eventCalls.get());
        getInstrumentation().runOnMainSync(() -> {
            try { assertFalse("Cached control capability must not authorize sends before a fresh snapshot", (boolean) field("connected")); }
            catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testWarmChatSkipsStatusAndBypassesBusyReadWorkers() throws Exception { startup(true, true, true, true); }
    public void testColdChatStillDiscoversCapabilities() throws Exception { startup(false, true, true, false); }
    public void testAnotherComputerCannotReuseCapabilityMetadata() throws Exception { startup(true, false, true, false); }
    public void testChangedCredentialsCannotReuseCapabilityMetadata() throws Exception { startup(true, true, false, false); }
    public void testDesktopDowngradeRetriesTheLegacyStreamOnce() throws Exception { downgraded = true; startup(true, true, true, false); }
}
