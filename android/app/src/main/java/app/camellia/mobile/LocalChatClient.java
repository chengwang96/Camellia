package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class LocalChatClient {
    interface Listener {
        void onText(String text);
        default void onThinking(String text) {}
    }
    private volatile HttpURLConnection connection;
    private volatile boolean cancelled;
    private static final int LIMIT = 2 * 1024 * 1024;

    void cancel() {
        cancelled = true;
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
    }

    static JSONObject request(LocalChatConfig.Route route, JSONArray history) throws Exception {
        return request(route, history, "auto");
    }

    static JSONObject request(LocalChatConfig.Route route, JSONArray history, String thinking) throws Exception {
        JSONArray messages = new JSONArray();
        for (int index = 0; index < history.length(); index++) {
            JSONObject row = history.getJSONObject(index);
            String role = row.optString("role"), content = row.optString("content");
            if ((role.equals("user") || role.equals("assistant")) && !content.isEmpty())
                messages.put(new JSONObject().put("role", role).put("content", content));
        }
        JSONObject body = new JSONObject().put("model", route.model).put("messages", messages).put("stream", true);
        if (route.protocol.equals("anthropic")) body.put("max_tokens", 4096);
        LocalChatThinking.apply(route, thinking, body);
        if (body.toString().length() > LIMIT) throw new IOException("会话过长，请新建会话 / Conversation too long; start a new one");
        return body;
    }

    String chat(LocalChatConfig.Route route, JSONObject body, Listener listener) throws Exception {
        for (int index = 0; index < route.keys.size(); index++) {
            if (cancelled) throw new IOException("Cancelled");
            try { return attempt(route, body, listener, index); }
            catch (LocalChatHttpError error) {
                if (cancelled) throw new IOException("Cancelled");
                if (!error.tryNextKey || index + 1 == route.keys.size()) throw error;
            }
        }
        throw new IOException("No enabled API keys");
    }

    private String attempt(LocalChatConfig.Route route, JSONObject body, Listener listener, int keyIndex) throws Exception {
        if (cancelled) throw new IOException("Cancelled");
        HttpURLConnection current = (HttpURLConnection) new URL(route.baseUrl
            + (route.protocol.equals("anthropic") ? "/messages" : "/chat/completions")).openConnection();
        connection = current;
        try {
            if (cancelled) throw new IOException("Cancelled");
            current.setInstanceFollowRedirects(false);
            current.setConnectTimeout(20000); current.setReadTimeout(120000);
            current.setRequestMethod("POST"); current.setDoOutput(true);
            current.setRequestProperty("Content-Type", "application/json");
            current.setRequestProperty("Accept", "text/event-stream, application/json");
            String key = route.keys.get(keyIndex);
            current.setRequestProperty("Authorization", "Bearer " + key);
            if (route.protocol.equals("anthropic")) {
                current.setRequestProperty("x-api-key", key); current.setRequestProperty("anthropic-version", "2023-06-01");
            }
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            current.setFixedLengthStreamingMode(payload.length);
            try (var output = current.getOutputStream()) { output.write(payload); }
            int code = current.getResponseCode();
            if (code < 200 || code >= 300) {
                String error = readError(current);
                if (cancelled) throw new IOException("Cancelled");
                throw LocalChatHttpError.from(code, error, route.keys, current.getURL().getHost(), keyIndex + 1, route.keys.size());
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(current.getInputStream(), StandardCharsets.UTF_8))) {
                String contentType = current.getContentType();
                if (contentType != null && contentType.toLowerCase(java.util.Locale.ROOT).contains("text/event-stream"))
                    return stream(reader, route.protocol, listener);
                StringBuilder source = new StringBuilder();
                char[] buffer = new char[4096]; int count;
                while ((count = reader.read(buffer)) != -1) {
                    if (cancelled) throw new IOException("Cancelled");
                    source.append(buffer, 0, count);
                    if (source.length() > LIMIT) throw new IOException("API response too large");
                }
                if (cancelled) throw new IOException("Cancelled");
                JSONObject response = new JSONObject(source.toString());
                if (route.protocol.equals("anthropic")) {
                    JSONArray blocks = response.optJSONArray("content"); StringBuilder reasoning = new StringBuilder();
                    if (blocks != null) for (int index = 0; index < blocks.length(); index++) {
                        JSONObject block = blocks.optJSONObject(index);
                        if (block != null && block.optString("type").equals("thinking")) reasoning.append(block.optString("thinking"));
                    }
                    if (reasoning.length() > 0) listener.onThinking(reasoning.toString());
                } else {
                    JSONObject message = response.getJSONArray("choices").getJSONObject(0).getJSONObject("message");
                    Object reasoning = message.opt("reasoning_content");
                    if (!(reasoning instanceof String)) reasoning = message.opt("reasoning");
                    if (reasoning instanceof String) listener.onThinking((String) reasoning);
                }
                String text = responseText(response, route.protocol);
                if (text.isEmpty()) throw new IOException("API 未返回文字 / API returned no text");
                listener.onText(text); return text;
            }
        } finally { connection = null; current.disconnect(); }
    }

    private String readError(HttpURLConnection current) {
        try {
            current.setReadTimeout(5000);
            java.io.InputStream input = current.getErrorStream();
            if (input == null) return "";
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                char[] buffer = new char[2048]; StringBuilder source = new StringBuilder();
                long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
                while (!cancelled && source.length() <= 32768 && System.nanoTime() < deadline) {
                    int count = reader.read(buffer, 0, Math.min(buffer.length, 32769 - source.length()));
                    if (count < 0) return source.toString();
                    source.append(buffer, 0, count);
                }
            }
        } catch (IOException ignored) {}
        return "";
    }

    private String stream(BufferedReader reader, String protocol, Listener listener) throws Exception {
        StringBuilder text = new StringBuilder(), thinking = new StringBuilder(), event = new StringBuilder(), line = new StringBuilder();
        boolean completed = false;
        long lastUpdate = 0;
        int character;
        while ((character = reader.read()) != -1) {
            if (cancelled) throw new IOException("Cancelled");
            if (character != '\n') {
                line.append((char) character);
                if (line.length() > LIMIT) throw new IOException("API event too large");
                continue;
            }
            String value = line.toString(); line.setLength(0);
            if (value.endsWith("\r")) value = value.substring(0, value.length() - 1);
            if (value.isEmpty() && event.length() > 0) {
                String data = event.toString().trim(); event.setLength(0);
                if (data.equals("[DONE]")) { completed = true; break; }
                JSONObject chunk = new JSONObject(data);
                if (chunk.has("error") || chunk.optString("type").equals("error")) throw new IOException("API 返回错误，已保留部分回复 / API stream error; partial reply kept");
                if (protocol.equals("anthropic")) {
                    if (chunk.optString("type").equals("message_stop")) { completed = true; break; }
                    JSONObject delta = chunk.optJSONObject("delta");
                    if (delta != null && delta.optString("type").equals("text_delta")) text.append(delta.optString("text"));
                    if (delta != null && delta.optString("type").equals("thinking_delta")) thinking.append(delta.optString("thinking"));
                    JSONObject block = chunk.optJSONObject("content_block");
                    if (block != null && block.optString("type").equals("thinking")) thinking.append(block.optString("thinking"));
                } else {
                    JSONArray choices = chunk.optJSONArray("choices");
                    JSONObject choice = choices == null ? null : choices.optJSONObject(0);
                    if (choice != null) {
                        JSONObject delta = choice.optJSONObject("delta");
                        if (delta != null && delta.opt("content") instanceof String) text.append(delta.getString("content"));
                        if (delta != null) {
                            Object reasoning = delta.opt("reasoning_content");
                            if (!(reasoning instanceof String)) reasoning = delta.opt("reasoning");
                            if (reasoning instanceof String) thinking.append((String) reasoning);
                        }
                        if (!choice.isNull("finish_reason")) completed = true;
                    }
                }
                if (text.length() + thinking.length() > LIMIT) throw new IOException("API response too large");
                if (System.currentTimeMillis() - lastUpdate >= 80) { listener.onThinking(thinking.toString()); listener.onText(text.toString()); lastUpdate = System.currentTimeMillis(); }
            } else if (value.startsWith("data:")) {
                event.append(value.substring(5)).append('\n');
                if (event.length() > LIMIT) throw new IOException("API event too large");
            }
        }
        if (cancelled) throw new IOException("Cancelled");
        listener.onThinking(thinking.toString()); listener.onText(text.toString());
        if (!completed) throw new IOException("回复连接中断，未自动重发 / Reply interrupted; not automatically resent");
        if (text.length() == 0) throw new IOException("API 未返回文字 / API returned no text");
        return text.toString();
    }

    private static String responseText(JSONObject response, String protocol) throws Exception {
        if (protocol.equals("anthropic")) {
            StringBuilder text = new StringBuilder();
            JSONArray blocks = response.getJSONArray("content");
            for (int index = 0; index < blocks.length(); index++) {
                JSONObject block = blocks.getJSONObject(index);
                if (block.optString("type").equals("text")) text.append(block.optString("text"));
            }
            return text.toString();
        }
        return response.getJSONArray("choices").getJSONObject(0).getJSONObject("message").optString("content", "");
    }
}
