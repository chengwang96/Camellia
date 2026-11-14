package app.camellia.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import java.util.Locale;

/** Opens a completed artifact with the system's default handler. */
final class ArtifactOpen {
    private static final String FALLBACK = "application/octet-stream";

    private ArtifactOpen() {}

    static String mimeType(String name) {
        String extension = extension(name);
        switch (extension) {
            case "apk": return "application/vnd.android.package-archive";
            case "pdf": return "application/pdf";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "mp4": return "video/mp4";
            case "webm": return "video/webm";
            case "mov": return "video/quicktime";
            case "m4v": return "video/x-m4v";
            case "mp3": return "audio/mpeg";
            case "m4a": return "audio/mp4";
            case "wav": return "audio/wav";
            case "ogg": return "audio/ogg";
            case "txt":
            case "log": return "text/plain";
            case "md": return "text/markdown";
            case "csv": return "text/csv";
            case "json": return "application/json";
            case "xml": return "application/xml";
            default:
                String mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return mapped == null || mapped.isEmpty() ? FALLBACK : mapped;
        }
    }

    static String mimeType(Context context, Uri uri, String name) {
        String mapped = mimeType(name);
        if (!FALLBACK.equals(mapped) || uri == null) return mapped;
        try {
            String provided = context.getContentResolver().getType(uri);
            return provided == null || provided.isEmpty() ? FALLBACK : provided;
        } catch (RuntimeException ignored) {
            return FALLBACK;
        }
    }

    static Intent intent(Context context, Uri uri, String name) {
        Intent view = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mimeType(context, uri, name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        view.setClipData(ClipData.newRawUri(name == null || name.isEmpty() ? "Camellia" : name, uri));
        return view;
    }

    static boolean open(Activity activity, Uri uri, String name, boolean chinese) {
        if (uri == null) {
            toast(activity, chinese ? "文件已保存，但系统没有返回可打开的位置。"
                : "The file was saved, but its location is unavailable.");
            return false;
        }
        Intent view = intent(activity, uri, name);
        try {
            activity.startActivity(view);
            return true;
        } catch (ActivityNotFoundException first) {
            try {
                activity.startActivity(new Intent(view).setDataAndType(uri, "*/*"));
                return true;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                toast(activity, chinese ? "没有可打开此文件的应用。文件已保存，可在文件管理器中查看。"
                    : "No app can open this file. It is saved; open it from your file manager.");
            }
        } catch (SecurityException ignored) {
            toast(activity, chinese ? "系统限制了打开此文件。可在文件管理器中查看或稍后重试。"
                : "The system blocked opening this file. Open it from your file manager or retry later.");
        }
        return false;
    }

    private static String extension(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        return dot < 0 || dot == name.length() - 1 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static void toast(Activity activity, String message) {
        android.widget.Toast.makeText(activity, message, android.widget.Toast.LENGTH_LONG).show();
    }
}
