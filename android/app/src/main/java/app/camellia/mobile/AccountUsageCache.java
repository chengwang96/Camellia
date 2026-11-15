package app.camellia.mobile;

import android.content.Context;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Separate encrypted cache, bound to both the computer and its current pairing. */
final class AccountUsageCache {
    private static final Object LOCK = new Object();
    private final CredentialStore store;
    AccountUsageCache(Context context) { store = new CredentialStore(context, "remote-account-usage"); }
    private String identity(JSONObject computer) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(computer.optString("token").getBytes(StandardCharsets.UTF_8));
        return android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP);
    }
    JSONObject load(JSONObject computer) throws Exception { synchronized (LOCK) {
        JSONObject entry = store.load().optJSONObject(computer.optString("address"));
        return entry != null && identity(computer).equals(entry.optString("identity")) ? entry.optJSONObject("data") : null;
    } }
    boolean save(JSONObject computer, JSONObject data) throws Exception { synchronized (LOCK) {
        boolean paired = false;
        for (JSONObject current : new ComputerStore(new CredentialStore(store.context)).all()) {
            if (current.optString("address").equals(computer.optString("address")) && current.optString("token").equals(computer.optString("token"))) paired = true;
        }
        if (!paired) return false;
        JSONObject cache;
        try { cache = store.load(); } catch (Exception unreadable) { cache = new JSONObject(); }
        cache.put(computer.getString("address"), new JSONObject().put("identity", identity(computer)).put("data", data));
        store.save(cache);
        return true;
    } }
    // A late denial from an old credential must not delete a newer pairing's snapshot.
    void remove(JSONObject computer) throws Exception { remove(computer.optString("address"), identity(computer)); }
    void remove(String address) throws Exception { remove(address, null); }
    private void remove(String address, String expectedIdentity) throws Exception { synchronized (LOCK) {
        JSONObject cache;
        try { cache = store.load(); } catch (Exception unreadable) { store.clear(); return; }
        JSONObject entry = cache.optJSONObject(address);
        if (expectedIdentity != null && (entry == null || !expectedIdentity.equals(entry.optString("identity")))) return;
        cache.remove(address); store.save(cache);
    } }
}
