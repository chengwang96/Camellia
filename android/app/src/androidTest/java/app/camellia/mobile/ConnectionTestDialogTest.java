package app.camellia.mobile;

import android.app.Dialog;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

public class ConnectionTestDialogTest extends InstrumentationTestCase {
    private static final String TOKEN = "a".repeat(43), ID = "12345678-1234-1234-1234-123456789abc";
    private MainActivity activity;
    private ConnectionTestDialog test;
    private CamelliaDialog dialog;
    private JSONObject owner;
    private boolean oldEmbedded;

    private static final class Transport implements ConnectionStabilityCheck.Transport {
        final int mode;
        final long heartbeatInterval;
        final CountDownLatch entered = new CountDownLatch(2), release = new CountDownLatch(1), cleaned = new CountDownLatch(1);
        final AtomicInteger closes = new AtomicInteger();
        Transport(int mode) { this(mode, 75); }
        Transport(int mode, long heartbeatInterval) { this.mode = mode; this.heartbeatInterval = heartbeatInterval; }
        @Override public JSONObject status() throws Exception {
            entered.countDown();
            if (mode == 0) throw new RemoteApi.Failure(401, "fixture authorization: Bearer " + TOKEN + ", key: sk-fixture-secret");
            if (mode == 1) release.await();
            return new JSONObject().put("protocol", 1).put("instanceId", ID);
        }
        @Override public void events(ConnectionStabilityCheck.Events listener) throws Exception {
            entered.countDown(); listener.snapshot(new JSONObject().put("instanceId", ID));
            while (!release.await(heartbeatInterval, TimeUnit.MILLISECONDS)) listener.heartbeat();
        }
        @Override public void close() { closes.incrementAndGet(); release.countDown(); cleaned.countDown(); }
    }

