package app.camellia.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.test.InstrumentationTestCase;
import java.io.File;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Exercises unknown-source authorization on a disposable emulator, without installing an APK. */
public class ArtifactInstallTest extends InstrumentationTestCase {
    private Activity host;
    private Uri uri;
    private File apk;
    private final List<Intent> external = new CopyOnWriteArrayList<>();
    private Instrumentation.ActivityMonitor monitor;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        host = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        File directory = new File(context.getCacheDir(), "camera");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        apk = new File(directory, "installation-test.apk");
        try (var output = new java.io.FileOutputStream(apk)) { output.write(new byte[] { 'P', 'K', 3, 4 }); }
        uri = CameraFileProvider.uri(context, apk);
        monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (intent.getComponent() != null && intent.getComponent().getPackageName().equals(host.getPackageName())) return null;
                external.add(new Intent(intent));
                return new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
            }
        };
        getInstrumentation().addMonitor(monitor);
    }

    @Override protected void tearDown() throws Exception {
        if (monitor != null) getInstrumentation().removeMonitor(monitor);
        if (host != null) getInstrumentation().runOnMainSync(host::finish);
        if (apk != null) apk.delete();
        super.tearDown();
    }

    public void testManifestAndNotificationIntentUseTheInstallationFlow() throws Exception {
        var context = getInstrumentation().getTargetContext();
        var info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
        assertTrue(java.util.Arrays.asList(info.requestedPermissions).contains("android.permission.REQUEST_INSTALL_PACKAGES"));
        Intent intent = ArtifactOpen.intent(context, uri, "Camellia.apk");
        assertEquals(ArtifactInstallActivity.class.getName(), intent.getComponent().getClassName());
        assertEquals(uri, intent.getData());
        assertEquals(uri, intent.getClipData().getItemAt(0).getUri());
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertFalse(context.getPackageManager().getActivityInfo(intent.getComponent(), 0).exported);
    }

    public void testInstallationOpenUsesAuthorizationAndKeepsTheApkGrant() throws Exception {
        boolean allowed = host.getPackageManager().canRequestPackageInstalls();
        openApk();
        await(1);
        getInstrumentation().waitForIdleSync();
        if (allowed) assertInstaller(external.get(0));
        else {
            assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, external.get(0).getAction());
            assertEquals("package:" + host.getPackageName(), external.get(0).getDataString());
        }
        Thread.sleep(200);
        assertEquals("Opening an APK must not repeat the authorization or installer page", 1, external.size());
    }

    private void openApk() {
        getInstrumentation().runOnMainSync(() -> assertTrue(ArtifactOpen.open(host, uri, "Camellia.apk", false)));
    }

    private void assertInstaller(Intent intent) {
        assertEquals(Intent.ACTION_VIEW, intent.getAction());
        assertEquals("application/vnd.android.package-archive", intent.getType());
        assertEquals(uri, intent.getData());
        assertEquals(uri, intent.getClipData().getItemAt(0).getUri());
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
    }

    private void await(int count) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (external.size() < count && android.os.SystemClock.uptimeMillis() < deadline) Thread.sleep(30);
        assertEquals(count, external.size());
    }

}
