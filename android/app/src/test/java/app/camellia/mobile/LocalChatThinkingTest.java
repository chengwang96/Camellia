package app.camellia.mobile;

import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class LocalChatThinkingTest {
    @Test public void protocolLevelsUseTheSameWordingAsTheDesktop() {
        assertEquals("默认", LocalChatThinking.display("", true));
        assertEquals("默认", LocalChatThinking.display("auto", true));
        assertEquals("默认", LocalChatThinking.display("default", true));
        assertEquals("关闭", LocalChatThinking.display("off", true));
        assertEquals("低", LocalChatThinking.display("low", true));
        assertEquals("中", LocalChatThinking.display("medium", true));
        assertEquals("高", LocalChatThinking.display("high", true));
        assertEquals("极高", LocalChatThinking.display("xhigh", true));
        assertEquals("最高", LocalChatThinking.display("max", true));
        assertEquals("Ultra", LocalChatThinking.display("ultra", true));
        // Remote account catalogs retain their existing wording.
        assertEquals("无", LocalChatThinking.display("none", true));
        assertEquals("最小", LocalChatThinking.display("minimal", true));
    }

    @Test public void labelsFollowTheLanguageAndKeepUnknownProtocolValues() {
        assertEquals("Default", LocalChatThinking.display("", false));
        assertEquals("Medium", LocalChatThinking.display("MEDIUM", false));
        assertEquals("Max", LocalChatThinking.display("max", false));
        assertEquals("Extra high", LocalChatThinking.display("xhigh", false));
        assertEquals("Ultra", LocalChatThinking.display("ULTRA", false));
        assertEquals("mystery", LocalChatThinking.display("mystery", true));
        assertEquals("默认", LocalChatThinking.display(null, true));
        assertEquals("默认", LocalChatThinking.label("unknown", true));
        assertEquals("中", LocalChatThinking.label("medium", true));
        assertEquals("高", LocalChatThinking.label("high", true));
    }

    private static LocalChatConfig.Route model(String name, String protocol) {
        return new LocalChatConfig.Route("r", "Model", name, protocol, "https://example.com/v1", "secret");
    }

    private static JSONObject thinking(Object... values) throws Exception {
        return new JSONObject().put("values", new JSONArray(java.util.Arrays.asList(values)));
    }

    private static JSONObject config(Object metadata) throws Exception {
        return new JSONObject().put("providers", new JSONArray().put(new JSONObject()
            .put("id", "desktop").put("protocol", "openai").put("baseUrl", "https://example.com/v1")
            .put("keys", new JSONArray().put(new JSONObject().put("key", "test-only")))
            .put("models", new JSONArray().put(new JSONObject().put("id", "alias")
                .put("upstream", "deepseek-v4.1-flash:1017").put("thinking", metadata)))));
    }

    private static LocalChatConfig.Route imported(JSONObject config) throws Exception {
        return LocalChatConfig.routes(LocalChatConfig.parse(LocalChatConfig.export(config))).get(0);
    }

    @Test public void desktopSyncPreservesTheReportedMenuAndDefault() throws Exception {
        JSONObject config = config(thinking("none", "low", "high", "max", "max").put("default", "high"));
        LocalChatConfig.Route route = imported(config);
        assertArrayEquals(new String[] { "auto", "none", "low", "high", "max" }, LocalChatThinking.menu(route));
        assertEquals("max", LocalChatThinking.effective(route, "max"));
        assertEquals("auto", LocalChatThinking.effective(route, "medium"));
        assertEquals("关闭", LocalChatThinking.label("none", route, true));
        JSONObject body = new JSONObject();
        LocalChatThinking.apply(route, "max", body);
        assertEquals("max", body.getString("reasoning_effort"));
        body = new JSONObject(); LocalChatThinking.apply(route, "auto", body); assertEquals(0, body.length());
        body = new JSONObject(); LocalChatThinking.apply(route, "medium", body); assertEquals(0, body.length());
        JSONObject saved = LocalChatConfig.parse(LocalChatConfig.export(config));
        assertEquals("high", saved.getJSONArray("providers").getJSONObject(0).getJSONArray("models")
            .getJSONObject(0).getJSONObject("thinking").getString("default"));
    }

    @Test public void emptyMetadataIsDifferentFromMissingOrInvalidMetadata() throws Exception {
        LocalChatConfig.Route fixed = imported(config(thinking()));
        assertArrayEquals(new String[] { "auto" }, LocalChatThinking.menu(fixed));
        assertFalse(LocalChatThinking.supported(fixed));
        assertEquals("auto", LocalChatThinking.effective(fixed, "high"));
        for (Object invalid : new Object[] { JSONObject.NULL, thinking(1), thinking(" low "), thinking(""),
                thinking("low", JSONObject.NULL), thinking(new Object()),
                new JSONObject().put("values", new JSONArray(java.util.Collections.nCopies(33, "high"))) }) {
            assertArrayEquals(new String[] { "low", "medium", "high" }, LocalChatThinking.levels(imported(config(invalid))));
        }
        for (String id : new String[] { "gpt-6.1-sol", "gpt-5.5", "claude-sonnet-4-6", "unknown" })
            assertArrayEquals(new String[] { "low", "medium", "high" }, LocalChatThinking.levels(model(id, "openai")));
    }

    @Test public void eachRouteAndRefreshUsesItsOwnReportedList() throws Exception {
        JSONObject source = config(thinking("low", "high", "max"));
        JSONObject second = new JSONObject(source.getJSONArray("providers").getJSONObject(0).toString()).put("id", "second");
        second.getJSONArray("models").getJSONObject(0).put("thinking", thinking("high", "ultra"));
        source.getJSONArray("providers").put(second);
        java.util.List<LocalChatConfig.Route> routes = LocalChatConfig.routes(source);
        assertArrayEquals(new String[] { "low", "high", "max" }, LocalChatThinking.levels(routes.get(0)));
        assertEquals("high", LocalChatThinking.effective(routes.get(1), "high"));
        assertEquals("auto", LocalChatThinking.effective(routes.get(1), "max"));
        assertEquals("ultra", LocalChatThinking.effective(routes.get(1), "ultra"));
        source.getJSONArray("providers").getJSONObject(0).getJSONArray("models").getJSONObject(0).put("thinking", thinking("low"));
        assertEquals("auto", LocalChatThinking.effective(imported(source), "high"));
    }

    @Test public void reportedCustomValuesSurviveNormalizationAndRequests() throws Exception {
        LocalChatConfig.Route route = imported(config(thinking("minimal", "Turbo", "ultra")));
        assertEquals("auto", LocalChatThinking.normalize("Turbo"));
        assertEquals("Turbo", LocalChatThinking.effective(route, "Turbo"));
        assertEquals("Turbo", LocalChatThinking.label("Turbo", route, false));
        JSONObject body = new JSONObject(); LocalChatThinking.apply(route, "Turbo", body);
        assertEquals("Turbo", body.getString("reasoning_effort"));
        assertEquals("auto", LocalChatThinking.effective(route, "unknown"));
        assertEquals("auto", LocalChatThinking.normalize("invalid value"));
    }

    @Test public void booleanControlsUseOnOffWithoutSendingAnEffort() throws Exception {
        LocalChatConfig.Route route = imported(config(thinking(false, true).put("default", true)));
        assertArrayEquals(new String[] { "auto", "none", "high" }, LocalChatThinking.menu(route));
        assertEquals("On", LocalChatThinking.label("high", route, false));
        assertEquals("Off", LocalChatThinking.label("none", route, false));
        for (String level : new String[] { "none", "high" }) {
            JSONObject body = new JSONObject(); LocalChatThinking.apply(route, level, body);
            assertEquals(level.equals("none") ? "disabled" : "enabled", body.getJSONObject("thinking").getString("type"));
            assertFalse(body.has("reasoning_effort"));
        }
        LocalChatConfig.Route ollama = new LocalChatConfig.Route(route.id, route.label, route.model, route.protocol,
            route.baseUrl, route.keys, route.thinking, "ollama");
        JSONObject body = new JSONObject(); LocalChatThinking.apply(ollama, "none", body);
        assertEquals("none", body.getString("reasoning_effort"));
    }

    @Test public void metadataAlsoControlsAnthropicAliasesAndDeepSeekWireParameters() throws Exception {
        LocalChatConfig.Route base = imported(config(thinking("none", "high", "max")));
        LocalChatConfig.Route anthropic = new LocalChatConfig.Route(base.id, base.label, "aliased-model", "anthropic",
            base.baseUrl, base.keys, base.thinking, "custom");
        JSONObject body = new JSONObject(); LocalChatThinking.apply(anthropic, "max", body);
        assertEquals("adaptive", body.getJSONObject("thinking").getString("type"));
        assertEquals("max", body.getJSONObject("output_config").getString("effort"));
        LocalChatConfig.Route deepseek = new LocalChatConfig.Route(base.id, base.label, base.model, base.protocol,
            base.baseUrl, base.keys, base.thinking, "deepseek");
        body = new JSONObject(); LocalChatThinking.apply(deepseek, "none", body);
        assertEquals("disabled", body.getJSONObject("thinking").getString("type")); assertFalse(body.has("reasoning_effort"));
        body = new JSONObject(); LocalChatThinking.apply(deepseek, "max", body);
        assertEquals("enabled", body.getJSONObject("thinking").getString("type")); assertEquals("max", body.getString("reasoning_effort"));
    }
}
