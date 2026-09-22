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

    public URI uri(String path) {
        if (!path.matches("/v1/(status|commands|pair/(request|claim)|conversations(?:/events|/[a-f0-9-]{36}(?:/(?:events|commands))?)?)(?:\\?(?:offset|before)=\\d{1,12})?")) {
            throw new IllegalArgumentException("Unsupported remote endpoint");
        }
        return URI.create(origin + path);
    }
}
