package app.camellia.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class CredentialStore {
    private static final String ALIAS = "camellia.remote.v1";
    private final android.content.SharedPreferences preferences;

    public CredentialStore(Context context) { preferences = context.getSharedPreferences("remote-private", Context.MODE_PRIVATE); }
    public CredentialStore(Context context, String name) { preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE); }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }

    public JSONObject load() throws Exception {
        String stored = preferences.getString("credential", null);
        if (stored == null) return new JSONObject();
        JSONObject envelope = new JSONObject(stored);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }

    public void save(JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        if (!preferences.edit().putString("credential", envelope.toString()).commit()) throw new java.io.IOException("Cannot save credentials");
    }

    public void clear() {
        if (!preferences.edit().clear().commit()) throw new IllegalStateException("Cannot remove credentials");
    }
}
