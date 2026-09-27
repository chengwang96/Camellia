package app.camellia.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class RemoteEngines {
    static List<String> available(List<String> advertised) {
        List<String> known = List.of("codex", "claude", "kimi", "dsh", "antigravity", "pi");
        if (advertised == null) return known.subList(0, 5);
        List<String> result = new ArrayList<>();
        for (String engine : advertised) {
            if (known.contains(engine) && !result.contains(engine)) result.add(engine);
        }
        return result;
    }

    static String label(String engine) {
        return engine.equals("pi") ? "Pi" : engine.toUpperCase(Locale.ROOT);
    }
}
