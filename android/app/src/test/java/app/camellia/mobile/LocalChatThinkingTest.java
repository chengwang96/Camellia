package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class LocalChatThinkingTest {
    @Test public void protocolLevelsUseTheSameWordingAsLocalChat() {
        assertEquals("默认", LocalChatThinking.display("", true));
        assertEquals("默认", LocalChatThinking.display("auto", true));
        assertEquals("默认", LocalChatThinking.display("default", true));
        assertEquals("关闭", LocalChatThinking.display("off", true));
        assertEquals("快速", LocalChatThinking.display("minimal", true));
        assertEquals("快速", LocalChatThinking.display("low", true));
        assertEquals("标准", LocalChatThinking.display("medium", true));
        assertEquals("进阶", LocalChatThinking.display("high", true));
        assertEquals("极限", LocalChatThinking.display("xhigh", true));
    }

    @Test public void labelsFollowTheLanguageAndKeepUnknownProtocolValues() {
        assertEquals("Default", LocalChatThinking.display("", false));
        assertEquals("Standard", LocalChatThinking.display("MEDIUM", false));
        assertEquals("Extreme", LocalChatThinking.display("max", false));
        assertEquals("mystery", LocalChatThinking.display("mystery", true));
        assertEquals("默认", LocalChatThinking.display(null, true));
        assertEquals("默认", LocalChatThinking.label("unknown", true));
        assertEquals("标准", LocalChatThinking.label("medium", true));
        assertEquals("进阶", LocalChatThinking.label("high", true));
    }
}
