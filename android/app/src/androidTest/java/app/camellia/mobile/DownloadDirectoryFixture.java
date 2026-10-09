package app.camellia.mobile;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.FileInputStream;

/** Real ExternalStorageProvider access in a disposable emulator, without changing personal folders. */
final class DownloadDirectoryFixture {
    static final String PATH = "Download/CamelliaDirectoryTest";
    static final Uri TREE = DocumentsContract.buildTreeDocumentUri("com.android.externalstorage.documents", "primary:" + PATH);
    static final int FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;

    static void grant(Instrumentation instrumentation) throws Exception {
        if (!android.os.Build.HARDWARE.equals("ranchu") && !android.os.Build.HARDWARE.equals("goldfish"))
            throw new IllegalStateException("Use a disposable Android emulator for directory tests");
        shell(instrumentation, "mkdir -p /sdcard/" + PATH);
        android.app.Activity settings = LocalChatFixture.start(instrumentation, new Intent(instrumentation.getTargetContext(), SettingsActivity.class)
            .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            instrumentation.runOnMainSync(() -> settings.startActivityForResult(DownloadDirectory.picker(settings)
                .putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(TREE.getAuthority(), "primary:" + PATH)), DownloadDirectory.PICK_REQUEST));
            click(instrumentation, "Use this folder", "使用此文件夹");
            click(instrumentation, "Allow", "允许");
            long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
            while (!TREE.equals(DownloadDirectory.selected(settings)) || !DownloadDirectory.hasPermission(settings, TREE)) {
                if (android.os.SystemClock.elapsedRealtime() >= deadline) throw new AssertionError("The system did not authorize the test folder");
                android.os.SystemClock.sleep(50);
            }
        } finally {
            instrumentation.runOnMainSync(settings::finish);
            long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
            while (!settings.isDestroyed() && android.os.SystemClock.elapsedRealtime() < deadline) android.os.SystemClock.sleep(50);
            if (!settings.isDestroyed()) throw new AssertionError("Directory fixture settings did not close");
        }
    }

    static void authorize(Instrumentation instrumentation) throws Exception {
        grant(instrumentation);
    }

    static Intent selection() { return new Intent().setData(TREE).addFlags(FLAGS); }

    private static void click(Instrumentation instrumentation, String... labels) {
        long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
        do {
            android.view.accessibility.AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root != null && click(root, labels)) return;
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        throw new AssertionError("Missing directory-picker action: " + labels[0]);
    }

    private static boolean click(android.view.accessibility.AccessibilityNodeInfo node, String[] labels) {
        String text = String.valueOf(node.getText());
        for (String label : labels) if (label.equalsIgnoreCase(text) && node.isVisibleToUser() && node.isEnabled()) {
            android.view.accessibility.AccessibilityNodeInfo target = node;
            while (target != null && !target.isClickable()) target = target.getParent();
            if (target != null && target.isEnabled() && target.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        for (int index = 0; index < node.getChildCount(); index++) {
            android.view.accessibility.AccessibilityNodeInfo child = node.getChild(index);
            if (child != null && click(child, labels)) return true;
        }
        return false;
    }

    static String shell(Instrumentation instrumentation, String command) throws Exception {
        try (var descriptor = instrumentation.getUiAutomation().executeShellCommand(command);
             var input = new FileInputStream(descriptor.getFileDescriptor())) {
            return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    static java.util.List<Uri> files(Context context) {
        java.util.List<Uri> files = new java.util.ArrayList<>();
        try (var cursor = context.getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(TREE,
                DocumentsContract.getTreeDocumentId(TREE)), new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID}, null, null, null)) {
            if (cursor == null) throw new AssertionError("Cannot read test directory");
            while (cursor.moveToNext()) files.add(DocumentsContract.buildDocumentUriUsingTree(TREE, cursor.getString(0)));
        }
        return files;
    }
}
