package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class LocalToolsTest extends InstrumentationTestCase {
    private static final class Api implements AutoCloseable {
        final ServerSocket server;
        final Thread thread;
        final List<JSONObject> requests = new ArrayList<>();
        volatile Throwable failure;
        Api(String... replies) throws Exception {
            server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(() -> {
                for (String reply : replies) try (var socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    int length = 0; String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) if (line.toLowerCase().startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                    char[] body = new char[length]; int offset = 0;
                    while (offset < length) { int count = reader.read(body, offset, length - offset); if (count < 0) break; offset += count; }
                    requests.add(new JSONObject(new String(body)));
                    byte[] bytes = reply.getBytes(StandardCharsets.UTF_8);
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().write(bytes); socket.getOutputStream().flush();
                } catch (Throwable error) { if (!server.isClosed()) failure = error; break; }
            }); thread.start();
        }
        LocalChatConfig.Route route(String protocol) { return new LocalChatConfig.Route("test", "Test", "fixture", protocol, "http://127.0.0.1:" + server.getLocalPort() + "/v1", "model-secret"); }
        public void close() throws Exception { server.close(); thread.join(5000); if (failure != null) throw new AssertionError(failure); }
    }

    private static class Tools implements LocalToolLoop.Executor {
        int calls; boolean cancelled;
        public JSONObject execute(String name, JSONObject arguments) throws Exception {
            calls++;
            return new JSONObject().put("sources", new JSONArray().put(new JSONObject().put("url", "https://example.com/article"))).put("text", "Public evidence");
        }
        public void cancel() { cancelled = true; }
    }

    private String call(String protocol, String id, String name, String arguments) throws Exception {
        if (protocol.equals("anthropic")) return new JSONObject().put("stop_reason", "tool_use").put("content", new JSONArray()
            .put(new JSONObject().put("type", "thinking").put("thinking", "Plan").put("signature", "opaque-signature"))
            .put(new JSONObject().put("type", "tool_use").put("id", id).put("name", name).put("input", new JSONObject(arguments)))).toString();
        return new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("finish_reason", "tool_calls")
            .put("message", new JSONObject().put("role", "assistant").put("content", JSONObject.NULL).put("reasoning_content", "Plan")
                .put("tool_calls", new JSONArray().put(new JSONObject().put("id", id).put("type", "function")
                    .put("function", new JSONObject().put("name", name).put("arguments", arguments))))))).toString();
    }

    private String answer(String protocol) throws Exception {
        if (protocol.equals("anthropic")) return "{\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Final answer\"}]}";
        return "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"Final answer\"}}]}";
    }

    private JSONObject body(LocalChatConfig.Route route) throws Exception {
        return LocalChatClient.request(route, new JSONArray().put(new JSONObject().put("role", "user").put("content", "Find evidence")));
    }

    public void testBothProtocolsPreserveToolContextAndCiteSources() throws Exception {
        for (String protocol : new String[]{"openai", "anthropic"}) try (Api api = new Api(call(protocol, "call-1", "web_fetch", "{\"url\":\"https://example.com/article\"}"), answer(protocol))) {
            Tools tools = new Tools(); List<JSONObject> progress = new ArrayList<>();
            LocalChatConfig.Route route = api.route(protocol);
            JSONObject original = body(route);
            String result = new LocalChatClient().chatWithTools(route, original, new LocalChatClient.Listener() {
                public void onText(String text) {}
                public void onTool(JSONObject entry) { progress.add(entry); }
            }, tools);
            assertTrue(result.contains("Final answer")); assertTrue(result.contains("https://example.com/article"));
            assertEquals(1, tools.calls); assertTrue(tools.cancelled); assertEquals(2, api.requests.size());
            assertEquals("running", progress.get(0).getString("status")); assertEquals("completed", progress.get(1).getString("status"));
            assertFalse(original.has("tools")); assertTrue(original.getBoolean("stream"));
            JSONObject second = api.requests.get(1); assertFalse(second.getBoolean("stream"));
            JSONArray messages = second.getJSONArray("messages");
            assertTrue(messages.toString().contains("call-1")); assertTrue(messages.toString().contains("Public evidence"));
            assertTrue(messages.toString().contains(protocol.equals("anthropic") ? "opaque-signature" : "reasoning_content"));
            assertFalse(second.toString().contains("model-secret"));
        }
    }

    public void testUnknownMalformedAndOversizedCallsNeverExecute() throws Exception {
        for (String[] invalid : new String[][]{{"shell", "{}"}, {"web_search", "{bad"}, {"web_search", "{\"query\":\"science\",\"extra\":true}"}, {"web_fetch", "{\"url\":\"https://example.com\",\"extra\":true}"}}) {
            try (Api api = new Api(call("openai", "call-1", invalid[0], invalid[1]), answer("openai"))) {
                Tools tools = new Tools();
                new LocalChatClient().chatWithTools(api.route("openai"), body(api.route("openai")), text -> {}, tools);
                assertEquals(0, tools.calls); assertTrue(api.requests.get(1).toString().contains("error"));
            }
        }
        try { LocalToolLoop.arguments("{} trailing"); fail("Trailing data accepted"); } catch (java.io.IOException expected) {}
        assertEquals(2, LocalToolLoop.definitions("openai").length());
        assertEquals("web_search", LocalToolLoop.definitions("openai").getJSONObject(0).getJSONObject("function").getString("name"));
        assertEquals("web_fetch", LocalToolLoop.definitions("openai").getJSONObject(1).getJSONObject("function").getString("name"));
        assertEquals(2, LocalToolLoop.definitions("anthropic").length());
        assertEquals("web_search", LocalToolLoop.definitions("anthropic").getJSONObject(0).getString("name"));
        assertEquals("web_fetch", LocalToolLoop.definitions("anthropic").getJSONObject(1).getString("name"));
    }

    public void testRepeatedIdsRoundLimitAndCancellationStopWithoutExtraCalls() throws Exception {
        try (Api api = new Api(call("openai", "same", "web_fetch", "{\"url\":\"https://example.com/one\"}"), call("openai", "same", "web_fetch", "{\"url\":\"https://example.com/two\"}"))) {
            Tools tools = new Tools();
            try { new LocalChatClient().chatWithTools(api.route("openai"), body(api.route("openai")), text -> {}, tools); fail("Repeated ID accepted"); } catch (java.io.IOException expected) {}
            assertEquals(1, tools.calls);
        }
        String[] replies = new String[9];
        for (int index = 0; index < replies.length - 1; index++) replies[index] = call("openai", "id-" + index, "web_fetch", "{\"url\":\"https://example.com/one\"}");
        replies[replies.length - 1] = answer("openai");
        try (Api api = new Api(replies)) {
            Tools tools = new Tools();
            String result = new LocalChatClient().chatWithTools(api.route("openai"), body(api.route("openai")), text -> {}, tools);
            assertTrue(result.contains("Final answer")); assertFalse(api.requests.get(8).has("tools"));
            assertEquals(8, tools.calls); assertEquals(9, api.requests.size());
        }
        try (Api api = new Api(call("openai", "id", "web_fetch", "{\"url\":\"https://example.com/one\"}"))) {
            LocalChatClient client = new LocalChatClient();
            Tools tools = new Tools() {
                public JSONObject execute(String name, JSONObject args) throws Exception { JSONObject result = super.execute(name, args); client.cancel(); return result; }
            };
            try { client.chatWithTools(api.route("openai"), body(api.route("openai")), text -> {}, tools); fail("Cancellation ignored"); } catch (java.io.IOException expected) {}
            assertEquals(1, api.requests.size()); assertTrue(tools.cancelled);
        }
    }

    public void testPublicNetworkValidationAndConfiguration() throws Exception {
        for (String address : new String[]{"127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "192.168.0.1", "172.16.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"})
            assertFalse(address, LocalWebTools.publicAddress(InetAddress.getByName(address)));
        assertTrue(LocalWebTools.publicAddress(InetAddress.getByName("8.8.8.8")));
        for (String url : new String[]{"http://example.com", "file:///etc/passwd", "https://user:secret@example.com", "https://example.com:8443", "https://server.local", "https://localhost", "https://example.com/<bad>"}) {
            try { LocalWebTools.publicUrl(url); fail("Accepted: " + url); } catch (java.io.IOException expected) {}
        }
        assertEquals("https://example.com/page", LocalWebTools.publicUrl("https://example.com/page#fragment").toString());
        LocalWebTools executor = new LocalWebTools();
        try { executor.execute("web_fetch", new JSONObject().put("url", "https://127.0.0.1")); fail("Loopback request allowed"); } catch (java.io.IOException expected) {} finally { executor.cancel(); }
        CredentialStore encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
        try {
            LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
            String id = store.createConversation("", "route").getString("id");
            assertFalse(store.conversation(id).optBoolean("webTools"));
            var stateField = LocalChatStore.class.getDeclaredField("state"); stateField.setAccessible(true);
            ((JSONObject) stateField.get(store)).put("webSearchKey", "legacy-secret");
            store.configureTools(id, true);
            LocalChatStore restored = new LocalChatStore(getInstrumentation().getTargetContext());
            assertTrue(restored.conversation(id).getBoolean("webTools"));
            assertFalse(((JSONObject) stateField.get(restored)).has("webSearchKey"));
        } finally { encrypted.clear(); }
    }

    public void testKeylessSearchResultParsingFiltersUnsafeLinks() throws Exception {
        String html = "<div class='result'><a class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle'>Example title</a><a class='result__snippet'>Useful summary</a></div>"
            + "<div class='result'><a class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2F127.0.0.1%2Fsecret'>Blocked</a></div>";
        JSONObject output = LocalWebTools.searchResults(html, "https://html.duckduckgo.com/html/?q=example");
        JSONArray sources = output.getJSONArray("sources");
        assertTrue(output.getBoolean("untrusted")); assertEquals(1, sources.length());
        assertEquals("https://example.com/article", sources.getJSONObject(0).getString("url"));
        assertEquals("Example title", sources.getJSONObject(0).getString("title"));
        assertEquals("Useful summary", sources.getJSONObject(0).getString("snippet"));
        String baidu = "<div class='c-result result' data-log='{&quot;mu&quot;:&quot;https://example.org/news&quot;}'><h3>News</h3><div class='c-abstract'>Latest report</div></div>";
        sources = LocalWebTools.searchResults(baidu, "https://www.baidu.com/s?wd=news").getJSONArray("sources");
        assertEquals(1, sources.length()); assertEquals("https://example.org/news", sources.getJSONObject(0).getString("url"));
        String rss = "<?xml version='1.0'?><rss><channel><item><title>MiMo 2.6</title><link>https://mimo.mi.com/news</link><description><![CDATA[<b>New model</b> released]]></description></item>"
            + "<item><title>Blocked</title><link>https://127.0.0.1/private</link><description>Private</description></item></channel></rss>";
        sources = LocalWebTools.rssResults(rss, "https://www.bing.com/search?format=rss").getJSONArray("sources");
        assertEquals(1, sources.length()); assertEquals("https://mimo.mi.com/news", sources.getJSONObject(0).getString("url"));
        assertEquals("New model released", sources.getJSONObject(0).getString("snippet"));
        try { LocalWebTools.rssResults("<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><rss><channel/></rss>", "https://www.bing.com/"); fail("DOCTYPE accepted"); }
        catch (Exception expected) {}
    }

    public void testTruncatedAndTooManyCallsDoNotExecute() throws Exception {
        String single = call("openai", "one", "web_fetch", "{\"url\":\"https://example.com/article\"}");
        JSONObject many = new JSONObject(single);
        JSONArray calls = many.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getJSONArray("tool_calls");
        for (int index = 1; index < 17; index++) calls.put(new JSONObject(calls.getJSONObject(0).toString()).put("id", "id-" + index));
        for (String reply : new String[]{single.replace("\"finish_reason\":\"tool_calls\"", "\"finish_reason\":\"length\""), many.toString()}) {
            try (Api api = new Api(reply)) {
                Tools tools = new Tools();
                try { new LocalChatClient().chatWithTools(api.route("openai"), body(api.route("openai")), text -> {}, tools); fail("Invalid batch executed"); }
                catch (java.io.IOException expected) {}
                assertEquals(0, tools.calls); assertEquals(1, api.requests.size());
            }
        }
    }

    public void testToolSettingsAreOptInAndKeyless() throws Exception {
        CredentialStore encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
        android.app.Activity activity = null;
        try {
            LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
            String id = store.createConversation("", "route").getString("id");
            activity = getInstrumentation().startActivitySync(new android.content.Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.app.Activity selected = activity;
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> selected.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> selected.getWindow().getDecorView().findViewWithTag("localTools").performClick());
            getInstrumentation().waitForIdleSync();
            var field = LocalChatActivity.class.getDeclaredField("dialog"); field.setAccessible(true);
            android.app.AlertDialog dialog = (android.app.AlertDialog) field.get(activity);
            getInstrumentation().runOnMainSync(() -> {
                android.widget.Switch enabled = dialog.findViewById(android.R.id.content).findViewWithTag("localToolsEnabled");
                assertFalse(enabled.isChecked()); enabled.setChecked(true);
                assertNull(dialog.findViewById(android.R.id.content).findViewWithTag("localToolsKey"));
                dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
            });
            store = new LocalChatStore(getInstrumentation().getTargetContext());
            assertTrue(store.conversation(id).getBoolean("webTools"));
        } finally {
            if (activity != null) { android.app.Activity selected = activity; getInstrumentation().runOnMainSync(selected::finish); }
            encrypted.clear();
        }
    }
}
