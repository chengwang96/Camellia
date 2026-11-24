package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class EndpointTest {
    @Test public void visualizationDocumentsAllowOnlyConversationScopedLightAndDarkRequests() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String conversation = "12345678-1234-1234-1234-123456789abc";
        String card = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
        String base = "/v1/conversations/" + conversation + "/visualizations/" + card;
        for (String theme : new String[]{"light", "dark"}) {
            String path = base + "?theme=" + theme;
            assertEquals(endpoint.origin() + path, endpoint.uri(path).toString());
        }
    }

    @Test public void visualizationDocumentsRejectUnscopedPathsAndUnexpectedQueries() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String id = "12345678-1234-1234-1234-123456789abc";
        String base = "/v1/conversations/" + id + "/visualizations/" + id;
        for (String path : new String[]{
                base, base + "/", base + "?theme=sepia", base + "?theme=", base + "?theme=LIGHT",
                base + "?theme=light&theme=dark", base + "?theme=dark&token=secret",
                base + "?theme=light#fragment", base + "?theme=light/extra",
                "/v1/visualizations/" + id + "?theme=light",
                "/v1/conversations/not-an-id/visualizations/" + id + "?theme=light",
                "/v1/conversations/" + id + "/visualizations/not-a-card?theme=light",
                "/v1/conversations/" + id + "/visualizations/../api-keys?theme=light"}) {
            assertThrows(path, IllegalArgumentException.class, () -> endpoint.uri(path));
        }
    }

    @Test public void selectedFileQueriesKeepTheMessageAndEncodedReferenceTogether() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String base = "/v1/conversations/12345678-1234-1234-1234-123456789abc/artifacts?offset=0";
        String query = "&seq=12&reference=dist%2Fnew+build%2Fphone.apk";
        assertEquals(base + query, endpoint.uri(base + query).getRawPath() + "?" + endpoint.uri(base + query).getRawQuery());
        for (String invalid : new String[]{"&seq=0&reference=a.apk", "&seq=-1&reference=a.apk", "&seq=1", "&reference=a.apk", query + "&extra=1", "&seq=1&reference=%GG", query + "#part"}) {
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri(base + invalid));
        }
    }
    @Test public void allowsOnlyTheExactDesktopRestartEndpoint() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals("/v1/desktop/restart", endpoint.uri("/v1/desktop/restart").getPath());
        for (String suffix : new String[]{"/", "?", "?confirmed=true", "/extra", "#fragment"})
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri("/v1/desktop/restart" + suffix));
    }
    @Test public void replyReadRouteAllowsOnlyTheExactConversationPath() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String base = "/v1/conversations/12345678-1234-1234-1234-123456789abc/read";
        assertEquals("http://100.64.0.1:43127" + base, endpoint.uri(base).toString());
        for (String invalid : new String[]{base + "?before=1", base + "?offset=1", base + "/extra", base + "/../commands", "/v1/conversations/not-an-id/read"}) {
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri(invalid));
        }
    }

    @Test public void discussionRoutesKeepOpaqueIdsAndBoundedQueries() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String id = "12345678-1234-1234-1234-123456789abc";
        for (String suffix : new String[] { "", "?offset=100", "/catalog", "/events", "/commands", "/commands/" + id, "/" + id, "/" + id + "?before=20", "/" + id + "/events" })
            assertEquals("http://100.64.0.1:43127/v1/discussions" + suffix, endpoint.uri("/v1/discussions" + suffix).toString());
        String artifacts = "/v1/discussions/" + id + "/artifacts";
        for (String suffix : new String[]{"", "?offset=100", "/" + "a".repeat(64)})
            assertEquals("http://100.64.0.1:43127" + artifacts + suffix, endpoint.uri(artifacts + suffix).toString());
        for (String suffix : new String[]{"/../private", "/result.txt", "?path=C:/private", "?offset=-1", "/" + "a".repeat(63), "/" + "a".repeat(64) + "?path=file"})
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri(artifacts + suffix));
        for (String suffix : new String[] { "/../api-keys", "?path=C:/private", "/catalog?offset=1", "/commands/" + id + "/events", "/" + id + "?before=-1", "/" + id + "/events?before=1" })
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri("/v1/discussions" + suffix));
    }
    @Test public void combinesSeparateIpAndPort() {
        Endpoint endpoint = new Endpoint(" 100.80.1.2 ", " 43128 ");
        assertEquals("http://100.80.1.2:43128", endpoint.origin());
        assertEquals("100.80.1.2", endpoint.host());
        assertEquals("43128", endpoint.port());
        Endpoint saved = new Endpoint("http://100.64.0.1:12345/");
        assertEquals(saved.origin(), new Endpoint(saved.host(), saved.port()).origin());
        for (String port : new String[]{"", "0", "65536", "1.5", "abc", "-1"}) {
            assertThrows(IllegalArgumentException.class, () -> new Endpoint("100.80.1.2", port));
        }
        for (String ip : new String[]{"", "192.168.1.1", "100.80.1.256", "100.80.1.2:43127", "http://100.80.1.2"}) {
            assertThrows(IllegalArgumentException.class, () -> new Endpoint(ip, "43127"));
        }
    }
    @Test public void acceptsOnlyOpaqueArtifactPaths() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String base = "/v1/conversations/12345678-1234-1234-1234-123456789abc/artifacts";
        assertEquals(base, endpoint.uri(base).getPath());
        assertEquals("offset=100", endpoint.uri(base + "?offset=100").getQuery());
        assertEquals(base + "/" + "a".repeat(64), endpoint.uri(base + "/" + "a".repeat(64)).getPath());
        for (String suffix : new String[]{"/../../secret", "/file.pdf", "?path=C:/secret", "/" + "a".repeat(63)}) {
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri(base + suffix));
        }
    }
    @Test public void acceptsConversationListStream() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals("http://100.64.0.1:43127/v1/conversations/events", endpoint.uri("/v1/conversations/events").toString());
        assertThrows(IllegalArgumentException.class, () -> endpoint.uri("/v1/conversations/events/commands"));
    }

    @Test public void acceptsIncrementalConversationStream() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String events = "/v1/conversations/12345678-1234-1234-1234-123456789abc/events";
        assertEquals(endpoint.origin() + events + "?incremental=1", endpoint.uri(events + "?incremental=1").toString());
        String versioned = events + "?incremental=1&historyVersion=" + "a".repeat(64);
        assertEquals(endpoint.origin() + versioned, endpoint.uri(versioned).toString());
        String delta = events + "?incremental=1&delta=live-v1";
        assertEquals(endpoint.origin() + delta, endpoint.uri(delta).toString());
        String deltaVersioned = delta + "&historyVersion=" + "a".repeat(64);
        assertEquals(endpoint.origin() + deltaVersioned, endpoint.uri(deltaVersioned).toString());
        for (String suffix : new String[]{"?incremental=1&historyVersion=short", "?incremental=1&historyVersion=" + "A".repeat(64),
                "?historyVersion=" + "a".repeat(64), "?incremental=1&historyVersion=" + "a".repeat(64) + "&token=secret"}) {
            assertThrows(suffix, IllegalArgumentException.class, () -> endpoint.uri(events + suffix));
        }
        for (String suffix : new String[]{"?incremental=0", "?incremental=", "?incremental=11", "?incremental=1&token=secret", "?incremental=1&incremental=1", "/extra?incremental=1"}) {
            assertThrows(suffix, IllegalArgumentException.class, () -> endpoint.uri(events + suffix));
        }
        assertThrows(IllegalArgumentException.class, () -> endpoint.uri("/v1/status?incremental=1"));
    }

    @Test public void acceptsModernConversationPagingAndEncodedSearch() throws Exception {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals(endpoint.origin() + "/v1/conversations?offset=0&limit=100&query=recent+task",
            endpoint.uri("/v1/conversations?offset=0&limit=100&query=recent+task").toString());
        for (String query : new String[]{"", "recent task", "中文 查询 & /?#=%+*._-", "中".repeat(200)}) {
            String encoded = java.net.URLEncoder.encode(query, "UTF-8");
            for (int limit : new int[]{1, 100, 1000}) {
                String path = "/v1/conversations?offset=0&limit=" + limit + "&query=" + encoded;
                assertEquals(endpoint.origin() + path, endpoint.uri(path).toString());
            }
        }
        assertEquals("offset=999999999999&limit=100&query=", endpoint.uri("/v1/conversations?offset=999999999999&limit=100&query=").getRawQuery());
        for (String query : new String[]{"limit=100&query=", "offset=-1&limit=100&query=", "offset=1000000000000&limit=100&query=", "offset=0&limit=0&query=", "offset=0&limit=1001&query=",
            "offset=0&limit=100&query=hello&token=secret", "offset=0&limit=100&query=%", "offset=0&limit=100&query=%GG", "offset=0&limit=100&query=hello#fragment", "offset=0&limit=100&query=hello world"}) {
            assertThrows(query, IllegalArgumentException.class, () -> endpoint.uri("/v1/conversations?" + query));
        }
        assertThrows(IllegalArgumentException.class, () -> endpoint.uri("/v1/status?offset=0&limit=100&query="));
    }

    @Test public void acceptsCommandReceiptLookupOnlyForOpaqueRequestIds() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String receipt = "/v1/commands/12345678-1234-1234-1234-123456789abc";
        assertEquals(endpoint.origin() + receipt, endpoint.uri(receipt).toString());
        for (String invalid : new String[]{receipt + "?offset=1", receipt + "/events", receipt + "/../status", "/v1/commands/not-an-id", "/v1/commands/"}) {
            assertThrows(invalid, IllegalArgumentException.class, () -> endpoint.uri(invalid));
        }
    }

    @Test public void acceptsOnlyTheBareApiKeyRoute() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals("http://100.64.0.1:43127/v1/api-keys", endpoint.uri("/v1/api-keys").toString());
        for (String invalid : new String[]{"/v1/api-keys?offset=1", "/v1/api-keys/1", "/v1/api-keys/extra", "/v1/API-KEYS", "/v1/apiKey"}) {
            assertThrows(invalid, IllegalArgumentException.class, () -> endpoint.uri(invalid));
        }
    }

    @Test public void acceptsOnlyTheExactWorkbenchRoutes() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals("http://100.64.0.1:43127/v1/workbench", endpoint.uri("/v1/workbench").toString());
        assertEquals("http://100.64.0.1:43127/v1/workbench/events", endpoint.uri("/v1/workbench/events").toString());
        for (String invalid : new String[]{"/v1/workbench/", "/v1/workbench?offset=0", "/v1/workbench/events?x=1", "/v1/workbench/events/extra", "/v1/workbench//events"}) {
            assertThrows(invalid, IllegalArgumentException.class, () -> endpoint.uri(invalid));
        }
    }

    @Test public void canonicalizesTailnetAddressOnly() {
        assertEquals("http://100.64.0.1:43127", new Endpoint(" http://100.64.0.1:43127/ ").origin());
        assertEquals("http://100.127.255.255:1", new Endpoint("http://100.127.255.255:1").origin());
    }

    @Test public void acceptsPinnedPrivateLanAddressesOverHttps() {
        Endpoint endpoint = new Endpoint("https://192.168.3.9:43127/");
        assertEquals("https://192.168.3.9:43127", endpoint.origin());
        assertEquals("192.168.3.9", endpoint.host());
        assertEquals("43127", endpoint.port());
        assertTrue(endpoint.isLan());
        assertEquals(endpoint.origin() + "/v1/status", endpoint.uri("/v1/status").toString());
        assertEquals("https://10.0.0.4:43127", new Endpoint("https://10.0.0.4:43127").origin());
        assertEquals("https://172.16.0.4:1", new Endpoint("https://172.16.0.4:1").origin());
    }

    @Test public void rejectsCredentialExfiltrationTargets() {
        String[] invalid = { "https://example.com:443", "http://127.0.0.1:43127", "http://192.168.1.1:80", "http://100.63.0.1:80",
            "http://100.128.0.1:80", "http://100.64.256.1:80", "http://100.64.0.1:0", "http://100.64.0.1:65536",
            "http://100.64.0.1:80@evil.example", "http://evil.example:80", "http://100.64.0.1:80/path", "http://100.64.0.1:80?token=secret",
            "http://100.64.0.1:80#fragment", "http://100.064.0.1:80", "http://100.64.00.1:80", "http://user@100.64.0.1:80", "http://[::1]:80",
            "https://192.168.1.1:80/path", "https://192.168.1.1:80?token=secret", "https://192.168.01.1:80",
            "https://8.8.8.8:43127", "https://100.64.0.1:43127", "http://192.168.1.1:43127" };
        for (String address : invalid) assertThrows(address, IllegalArgumentException.class, () -> new Endpoint(address));
    }

    @Test public void pathsCannotChangeOriginOrInvokeCommands() {
        Endpoint endpoint = new Endpoint("http://100.80.1.2:43127");
        assertEquals("/v1/status", endpoint.uri("/v1/status").getPath());
        assertEquals("offset=100", endpoint.uri("/v1/conversations?offset=100").getQuery());
        assertEquals("/v1/conversations/12345678-1234-1234-1234-123456789abc/events", endpoint.uri("/v1/conversations/12345678-1234-1234-1234-123456789abc/events").getPath());
        for (String route : new String[]{"//evil.example/path", "/v1/command", "/v1/../files", "/v1/status?token=secret", "/v1/conversations?offset=-1"}) {
            assertThrows(IllegalArgumentException.class, () -> endpoint.uri(route));
        }
    }
}
