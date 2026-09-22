package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.StringReader;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.TimeUnit;
import javax.xml.parsers.DocumentBuilderFactory;
import org.xml.sax.InputSource;

final class LocalWebTools implements LocalToolLoop.Executor {
    private volatile Call active;
    private volatile boolean cancelled;
    private final OkHttpClient http = new OkHttpClient.Builder().proxy(Proxy.NO_PROXY)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS)
        .dns(host -> {
            java.util.List<InetAddress> addresses = Arrays.asList(InetAddress.getAllByName(host));
            java.util.List<InetAddress> allowed = new java.util.ArrayList<>();
            for (InetAddress address : addresses) if (publicAddress(address)) allowed.add(address);
            if (allowed.isEmpty()) throw new UnknownHostException("No public address available");
            return allowed;
        }).build();

    LocalWebTools() {}
    public void cancel() { cancelled = true; Call call = active; if (call != null) call.cancel(); http.dispatcher().cancelAll(); http.connectionPool().evictAll(); }

    static HttpUrl publicUrl(String value) throws IOException {
        if (value.length() > 2048 || value.matches("(?s).*[\\x00-\\x20\\x7f<>\\\\].*")) throw new IOException("Invalid URL");
        HttpUrl url = HttpUrl.parse(value);
        if (url == null || !url.scheme().equals("https") || url.port() != 443 || !url.username().isEmpty() || !url.password().isEmpty()) throw new IOException("Public HTTPS URL required");
        String host = url.host();
        if ((host.matches("[0-9.]+") || host.contains(":")) && !publicAddress(InetAddress.getByName(host))) throw new IOException("Non-public address blocked");
        if (!host.contains(".") || host.endsWith(".") || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".home") || host.endsWith(".lan")) throw new IOException("Private host blocked");
        return url.newBuilder().fragment(null).build();
    }

    static boolean publicAddress(InetAddress address) {
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
        byte[] bytes = address.getAddress();
        int first = bytes[0] & 255, second = bytes[1] & 255;
        if (bytes.length == 4) {
            return first != 0 && first != 10 && first != 127 && first < 224
                && !(first == 100 && second >= 64 && second <= 127)
                && !(first == 169 && second == 254) && !(first == 172 && second >= 16 && second <= 31)
                && !(first == 192 && (second == 168 || second == 0 || second == 2))
                && !(first == 198 && (second == 18 || second == 19 || second == 51)) && !(first == 203 && second == 0);
        }
        return bytes.length == 16 && (first & 0xe0) == 0x20 && !(first == 0x20 && second == 0x02)
            && !(first == 0x20 && second == 0x01 && ((bytes[2] & 255) < 2 || (bytes[2] & 255) == 0x0d && (bytes[3] & 255) == 0xb8));
    }

    public JSONObject execute(String name, JSONObject arguments) throws Exception {
        LocalToolLoop.validate(name, arguments);
        if (cancelled) throw new IOException("Cancelled");
        boolean search = name.equals("web_search");
        if (search) return search(arguments.getString("query"));
        HttpUrl url = publicUrl(arguments.getString("url"));
        String body = request(url, 512 * 1024, 0);
        org.jsoup.nodes.Document document = org.jsoup.Jsoup.parse(body, url.toString());
        document.select("script,style,noscript,iframe,form,svg,nav,footer").remove();
        String text = document.body().text();
        if (text.trim().isEmpty()) throw new IOException("Page has no readable text; use the search result snippet instead");
        JSONArray sources = new JSONArray().put(new JSONObject().put("url", url.toString()).put("title", clip(document.title(), 200)));
        return new JSONObject().put("untrusted", true).put("sources", sources).put("text", clip(text, 12000)).put("truncated", text.length() > 12000);
    }

    private JSONObject search(String query) throws Exception {
        Exception failure = null;
        HttpUrl bingRss = new HttpUrl.Builder().scheme("https").host("www.bing.com").addPathSegment("search")
            .addQueryParameter("format", "rss").addQueryParameter("q", query).build();
        try {
            return rssResults(request(bingRss, 512 * 1024, 0), bingRss.toString());
        } catch (Exception error) {
            if (cancelled) throw new IOException("Cancelled");
            failure = error;
        }
        HttpUrl baidu = new HttpUrl.Builder().scheme("https").host("www.baidu.com").addPathSegment("s")
            .addQueryParameter("wd", query).addQueryParameter("rn", "5").build();
        try {
            return searchResults(request(baidu, 2 * 1024 * 1024, 0), baidu.toString());
        } catch (Exception error) {
            if (cancelled) throw new IOException("Cancelled");
            failure = error;
        }
        throw new IOException("Search providers unavailable", failure);
    }

    private String request(HttpUrl url, int limit, int redirects) throws Exception {
        Request.Builder request = new Request.Builder().url(url).header("User-Agent", "Camellia-Android/LocalWebTools")
            .header("Accept", "application/rss+xml, application/xml, text/xml, text/html, text/plain");
        Call call = http.newCall(request.build()); active = call;
        if (cancelled) call.cancel();
        try (Response response = call.execute()) {
            if (response.isRedirect()) {
                String location = response.header("Location", "");
                HttpUrl next = url.resolve(location);
                if (redirects >= 3 || next == null) throw new IOException("Unsafe or excessive web redirect");
                next = publicUrl(next.toString());
                return request(next, limit, redirects + 1);
            }
            if (!response.isSuccessful() || response.body() == null) throw new IOException("Web request failed with HTTP " + response.code());
            String type = response.header("Content-Type", "").toLowerCase(java.util.Locale.ROOT);
            if (!(type.startsWith("text/html") || type.startsWith("text/plain") || type.startsWith("text/xml") || type.startsWith("application/xml") || type.startsWith("application/rss+xml"))) throw new IOException("Unsupported web content");
            if (response.body().contentLength() > limit) throw new IOException("Page too large");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (var input = response.body().byteStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (cancelled) throw new IOException("Cancelled");
                    if (bytes.size() + count > limit) throw new IOException("Page too large");
                    bytes.write(buffer, 0, count);
                }
            }
            String body = bytes.toString(StandardCharsets.UTF_8.name());
            return body;
        } finally { active = null; }
    }

    static JSONObject searchResults(String body, String baseUrl) throws Exception {
        org.jsoup.nodes.Document document = org.jsoup.Jsoup.parse(body, baseUrl);
        JSONArray sources = new JSONArray();
        HashSet<String> seen = new HashSet<>();
        for (org.jsoup.nodes.Element result : document.select(".result, li.b_algo, .c-result.result")) {
            org.jsoup.nodes.Element anchor = result.selectFirst("a.result__a, h2 a, h3 a, [rl-link-href]");
            String href = anchor == null ? "" : anchor.hasAttr("rl-link-href") ? anchor.attr("rl-link-href") : anchor.attr("href");
            String title = anchor == null ? "" : anchor.text();
            String baiduTarget = baiduTarget(result.attr("data-log"));
            if (!baiduTarget.isEmpty()) href = baiduTarget;
            if (title.isEmpty()) {
                org.jsoup.nodes.Element heading = result.selectFirst("h3, .c-title");
                if (heading != null) title = heading.text();
            }
            if (href.isEmpty() || title.isEmpty()) continue;
            HttpUrl link = HttpUrl.parse(href.startsWith("//") ? "https:" + href : href);
            if (link == null) link = HttpUrl.parse(baseUrl).resolve(href);
            if (link == null) continue;
            if (link.host().equals("duckduckgo.com") || link.host().endsWith(".duckduckgo.com")) {
                String target = link.queryParameter("uddg");
                if (target == null) continue;
                link = HttpUrl.parse(target);
                if (link == null) continue;
            }
            try {
                String publicLink = publicUrl(link.toString()).toString();
                if (!seen.add(publicLink)) continue;
                org.jsoup.nodes.Element snippet = result.selectFirst(".result__snippet, .b_caption p, .c-abstract, [data-module=summary], [data-module=left-image-summary]");
                sources.put(new JSONObject().put("url", publicLink).put("title", clip(title, 200))
                    .put("snippet", clip(snippet == null ? "" : snippet.text(), 1200)));
                if (sources.length() == 5) break;
            } catch (Exception ignored) {}
        }
        if (sources.length() == 0) throw new IOException("Search returned no readable results");
        return new JSONObject().put("untrusted", true).put("sources", sources);
    }

    static JSONObject rssResults(String body, String baseUrl) throws Exception {
        if (body.matches("(?is).*<!DOCTYPE.*") || body.matches("(?is).*<!ENTITY.*")) throw new IOException("Unsafe XML declaration");
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        try { factory.setFeature("http://xml.org/sax/features/external-general-entities", false); } catch (Exception ignored) {}
        try { factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false); } catch (Exception ignored) {}
        try { factory.setXIncludeAware(false); } catch (Exception ignored) {}
        factory.setExpandEntityReferences(false);
        org.w3c.dom.Document document = factory.newDocumentBuilder().parse(new InputSource(new StringReader(body)));
        org.w3c.dom.NodeList items = document.getElementsByTagName("item");
        JSONArray sources = new JSONArray(); HashSet<String> seen = new HashSet<>();
        for (int index = 0; index < items.getLength() && sources.length() < 5; index++) {
            org.w3c.dom.Element item = (org.w3c.dom.Element) items.item(index);
            String title = xmlText(item, "title"), link = xmlText(item, "link"), description = xmlText(item, "description");
            try {
                String publicLink = publicUrl(link).toString();
                if (!title.isEmpty() && seen.add(publicLink)) sources.put(new JSONObject().put("url", publicLink)
                    .put("title", clip(title, 200)).put("snippet", clip(org.jsoup.Jsoup.parse(description).text(), 1200)));
            } catch (Exception ignored) {}
        }
        if (sources.length() == 0) throw new IOException("RSS search returned no readable results: " + baseUrl);
        return new JSONObject().put("untrusted", true).put("sources", sources);
    }

    private static String xmlText(org.w3c.dom.Element parent, String name) {
        org.w3c.dom.NodeList nodes = parent.getElementsByTagName(name);
        return nodes.getLength() == 0 ? "" : nodes.item(0).getTextContent().trim();
    }

    private static String baiduTarget(String dataLog) {
        if (dataLog.isEmpty()) return "";
        try { return new JSONObject(dataLog).optString("mu"); } catch (Exception ignored) { return ""; }
    }

    private static String clip(String value, int length) { return value.substring(0, Math.min(length, value.length())); }
}
