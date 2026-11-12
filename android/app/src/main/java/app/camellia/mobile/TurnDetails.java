package app.camellia.mobile;

import org.json.JSONObject;
import java.util.Locale;

/** Recorded turn accounting. Absent buckets stay unknown, including cache reads. */
final class TurnDetails {
    final String state, model;
    final Double duration, cost;
    final Long input, output, cacheRead, cacheWrite;
    // A request total also covers later background replies and native child
    // agents. Child tokens are one reported number with no bucket split.
    final Long requestTotal, requestMain, requestBackground, requestChildren;
    final Long requestInput, requestOutput, requestCacheRead, requestCacheWrite;
    final int requestBackgroundTurns, requestChildTasks;

    TurnDetails(JSONObject json) {
        if (json == null) json = new JSONObject();
        state = json.optString("state"); model = json.optString("model");
        duration = number(json, "duration_ms"); cost = number(json, "total_cost_usd");
        JSONObject usage = json.optJSONObject("usage");
        input = count(usage, "input_tokens"); output = count(usage, "output_tokens");
        cacheRead = count(usage, "cache_read_input_tokens"); cacheWrite = count(usage, "cache_creation_input_tokens");
        JSONObject request = json.optJSONObject("requestUsage");
        requestTotal = count(request, "total"); requestMain = count(request, "main");
        requestBackground = count(request, "background"); requestChildren = count(request, "children");
        requestInput = count(request, "input"); requestOutput = count(request, "output");
        requestCacheRead = count(request, "cacheRead"); requestCacheWrite = count(request, "cacheWrite");
        requestBackgroundTurns = whole(count(request, "backgroundTurns"));
        requestChildTasks = whole(count(request, "childTasks"));
    }

    private static int whole(Long value) { return value == null ? 0 : (int) Math.min(Integer.MAX_VALUE, value); }

    static Double number(JSONObject object, String key) {
        Object raw = object == null ? null : object.opt(key);
        if (!(raw instanceof Number)) return null;
        double value = ((Number) raw).doubleValue();
        return Double.isFinite(value) && value >= 0 && value <= 9007199254740991d ? value : null;
    }
    private static Long count(JSONObject object, String key) {
        Double value = number(object, key);
        return value != null && value == Math.floor(value) ? value.longValue() : null;
    }
    boolean completed() { return state.equals("complete"); }
    boolean terminal() { return completed() || state.equals("stopped") || state.equals("error"); }
    boolean hasRequestUsage() { return requestTotal != null; }
    boolean hasUsage() {
        return hasRequestUsage() || input != null || output != null || cacheRead != null || cacheWrite != null;
    }
    long total() { return value(input) + value(output) + value(cacheRead) + value(cacheWrite); }
    long displayTotal() { return hasRequestUsage() ? value(requestTotal) : total(); }
    Double cacheHit() {
        Long input = hasRequestUsage() ? requestInput : this.input;
        Long cacheRead = hasRequestUsage() ? requestCacheRead : this.cacheRead;
        Long cacheWrite = hasRequestUsage() ? requestCacheWrite : this.cacheWrite;
        if (input == null || cacheRead == null) return null;
        long prompt = input + cacheRead + value(cacheWrite);
        return prompt == 0 ? 0d : cacheRead * 100d / prompt;
    }
    private static long value(Long number) { return number == null ? 0 : number; }
    static String tokens(long count) { return String.format(Locale.US, "%,d tok", count); }
    String elapsed() {
        long seconds = Math.round(duration == null ? 0 : duration / 1000);
        return seconds < 60 ? seconds + "s" : seconds / 60 + "m " + seconds % 60 + "s";
    }
}
