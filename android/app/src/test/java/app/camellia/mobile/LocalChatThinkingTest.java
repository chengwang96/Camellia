package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;

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
        // Catalog-only levels keep the desktop wording even though Camellia's
        // own ladder no longer offers them.
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

    private static String[] labels(String[] levels, boolean chinese) {
        return java.util.Arrays.stream(levels).map(level -> LocalChatThinking.display(level, chinese)).toArray(String[]::new);
    }

    @Test public void theLadderMirrorsTheDesktopPerModelAndProtocol() {
        LocalChatConfig.Route ultra = model("gpt-5.6-sol", "openai");
        LocalChatConfig.Route anthropic = model("claude-sonnet-4-6", "anthropic");
        assertArrayEquals(new String[] { "低", "中", "高", "极高", "最高", "Ultra" }, labels(LocalChatThinking.levels(ultra), true));
        assertArrayEquals(new String[] { "关闭", "低", "中", "高", "最高" }, labels(LocalChatThinking.levels(anthropic), true));
        assertArrayEquals(new String[] { "默认", "低", "中", "高", "极高", "最高", "Ultra" },
            labels(LocalChatThinking.menu(ultra), true));
    }

    @Test public void notEveryModelOffersEveryLevel() {
        // Only the newest Codex models reach max/ultra; GPT-5.5 stops at xhigh and
        // unknown models keep the conservative default.
        assertArrayEquals(new String[] { "低", "中", "高", "极高" }, labels(LocalChatThinking.levels(model("gpt-5.5", "openai")), true));
        assertArrayEquals(new String[] { "低", "中", "高", "极高", "最高" }, labels(LocalChatThinking.levels(model("gpt-5.6-luna", "openai")), true));
        assertArrayEquals(new String[] { "低", "中", "高" }, labels(LocalChatThinking.levels(model("some-other-model", "openai")), true));
        assertArrayEquals(new String[] { "低", "中", "高" }, labels(LocalChatThinking.levels(null), true));
    }

    @Test public void levelsOutsideTheRouteLadderFallBackToAuto() {
        LocalChatConfig.Route anthropic = new LocalChatConfig.Route("a", "Model", "claude-sonnet-4-6", "anthropic", "https://example.com/v1", "secret");
        // xhigh/ultra are OpenAI-only; an Anthropic route folds them back to auto.
        assertEquals("auto", LocalChatThinking.effective(anthropic, "xhigh"));
        assertEquals("auto", LocalChatThinking.effective(anthropic, "ultra"));
        assertEquals("max", LocalChatThinking.effective(anthropic, "max"));
        assertEquals("ultra", LocalChatThinking.effective(model("gpt-5.6-sol", "openai"), "ultra"));
        // A model that tops out at xhigh folds ultra back to auto instead.
        assertEquals("auto", LocalChatThinking.effective(model("gpt-5.5", "openai"), "ultra"));
    }
}
