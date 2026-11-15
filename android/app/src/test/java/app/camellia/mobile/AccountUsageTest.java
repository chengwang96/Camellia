package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class AccountUsageTest {
    @Test public void filtersPeriodsSourcesAccountsAndModelsWithoutAddingBalances() throws Exception {
        JSONObject data = new JSONObject("""
            {"version":1,"accounts":[{"id":"api:a","source":"api"},{"id":"subscription:b","source":"subscription"}],
             "ranges":{"1":[],"30":[],"7":[{"accountId":"api:a","model":"model-a","requests":3,"inputTokens":30,"cacheReadTokens":20},
                                {"accountId":"subscription:b","model":"model-b","requests":4,"outputTokens":50}],
                       "all":[{"accountId":"api:a","model":"","requests":10}]}}
            """);
        assertTrue(AccountUsage.valid(data));
        assertEquals(1, AccountUsage.accounts(data, "api").size());
        assertEquals(7, AccountUsage.sum(AccountUsage.rows(data, "7", "", "", ""), "requests"), 0);
        assertEquals(50, AccountUsage.sum(AccountUsage.rows(data, "7", "api", "", ""), "inputTokens", "cacheReadTokens"), 0);
        assertEquals(0, AccountUsage.rows(data, "7", "api", "subscription:b", "").size());
        assertEquals(0, AccountUsage.rows(data, "7", "", "", "missing").size());
        assertEquals(10, AccountUsage.sum(AccountUsage.rows(data, "all", "", "", ""), "requests"), 0);
        assertFalse(AccountUsage.valid(new JSONObject()));
        data.getJSONObject("ranges").remove("7"); assertFalse(AccountUsage.valid(data));
    }
    @Test public void usageEndpointsDoNotAcceptArbitraryQueriesOrSubpaths() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        for (String path : new String[]{"/v1/account-usage", "/v1/account-usage/refresh"}) assertEquals(path, endpoint.uri(path).getPath());
        for (String path : new String[]{"/v1/account-usage/", "/v1/account-usage?key=secret", "/v1/account-usage/refresh?force=true", "/v1/account-usage/../api-keys"}) assertThrows(IllegalArgumentException.class, () -> endpoint.uri(path));
    }
}
