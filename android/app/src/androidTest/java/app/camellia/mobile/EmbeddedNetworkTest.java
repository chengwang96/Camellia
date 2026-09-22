package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import org.json.JSONObject;
import tailnet.Storage;
import tailnet.Tailnet;

public class EmbeddedNetworkTest extends InstrumentationTestCase {
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
