package app.camellia.mobile;

import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

final class ComputerStore {
    private final CredentialStore store;

    ComputerStore(CredentialStore store) { this.store = store; }

    private JSONObject profiles(JSONObject saved) throws Exception {
        JSONObject profiles = saved.optJSONObject("computers");
        if (profiles == null) profiles = new JSONObject();
        if (saved.has("token") || saved.has("deviceId")) {
            JSONObject current = new JSONObject(saved.toString());
            current.remove("computers");
            profiles.put(current.getString("address"), current);
        }
        return profiles;
    }

    JSONObject load() throws Exception {
        JSONObject saved = store.load();
        saved.remove("computers");
        return saved;
    }

    List<JSONObject> all() throws Exception {
        JSONObject profiles = profiles(store.load());
        List<JSONObject> result = new ArrayList<>();
        var addresses = profiles.keys();
        while (addresses.hasNext()) result.add(profiles.getJSONObject(addresses.next()));
        return result;
    }

    void save(JSONObject value) throws Exception {
        JSONObject profiles = profiles(store.load());
        JSONObject current = new JSONObject(value.toString());
        current.remove("computers");
        if (current.has("token") || current.has("deviceId") || profiles.has(current.optString("address")) && !current.has("claim")) {
            profiles.put(current.getString("address"), new JSONObject(current.toString()));
        }
        current.put("computers", profiles);
        store.save(current);
    }

    void rename(String address, String name) throws Exception {
        JSONObject saved = store.load();
        JSONObject profiles = profiles(saved);
        profiles.getJSONObject(address).put("computerName", name);
        if (address.equals(saved.optString("address"))) saved.put("computerName", name);
        saved.put("computers", profiles);
        store.save(saved);
    }

    void remove(String address) throws Exception {
        JSONObject saved = store.load();
        JSONObject profiles = profiles(saved);
        profiles.remove(address);
        if (address.equals(saved.optString("address"))) saved = new JSONObject();
        saved.put("computers", profiles);
        store.save(saved);
    }
}
