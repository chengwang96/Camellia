package app.camellia.mobile.release;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.BitmapDrawable;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.test.InstrumentationTestCase;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Exercises the shipped, obfuscated APK through Android components, UI and camera callbacks.
 * No keep rules, app classes, or private field names are added for these tests. */
public class ReleaseSmokeTest extends InstrumentationTestCase {
    private static final String ALIAS = "camellia.remote.v1";
    private static final String ID = "release-upgrade-fixture";
    private static final String DRAFT = "Preserved upgrade draft";
    private final List<Activity> activities = new ArrayList<>();
    private interface Check { void run() throws Exception; }
    private interface Condition { boolean ready() throws Exception; }
    private Context context() { return getInstrumentation().getTargetContext(); }
    private void ui(Check check) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private void await(String description, Condition condition) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 20000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            AtomicReference<Boolean> ready = new AtomicReference<>(false);
            ui(() -> ready.set(condition.ready())); if (ready.get()) return;
            Thread.sleep(75);
        }
        fail(description);
    }
    private Activity open(String component) {
        Activity activity = getInstrumentation().startActivitySync(new Intent().setClassName(context(), "app.camellia.mobile." + component)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        activities.add(activity); return activity;
    }
    private View tag(Activity activity, String value) { return activity.getWindow().getDecorView().findViewWithTag(value); }
    private void click(Activity activity, String value) throws Exception {
        await("Missing UI control: " + value, () -> tag(activity, value) != null && tag(activity, value).isEnabled());
        ui(() -> assertTrue(tag(activity, value).performClick()));
    }
    private String texts(View view) {
        StringBuilder result = new StringBuilder();
        if (view instanceof TextView) result.append(((TextView) view).getText()).append('\n');
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) result.append(texts(((ViewGroup) view).getChildAt(i)));
        return result.toString();
    }
    private ImageView logo(View view) {
        if (view instanceof ImageView && "Camellia".contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return (ImageView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            ImageView found = logo(((ViewGroup) view).getChildAt(i)); if (found != null) return found;
        }
        return null;
    }
    private boolean bold(View view, String phrase) {
        if (view instanceof TextView && ((TextView) view).getText() instanceof android.text.Spanned) {
            android.text.Spanned text = (android.text.Spanned) ((TextView) view).getText();
            int start = text.toString().indexOf(phrase);
            if (start >= 0) for (android.text.style.StyleSpan span : text.getSpans(start, start + phrase.length(), android.text.style.StyleSpan.class))
                if ((span.getStyle() & android.graphics.Typeface.BOLD) != 0) return true;
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++)
            if (bold(((ViewGroup) view).getChildAt(i), phrase)) return true;
        return false;
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS) && create) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        assertTrue("Upgrade must preserve the Keystore key", store.containsAlias(ALIAS));
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private void save(String name, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true)); cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        assertTrue(context().getSharedPreferences(name, 0).edit().putString("credential", envelope.toString()).commit());
    }
    private JSONObject load(String name) throws Exception {
        JSONObject envelope = new JSONObject(context().getSharedPreferences(name, 0).getString("credential", ""));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
        cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    private Activity conversation() throws Exception {
        Activity activity = open("LocalChatActivity"); click(activity, "localConversation:" + ID);
        await("Migrated conversation did not open", () -> tag(activity, "localComposer") != null);
        return activity;
    }
    @Override protected void tearDown() throws Exception {
        for (int i = activities.size() - 1; i >= 0; i--) {
            Activity activity = activities.get(i); ui(() -> { if (!activity.isFinishing()) activity.finish(); });
            await("Activity did not close", activity::isDestroyed);
        }
        super.tearDown();
    }
    public void testSeedUpgradeFixture() throws Exception {
        // Run explicitly against the previous signed APK, then install -r without clearing data.
        assertFalse("Seed on a fresh old-version installation", new java.io.File(context().getNoBackupFilesDir(), "local-chat-v2.db").exists());
        assertTrue(context().getSharedPreferences(ID, 0).edit().putInt("originalVersion", context().getPackageManager()
            .getPackageInfo(context().getPackageName(), 0).versionCode).commit());
        save("remote-private", new JSONObject().put("releaseSentinel", "encrypted-token-preserved").put("computers", new JSONObject()));
        JSONObject chat = new JSONObject().put("id", ID).put("title", "Upgrade kept").put("workspaceId", "").put("routeId", "")
            .put("updatedAt", System.currentTimeMillis()).put("draft", DRAFT).put("messages", new JSONArray()
                .put(new JSONObject().put("role", "user").put("content", "Original upgrade question"))
                .put(new JSONObject().put("role", "assistant").put("content", "# Release heading\n\n**Preserved bold** and [a link](https://example.com)\n\n```java\nint preserved = 7;\n```\n\nEnergy $E=mc^2$ and \\(x_i=\\sqrt{y}\\).\n\n$$\\frac{1}{2} + \\sum_{i=1}^{n} x_i$$\n\n\\[\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\]")));
        save("local-chat-private", new JSONObject().put("config", new JSONObject()).put("workspaces", new JSONArray()).put("conversations", new JSONArray().put(chat)));
        assertTrue(context().getSharedPreferences("mobile-preferences", 0).edit().putString("language", "en").putString("theme", "light").putString("deviceName", "Upgrade fixture").commit());
        assertTrue(context().getSharedPreferences("network-mode", 0).edit().putBoolean("embedded", true).commit());
        assertEquals("encrypted-token-preserved", load("remote-private").getString("releaseSentinel"));
        assertEquals(DRAFT, load("local-chat-private").getJSONArray("conversations").getJSONObject(0).getString("draft"));
    }
    public void testUpgradePreservesEncryptedDataAndMarkdown() throws Exception {
        int originalVersion = context().getSharedPreferences(ID, 0).getInt("originalVersion", -1);
        assertTrue("An older signed version must be seeded first", originalVersion > 0);
        assertTrue("Install the newer APK without clearing data", context().getPackageManager().getPackageInfo(context().getPackageName(), 0).versionCode > originalVersion);
        assertEquals(0, context().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE);
        assertEquals("encrypted-token-preserved", load("remote-private").getString("releaseSentinel"));
        assertEquals("Upgrade fixture", context().getSharedPreferences("mobile-preferences", 0).getString("deviceName", ""));
        Activity activity = conversation();
        await("History or Markdown disappeared during upgrade", () -> {
            String text = texts(activity.getWindow().getDecorView());
            return text.contains("Original upgrade question") && text.contains("Release heading") && text.contains("Preserved bold") && text.contains("int preserved = 7;");
        });
        ui(() -> assertTrue("Markdown emphasis was lost by shrinking", bold(activity.getWindow().getDecorView(), "Preserved bold")));
        ui(() -> assertEquals("History formulas disappeared after upgrade", 4, verifyMath(activity.getWindow().getDecorView())));
        ui(() -> assertEquals(DRAFT, ((EditText) tag(activity, "localComposer")).getText().toString()));
        assertTrue(new java.io.File(context().getNoBackupFilesDir(), "local-chat-v2.db").isFile());
        assertFalse("Verified migration should remove the old encrypted duplicate", context().getSharedPreferences("local-chat-private", 0).contains("credential"));
        ui(activity::finish); await("Conversation did not close", activity::isDestroyed);
        Activity reopened = conversation(); ui(() -> assertEquals(DRAFT, ((EditText) tag(reopened, "localComposer")).getText().toString()));
    }
    private int verifyMath(View view) {
        int count = 0;
        if (view instanceof TextView && ((TextView) view).getText() instanceof android.text.Spanned) {
            TextView text = (TextView) view; android.text.Spanned value = (android.text.Spanned) text.getText();
            for (android.text.style.ReplacementSpan span : value.getSpans(0, value.length(), android.text.style.ReplacementSpan.class)) {
                int start = value.getSpanStart(span), end = value.getSpanEnd(span);
                android.graphics.Paint.FontMetricsInt metrics = new android.graphics.Paint.FontMetricsInt();
                int width = span.getSize(text.getPaint(), value, start, end, metrics);
                assertTrue("TeX fell back to raw text after shrinking: " + value, width < text.getPaint().measureText(value, start, end));
                assertTrue("Formula has no height", metrics.descent > metrics.ascent); count++;
            }
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) count += verifyMath(((ViewGroup) view).getChildAt(i));
        return count;
    }
    public void testNativeNetworkAndBrandResource() throws Exception {
        Activity activity = open("MainActivity");
        ui(() -> {
            ImageView image = logo(activity.getWindow().getDecorView()); assertNotNull(image);
            assertTrue(image.getDrawable() instanceof BitmapDrawable);
            android.graphics.Bitmap bitmap = ((BitmapDrawable) image.getDrawable()).getBitmap();
            assertEquals(256, bitmap.getWidth()); assertEquals(256, bitmap.getHeight()); assertTrue(bitmap.hasAlpha());
        });
        click(activity, "settingsEntry"); click(activity, "settings:network");
        await("Go/JNI network or encrypted callbacks failed", () -> {
            String text = ((TextView) tag(activity, "connectionStatus")).getText().toString();
            return text.equals("Network state: NeedsLogin") || text.equals("Connected. Return to pairing.");
        });
        // tsnet creates its machine key through the actual app's encrypted Storage callback.
        await("Native state was not persisted by the app", () -> context().getSharedPreferences("tailnet-private", 0).contains("credential"));
        assertTrue("Encrypted native state must remain decryptable", load("tailnet-private").length() > 0);
        click(activity, "networkRefresh");
        await("Refreshing native network failed", () -> ((TextView) tag(activity, "connectionStatus")).getText().toString().startsWith("Network state:"));
    }

    public void testSeedDefaultDownloadDirectory() throws Exception {
        assertTrue("Use a disposable emulator", android.os.Build.HARDWARE.equals("ranchu") || android.os.Build.HARDWARE.equals("goldfish"));
        try (var descriptor = getInstrumentation().getUiAutomation().executeShellCommand("mkdir -p /sdcard/Download/CamelliaDirectoryTest");
             var input = new java.io.FileInputStream(descriptor.getFileDescriptor())) { while (input.read() != -1) {} }
        Uri directory = defaultDownloadTree();
        Activity activity = open("MainActivity");
        ui(() -> activity.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            .putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, android.provider.DocumentsContract.buildDocumentUri(directory.getAuthority(), "primary:Download/CamelliaDirectoryTest")), 706));
        clickSystemButton("Use this folder"); clickSystemButton("Allow");
        await("Folder picker did not return", activity::hasWindowFocus);
        context().getContentResolver().takePersistableUriPermission(directory, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        assertTrue(context().getSharedPreferences("mobile-preferences", 0).edit()
            .putString("downloadDirectoryUri", directory.toString()).putString("downloadDirectoryLabel", "Download/CamelliaDirectoryTest").commit());
        assertTrue(hasDirectoryGrant(directory));
    }

    public void testDefaultDownloadDirectorySurvivesUpgrade() throws Exception {
        Uri directory = defaultDownloadTree();
        assertEquals(directory.toString(), context().getSharedPreferences("mobile-preferences", 0).getString("downloadDirectoryUri", ""));
        assertTrue("Upgrade must preserve the directory's read/write grant", hasDirectoryGrant(directory));
        Activity settings = getInstrumentation().startActivitySync(new Intent().setClassName(context(), "app.camellia.mobile.SettingsActivity")
            .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); activities.add(settings);
        await("The signed release must show the saved download directory", () -> tag(settings, "preference:downloadDirectory") != null);
        ui(() -> assertTrue(tag(settings, "preference:downloadDirectory").getContentDescription().toString().contains("Download/CamelliaDirectoryTest")));
        Uri parent = android.provider.DocumentsContract.buildDocumentUriUsingTree(directory, android.provider.DocumentsContract.getTreeDocumentId(directory));
        Uri file = android.provider.DocumentsContract.createDocument(context().getContentResolver(), parent, "text/plain", "upgrade-grant.txt");
        assertNotNull(file);
        try {
            try (var output = context().getContentResolver().openOutputStream(file, "wt")) { output.write("upgrade retained access".getBytes(StandardCharsets.UTF_8)); }
            try (var input = context().getContentResolver().openInputStream(file)) { assertEquals("upgrade retained access", new String(input.readAllBytes(), StandardCharsets.UTF_8)); }
        } finally { android.provider.DocumentsContract.deleteDocument(context().getContentResolver(), file); }
    }

    private Uri defaultDownloadTree() {
        return android.provider.DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents", "primary:Download/CamelliaDirectoryTest");
    }
    private boolean hasDirectoryGrant(Uri directory) {
        for (android.content.UriPermission grant : context().getContentResolver().getPersistedUriPermissions())
            if (directory.equals(grant.getUri()) && grant.isReadPermission() && grant.isWritePermission()) return true;
        return false;
    }
    private void clickSystemButton(String text) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
        do {
            AccessibilityNodeInfo root = getInstrumentation().getUiAutomation().getRootInActiveWindow();
            if (root != null) for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText(text)) {
                if (!text.equalsIgnoreCase(String.valueOf(node.getText())) || !node.isEnabled()) continue;
                while (node != null && !node.isClickable()) node = node.getParent();
                if (node != null && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
            }
            Thread.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        fail("Missing folder-picker button: " + text);
    }
    public void testOfficeImportInMinifiedRelease() throws Exception {
        Activity activity = conversation();
        IntentFilter filter = new IntentFilter(Intent.ACTION_GET_CONTENT); filter.addCategory(Intent.CATEGORY_OPENABLE); filter.addDataType("*/*");
        Intent result = new Intent().setData(Uri.parse("content://app.camellia.mobile.release.test.fixtures/document"));
        Instrumentation.ActivityMonitor picker = getInstrumentation().addMonitor(filter, new Instrumentation.ActivityResult(Activity.RESULT_OK, result), true);
        try {
            click(activity, "localAttach");
            boolean clicked = false;
            long end = android.os.SystemClock.uptimeMillis() + 10000;
            while (!clicked && android.os.SystemClock.uptimeMillis() < end) {
                AccessibilityNodeInfo root = getInstrumentation().getUiAutomation().getRootInActiveWindow();
                if (root != null) for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText("Files")) {
                    if (!"Files".contentEquals(node.getText() == null ? "" : node.getText())) continue;
                    while (node != null && !node.isClickable()) node = node.getParent();
                    if (node != null && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { clicked = true; break; }
                }
                if (!clicked) Thread.sleep(100);
            }
            assertTrue("Document picker tile was not accessible", clicked);
            await("Document was not imported in the optimized APK", () -> texts(tag(activity, "localImageTray")).contains("release-fixture.docx"));
            assertEquals(1, picker.getHits());
        } finally { getInstrumentation().removeMonitor(picker); }
    }
    public void testCameraDecodesPairingQrInMinifiedRelease() throws Exception {
        try (java.io.InputStream grant = new android.os.ParcelFileDescriptor.AutoCloseInputStream(getInstrumentation().getUiAutomation()
                .executeShellCommand("pm grant " + context().getPackageName() + " android.permission.CAMERA"))) { while (grant.read() != -1) {} }
        Activity scanner = open("QrScanActivity");
        AtomicReference<android.hardware.Camera> camera = new AtomicReference<>();
        await("Camera preview did not start", () -> {
            // Locate the SDK camera by type, so this works without preserving a private field name.
            for (java.lang.reflect.Field field : scanner.getClass().getDeclaredFields()) {
                if (field.getType() == android.hardware.Camera.class) {
                    field.setAccessible(true); camera.set((android.hardware.Camera) field.get(scanner));
                }
            }
            android.view.TextureView preview = (android.view.TextureView) tag(scanner, "qrPreview");
            return camera.get() != null && preview != null && preview.isAvailable();
        });
        try (java.io.InputStream input = getInstrumentation().getContext().getAssets().open("pairing-qr.png")) {
            android.graphics.Bitmap fixture = android.graphics.BitmapFactory.decodeStream(input); assertNotNull(fixture);
            try {
                ui(() -> {
                    var size = camera.get().getParameters().getPreviewSize();
                    int side = Math.min(size.width, size.height) * 3 / 4;
                    android.graphics.Bitmap code = android.graphics.Bitmap.createScaledBitmap(fixture, side, side, false);
                    try {
                        byte[] frame = new byte[size.width * size.height * 3 / 2];
                        java.util.Arrays.fill(frame, 0, size.width * size.height, (byte) 235);
                        java.util.Arrays.fill(frame, size.width * size.height, frame.length, (byte) 128);
                        int left = (size.width - side) / 2, top = (size.height - side) / 2;
                        for (int y = 0; y < side; y++) for (int x = 0; x < side; x++)
                            frame[(top + y) * size.width + left + x] = (byte) ((code.getPixel(x, y) & 0xffffff) == 0 ? 16 : 235);
                        camera.get().setPreviewCallbackWithBuffer(null);
                        assertFalse(scanner.isFinishing());
                        ((android.hardware.Camera.PreviewCallback) scanner).onPreviewFrame(frame, camera.get());
                    } finally { code.recycle(); }
                });
            } finally { fixture.recycle(); }
        }
        // Use the production callback, decoder and payload validation with the actual preview size.
        // Emulator imagefile rendering clips its synthetic frames; physical camera input is a device check.
        await("Optimized camera/ZXing scanner did not decode the fixture", scanner::isFinishing);
        await("Scanner did not release its camera", scanner::isDestroyed);
    }
}
