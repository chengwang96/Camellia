package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class EndpointTest {
    @Test public void acceptsConversationListStream() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        assertEquals("http://100.64.0.1:43127/v1/conversations/events", endpoint.uri("/v1/conversations/events").toString());
        assertThrows(IllegalArgumentException.class, () -> endpoint.uri("/v1/conversations/events/commands"));
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
