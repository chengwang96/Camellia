package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import org.json.JSONObject;
import tailnet.Storage;
import tailnet.Tailnet;

public class EmbeddedNetworkTest extends InstrumentationTestCase {
    public void testDefaultNetworkCallbacksDebounceAndNotifyRecovery() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        var manager = (android.net.ConnectivityManager) context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        var active = manager.getActiveNetwork();
        assertNotNull("Emulator requires an active network", active);
        var callbackField = EmbeddedNetwork.class.getDeclaredField("networkCallback"); callbackField.setAccessible(true);
        var callback = (android.net.ConnectivityManager.NetworkCallback) callbackField.get(null);
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        var originalRoute = routeField.get(null);
        var recovered = new java.util.concurrent.CountDownLatch(1);
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try { routeField.set(null, new NetworkRoute(active, "before")); }
                catch (Exception error) { throw new AssertionError(error); }
                EmbeddedNetwork.setNetworkListener(() -> { calls.incrementAndGet(); recovered.countDown(); });
                callback.onLost(active);
                callback.onAvailable(active);
                callback.onLinkPropertiesChanged(active, new android.net.LinkProperties());
                callback.onLinkPropertiesChanged(active, new android.net.LinkProperties());
            });
            assertTrue("Recovery was not notified", recovered.await(5, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(1, calls.get());
            assertTrue(EmbeddedNetwork.online());
        } finally {
            getInstrumentation().runOnMainSync(() -> {
                EmbeddedNetwork.setNetworkListener(null);
                try { routeField.set(null, originalRoute); }
                catch (Exception error) { throw new AssertionError(error); }
            });
        }
    }

    public void testChangedRouteReplacesNativeNodeButKeepsEncryptedIdentity() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        boolean previousMode = EmbeddedNetwork.enabled();
        EmbeddedNetwork.setEnabled(true);
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        var originalRoute = routeField.get(null);
        EmbeddedNetwork.close();
        try {
            NetworkRoute route = new NetworkRoute("wifi", "links");
            getInstrumentation().runOnMainSync(() -> {
                try { routeField.set(null, route); } catch (Exception error) { throw new AssertionError(error); }
            });
            var first = EmbeddedNetwork.node();
            assertSame(first, EmbeddedNetwork.node());
            route.available("cellular");
            var second = EmbeddedNetwork.node();
            assertNotSame(first, second);
            assertSame(second, EmbeddedNetwork.node());
            try { first.prepare("GET", "http://100.64.0.1:43127/v1/status", "", ""); fail("Old node remains open"); }
            catch (Exception expected) { assertTrue(expected.getMessage().contains("closed")); }
            assertTrue(new JSONObject(second.status()).has("state"));
        } finally {
            EmbeddedNetwork.close();
            getInstrumentation().runOnMainSync(() -> {
                try { routeField.set(null, originalRoute); } catch (Exception error) { throw new AssertionError(error); }
            });
            EmbeddedNetwork.setEnabled(previousMode);
        }
    }

    public void testExpiredRetentionRebuildsNodeOnReturn() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        boolean previousMode = EmbeddedNetwork.enabled();
        EmbeddedNetwork.setEnabled(true);
        var routeField = EmbeddedNetwork.class.getDeclaredField("route"); routeField.setAccessible(true);
        var originalRoute = routeField.get(null);
        var deadlineField = EmbeddedNetwork.class.getDeclaredField("backgroundDeadline"); deadlineField.setAccessible(true);
        EmbeddedNetwork.close();
        try {
            var manager = (android.net.ConnectivityManager) context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            var active = manager.getActiveNetwork();
            if (active == null) return;
            var links = manager.getLinkProperties(active);
            getInstrumentation().runOnMainSync(() -> {
                try { routeField.set(null, new NetworkRoute(active, links == null ? null : links.toString())); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            var first = EmbeddedNetwork.node();
            EmbeddedNetwork.background();
            getInstrumentation().runOnMainSync(EmbeddedNetwork::foreground);
            assertSame("A node inside the retention window must be reused", first, EmbeddedNetwork.node());
            EmbeddedNetwork.background();
            deadlineField.setLong(null, android.os.SystemClock.elapsedRealtime() - 1);
            getInstrumentation().runOnMainSync(EmbeddedNetwork::foreground);
            var second = EmbeddedNetwork.node();
            assertNotSame("A frozen node past the retention window must be rebuilt", first, second);
            try { first.prepare("GET", "http://100.64.0.1:43127/v1/status", "", ""); fail("Expired node remains open"); }
            catch (Exception expected) { assertTrue(expected.getMessage().contains("closed")); }
            assertSame(second, EmbeddedNetwork.node());
        } finally {
            EmbeddedNetwork.close();
            deadlineField.setLong(null, 0);
            getInstrumentation().runOnMainSync(() -> {
                try { routeField.set(null, originalRoute); } catch (Exception error) { throw new AssertionError(error); }
            });
            EmbeddedNetwork.setEnabled(previousMode);
        }
    }

    public void testNativeNodeStartupStatusAndEncryptedState() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.registerInterfaces();
        CredentialStore encrypted = new CredentialStore(context, "tailnet-instrumentation");
        encrypted.clear();
        Storage storage = new Storage() {
            @Override public synchronized String read(String key) throws Exception { return encrypted.load().optString(key); }
            @Override public synchronized void write(String key, String value) throws Exception {
                JSONObject state = encrypted.load(); state.put(key, value); encrypted.save(state);
            }
        };
        var directory = new java.io.File(context.getNoBackupFilesDir(), "tailnet-test"); directory.mkdirs();
        var node = Tailnet.newNode(directory.getAbsolutePath(), storage);
        try {
            JSONObject state = new JSONObject(node.status());
            assertTrue(state.has("state"));
            try { node.open("GET", "http://127.0.0.1:43127/v1/status", "", ""); fail("must reject non-tailnet addresses"); }
            catch (Exception expected) { assertTrue(expected.getMessage().contains("tailnet")); }
            storage.write("fixture-node-key", "secret-state");
            assertEquals("secret-state", storage.read("fixture-node-key"));
            String raw = context.getSharedPreferences("tailnet-instrumentation", 0).getString("credential", "");
            assertFalse(raw.contains("secret-state"));
            assertFalse(new java.io.File(directory, "tailscaled.state").exists());
        } finally { node.close(); encrypted.clear(); }
    }

    public void testInteractiveLoginReturnsOfficialBrowserUrl() throws Exception {
        var runner = (android.test.InstrumentationTestRunner) getInstrumentation();
        if (!"true".equals(runner.getArguments().getString("onlineLogin"))) return;
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext());
        EmbeddedNetwork.setEnabled(true);
        try {
            var node = EmbeddedNetwork.node(); node.login();
            long deadline = android.os.SystemClock.elapsedRealtime() + 30_000;
            while (android.os.SystemClock.elapsedRealtime() < deadline) {
                JSONObject status = new JSONObject(node.status());
                if (EmbeddedNetwork.loginUrl(status.optString("loginUrl")) != null) return;
                Thread.sleep(500);
            }
            fail("No official login URL within 30 seconds; verify internet connectivity");
        } finally { EmbeddedNetwork.close(); }
    }

    public void testBrowserLoginRestrictsDestination() {
        assertEquals("https://login.tailscale.com/a/test", EmbeddedNetwork.loginUrl("https://login.tailscale.com/a/test"));
        for (String value : new String[]{"http://login.tailscale.com/a", "https://evil.example/a", "https://user@login.tailscale.com/a", "https://login.tailscale.com:443/a", "intent://test"}) {
            assertNull(EmbeddedNetwork.loginUrl(value));
        }
    }
}
