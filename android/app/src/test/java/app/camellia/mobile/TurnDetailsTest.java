package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class TurnDetailsTest {
    @Test public void providerCacheCountsAreNormalizedAndMultiCallTotalsStayHonest() throws Exception {
        JSONObject normalized = LocalTurnUsage.normalize(new JSONObject("{\"prompt_tokens\":100,\"completion_tokens\":20,\"prompt_tokens_details\":{\"cached_tokens\":75}}"), false);
        assertEquals(25, normalized.getLong("input_tokens")); assertEquals(75, normalized.getLong("cache_read_input_tokens"));
        LocalTurnUsage aggregate = new LocalTurnUsage(); aggregate.add(normalized);
        JSONObject total = aggregate.add(new JSONObject("{\"input_tokens\":5,\"output_tokens\":10}"));
        assertEquals(30, total.getLong("input_tokens")); assertEquals(30, total.getLong("output_tokens"));
        assertFalse(total.has("cache_read_input_tokens"));
        assertEquals(0, aggregate.add(new JSONObject()).length());
        JSONObject nativeUsage = new JSONObject("{\"input_tokens\":12,\"cache_read_input_tokens\":100,\"output_tokens\":5}");
        assertEquals(12, LocalTurnUsage.normalize(nativeUsage, true).getLong("input_tokens"));
    }
    @Test public void bucketsAreCountedOnceAndCacheRateUsesAllInput() throws Exception {
        TurnDetails details = new TurnDetails(new JSONObject("{\"state\":\"complete\",\"model\":\"recorded\",\"duration_ms\":61500,\"usage\":{\"input_tokens\":1000,\"cache_read_input_tokens\":7500,\"cache_creation_input_tokens\":1500,\"output_tokens\":2000}}"));
        assertTrue(details.completed()); assertEquals("recorded", details.model);
        assertEquals(12000, details.total()); assertEquals(75, details.cacheHit(), .001);
        assertEquals("1m 2s", details.elapsed());
    }
    @Test public void unknownCacheDoesNotBecomeZero() throws Exception {
        TurnDetails details = new TurnDetails(new JSONObject("{\"usage\":{\"input_tokens\":20,\"output_tokens\":5}}"));
        assertTrue(details.hasUsage()); assertEquals(25, details.total()); assertNull(details.cacheRead); assertNull(details.cacheHit());
        TurnDetails zero = new TurnDetails(new JSONObject("{\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":0}}"));
        assertTrue(zero.hasUsage()); assertEquals(0, zero.cacheHit(), .001);
    }
    @Test public void malformedFieldsDoNotInventUsageOrSuccessfulCompletion() throws Exception {
        TurnDetails details = new TurnDetails(new JSONObject("{\"state\":\"stopped\",\"duration_ms\":-1,\"usage\":{\"input_tokens\":\"100\",\"output_tokens\":true,\"cache_read_input_tokens\":-1,\"cache_creation_input_tokens\":0.5}}"));
        assertFalse(details.completed()); assertFalse(details.hasUsage()); assertNull(details.duration);
        assertFalse(new TurnDetails(null).hasUsage());
    }

    @Test public void requestUsageAddsBackgroundAndNativeChildTotals() throws Exception {
        JSONObject request = new JSONObject("{\"total\":1040,\"main\":920,\"background\":60,\"backgroundTurns\":1,"
            + "\"children\":60,\"childTasks\":1,\"input\":150,\"output\":30,\"cacheRead\":800,\"cacheWrite\":0}");
        TurnDetails details = new TurnDetails(new JSONObject("{\"state\":\"complete\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20},"
            + "\"requestUsage\":" + request + "}"));
        assertTrue(details.hasRequestUsage());
        assertEquals(1040L, details.displayTotal());
        assertEquals(920L, details.requestMain.longValue());
        assertEquals(60L, details.requestChildren.longValue());
        assertEquals(1, details.requestChildTasks);
        assertEquals(800d / 950d * 100d, details.cacheHit(), .001);
    }

    @Test public void stoppedAndFailedAreTerminalWithoutClaimingSuccess() throws Exception {
        for (String state : new String[] {"stopped", "error", "complete"}) {
            TurnDetails details = new TurnDetails(new JSONObject().put("state", state));
            assertTrue(details.terminal()); assertEquals(state.equals("complete"), details.completed());
        }
        assertFalse(new TurnDetails(null).terminal());
        assertFalse(new TurnDetails(new JSONObject().put("state", "running")).terminal());
    }
}
