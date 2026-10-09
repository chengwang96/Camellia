package app.camellia.mobile;

import java.net.URI;
import java.util.regex.Pattern;

public final class Endpoint {
    private static final Pattern ADDRESS = Pattern.compile("http://(100\\.(?:[1-9][0-9]?|1[0-9]{2})\\.(?:0|[1-9][0-9]{0,2})\\.(?:0|[1-9][0-9]{0,2})):(\\d{1,5})/?");
    private final String origin;

    public Endpoint(String input) {
        var match = ADDRESS.matcher(input.trim());
        if (!match.matches()) throw new IllegalArgumentException("Use the exact http://100.x.x.x:port address shown by Camellia.");
        String[] parts = match.group(1).split("\\.");
        int second = Integer.parseInt(parts[1]);
        int port = Integer.parseInt(match.group(2));
        if (second < 64 || second > 127 || Integer.parseInt(parts[2]) > 255 || Integer.parseInt(parts[3]) > 255 || port < 1 || port > 65535) {
            throw new IllegalArgumentException("Only a Tailscale IPv4 address and a valid port are allowed.");
        }
        origin = "http://" + match.group(1) + ":" + port;
    }

    public String origin() { return origin; }

    public Endpoint(String ip, String port) {
        this("http://" + ip.trim() + ":" + port.trim());
    }

    public String host() { return URI.create(origin).getHost(); }
    public String port() { return Integer.toString(URI.create(origin).getPort()); }

    public URI uri(String path) {
        if (path.matches("/v1/commands/[a-f0-9-]{36}")
                || path.matches("/v1/conversations/[a-f0-9-]{36}/events\\?incremental=1")
                || path.matches("/v1/conversations\\?offset=\\d{1,12}&limit=(?:[1-9]\\d{0,2}|1000)&query=(?:[A-Za-z0-9._*+-]|%[a-fA-F0-9]{2})*")) {
            return URI.create(origin + path);
        }
        if (path.matches("/v1/conversations/[a-f0-9-]{36}/read")) return URI.create(origin + path);
        if (path.matches("/v1/discussions/[a-f0-9-]{36}/artifacts(?:/[a-f0-9]{64}|\\?offset=\\d{1,12})?")) return URI.create(origin + path);
        if (path.matches("/v1/discussions(?:\\?(?:offset)=\\d{1,12}|/(?:catalog|events|commands(?:/[a-f0-9-]{36})?|[a-f0-9-]{36}(?:/events|\\?before=\\d{1,12})?))?")) {
            return URI.create(origin + path);
        }
        if (!path.matches("/v1/(?:(?:status|commands|pair/(request|claim)|conversations(?:/events|/[a-f0-9-]{36}(?:/(?:events|commands|artifacts(?:/[a-f0-9]{64})?))?)?)(?:\\?(?:offset|before)=\\d{1,12})?|api-keys)")) {
            throw new IllegalArgumentException("Unsupported remote endpoint");
        }
        return URI.create(origin + path);
    }
}