    @Override protected void setUp() throws Exception {
        super.setUp(); Context context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false).get(5, TimeUnit.SECONDS);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        owner = new JSONObject().put("address", "http://100.64.0.12:43127").put("computerName", "ROG").put("token", "b".repeat(43));
        ui(() -> {
            var method = MainActivity.class.getDeclaredMethod("computersScreen"); method.setAccessible(true); method.invoke(activity);
            field("credentials", owner); field("foreground", false);
        });
        waitForActivityState("The test activity must be in the foreground", () -> activity.hasWindowFocus() && !activity.isFinishing() && !activity.isDestroyed());
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> { if (test != null) test.close(); if (!activity.isDestroyed()) activity.finish(); });
        waitForActivityState("The test activity must finish before the next test starts", activity::isDestroyed);
        getInstrumentation().waitForIdleSync(); EmbeddedNetwork.setEnabled(oldEmbedded).get(5, TimeUnit.SECONDS); super.tearDown();
    }

    public void testFailureAutomaticallyShowsDetailsAndOneTapCopiesWithoutCredentialsOrChangingTheComputer() throws Exception {
        Transport transport = new Transport(0); show(transport, ConnectionStabilityCheck.DEFAULT);
        waitForReport(); assertTrue(transport.cleaned.await(3, TimeUnit.SECONDS)); screenshot("connection-test-error");
        ui(() -> {
            assertEquals("连接稳定性异常", ((TextView) view("camelliaDialogTitle")).getText().toString());
            TextView report = (TextView) view("connectionTestReport"); String value = report.getText().toString();
            assertTrue(value, value.contains("HTTP 401")); assertTrue(value.contains("HP")); assertTrue(value.contains("REQUEST_ERROR"));
            assertTrue(value.contains("[redacted]")); assertFalse(value.contains(TOKEN)); assertFalse(value.contains("sk-fixture-secret"));
            assertTrue(report.isTextSelectable()); assertSame(owner, field("credentials"));
            dialog.getWindow().getDecorView().findViewById(android.R.id.button1).performClick();
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            assertEquals(value, clipboard.getPrimaryClip().getItemAt(0).getText().toString());
            assertTrue(dialog.isShowing()); assertEquals("已复制", dialog.getButton(Dialog.BUTTON_POSITIVE).getText().toString());
        });
    }

    public void testCancelClosesTheRequestAndStreamWithoutOpeningAnErrorReport() throws Exception {
        Transport transport = new Transport(1); show(transport, ConnectionStabilityCheck.DEFAULT);
        assertTrue(transport.entered.await(3, TimeUnit.SECONDS));
        ui(() -> dialog.getWindow().getDecorView().findViewById(android.R.id.button2).performClick());
        assertTrue(transport.cleaned.await(3, TimeUnit.SECONDS)); getInstrumentation().waitForIdleSync();
        ui(() -> { assertFalse(dialog.isShowing()); assertEquals(1, transport.closes.get()); assertSame(owner, field("credentials")); });
    }

    public void testSuccessfulReportCanBeCopiedAndRetriedWithFreshClients() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        var config = new ConnectionStabilityCheck.Config(1000, 100, 500, 500, 500, 400);
        ui(() -> {
            test = new ConnectionTestDialog(activity, computer(), true, () -> { runs.incrementAndGet(); return new Transport(2); }, config);
            field("connectionTest", test); dialog = test.show();
        });
        waitForReport(); screenshot("connection-test-success");
        ui(() -> {
            assertEquals("测试完成", ((TextView) view("camelliaDialogTitle")).getText().toString());
            assertTrue(((TextView) view("connectionTestStatus")).getText().toString().contains("未发现连接异常"));
            assertTrue(((TextView) view("connectionTestReport")).getText().toString().contains("已建立"));
            dialog.getButton(Dialog.BUTTON_POSITIVE).performClick(); assertTrue(dialog.isShowing());
            dialog.getButton(Dialog.BUTTON_NEUTRAL).performClick(); assertEquals(View.GONE, view("connectionTestReport").getVisibility());
        });
        waitForReport(); assertEquals(2, runs.get());
        ui(() -> { assertEquals("测试完成", ((TextView) view("camelliaDialogTitle")).getText().toString()); assertSame(owner, field("credentials")); });
    }

    public void testActivityStopCancelsItsTestAndDoesNotLeaveAResultPopup() throws Exception {
        Transport transport = new Transport(1); show(transport, ConnectionStabilityCheck.DEFAULT);
        assertTrue(transport.entered.await(3, TimeUnit.SECONDS)); ui(() -> activity.finish());
        waitForActivityState("Finishing the activity must deliver its stop and destroy callbacks", activity::isDestroyed);
        assertTrue(transport.cleaned.await(3, TimeUnit.SECONDS)); getInstrumentation().waitForIdleSync();
        ui(() -> { assertFalse(dialog.isShowing()); assertEquals(1, transport.closes.get()); });
    }

    public void testDefaultThirtySecondWindowAcceptsIdleDesktopHeartbeats() throws Exception {
        Transport transport = new Transport(2, 10000); show(transport, ConnectionStabilityCheck.DEFAULT);
        waitForReport(40000); assertTrue(transport.cleaned.await(3, TimeUnit.SECONDS)); screenshot("connection-test-default-success");
        ui(() -> {
            assertEquals("测试完成", ((TextView) view("camelliaDialogTitle")).getText().toString());
            String report = ((TextView) view("connectionTestReport")).getText().toString();
            assertTrue(report, report.contains("心跳 2") || report.contains("心跳 3"));
            assertTrue(report.contains("成功，失败 0")); assertSame(owner, field("credentials"));
        });
    }

    public void testActualHttpAndSseTransportReceivesHeartbeatsWithoutSendingCommands() throws Exception {
        try (HttpFixture server = new HttpFixture(true)) {
            showNetwork(server, new ConnectionStabilityCheck.Config(1500, 150, 800, 800, 500, 700));
            waitForReport();
            ui(() -> assertEquals("测试完成", ((TextView) view("camelliaDialogTitle")).getText().toString()));
            assertTrue(server.requests.get() >= 2); assertEquals(1, server.streams.get()); assertEquals(0, server.invalidRequests.get());
        }
    }

    public void testActualStalledLiveStreamProducesACopyableHeartbeatError() throws Exception {
        try (HttpFixture server = new HttpFixture(false)) {
            showNetwork(server, new ConnectionStabilityCheck.Config(2000, 150, 800, 800, 400, 700));
            waitForReport();
            ui(() -> {
                String report = ((TextView) view("connectionTestReport")).getText().toString();
                assertTrue(report, report.contains("HEARTBEAT_TIMEOUT"));
                dialog.getButton(Dialog.BUTTON_POSITIVE).performClick();
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                assertEquals(report, clipboard.getPrimaryClip().getItemAt(0).getText().toString());
            });
            assertTrue(server.requests.get() >= 2); assertEquals(0, server.invalidRequests.get());
        }
    }

    // The production Endpoint remains restricted to Tailscale addresses. Only these fresh test
    // clients are redirected to a loopback fixture so the real HTTP/SSE readers can be exercised.
    private RemoteApi localApi(HttpFixture server) throws Exception {
        RemoteApi client = new RemoteApi(activity, "http://100.64.0.11:43127");
        var endpoint = RemoteApi.class.getDeclaredField("endpoint"); endpoint.setAccessible(true);
        var origin = Endpoint.class.getDeclaredField("origin"); origin.setAccessible(true);
        origin.set(endpoint.get(client), "http://127.0.0.1:" + server.socket.getLocalPort()); return client;
    }
    private void showNetwork(HttpFixture server, ConnectionStabilityCheck.Config config) throws Exception {
        RemoteApi requests = localApi(server), events = localApi(server);
        ui(() -> {
            test = new ConnectionTestDialog(activity, computer(), true, () -> new ConnectionStabilityCheck.Transport() {
                @Override public JSONObject status() throws Exception { return requests.json("/v1/status", TOKEN, null); }
                @Override public void events(ConnectionStabilityCheck.Events listener) throws Exception { events.listEvents(TOKEN, listener::snapshot, listener::heartbeat); }
                @Override public void close() { try { requests.cancel(); } finally { events.cancel(); } }
            }, config);
            field("connectionTest", test); dialog = test.show();
        });
    }
    private static final class HttpFixture implements AutoCloseable {
        final java.net.ServerSocket socket = new java.net.ServerSocket(0, 16, java.net.InetAddress.getByName("127.0.0.1"));
        final java.util.concurrent.ExecutorService workers = java.util.concurrent.Executors.newCachedThreadPool();
        final java.util.Set<java.net.Socket> clients = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final AtomicInteger requests = new AtomicInteger(), streams = new AtomicInteger(), invalidRequests = new AtomicInteger();
        final boolean heartbeats;
        volatile boolean closed;
        HttpFixture(boolean heartbeats) throws Exception {
            this.heartbeats = heartbeats;
            workers.execute(() -> {
                while (!closed) try {
                    java.net.Socket client = socket.accept(); clients.add(client); workers.execute(() -> serve(client));
                } catch (Exception ignored) { if (!closed) invalidRequests.incrementAndGet(); }
            });
        }
        private void serve(java.net.Socket client) {
            try (client) {
                client.setSoTimeout(3000);
                var reader = new java.io.BufferedReader(new java.io.InputStreamReader(client.getInputStream(), java.nio.charset.StandardCharsets.UTF_8));
                String request = reader.readLine(), line; boolean authenticated = false;
                while ((line = reader.readLine()) != null && !line.isEmpty()) if (line.equals("Authorization: Bearer " + TOKEN)) authenticated = true;
                boolean stream = request != null && request.startsWith("GET /v1/conversations/events ");
                if (!authenticated || request == null || !(stream || request.startsWith("GET /v1/status "))) { invalidRequests.incrementAndGet(); return; }
                var output = client.getOutputStream();
                if (stream) {
                    streams.incrementAndGet();
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: snapshot\ndata: {\"instanceId\":\"" + ID + "\"}\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8)); output.flush();
                    while (!closed) { Thread.sleep(75); if (heartbeats) { output.write(": heartbeat\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8)); output.flush(); } }
                } else {
                    requests.incrementAndGet(); byte[] body = ("{\"protocol\":1,\"instanceId\":\"" + ID + "\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8)); output.write(body); output.flush();
                }
            } catch (Exception ignored) { /* A cancelled probe closes its socket. */ }
            finally { clients.remove(client); }
        }
        @Override public void close() throws Exception {
            closed = true; socket.close(); for (var client : clients) client.close(); workers.shutdownNow();
        }
    }

    private JSONObject computer() throws Exception { return new JSONObject().put("address", "http://100.64.0.11:43127").put("computerName", "HP").put("token", TOKEN); }
    private void show(Transport transport, ConnectionStabilityCheck.Config config) {
        ui(() -> { test = new ConnectionTestDialog(activity, computer(), true, () -> transport, config); field("connectionTest", test); dialog = test.show(); });
    }
    private View view(String tag) { return dialog.getWindow().getDecorView().findViewWithTag(tag); }
    private void waitForActivityState(String message, BooleanSupplier condition) throws Exception {
        // Main-thread idleness does not mean an activity transition has completed.
        // Wait for its lifecycle before opening a probe or starting another test.
        long deadline = android.os.SystemClock.elapsedRealtime() + 10000;
        AtomicBoolean ready = new AtomicBoolean();
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            ui(() -> ready.set(condition.getAsBoolean()));
            if (ready.get()) return;
            Thread.sleep(40);
        }
        fail(message);
    }
    private void waitForReport() throws Exception {
        waitForReport(5000);
    }
    private void waitForReport(long timeout) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeout;
        AtomicBoolean visible = new AtomicBoolean();
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            ui(() -> {
                View report = view("connectionTestReport");
                android.graphics.Rect bounds = new android.graphics.Rect();
                // Visibility changes before the next traversal resizes the retry sheet.
                // Wait for the rendered report and actions, rather than the VISIBLE flag.
                visible.set(dialog.isShowing() && report.getVisibility() == View.VISIBLE
                    && !report.isLayoutRequested() && !dialog.getWindow().getDecorView().isLayoutRequested()
                    && view("connectionTestStatus").getGlobalVisibleRect(bounds)
                    && report.getGlobalVisibleRect(bounds)
                    && dialog.getButton(Dialog.BUTTON_POSITIVE).getGlobalVisibleRect(bounds)
                    && dialog.getButton(Dialog.BUTTON_NEUTRAL).getGlobalVisibleRect(bounds));
            });
            if (visible.get()) {
                getInstrumentation().getUiAutomation().waitForIdle(150, 3000);
                ui(() -> {
                    android.graphics.Rect text = new android.graphics.Rect();
                    assertTrue("The result summary must be visible", view("connectionTestStatus").getGlobalVisibleRect(text));
                    assertTrue("The result report must be visible", view("connectionTestReport").getGlobalVisibleRect(text));
                    assertTrue("The copy button must be visible", dialog.getButton(Dialog.BUTTON_POSITIVE).getGlobalVisibleRect(text));
                    android.graphics.Rect screen = new android.graphics.Rect(); activity.getWindow().getDecorView().getWindowVisibleDisplayFrame(screen);
                    int[] position = new int[2]; dialog.getButton(Dialog.BUTTON_NEUTRAL).getLocationOnScreen(position);
                    assertTrue("The final action must stay inside the screen", position[1] + dialog.getButton(Dialog.BUTTON_NEUTRAL).getHeight() <= screen.bottom);
                });
                return;
            }
            Thread.sleep(40);
        }
        ui(() -> fail("Connection test did not produce its result: showing=" + dialog.isShowing()
            + ", activityFinishing=" + activity.isFinishing() + ", activityDestroyed=" + activity.isDestroyed()
            + ", reportVisibility=" + view("connectionTestReport").getVisibility()
            + ", reportLayoutPending=" + view("connectionTestReport").isLayoutRequested()));
    }
    private Object field(String name) throws Exception { var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity); }
    private void field(String name, Object value) throws Exception { var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value); }
    private interface Check { void run() throws Exception; }
    private void ui(Check action) {
        var error = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable failure) { error.set(failure); } });
        if (error.get() != null) throw new AssertionError(error.get());
    }
    private void screenshot(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        var image = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { image.recycle(); }
    }
}
