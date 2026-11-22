package app.camellia.mobile;

import org.json.JSONException;
import org.json.JSONObject;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resolves a stored computer key to the transport that is currently usable.
 * Conversation caches keep using the stable key while LAN or Tailscale changes
 * underneath it.
 */
final class ComputerRoutes {
    static final String LAN = "lan";
    static final String TAILSCALE = "tailscale";

    static final class Route {
        final String url;
        final String fingerprint;
        final String transport;

        Route(String url, String fingerprint, String transport) {
            this.url = url;
            this.fingerprint = fingerprint == null ? "" : fingerprint;
            this.transport = transport == null ? "" : transport;
        }

        boolean isLan() { return LAN.equals(transport); }
    }

    private static final Map<String, Route> ROUTES = new ConcurrentHashMap<>();
    private static final Map<String, Choices> CHOICES = new ConcurrentHashMap<>();

    private static final class Choices {
        final String key;
        String lanUrl = "";
        String lanFingerprint = "";
        String tailscaleUrl = "";

        Choices(String key) { this.key = key; }
    }

    private ComputerRoutes() {}

    static void clear() { ROUTES.clear(); CHOICES.clear(); }

    static void put(String key, Route route) {
        if (key == null || key.isEmpty() || route == null || route.url == null || route.url.isEmpty()) return;
        ROUTES.put(key, route);
        ROUTES.put(route.url, route);
    }

    static Route route(String stored) {
        Route found = ROUTES.get(stored);
        if (found != null) return found;
        try {
            Endpoint endpoint = new Endpoint(stored);
            return new Route(endpoint.origin(), "", endpoint.isLan() ? LAN : TAILSCALE);
        } catch (IllegalArgumentException error) {
            return new Route(stored, "", "");
        }
    }

    static void configure(List<JSONObject> computers) {
        clear();
        if (computers == null) return;
        for (JSONObject computer : computers) {
            if (computer == null) continue;
            String key = computer.optString("address");
            if (key.isEmpty()) continue;
            String lan = computer.optString("lanAddress");
            String lanFingerprint = computer.optString("lanFingerprint");
            String tailscale = tailscaleUrl(computer);
            String active = computer.optString("activeTransport");
            Choices choices = new Choices(key);
            choices.lanUrl = lan;
            choices.lanFingerprint = LanTls.validFingerprint(lanFingerprint) ? LanTls.normalize(lanFingerprint) : "";
            choices.tailscaleUrl = tailscale;
            CHOICES.put(key, choices);
            if (LAN.equals(active) && prefersLan(computer) && !choices.lanUrl.isEmpty() && !choices.lanFingerprint.isEmpty()) {
                put(key, new Route(choices.lanUrl, choices.lanFingerprint, LAN));
            } else if (!tailscale.isEmpty()) {
                put(key, new Route(tailscale, "", TAILSCALE));
            } else if (!choices.lanUrl.isEmpty() && !choices.lanFingerprint.isEmpty()) {
                put(key, new Route(choices.lanUrl, choices.lanFingerprint, LAN));
            }
        }
    }

    static void select(String key, String transport) {
        Choices choices = CHOICES.get(key);
        if (choices == null) return;
        if (LAN.equals(transport) && !choices.lanUrl.isEmpty() && !choices.lanFingerprint.isEmpty()) {
            put(key, new Route(choices.lanUrl, choices.lanFingerprint, LAN));
        } else if (TAILSCALE.equals(transport) && !choices.tailscaleUrl.isEmpty()) {
            put(key, new Route(choices.tailscaleUrl, "", TAILSCALE));
        }
    }

    static boolean hasLan(String key) {
        Choices choices = CHOICES.get(key);
        return choices != null && !choices.lanUrl.isEmpty() && !choices.lanFingerprint.isEmpty();
    }

    static String lanUrl(String key) {
        Choices choices = CHOICES.get(key);
        return choices == null ? "" : choices.lanUrl;
    }

    static String lanFingerprint(String key) {
        Choices choices = CHOICES.get(key);
        return choices == null ? "" : choices.lanFingerprint;
    }

    static String activeTransport(String key) {
        Route route = ROUTES.get(key);
        return route == null ? "" : route.transport;
    }

    static boolean prefersLan(JSONObject computer) {
        if (computer.optString("token").isEmpty()) return false;
        if (tailscaleUrl(computer).isEmpty()) return true;
        // Older LAN pairings preferred LAN even when autoLan was off.
        boolean legacy = computer.optBoolean("autoLan", false)
            || computer.optBoolean("lanPaired", LAN.equals(computer.optString("activeTransport")));
        return computer.optBoolean("lanPreferred", legacy);
    }

    static String tailscaleUrl(JSONObject computer) {
        String saved = tailscaleOrigin(computer.optString("tailscaleAddress"));
        return saved.isEmpty() ? tailscaleOrigin(computer.optString("address")) : saved;
    }

    static String tailscaleOrigin(String address) {
        try {
            Endpoint endpoint = new Endpoint(address);
            return endpoint.isLan() ? "" : endpoint.origin();
        }
        catch (IllegalArgumentException error) { return ""; }
    }

    static boolean matchesLanFingerprint(JSONObject computer, String computerId, String fingerprint) {
        return !computerId.isEmpty() && computerId.equals(computer.optString("computerId"))
            && LanTls.validFingerprint(fingerprint) && fingerprint.equalsIgnoreCase(computer.optString("lanFingerprint"));
    }

    static boolean updateDiscoveredRoute(JSONObject computer, LanDiscovery.Service service) throws JSONException {
        boolean preferLan = prefersLan(computer);
        String transport = computer.optString("activeTransport");
        if (preferLan && service != null && matchesLanFingerprint(computer, service.computerId, service.fingerprint)) {
            if (LAN.equals(transport) && service.url.equals(computer.optString("lanAddress"))) return false;
            computer.put("lanAddress", service.url).put("activeTransport", LAN);
        } else if (LAN.equals(transport) && !tailscaleUrl(computer).isEmpty()) {
            computer.put("activeTransport", TAILSCALE);
        } else {
            return false;
        }
        // Older profiles may have inferred this preference from the previous route.
        computer.put("lanPreferred", preferLan);
        return true;
    }
}
