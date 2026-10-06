package app.camellia.mobile;

import org.json.JSONObject;
import java.util.Locale;

final class LocalChatThinking {
    // The desktop reports protocol level names (off/low/medium/high/xhigh/max/
    // ultra). The phone mirrors the same ladder so one label never means two
    // different things: both composers and both model menus use 关闭/低/中/高/
    // 极高/最高/Ultra (Off/Low/Medium/High/Extra high/Max/Ultra).
    //
    // Not every model exposes every level. Anthropic routes follow Claude Code's
    // own effort flag (off..max, no xhigh/ultra). OpenAI routes follow the Codex
    // catalog, where only the newest models add max and ultra and GPT-5.5 stops
    // at xhigh; unknown models keep the conservative three-level default. This
    // mirrors levelsFor() in shared/model-levels.js.
    private static final String[] DEFAULT_LEVELS = { "low", "medium", "high" };
    private static final String[] XHIGH_LEVELS = { "low", "medium", "high", "xhigh" };
    private static final String[] MAX_LEVELS = { "low", "medium", "high", "xhigh", "max" };
    private static final String[] ULTRA_LEVELS = { "low", "medium", "high", "xhigh", "max", "ultra" };
    private static final String[] CLAUDE_LEVELS = { "off", "low", "medium", "high", "max" };
    // Longest slugs first so a prefix such as gpt-6-sol never shadows a longer
    // one such as gpt-6.1-sol; MODEL_SLUGS[i] pairs with MODEL_LADDERS[i].
    private static final String[] MODEL_SLUGS = {
        "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "gpt-6.1-sol", "gpt-6-astra",
        "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-5.5", "codex-auto-review",
    };
    private static final String[][] MODEL_LADDERS = {
        ULTRA_LEVELS, ULTRA_LEVELS, ULTRA_LEVELS, ULTRA_LEVELS,
        MAX_LEVELS, ULTRA_LEVELS, ULTRA_LEVELS, MAX_LEVELS, ULTRA_LEVELS, XHIGH_LEVELS, MAX_LEVELS,
    };
    private static final String[] KNOWN_LEVELS = { "off", "low", "medium", "high", "xhigh", "max", "ultra" };
    static final String AUTO = "auto";

    static String[] levels(LocalChatConfig.Route route) {
        if (route == null) return DEFAULT_LEVELS;
        if (route.protocol.equals("anthropic")) return CLAUDE_LEVELS;
        String id = route.model.toLowerCase(Locale.ROOT);
        int slash = id.lastIndexOf('/');
        String segment = slash < 0 ? id : id.substring(slash + 1);
        for (int index = 0; index < MODEL_SLUGS.length; index++)
            if (segment.equals(MODEL_SLUGS[index]) || segment.startsWith(MODEL_SLUGS[index] + "-")) return MODEL_LADDERS[index];
        return DEFAULT_LEVELS;
    }

    static String[] menu(LocalChatConfig.Route route) {
        String[] levels = levels(route), options = new String[levels.length + 1];
        options[0] = AUTO;
        System.arraycopy(levels, 0, options, 1, levels.length);
        return options;
    }

    private static boolean known(String level) {
        for (String value : KNOWN_LEVELS) if (value.equals(level)) return true;
        return false;
    }

    private static boolean accepts(LocalChatConfig.Route route, String level) {
        for (String value : levels(route)) if (value.equals(level)) return true;
        return false;
    }

    static String normalize(String value) {
        String level = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        return known(level) ? level : AUTO;
    }

    static String label(String value, boolean chinese) {
        return display(normalize(value), chinese);
    }

    static String display(String value, boolean chinese) {
        String level = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        switch (level) {
            case "": case "auto": case "default": return chinese ? "默认" : "Default";
            case "off": return chinese ? "关闭" : "Off";
            case "low": return chinese ? "低" : "Low";
            case "medium": return chinese ? "中" : "Medium";
            case "high": return chinese ? "高" : "High";
            case "xhigh": return chinese ? "极高" : "Extra high";
            case "max": return chinese ? "最高" : "Max";
            // Product name; identical in both languages.
            case "ultra": return "Ultra";
            // Reported by some account catalogs; kept so the wording matches the
            // desktop even though they are not offered in Camellia's own ladder.
            case "none": return chinese ? "无" : "None";
            case "minimal": return chinese ? "最小" : "Minimal";
            default: return value == null ? "" : value.trim();
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
        if (!supported(route)) return AUTO;
        String level = normalize(value);
        return level.equals(AUTO) || accepts(route, level) ? level : AUTO;
    }

    static void apply(LocalChatConfig.Route route, String value, JSONObject body) throws Exception {
        String level = effective(route, value);
        if (level.equals(AUTO)) return;
        if (level.equals("off")) { body.put("thinking", new JSONObject().put("type", "disabled")); return; }
        if (route.protocol.equals("openai")) body.put("reasoning_effort", level);
        else if (adaptive(route)) {
            body.put("thinking", new JSONObject().put("type", "adaptive"));
            body.put("output_config", new JSONObject().put("effort", level));
            body.put("max_tokens", 16384);
        } else {
            int tokens = level.equals("high") || level.equals("max") ? 8192 : 2048;
            body.put("thinking", new JSONObject().put("type", "enabled").put("budget_tokens", tokens));
            body.put("max_tokens", tokens + 4096);
        }
    }
}
