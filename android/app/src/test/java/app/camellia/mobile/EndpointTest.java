package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class EndpointTest {
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

    @Test public void acceptsOnlyTheBareApiKeyRoute() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals("http://100.64.0.1:43127/v1/api-keys", endpoint.uri("/v1/api-keys").toString());
        for (String invalid : new String[]{"/v1/api-keys?offset=1", "/v1/api-keys/1", "/v1/api-keys/extra", "/v1/API-KEYS", "/v1/apiKey"}) {
            assertThrows(invalid, IllegalArgumentException.class, () -> endpoint.uri(invalid));
        }
    }

    @Test public void canonicalizesTailnetAddressOnly() {
        assertEquals("http://100.64.0.1:43127", new Endpoint(" http://100.64.0.1:43127/ ").origin());
        assertEquals("http://100.127.255.255:1", new Endpoint("http://100.127.255.255:1").origin());
    }

    @Test public void rejectsCredentialExfiltrationTargets() {
        String[] invalid = { "https://example.com:443", "http://127.0.0.1:43127", "http://192.168.1.1:80", "http://100.63.0.1:80",
            "http://100.128.0.1:80", "http://100.64.256.1:80", "http://100.64.0.1:0", "http://100.64.0.1:65536",
            "http://100.64.0.1:80@evil.example", "http://evil.example:80", "http://100.64.0.1:80/path", "http://100.64.0.1:80?token=secret",
            "http://100.64.0.1:80#fragment", "http://100.064.0.1:80", "http://100.64.00.1:80", "http://user@100.64.0.1:80", "http://[::1]:80" };
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
