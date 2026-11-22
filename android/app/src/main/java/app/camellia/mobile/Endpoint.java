package app.camellia.mobile;

import java.net.URI;

public final class Endpoint {
    private final String origin;
    private final String scheme;
    private final String host;
    private final int port;

    public Endpoint(String input) {
        String text = input == null ? "" : input.trim();
        URI uri;
        try { uri = URI.create(text); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("Use the exact address shown by Camellia."); }
        String parsedScheme = uri.getScheme();
        String parsedHost = uri.getHost();
        int parsedPort = uri.getPort();
        if (!(("http".equals(parsedScheme) || "https".equals(parsedScheme)))
                || parsedHost == null || parsedPort < 1 || parsedPort > 65535
                || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")) {
            throw new IllegalArgumentException("Use the exact address shown by Camellia.");
        }
        String[] parts = parsedHost.split("\\.");
        if (parts.length != 4 || !canonicalOctets(parts)) {
            throw new IllegalArgumentException("Use a Tailscale address or a private LAN IPv4 address.");
        }
        if ("http".equals(parsedScheme)) {
            int second = Integer.parseInt(parts[1]);
            if (!"100".equals(parts[0]) || second < 64 || second > 127) {
                throw new IllegalArgumentException("Only a Tailscale IPv4 address is allowed over HTTP.");
            }
        } else if (!privateIPv4(parts)) {
            throw new IllegalArgumentException("Only a private LAN IPv4 address is allowed over HTTPS.");
        }
        scheme = parsedScheme;
        host = parsedHost;
        port = parsedPort;
        origin = parsedScheme + "://" + parsedHost + ":" + parsedPort;
    }

    public String origin() { return origin; }
    public String scheme() { return scheme; }
    public boolean isLan() { return "https".equals(scheme); }

    public Endpoint(String ip, String port) {
        this("http://" + ip.trim() + ":" + port.trim());
    }

    public String host() { return host; }
    public String port() { return Integer.toString(port); }

    private static boolean canonicalOctets(String[] parts) {
        for (String part : parts) {
            if (part.isEmpty() || part.length() > 3 || !part.chars().allMatch(value -> value >= '0' && value <= '9')) return false;
            if (part.length() > 1 && part.charAt(0) == '0') return false;
            if (Integer.parseInt(part) > 255) return false;
        }
        return true;
    }

    private static boolean privateIPv4(String[] parts) {
        int first = Integer.parseInt(parts[0]);
        int second = Integer.parseInt(parts[1]);
        return first == 10
                || first == 192 && second == 168
                || first == 172 && second >= 16 && second <= 31;
    }

    public URI uri(String path) {
        if (path.equals("/v1/account-usage") || path.equals("/v1/account-usage/refresh")) return URI.create(origin + path);
        if (path.equals("/v1/desktop/restart")) return URI.create(origin + path);
        if (path.equals("/v1/workbench") || path.equals("/v1/workbench/events")) return URI.create(origin + path);
        if (path.matches("/v1/commands/[a-f0-9-]{36}")
                || path.matches("/v1/conversations/[a-f0-9-]{36}/events\\?incremental=1(?:&historyVersion=[a-f0-9]{64})?")
                || path.matches("/v1/conversations\\?offset=\\d{1,12}&limit=(?:[1-9]\\d{0,2}|1000)&query=(?:[A-Za-z0-9._*+-]|%[a-fA-F0-9]{2})*")) {
            return URI.create(origin + path);
        }
        if (path.matches("/v1/conversations/[a-f0-9-]{36}/read")) return URI.create(origin + path);
        if (path.matches("/v1/conversations/[a-f0-9-]{36}/visualizations/[a-f0-9-]{36}\\?theme=(?:light|dark)")) return URI.create(origin + path);
        if (path.matches("/v1/conversations/[a-f0-9-]{36}/artifacts\\?offset=\\d{1,12}&seq=[1-9][0-9]{0,11}&reference=(?:[A-Za-z0-9._*+-]|%[a-fA-F0-9]{2})+")) return URI.create(origin + path);
        if (path.matches("/v1/conversations/[a-f0-9-]{36}/attachments/[1-9][0-9]{0,11}/(?:[0-9]|1[0-9])")) return URI.create(origin + path);
        if (path.matches("/v1/discussions/[a-f0-9-]{36}/artifacts(?:/[a-f0-9]{64}|\\?offset=\\d{1,12})?")) return URI.create(origin + path);
        if (path.matches("/v1/discussions(?:\\?(?:offset)=\\d{1,12}|/(?:catalog|events|commands(?:/[a-f0-9-]{36})?|[a-f0-9-]{36}(?:/events|\\?before=\\d{1,12})?))?")) {
            return URI.create(origin + path);
        }
        if (!path.matches("/v1/(?:(?:status|commands|pair/(request|claim)|lan/join|conversations(?:/events|/[a-f0-9-]{36}(?:/(?:events|commands|artifacts(?:/[a-f0-9]{64})?))?)?)(?:\\?(?:offset|before)=\\d{1,12})?|api-keys)")) {
            throw new IllegalArgumentException("Unsupported remote endpoint");
        }
        return URI.create(origin + path);
    }
}
