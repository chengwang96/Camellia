package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class ModelLabelTest {
    @Test public void knownNamesAreCompact() {
        assertEquals("K3", ModelLabel.compact("kimi k3"));
        assertEquals("K3", ModelLabel.compact("kimi-k3"));
        assertEquals("K2.5", ModelLabel.compact("kimi-k2.5"));
        assertEquals("Astra", ModelLabel.compact("gpt-6-astra"));
        assertEquals("Sol", ModelLabel.compact("gpt-5.6-sol"));
        assertEquals("V4 Pro", ModelLabel.compact("deepseek-v4-pro"));
        assertEquals("R1", ModelLabel.compact("deepseek-r1"));
        assertEquals("MiMo 2.6 Pro", ModelLabel.compact("mimo-v2.6-pro"));
        assertEquals("MiMo 2.6 Flash", ModelLabel.compact("mimo-v2.6-flash"));
    }

    @Test public void unknownVariantsAndAliasesStayDistinct() {
        assertEquals("gpt-7-sol", ModelLabel.compact("gpt-7-sol"));
        assertEquals("deepseek-r1-distill-qwen-32b", ModelLabel.compact("deepseek-r1-distill-qwen-32b"));
        assertEquals("My custom model", ModelLabel.compact("My custom model"));
        assertEquals("DS Chat", ModelLabel.compact("deepseek-chat"));
        assertEquals("", ModelLabel.compact(null));
    }

    @Test public void registryTagsDoNotHideTheFamily() {
        assertEquals("K3", ModelLabel.compact("kimi-k3:cloud"));
        assertEquals("K2.5", ModelLabel.compact("kimi-k2.5:latest"));
        assertEquals("Sol", ModelLabel.compact("gpt-5.6-sol:free"));
        assertEquals("R1", ModelLabel.compact("deepseek-r1:7b"));
        assertEquals("MiMo 2.6 Pro", ModelLabel.compact("mimo-v2.6-pro:cloud"));
    }
}
