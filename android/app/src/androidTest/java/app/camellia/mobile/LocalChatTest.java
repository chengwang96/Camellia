package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

public class LocalChatTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp();
        encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testEditingDraftSurvivesReopeningAndCanBeCancelled() throws Throwable {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        store.importConfig(LocalChatConfig.parse(bundle("https://example.com/v1", "openai").toString()));
        JSONObject conversation = store.createConversation("", LocalChatConfig.routes(store.config()).get(0).id);
        String id = conversation.getString("id");
        conversation.getJSONArray("messages").put(new JSONObject().put("role", "user").put("content", "Original"))
            .put(new JSONObject().put("role", "assistant").put("content", "Reply"));
        store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            ui(() -> {
                View root = activity.getWindow().getDecorView();
                root.findViewWithTag("localMessage:0").performClick();
                ((EditText) root.findViewWithTag("localComposer")).setText("Edited draft");
                assertEquals(View.VISIBLE, root.findViewWithTag("composerEditBanner").getVisibility());
                activity.onBackPressed();
            });
            assertEquals(0, LocalChatDraft.editIndex(new LocalChatStore(activity).conversation(id)));
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            ui(() -> {
                View root = activity.getWindow().getDecorView();
                assertEquals("Edited draft", ((EditText) root.findViewWithTag("localComposer")).getText().toString());
                assertEquals(View.VISIBLE, root.findViewWithTag("composerEditBanner").getVisibility());
                root.findViewWithTag("composerCancelEdit").performClick();
                assertEquals("", ((EditText) root.findViewWithTag("localComposer")).getText().toString());
                assertEquals(View.GONE, root.findViewWithTag("composerEditBanner").getVisibility());
                root.findViewWithTag("localMessage:0").performClick();
                ((EditText) root.findViewWithTag("localComposer")).setText("");
                assertEquals(View.VISIBLE, root.findViewWithTag("composerEditBanner").getVisibility());
                assertFalse(root.findViewWithTag("localSend").isEnabled());
                activity.onBackPressed();
            });
            assertEquals(0, LocalChatDraft.editIndex(new LocalChatStore(activity).conversation(id)));
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            ui(() -> {
                View root = activity.getWindow().getDecorView();
                assertEquals(View.VISIBLE, root.findViewWithTag("composerEditBanner").getVisibility());
                ((EditText) root.findViewWithTag("localComposer")).setText("Replacement");
                assertEquals(View.VISIBLE, root.findViewWithTag("composerEditBanner").getVisibility());
                root.findViewWithTag("composerCancelEdit").performClick();
                activity.onBackPressed();
            });
            JSONObject saved = new LocalChatStore(activity).conversation(id);
            assertFalse(saved.has("draftEditIndex"));
            assertEquals("Original", saved.getJSONArray("messages").getJSONObject(0).getString("content"));
        } finally { ui(activity::finish); }
    }

    public void testDraftRejectsStaleEditTarget() throws Exception {
        JSONObject conversation = new JSONObject().put("messages", new JSONArray()
            .put(new JSONObject().put("role", "user")).put(new JSONObject().put("role", "assistant")));
        LocalChatDraft.save(conversation, "draft", 0);
        assertEquals(0, LocalChatDraft.editIndex(conversation));
        conversation.getJSONArray("messages").put(new JSONObject().put("role", "user"));
        assertEquals(-1, LocalChatDraft.editIndex(conversation));
        LocalChatDraft.save(conversation, "draft", 1);
        assertEquals(-1, LocalChatDraft.editIndex(conversation));
        LocalChatDraft.save(conversation, "", 2);
        assertEquals(2, LocalChatDraft.editIndex(conversation));
        LocalChatDraft.save(conversation, "", -1);
        assertFalse(conversation.has("draftEditIndex"));
    }

    public void testRunningReplyUsesMarkdownWithoutRebuildingProcess() throws Throwable {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject conversation = store.createConversation("", "missing-route");
        String id = conversation.getString("id");
        conversation.getJSONArray("messages").put(new JSONObject().put("role", "assistant").put("content", "")); store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            ui(() -> {
                try {
                var storeField = LocalChatActivity.class.getDeclaredField("store"); storeField.setAccessible(true);
                JSONObject reply = ((LocalChatStore) storeField.get(activity)).conversation(id).getJSONArray("messages").getJSONObject(0);
                var replyField = LocalChatActivity.class.getDeclaredField("runningReply"); replyField.setAccessible(true); replyField.set(activity, reply);
                var runningField = LocalChatActivity.class.getDeclaredField("runningId"); runningField.setAccessible(true); runningField.set(activity, id);
                var latestField = LocalChatActivity.class.getDeclaredField("latest"); latestField.setAccessible(true); latestField.set(activity, "**Streaming**");
                var render = LocalChatActivity.class.getDeclaredMethod("renderMessages"); render.setAccessible(true); render.invoke(activity);
                View block = activity.getWindow().getDecorView().findViewWithTag("localMessage:0");
                assertNotNull(block.findViewWithTag("markdown"));
                latestField.set(activity, "**Streaming**\n\n- More output");
                var update = LocalChatActivity.class.getDeclaredMethod("renderLiveBody"); update.setAccessible(true); update.invoke(activity);
                assertSame(block, activity.getWindow().getDecorView().findViewWithTag("localMessage:0"));
                assertNotNull(block.findViewWithTag("markdown"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { ui(activity::finish); }
    }

    private JSONObject bundle(String baseUrl, String protocol) throws Exception {
        JSONObject provider = new JSONObject().put("id", "test-provider").put("name", "Test API").put("protocol", protocol)
            .put("baseUrl", baseUrl).put("keys", new JSONArray().put(new JSONObject().put("key", "test-secret").put("enabled", true)))
            .put("models", new JSONArray().put(new JSONObject().put("id", "test-model").put("upstream", "upstream-model").put("protocol", "auto")));
        return new JSONObject().put("format", "camellia-api-routes").put("version", 2)
            .put("config", new JSONObject().put("enabled", false).put("providers", new JSONArray().put(provider)));
    }

    public void testImportValidationAndEncryptedPersistence() throws Exception {
        JSONObject exported = bundle("https://example.com/v1/", "dual");
        JSONObject config = LocalChatConfig.parse("\ufeff" + exported);
        LocalChatConfig.Route route = LocalChatConfig.routes(config).get(0);
        assertEquals("https://example.com/v1", route.baseUrl); assertEquals("openai", route.protocol); assertEquals("upstream-model", route.model);
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext()); store.importConfig(config);
        JSONObject workspace = store.createWorkspace("Research");
        JSONObject conversation = store.createConversation(workspace.getString("id"), route.id);
        conversation.put("draft", "Draft stays here"); store.save();
        LocalChatStore restored = new LocalChatStore(getInstrumentation().getTargetContext());
        assertEquals("Draft stays here", restored.conversation(conversation.getString("id")).getString("draft"));
        assertEquals("test-secret", LocalChatConfig.routes(restored.config()).get(0).key);
        String stored = getInstrumentation().getTargetContext().getSharedPreferences("local-chat-private", 0).getString("credential", "");
        assertFalse(stored.contains("test-secret")); assertFalse(stored.contains("Draft stays here"));
        restored.importConfig(config); assertEquals(1, restored.conversations().length()); assertEquals(1, restored.workspaces().length());
        restored.deleteWorkspace(workspace.getString("id")); assertEquals("", restored.conversation(conversation.getString("id")).getString("workspaceId"));
        for (String invalid : new String[] {"not json", exported + " trailing", "{}", bundle("http://example.com/v1", "openai").toString(),
            bundle("https://user:secret@example.com/v1", "openai").toString(), bundle("https://example.com/v1?key=secret", "openai").toString(),
            bundle("https://example.com/v1", "unsupported").toString()}) {
            try { LocalChatConfig.parse(invalid); fail("Accepted invalid export"); } catch (IllegalArgumentException expected) {}
        }
        exported.getJSONObject("config").getJSONArray("providers").getJSONObject(0).put("enabled", false);
        assertTrue(LocalChatConfig.routes(LocalChatConfig.parse(exported.toString())).isEmpty());
        assertEquals("test-secret", LocalChatConfig.routes(restored.config()).get(0).key);
        restored.deleteConversation(conversation.getString("id")); assertEquals(0, new LocalChatStore(getInstrumentation().getTargetContext()).conversations().length());
    }

    public void testProtocolsMappingDisabledKeysAndHistory() throws Exception {
        JSONObject exported = bundle("https://example.com/v1", "dual");
        JSONObject provider = exported.getJSONObject("config").getJSONArray("providers").getJSONObject(0);
        provider.put("anthropicBaseUrl", "https://example.com/anthropic/v1");
        provider.getJSONArray("models").getJSONObject(0).put("protocol", "anthropic");
        provider.getJSONArray("keys").getJSONObject(0).put("enabled", false);
        provider.getJSONArray("keys").put(new JSONObject().put("key", "second-secret"));
        LocalChatConfig.Route route = LocalChatConfig.routes(LocalChatConfig.parse(exported.toString())).get(0);
        assertEquals("anthropic", route.protocol); assertEquals("https://example.com/anthropic/v1", route.baseUrl); assertEquals("second-secret", route.key);
        JSONArray history = new JSONArray().put(new JSONObject().put("role", "user").put("content", "Hello"))
            .put(new JSONObject().put("role", "assistant").put("content", ""));
        JSONObject request = LocalChatClient.request(route, history);
        assertEquals(4096, request.getInt("max_tokens")); assertEquals("upstream-model", request.getString("model")); assertEquals(1, request.getJSONArray("messages").length());
    }

    private static final class MockApi implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));
        final AtomicReference<String> request = new AtomicReference<>();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final java.util.List<String> requests = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        final Thread thread;
        MockApi(int status, String type, String response) throws Exception {
            this(new int[] {status}, new String[] {type}, new String[] {response});
        }
        MockApi(int[] statuses, String[] types, String[] responses) throws Exception {
            thread = new Thread(() -> {
                for (int turn = 0; turn < statuses.length; turn++) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder captured = new StringBuilder(); String line; int length = 0;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        captured.append(line).append('\n');
                        if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                    }
                    char[] payload = new char[length]; int offset = 0;
                    while (offset < length) { int count = reader.read(payload, offset, length - offset); if (count < 0) break; offset += count; }
                    captured.append(payload); request.set(captured.toString()); requests.add(captured.toString());
                    byte[] bytes = responses[turn].getBytes(StandardCharsets.UTF_8);
                    socket.getOutputStream().write(("HTTP/1.1 " + statuses[turn] + " Test\r\nContent-Type: " + types[turn] + "\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().write(bytes); socket.getOutputStream().flush();
                } catch (Throwable error) { if (!server.isClosed()) failure.set(error); break; }
                }
            }); thread.start();
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/v1"; }
        public void close() throws Exception { server.close(); thread.join(5000); if (failure.get() != null) throw new AssertionError(failure.get()); }
    }

    private JSONObject request() throws Exception { return new JSONObject().put("model", "upstream-model").put("stream", true).put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", "Hello"))); }
    public void testThinkingStreamsStaySeparateFromAnswer() throws Exception {
        for (String protocol : new String[] {"openai", "anthropic"}) {
            String stream = protocol.equals("openai")
                ? "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Published reasoning\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Final\"}}]}\n\ndata: [DONE]\n\n"
                : "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Published reasoning\"}}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"signature_delta\",\"signature\":\"hidden\"}}\n\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Final\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
            try (MockApi api = new MockApi(200, "text/event-stream", stream)) {
                AtomicReference<String> thinking = new AtomicReference<>();
                String result = new LocalChatClient().chat(route(api.url(), protocol), request(), new LocalChatClient.Listener() {
                    public void onText(String text) {}
                    public void onThinking(String text) { thinking.set(text); }
                });
                assertEquals("Final", result); assertEquals("Published reasoning", thinking.get());
            }
        }
    }

    public void testStreamingErrorsPreserveProviderDetail() throws Exception {
        try (MockApi api = new MockApi(200, "text/event-stream",
                "data: {\"error\":{\"message\":\"upstream overloaded\",\"code\":\"overloaded\"}}\n\n")) {
            try {
                new LocalChatClient().chat(route(api.url(), "openai"), request(), text -> {});
                fail("Accepted streaming error");
            } catch (java.io.IOException error) {
                assertTrue(error.getMessage().contains("upstream overloaded"));
                assertTrue(error.getMessage().contains("overloaded"));
            }
        }
    }

    public void testLocalStatusOpensSharedErrorDetails() throws Throwable {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            ui(() -> {
                View status = activity.getWindow().getDecorView().findViewWithTag("localStatus");
                assertNotNull(status);
                assertTrue(status.hasOnClickListeners());
                status.performClick();
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        } finally {
            finishActivity(activity);
        }
    }

    private LocalChatConfig.Route route(String url, String protocol) { return new LocalChatConfig.Route("test", "Test", "upstream-model", protocol, url, "test-secret"); }

    public void testExplicitClientIdentityForBothProtocolsAndResponseModes() throws Exception {
        for (String protocol : new String[]{"openai", "anthropic"}) for (boolean stream : new boolean[]{false, true}) {
            String reply = protocol.equals("openai")
                ? stream ? "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n" : "{\"choices\":[{\"message\":{\"content\":\"OK\"}}]}"
                : stream ? "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n" : "{\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}";
            try (MockApi api = new MockApi(200, stream ? "text/event-stream" : "application/json", reply)) {
                assertEquals("OK", new LocalChatClient().chat(route(api.url(), protocol), request().put("stream", stream), text -> {}));
                String captured = api.request.get();
                assertTrue(captured.contains("User-Agent: Camellia-Android/LocalChat\n"));
                assertFalse(captured.contains("Dalvik/"));
                assertTrue(captured.contains("Authorization: Bearer test-secret\n"));
                assertTrue(captured.startsWith("POST /v1/" + (protocol.equals("anthropic") ? "messages" : "chat/completions") + " HTTP/"));
            }
        }
    }

    public void testImportedOllamaKeysAndRejectedKeyFallback() throws Exception {
        String reply = "data: {\"choices\":[{\"delta\":{\"content\":\"Recovered reply\"}}]}\n\ndata: [DONE]\n\n";
        for (int code : new int[] {401, 402, 403, 429}) {
            try (MockApi api = new MockApi(new int[] {code, 200}, new String[] {"application/json", "text/event-stream"},
                    new String[] {"{\"error\":\"subscription usage limit exceeded\"}", reply})) {
                JSONObject exported = bundle(api.url(), "dual");
                JSONObject provider = exported.getJSONObject("config").getJSONArray("providers").getJSONObject(0);
                provider.put("type", "ollama");
                provider.getJSONArray("models").getJSONObject(0).put("upstream", "deepseek-v4.1-flash:cloud");
                provider.getJSONArray("keys").put(new JSONObject().put("key", "disabled-key").put("enabled", false))
                    .put(new JSONObject().put("key", "second-secret")).put(new JSONObject().put("key", "second-secret"));
                LocalChatConfig.Route route = LocalChatConfig.routes(LocalChatConfig.parse(exported.toString())).get(0);
                assertEquals(2, route.keys.size());
                JSONObject body = LocalChatClient.request(route, new JSONArray().put(new JSONObject().put("role", "user").put("content", "Hello")));
                assertEquals("Recovered reply", new LocalChatClient().chat(route, body, text -> {}));
                assertEquals(2, api.requests.size());
                for (String captured : api.requests) assertTrue(captured.contains("User-Agent: Camellia-Android/LocalChat\n"));
                assertTrue(api.requests.get(0).contains("Bearer test-secret")); assertTrue(api.requests.get(1).contains("Bearer second-secret"));
                assertFalse(api.requests.toString().contains("disabled-key"));
                assertTrue(api.requests.get(1).contains("deepseek-v4.1-flash:cloud"));
            }
        }
    }

    public void testHttpDiagnosticsRedactSecretsAndClassify403() throws Exception {
        java.util.List<String> keys = java.util.Arrays.asList("test-secret", "second-secret");
        String source = "{\"error\":{\"message\":\"subscription limit for test-secret and second-secret Authorization: Bearer hidden-token\",\"code\":\"quota_exceeded\"}}";
        LocalChatHttpError quota = LocalChatHttpError.from(403, source, keys, "ollama.com", 2, 2);
        assertTrue(quota.tryNextKey); assertTrue(quota.getMessage().contains("quota_exceeded")); assertTrue(quota.getMessage().contains("2/2"));
        assertFalse(quota.getMessage().contains("test-secret")); assertFalse(quota.getMessage().contains("second-secret")); assertFalse(quota.getMessage().contains("hidden-token"));
        LocalChatHttpError firewall = LocalChatHttpError.from(403, "<!doctype html><html>Access denied quota test-secret</html>", keys, "ollama.com", 1, 2);
        assertFalse(firewall.tryNextKey); assertTrue(firewall.getMessage().contains("IP")); assertFalse(firewall.getMessage().contains("<html>"));
        assertFalse(LocalChatHttpError.from(403, "{\"error\":\"Access denied in your region\"}", keys, "ollama.com", 1, 2).tryNextKey);
        assertFalse(LocalChatHttpError.from(403, "{\"error\":\"IP address limit reached\"}", keys, "ollama.com", 1, 2).tryNextKey);
        assertTrue(LocalChatHttpError.from(403, "{\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid API key\"}}", keys, "ollama.com", 1, 2).tryNextKey);
        for (int code : new int[]{400, 405}) {
            assertTrue(LocalChatHttpError.from(code, "{\"error\":{\"code\":\"insufficient_quota\"}}", keys, "example.com", 1, 2).tryNextKey);
            assertFalse(LocalChatHttpError.from(code, "{\"error\":\"context limit exceeded\"}", keys, "example.com", 1, 2).tryNextKey);
            try (MockApi api = new MockApi(new int[]{code, 200}, new String[]{"application/json", "application/json"},
                    new String[]{"{\"error\":{\"code\":\"insufficient_quota\"}}", "{\"choices\":[{\"message\":{\"content\":\"Recovered\"}}]}"})) {
                LocalChatConfig.Route route = new LocalChatConfig.Route("test", "Test", "model", "openai", api.url(), keys);
                assertEquals("Recovered", new LocalChatClient().chat(route, request(), text -> {}));
                assertEquals(2, api.requests.size());
                assertTrue(api.requests.get(1).contains("Bearer second-secret"));
            }
        }
        assertTrue(LocalChatHttpError.redact("api_key=unknown-secret sk-other-secret Bearer hidden", keys).indexOf("unknown-secret") < 0);
        try (MockApi api = new MockApi(403, "application/json", source)) {
            try { new LocalChatClient().chat(route(api.url(), "openai"), request(), text -> {}); fail("Accepted quota rejection"); }
            catch (java.io.IOException error) { assertTrue(error.getMessage().contains("quota_exceeded")); assertFalse(error.getMessage().contains("test-secret")); }
        }
    }

    public void testNeverReplayForbiddenServerErrorOrPartialResponse() throws Exception {
        for (int code : new int[] {302, 403, 500, 200}) {
            String response = code == 200 ? "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n" : "{\"error\":\"Access denied\"}";
            try (MockApi api = new MockApi(new int[] {code, 200}, new String[] {code == 200 ? "text/event-stream" : "application/json", "application/json"},
                    new String[] {response, "{\"choices\":[{\"message\":{\"content\":\"should not happen\"}}]}"})) {
                LocalChatConfig.Route route = new LocalChatConfig.Route("test", "Test", "model", "openai", api.url(), java.util.Arrays.asList("first", "second"));
                try { new LocalChatClient().chat(route, request(), text -> {}); fail("Expected error without replay"); }
                catch (java.io.IOException expected) { assertEquals(1, api.requests.size()); }
            }
        }
        try (MockApi api = new MockApi(new int[] {401, 401}, new String[] {"application/json", "application/json"}, new String[] {"{}", "{}"})) {
            LocalChatConfig.Route route = new LocalChatConfig.Route("test", "Test", "model", "openai", api.url(), java.util.Arrays.asList("first", "second"));
            try { new LocalChatClient().chat(route, request(), text -> {}); fail("Expected exhausted keys"); }
            catch (java.io.IOException expected) { assertEquals(2, api.requests.size()); assertTrue(expected.getMessage().contains("2/2")); }
        }
    }

    public void testOpenAiAndAnthropicStreamingAndJson() throws Exception {
        try (MockApi api = new MockApi(200, "text/event-stream", ": ping\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n")) {
            assertEquals("你好", new LocalChatClient().chat(route(api.url(), "openai"), request(), text -> {}));
            assertTrue(api.request.get().startsWith("POST /v1/chat/completions")); assertTrue(api.request.get().contains("Bearer test-secret"));
        }
        try (MockApi api = new MockApi(200, "text/event-stream", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")) {
            assertEquals("Hello", new LocalChatClient().chat(route(api.url(), "anthropic"), request(), text -> {}));
            assertTrue(api.request.get().startsWith("POST /v1/messages")); assertTrue(api.request.get().contains("x-api-key: test-secret"));
        }
        try (MockApi api = new MockApi(200, "application/json", "{\"choices\":[{\"message\":{\"content\":\"JSON reply\"}}]}")) {
            assertEquals("JSON reply", new LocalChatClient().chat(route(api.url(), "openai"), request(), text -> {}));
        }
    }

    public void testTruncatedStreamHttpErrorsAndCancel() throws Exception {
        AtomicReference<String> partial = new AtomicReference<>();
        try (MockApi api = new MockApi(200, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")) {
            try { new LocalChatClient().chat(route(api.url(), "openai"), request(), partial::set); fail("Accepted truncated stream"); }
            catch (java.io.IOException expected) { assertEquals("partial", partial.get()); }
        }
        for (int code : new int[] {302, 401, 429, 500}) {
            try (MockApi api = new MockApi(code, "application/json", "secret-error-body")) {
                try { new LocalChatClient().chat(route(api.url(), "openai"), request(), text -> {}); fail("Accepted HTTP error"); }
                catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains(String.valueOf(code))); assertFalse(expected.getMessage().contains("secret-error-body")); }
            }
        }
        LocalChatClient cancelled = new LocalChatClient(); cancelled.cancel();
        try { cancelled.chat(route("http://127.0.0.1:1", "openai"), request(), text -> {}); fail("Ignored cancellation"); }
        catch (java.io.IOException expected) { assertEquals("Cancelled", expected.getMessage()); }
    }

    private void ui(Runnable action) throws Throwable { runTestOnUiThread(action); getInstrumentation().waitForIdleSync(); }
    private void finishActivity(Activity activity) throws Exception {
        getInstrumentation().runOnMainSync(activity::finish);
        long deadline = System.currentTimeMillis() + 5000;
        while (!activity.isDestroyed() && System.currentTimeMillis() < deadline) {
            getInstrumentation().waitForIdleSync(); Thread.sleep(25);
        }
        assertTrue("Activity must stop saving before test storage is cleared", activity.isDestroyed());
    }
    private View picker(Activity activity) {
        try {
            var field = LocalChatActivity.class.getDeclaredField("modelPicker"); field.setAccessible(true);
            var window = ModelPickerPopup.class.getDeclaredField("popup"); window.setAccessible(true);
            return ((android.widget.PopupWindow) window.get(field.get(activity))).getContentView();
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private void screenshot(Activity activity, String name) throws Exception {
        getInstrumentation().getUiAutomation().waitForIdle(200, 3000);
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        }
        image.recycle();
    }

    public void testThinkingRequestParameters() throws Exception {
        JSONArray history = new JSONArray().put(new JSONObject().put("role", "user").put("content", "Hello"));
        LocalChatConfig.Route openai = route("https://example.com/v1", "openai");
        assertFalse(LocalChatClient.request(openai, history, "auto").has("reasoning_effort"));
        assertEquals("medium", LocalChatClient.request(openai, history, "medium").getString("reasoning_effort"));
        assertEquals("high", LocalChatClient.request(openai, history, "high").getString("reasoning_effort"));
        assertFalse(LocalChatClient.request(openai, history, "invalid").has("reasoning_effort"));
        LocalChatConfig.Route adaptive = new LocalChatConfig.Route("a", "Claude", "claude-sonnet-4-6", "anthropic", "https://example.com/v1", "secret");
        JSONObject modern = LocalChatClient.request(adaptive, history, "high");
        assertEquals("adaptive", modern.getJSONObject("thinking").getString("type"));
        assertEquals("high", modern.getJSONObject("output_config").getString("effort"));
        LocalChatConfig.Route legacy = new LocalChatConfig.Route("b", "Claude", "claude-sonnet-4-5-20250929", "anthropic", "https://example.com/v1", "secret");
        JSONObject budget = LocalChatClient.request(legacy, history, "medium");
        assertEquals(2048, budget.getJSONObject("thinking").getInt("budget_tokens"));
        assertTrue(budget.getInt("max_tokens") > budget.getJSONObject("thinking").getInt("budget_tokens"));
        assertFalse(LocalChatClient.request(legacy, history, "auto").has("thinking"));
        assertFalse(LocalChatThinking.supported(route("https://example.com/v1", "anthropic")));
        assertFalse(LocalChatClient.request(route("https://example.com/v1", "anthropic"), history, "high").has("thinking"));
    }

    public void testModelPillThinkingPopupPersistenceAndRequest() throws Throwable {
        try (MockApi api = new MockApi(200, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"Configured reply\"}}]}\n\ndata: [DONE]\n\n")) {
            JSONObject exported = bundle(api.url(), "openai");
            JSONArray models = exported.getJSONObject("config").getJSONArray("providers").getJSONObject(0).getJSONArray("models");
            models.getJSONObject(0).put("id", "kimi-k3");
            models.put(new JSONObject().put("id", "deepseek-v4-pro").put("upstream", "another-model"));
            models.put(new JSONObject().put("id", "claude-sonnet-4.6").put("upstream", "claude-sonnet-4-6").put("protocol", "anthropic"));
            LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext()); store.importConfig(LocalChatConfig.parse(exported.toString()));
            Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localNewStandalone").performClick());
                String id = new LocalChatStore(getInstrumentation().getTargetContext()).conversations().getJSONObject(0).getString("id");
                ui(() -> {
                    View root = activity.getWindow().getDecorView(); View model = root.findViewWithTag("localModel"), back = root.findViewWithTag("localBack");
                    assertSame(root.findViewWithTag("localComposerBar"), model.getParent().getParent());
                    assertNotSame(back.getParent(), model.getParent());
                    assertTrue(((android.widget.TextView) model).getText().toString().startsWith("K3 · "));
                    assertTrue(model.getWidth() < ((View) model.getParent()).getWidth());
                    ((EditText) root.findViewWithTag("localComposer")).setText("Hello"); model.performClick();
                    assertTrue(picker(activity).findViewWithTag("modelOption:test-provider/kimi-k3").isSelected());
                });
                screenshot(activity, "model-picker");
                ui(() -> picker(activity).findViewWithTag("thinkingSettings").performClick());
                screenshot(activity, "thinking-picker");
                ui(() -> picker(activity).findViewWithTag("thinkingOption:high").performClick());
                assertEquals("high", new LocalChatStore(getInstrumentation().getTargetContext()).conversation(id).getString("thinking"));
                screenshot(activity, "model-pill");
                ui(() -> activity.onBackPressed());
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
                ui(() -> {
                    View root = activity.getWindow().getDecorView();
                    assertEquals("Hello", ((EditText) root.findViewWithTag("localComposer")).getText().toString());
                    assertTrue(root.findViewWithTag("localModel").getContentDescription().toString().matches("(?s).*(Advanced|进阶).*"));
                    root.findViewWithTag("localSend").performClick(); assertFalse(root.findViewWithTag("localModel").isEnabled());
                });
                long deadline = System.currentTimeMillis() + 5000;
                while (System.currentTimeMillis() < deadline && api.request.get() == null) Thread.sleep(50);
                assertNotNull(api.request.get()); assertTrue(api.request.get().contains("\"reasoning_effort\":\"high\""));
                while (System.currentTimeMillis() < deadline) {
                    JSONObject reply = new LocalChatStore(getInstrumentation().getTargetContext()).conversation(id).getJSONArray("messages").getJSONObject(1);
                    if (reply.optString("state").equals("complete")) break;
                    Thread.sleep(50);
                }
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localModel").performClick());
                ui(() -> picker(activity).findViewWithTag("modelOption:test-provider/deepseek-v4-pro").performClick());
                JSONObject changed = new LocalChatStore(getInstrumentation().getTargetContext()).conversation(id);
                assertEquals("test-provider/deepseek-v4-pro", changed.getString("routeId")); assertEquals("auto", changed.getString("thinking"));
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localModel").performClick());
                ui(() -> picker(activity).findViewWithTag("thinkingSettings").performClick());
                ui(() -> picker(activity).findViewWithTag("thinkingBack").performClick());
                assertNotNull(picker(activity).findViewWithTag("modelOption:test-provider/kimi-k3"));
                getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
                assertNotNull(activity.getWindow().getDecorView().findViewWithTag("localComposer"));
            } finally { finishActivity(activity); }
        }
    }
    private AlertDialog dialog(Activity activity) {
        try { var field = LocalChatActivity.class.getDeclaredField("dialog"); field.setAccessible(true); return (AlertDialog) field.get(activity); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    public void testHomeEntryBeforeComputers() throws Throwable {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> {
                View entry = activity.getWindow().getDecorView().findViewWithTag("localChatEntry"); assertNotNull(entry);
                android.view.ViewGroup parent = (android.view.ViewGroup) entry.getParent();
                assertEquals(parent.indexOfChild(entry) + 1, parent.indexOfChild(parent.findViewWithTag("remoteControlEntry")));
                assertNotNull(parent.findViewWithTag("settingsEntry"));
            });
        } finally { finishActivity(activity); }
    }

    public void testStopAndBackgroundPreservePartialReply() throws Throwable {
        for (boolean background : new boolean[] {false, true}) {
            try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
                java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
                Thread upstream = new Thread(() -> {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(5000);
                        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                        String line; int length = 0;
                        while ((line = reader.readLine()) != null && !line.isEmpty()) if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                        for (int index = 0; index < length; index++) reader.read();
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                            + "data: {\"choices\":[{\"delta\":{\"content\":\"Keep this partial\"}}]}\n\n").getBytes(StandardCharsets.UTF_8));
                        socket.getOutputStream().flush(); release.await(10, java.util.concurrent.TimeUnit.SECONDS);
                    } catch (Exception ignored) {}
                }); upstream.start();
                LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
                store.importConfig(LocalChatConfig.parse(bundle("http://127.0.0.1:" + server.getLocalPort() + "/v1", "openai").toString()));
                Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                try {
                    ui(() -> activity.getWindow().getDecorView().findViewWithTag("localNewStandalone").performClick());
                    ui(() -> { View root = activity.getWindow().getDecorView(); ((EditText) root.findViewWithTag("localComposer")).setText("Hello"); root.findViewWithTag("localSend").performClick(); });
                    long deadline = System.currentTimeMillis() + 5000;
                    AtomicReference<String> latest = new AtomicReference<>("");
                    while (System.currentTimeMillis() < deadline) {
                        ui(() -> { try { var field = LocalChatActivity.class.getDeclaredField("latest"); field.setAccessible(true); latest.set((String) field.get(activity)); } catch (Exception error) { throw new AssertionError(error); } });
                        if (latest.get().equals("Keep this partial")) break;
                        Thread.sleep(50);
                    }
                    AtomicReference<String> status = new AtomicReference<>();
                    ui(() -> status.set(((android.widget.TextView) activity.getWindow().getDecorView().findViewWithTag("localStatus")).getText().toString()));
                    assertEquals(status.get(), "Keep this partial", latest.get());
                    if (background) {
                        getInstrumentation().runOnMainSync(() -> getInstrumentation().callActivityOnStop(activity));
                    } else ui(() -> activity.getWindow().getDecorView().findViewWithTag("localStop").performClick());
                    JSONArray conversations = new LocalChatStore(getInstrumentation().getTargetContext()).conversations();
                    JSONObject reply = conversations.getJSONObject(conversations.length() - 1).getJSONArray("messages").getJSONObject(1);
                    assertEquals("Keep this partial", reply.getString("content")); assertEquals(background ? "interrupted" : "stopped", reply.getString("state"));
                } finally { release.countDown(); server.close(); upstream.join(5000); finishActivity(activity); }
            }
        }
    }

    public void testPasteImportWorkspaceAndChatUi() throws Throwable {
        try (MockApi api = new MockApi(200, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"Local reply\"}}]}\n\ndata: [DONE]\n\n")) {
            Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                ui(() -> {
                    View root;
                    try { var field = LocalChatActivity.class.getDeclaredField("root"); field.setAccessible(true); root = (View) field.get(activity); }
                    catch (Exception error) { throw new AssertionError(error); }
                    assertTrue(root.getPaddingLeft() >= Math.round(18 * activity.getResources().getDisplayMetrics().density));
                    assertTrue(root.getPaddingRight() >= Math.round(18 * activity.getResources().getDisplayMetrics().density));
                });
                var monitor = getInstrumentation().addMonitor(SettingsActivity.class.getName(), null, false);
                ui(() -> {
                    View root = activity.getWindow().getDecorView(); assertNull(root.findViewWithTag("localConfig"));
                    assertTrue(root.findViewWithTag("localNewWorkspace") instanceof android.widget.ImageButton);
                    root.findViewWithTag("localNewStandalone").performClick();
                });
                Activity settings = monitor.waitForActivityWithTimeout(5000); assertNotNull(settings);
                getInstrumentation().removeMonitor(monitor);
                String exported = bundle(api.url(), "openai").toString();
                try {
                    ui(() -> settings.getWindow().getDecorView().findViewWithTag("providerImport").performClick());
                    ui(() -> {
                        try {
                            var field = SettingsActivity.class.getDeclaredField("dialog"); field.setAccessible(true);
                            AlertDialog importDialog = (AlertDialog) field.get(settings);
                            EditText input = importDialog.getWindow().getDecorView().findViewWithTag("providerImportText");
                            input.setText("broken"); importDialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertTrue(importDialog.isShowing());
                            input.setText(exported); importDialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertFalse(importDialog.isShowing());
                        } catch (Exception error) { throw new AssertionError(error); }
                    });
                } finally { finishActivity(settings); }
                getInstrumentation().waitForIdleSync();
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localNewWorkspace").performClick());
                ui(() -> {
                    AlertDialog workspace = dialog(activity); ((EditText) workspace.getWindow().getDecorView().findViewWithTag("localWorkspaceName")).setText("Phone research");
                    workspace.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                });
                String workspaceId = new LocalChatStore(getInstrumentation().getTargetContext()).workspaces().getJSONObject(0).getString("id");
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localAdd:" + workspaceId).performClick());
                ui(() -> {
                    View root = activity.getWindow().getDecorView(); ((EditText) root.findViewWithTag("localComposer")).setText("Hello"); root.findViewWithTag("localSend").performClick();
                });
                long deadline = System.currentTimeMillis() + 5000;
                while (System.currentTimeMillis() < deadline) {
                    getInstrumentation().waitForIdleSync();
                    JSONArray messages = new LocalChatStore(getInstrumentation().getTargetContext()).conversations().getJSONObject(0).getJSONArray("messages");
                    if (messages.length() == 2 && messages.getJSONObject(1).optString("state").equals("complete")) break;
                    Thread.sleep(50);
                }
                JSONObject conversation = new LocalChatStore(getInstrumentation().getTargetContext()).conversations().getJSONObject(0);
                assertEquals("Local reply", conversation.getJSONArray("messages").getJSONObject(1).getString("content"));
                assertEquals(workspaceId, conversation.getString("workspaceId"));
                ui(() -> { ((EditText) activity.getWindow().getDecorView().findViewWithTag("localComposer")).setText("Draft"); activity.onBackPressed(); });
                assertEquals("Draft", new LocalChatStore(getInstrumentation().getTargetContext()).conversation(conversation.getString("id")).getString("draft"));
                ui(() -> activity.getWindow().getDecorView().findViewWithTag("localNewStandalone").performClick());
                assertEquals("", new LocalChatStore(getInstrumentation().getTargetContext()).conversations().getJSONObject(1).getString("workspaceId"));
            } finally { finishActivity(activity); }
        }
    }

    // Archiving the open chat continues at its neighbor below, then the chat
    // above; an emptied group opens a new chat there, and standalone chats use
    // the standalone group the same way.
    public void testArchiveOpensNeighborThenNewChatInSameGroup() throws Throwable {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        store.importConfig(LocalChatConfig.parse(bundle("https://example.com/v1", "openai").toString()));
        String group = store.createWorkspace("Phone group").getString("id");
        JSONObject newerGroup = seedChat(store, group, "Newer group chat", 3000);
        JSONObject olderGroup = seedChat(store, group, "Older group chat", 1000);
        JSONObject newerStandalone = seedChat(store, "", "Newer standalone chat", 2000);
        JSONObject olderStandalone = seedChat(store, "", "Older standalone chat", 500);
        store.save();
        Activity activity = getInstrumentation().startActivitySync(
            new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            // The row below wins, then the row above once that one is archived.
            openChat(activity, newerGroup);
            archiveOpenChat(activity);
            assertEquals(olderGroup.optString("id"), openConversationId(activity));
            archiveOpenChat(activity);
            String replacement = openConversationId(activity);
            assertNotNull(replacement);
            assertEquals(group, new LocalChatStore(activity).conversation(replacement).getString("workspaceId"));
            assertTrue(new LocalChatStore(activity).conversation(olderGroup.optString("id")).getBoolean("archived"));
            assertTrue(new LocalChatStore(activity).conversation(newerGroup.optString("id")).getBoolean("archived"));

            // Standalone chats keep the current workspace-less group too.
            ui(() -> activity.onBackPressed());
            openChat(activity, newerStandalone);
            archiveOpenChat(activity);
            assertEquals(olderStandalone.optString("id"), openConversationId(activity));
            archiveOpenChat(activity);
            String standaloneReplacement = openConversationId(activity);
            assertNotNull(standaloneReplacement);
            assertEquals("", new LocalChatStore(activity).conversation(standaloneReplacement).getString("workspaceId"));
        } finally { finishActivity(activity); }
    }

    private JSONObject seedChat(LocalChatStore store, String workspace, String title, long updatedAt) throws Exception {
        JSONObject conversation = store.createConversation(workspace, "missing-route");
        conversation.put("title", title);
        conversation.put("updatedAt", updatedAt);
        return conversation;
    }

    private void openChat(Activity activity, JSONObject conversation) throws Throwable {
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + conversation.optString("id")).performClick());
        assertEquals(conversation.optString("id"), openConversationId(activity));
    }

    private void archiveOpenChat(Activity activity) throws Throwable {
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("localChatMenu").performClick());
        ui(() -> dialog(activity).getWindow().getDecorView().findViewWithTag("localConversationArchive").performClick());
    }

    private String openConversationId(Activity activity) {
        try {
            var field = LocalChatActivity.class.getDeclaredField("conversationId"); field.setAccessible(true);
            return (String) field.get(activity);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    public void testInterruptedReplyRecovery() throws Exception {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject conversation = store.createConversation("", "missing-route");
        conversation.getJSONArray("messages").put(new JSONObject().put("role", "assistant").put("content", "Partial persisted text").put("state", "running")); store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            JSONObject recovered = new LocalChatStore(getInstrumentation().getTargetContext()).conversation(conversation.getString("id")).getJSONArray("messages").getJSONObject(0);
            assertEquals("interrupted", recovered.getString("state")); assertEquals("Partial persisted text", recovered.getString("content"));
        } finally { finishActivity(activity); }
    }

    public void testTapLastUserMessageEntersEditMode() throws Throwable {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject conversation = store.createConversation("", "missing-route");
        conversation.getJSONArray("messages")
            .put(new JSONObject().put("role", "user").put("content", "First question").put("at", 1))
            .put(new JSONObject().put("role", "assistant").put("content", "First answer").put("state", "complete").put("at", 1))
            .put(new JSONObject().put("role", "user").put("content", "Latest question").put("at", 2))
            .put(new JSONObject().put("role", "assistant").put("content", "Latest answer").put("state", "complete").put("at", 2));
        store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + conversation.optString("id")).performClick());
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localMessage:2").performClick());
            EditText composer = activity.getWindow().getDecorView().findViewWithTag("localComposer");
            assertEquals("Latest question", composer.getText().toString());
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localMessage:0").performClick());
            assertEquals("Latest question", composer.getText().toString());
        } finally { finishActivity(activity); }
    }
}
