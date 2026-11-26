package app.camellia.mobile;

import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Probes the Camellia hosts visible in the embedded Tailnet. The peer table is
 * authenticated by Tailscale, but a peer still has to answer the application
 * hello before it becomes a computer in the UI.
 */
final class TailnetDiscovery {
    static final class Candidate {
        final String computerId, name, url, nodeId, userId, hostName, os, loginName, lanUrl, lanFingerprint;

        Candidate(String computerId, String name, String url, String nodeId, String userId, String hostName, String os,
                  String loginName, String lanUrl, String lanFingerprint) {
            this.computerId = computerId; this.name = name; this.url = url;
            this.nodeId = nodeId; this.userId = userId; this.hostName = hostName; this.os = os; this.loginName = loginName;
            this.lanUrl = lanUrl; this.lanFingerprint = lanFingerprint;
        }

        boolean hasLan() {
            return !lanUrl.isEmpty() && LanTls.validFingerprint(lanFingerprint);
        }

        JSONObject toJson() {
            try {
                return new JSONObject().put("computerId", computerId).put("name", name).put("url", url)
                    .put("nodeId", nodeId).put("userId", userId).put("hostName", hostName).put("os", os).put("loginName", loginName)
                    .put("lanUrl", lanUrl).put("lanFingerprint", lanFingerprint);
            } catch (org.json.JSONException error) {
                return new JSONObject();
            }
        }
    }

    interface Listener {
        void onTailnetCandidates(List<Candidate> candidates, String error);
    }

    private final ExecutorService scans = Executors.newSingleThreadExecutor(
        action -> new Thread(action, "camellia-tailnet-discovery"));
    private final ExecutorService probes = Executors.newFixedThreadPool(6,
        action -> new Thread(action, "camellia-tailnet-probe"));
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger generation = new AtomicInteger();
    private volatile boolean closed;

    void scan(Listener listener) {
        if (closed) return;
        int ticket = generation.incrementAndGet();
        scans.submit(() -> {
            List<Candidate> result = new ArrayList<>();
            String error = null;
            try {
                if (!EmbeddedNetwork.enabled()) throw new IOException("内置网络未开启");
                if (!EmbeddedNetwork.online()) throw new IOException("Tailscale 未连接");
                JSONArray peers = EmbeddedNetwork.peers();
                List<Future<Candidate>> pending = new ArrayList<>();
                for (int i = 0; i < peers.length(); i++) {
                    JSONObject peer = peers.optJSONObject(i);
                    if (peer == null || !peer.optBoolean("online")) continue;
                    JSONArray addresses = peer.optJSONArray("addresses");
                    if (addresses == null || addresses.length() == 0) continue;
                    String host = addresses.optString(0);
                    pending.add(probes.submit(() -> probe(peer, host)));
                }
                long deadline = System.currentTimeMillis() + 6_500;
                for (Future<Candidate> future : pending) {
                    try {
                        long remaining = Math.max(1, deadline - System.currentTimeMillis());
                        Candidate candidate = future.get(remaining, TimeUnit.MILLISECONDS);
                        if (candidate != null) result.add(candidate);
                    } catch (Exception ignored) {
                        future.cancel(true);
                    }
                }
                Collections.sort(result, (left, right) -> left.name.compareToIgnoreCase(right.name));
            } catch (Exception failure) {
                error = failure.getMessage();
            }
            List<Candidate> candidates = Collections.unmodifiableList(result);
            final String failure = error;
            main.post(() -> {
                if (!closed && ticket == generation.get()) listener.onTailnetCandidates(candidates, failure);
            });
        });
    }

    private static Candidate probe(JSONObject peer, String host) {
        try {
            String url = "http://" + host + ":43127";
            new Endpoint(url);
            JSONObject hello = EmbeddedNetwork.hello(host);
            if (hello.optInt("protocol") != 1 || !"camellia".equals(hello.optString("app"))) return null;
            JSONObject join = hello.optJSONObject("join");
            JSONObject auth = hello.optJSONObject("auth");
            if (join != null && !join.optBoolean("tailnet")) return null;
            if (auth != null && !auth.optBoolean("tailnet")) return null;
            String computerId = hello.optString("computerId");
            if (computerId.isEmpty()) return null;
            String name = hello.optString("computerName");
            if (name.isEmpty()) name = peer.optString("hostName");
            if (name.isEmpty()) name = computerId;
            JSONObject transports = hello.optJSONObject("transports");
            JSONObject lan = transports == null ? null : transports.optJSONObject("lan");
            String lanUrl = lan == null ? "" : lan.optString("url");
            String lanFingerprint = lan == null ? "" : lan.optString("fingerprint");
            if (!LanTls.validFingerprint(lanFingerprint)) {
                lanUrl = ""; lanFingerprint = "";
            }
            return new Candidate(computerId, name, url, peer.optString("id"), peer.optString("userId"), peer.optString("hostName"),
                peer.optString("os"), peer.optString("loginName"), lanUrl, lanFingerprint);
        } catch (Exception ignored) {
            return null;
        }
    }

    void cancel() {
        generation.incrementAndGet();
    }

    void close() {
        closed = true;
        cancel();
        scans.shutdownNow();
        probes.shutdownNow();
    }
}
