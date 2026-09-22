package app.camellia.mobile;

import org.json.JSONObject;
import java.util.Locale;

final class LocalChatThinking {
    static final String[] LEVELS = { "auto", "medium", "high" };

    static String normalize(String value) {
        return value.equals("medium") || value.equals("high") ? value : "auto";
    }

    static String label(String value, boolean chinese) {
        switch (normalize(value)) {
            case "medium": return chinese ? "标准" : "Standard";
            case "high": return chinese ? "进阶" : "Advanced";
            default: return chinese ? "默认" : "Default";
        }
    }

    private static boolean adaptive(LocalChatConfig.Route route) {
        String model = route.model.toLowerCase(Locale.ROOT).replace('.', '-');
        return model.matches(".*claude-(opus|sonnet)-(4-[6-9]|[5-9])(?:-.*)?") || model.contains("claude-mythos");
    }

    private static boolean budget(LocalChatConfig.Route route) {
        String model = route.model.toLowerCase(Locale.ROOT).replace('.', '-');
        return model.contains("claude-3-7-sonnet") || model.matches(".*claude-(opus|sonnet)-4(?:-20[0-9]+)?")
            || model.matches(".*claude-(opus|sonnet|haiku)-4-[015](?:-.*)?");
    }

    static boolean supported(LocalChatConfig.Route route) {
        return route != null && (route.protocol.equals("openai") || adaptive(route) || budget(route));
    }

    static String effective(LocalChatConfig.Route route, String value) {
        return supported(route) ? normalize(value) : "auto";
    }

    static void apply(LocalChatConfig.Route route, String value, JSONObject body) throws Exception {
        String level = effective(route, value);
        if (level.equals("auto")) return;
        if (route.protocol.equals("openai")) body.put("reasoning_effort", level);
        else if (adaptive(route)) {
            body.put("thinking", new JSONObject().put("type", "adaptive"));
            body.put("output_config", new JSONObject().put("effort", level));
            body.put("max_tokens", 16384);
        } else {
            int tokens = level.equals("high") ? 8192 : 2048;
            body.put("thinking", new JSONObject().put("type", "enabled").put("budget_tokens", tokens));
            body.put("max_tokens", tokens + 4096);
        }
    }
}
