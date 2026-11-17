package app.camellia.mobile;

import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class LocalChatThinking {
    // Match shared/model-levels.js: reported metadata wins, including an empty
    // list. Only missing/invalid metadata falls back to generic API efforts.
    private static final String[] DEFAULT_LEVELS = { "low", "medium", "high" };
    private static final String[] KNOWN_LEVELS = { "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra" };
    static final String AUTO = "auto";

    static final class Metadata {
        final List<String> levels;
        final boolean booleanOnly, onLabel;
        Metadata(List<String> levels, boolean booleanOnly, boolean onLabel) {
            this.levels = java.util.Collections.unmodifiableList(new ArrayList<>(levels));
            this.booleanOnly = booleanOnly; this.onLabel = onLabel;
        }
    }

    static Metadata metadata(JSONObject thinking) {
        JSONArray values = thinking == null ? null : thinking.optJSONArray("values");
        if (values == null || values.length() > 32) return null;
        List<String> levels = new ArrayList<>();
        boolean booleanOnly = values.length() > 0, hasTrue = false, hasHigh = false;
        for (int index = 0; index < values.length(); index++) {
            Object value = values.opt(index);
            if (!(value instanceof Boolean) && !(value instanceof String && valid((String) value))) return null;
            booleanOnly &= value instanceof Boolean;
            hasTrue |= Boolean.TRUE.equals(value); hasHigh |= "high".equals(value);
            String level = value instanceof Boolean ? ((Boolean) value ? "high" : "none") : (String) value;
            if (!levels.contains(level)) levels.add(level);
        }
        return new Metadata(levels, booleanOnly, hasTrue && !hasHigh);
    }

    private static boolean valid(String value) { return value.matches("(?i)[a-z][a-z0-9_-]{0,63}"); }

    static String[] levels(LocalChatConfig.Route route) {
        return route != null && route.thinking != null ? route.thinking.levels.toArray(new String[0]) : DEFAULT_LEVELS.clone();
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

    static String label(String value, LocalChatConfig.Route route, boolean chinese) {
        if (value.equals("none")) return chinese ? "关闭" : "Off";
        if (value.equals("high") && route != null && route.thinking != null && route.thinking.onLabel)
            return chinese ? "开启" : "On";
        if (route != null && accepts(route, value)) return display(value, chinese);
        return label(value, chinese);
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
        return route != null && (route.thinking != null ? !route.thinking.levels.isEmpty()
            : route.protocol.equals("openai") || adaptive(route) || budget(route));
    }

    static String effective(LocalChatConfig.Route route, String value) {
        if (!supported(route)) return AUTO;
        String trimmed = value == null ? "" : value.trim();
        String level = accepts(route, trimmed) ? trimmed : normalize(value);
        return level.equals(AUTO) || accepts(route, level) ? level : AUTO;
    }

    static void apply(LocalChatConfig.Route route, String value, JSONObject body) throws Exception {
        String level = effective(route, value);
        if (level.equals(AUTO)) return;
        boolean off = level.equals("off") || level.equals("none");
        String host = java.net.URI.create(route.baseUrl).getHost();
        if (route.thinking != null && route.thinking.booleanOnly) {
            body.put("thinking", new JSONObject().put("type", off ? "disabled" : "enabled"));
            if (route.protocol.equals("openai") && (route.providerType.equals("ollama") || "ollama.com".equals(host)))
                body.put("reasoning_effort", level);
            return;
        }
        if (route.protocol.equals("openai")) {
            body.put("reasoning_effort", level);
            boolean deepseek = route.providerType.equals("deepseek") || "api.deepseek.com".equals(host)
                || (java.util.Arrays.asList("commandcode", "opencode", "opencode-go").contains(route.providerType)
                    || "api.commandcode.ai".equals(host) || "opencode.ai".equals(host))
                && route.model.toLowerCase(Locale.ROOT).matches("(?:.*/)?deepseek-.*");
            if (deepseek) {
                body.put("thinking", new JSONObject().put("type", off ? "disabled" : "enabled"));
                if (off) body.remove("reasoning_effort");
            }
        } else if (off) body.put("thinking", new JSONObject().put("type", "disabled"));
        else if (adaptive(route) || route.thinking != null && !budget(route)) {
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
