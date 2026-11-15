package app.camellia.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

/** Keeps the selected APK and its URI grant through the unknown-sources settings flow. */
public final class ArtifactInstallActivity extends Activity {
    static final int INSTALL_PERMISSION_REQUEST = 705;
    private boolean waitingForPermission;
    private boolean finished;

    @Override protected void attachBaseContext(android.content.Context context) {
        super.attachBaseContext(MobilePreferences.wrap(context));
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Uri uri = getIntent().getData();
        if (uri == null || !"content".equals(uri.getScheme())) {
            message("安装包位置不可用，请在文件管理器中打开已下载的 APK。",
                "The APK location is unavailable. Open the downloaded APK from your file manager.");
            finish();
            return;
        }
        waitingForPermission = saved != null && saved.getBoolean("waitingForInstallPermission");
        if (!waitingForPermission) continueInstall();
    }

    @Override protected void onResume() {
        super.onResume();
        // Android can kill this process when the user changes the install app-op.
        // Restore from the original intent even if the settings result was lost.
        if (waitingForPermission && !finished && getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = false;
            openInstaller();
        }
    }

    private void continueInstall() {
        if (finished) return;
        if (getPackageManager().canRequestPackageInstalls()) {
            openInstaller();
            return;
        }
        message("请允许 Camellia 安装未知应用，返回后继续安装。",
            "Allow Camellia to install unknown apps, then return to continue installation.");
        waitingForPermission = true;
        try {
            startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getPackageName())), INSTALL_PERMISSION_REQUEST);
        } catch (ActivityNotFoundException | SecurityException error) {
            waitingForPermission = false;
            message("无法打开安装授权页面，请在系统设置中允许 Camellia 安装未知应用，或从文件管理器安装。",
                "Could not open installation settings. Allow Camellia to install unknown apps in system settings, or install from your file manager.");
            finished = true;
            finish();
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != INSTALL_PERMISSION_REQUEST || finished) return;
        waitingForPermission = false;
        if (getPackageManager().canRequestPackageInstalls()) openInstaller();
        else {
            message("尚未允许 Camellia 安装应用。安装包已保存，可稍后重试或从文件管理器打开。",
                "Camellia is not allowed to install apps. The APK is saved; retry later or open it from your file manager.");
            finished = true;
            finish();
        }
    }

    private void openInstaller() {
        if (finished) return;
        finished = true;
        try {
            startActivity(ArtifactOpen.viewIntent(this, getIntent().getData(), getIntent().getStringExtra(Intent.EXTRA_TITLE)));
        } catch (ActivityNotFoundException | SecurityException error) {
            message("无法打开系统安装器，请从文件管理器打开已下载的 APK。",
                "Could not open the system installer. Open the downloaded APK from your file manager.");
        }
        finish();
    }

    @Override protected void onSaveInstanceState(Bundle saved) {
        saved.putBoolean("waitingForInstallPermission", waitingForPermission);
        super.onSaveInstanceState(saved);
    }

    private void message(String zh, String en) {
        boolean chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        Toast.makeText(this, chinese ? zh : en, Toast.LENGTH_LONG).show();
    }
}
