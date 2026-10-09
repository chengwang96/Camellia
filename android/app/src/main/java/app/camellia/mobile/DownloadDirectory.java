package app.camellia.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.webkit.MimeTypeMap;
import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** The user-selected SAF directory and its persistent read/write grant. */
final class DownloadDirectory {
    static final int PICK_REQUEST = 706;
    private static final String URI_KEY = "downloadDirectoryUri", LABEL_KEY = "downloadDirectoryLabel";

    private static android.content.SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("mobile-preferences", Context.MODE_PRIVATE);
    }

    static Uri selected(Context context) {
        String value = preferences(context).getString(URI_KEY, "");
        if (value.isEmpty()) return null;
        Uri uri = Uri.parse(value);
        return "content".equals(uri.getScheme()) && DocumentsContract.isTreeUri(uri) ? uri : null;
    }

    static String label(Context context) { return preferences(context).getString(LABEL_KEY, ""); }

    static Intent picker(Context context) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        Uri current = selected(context);
        if (current != null) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, current);
        return intent;
    }

    static boolean hasPermission(Context context, Uri directory) {
        for (android.content.UriPermission permission : context.getContentResolver().getPersistedUriPermissions())
            if (directory.equals(permission.getUri()) && permission.isReadPermission() && permission.isWritePermission()) return true;
        return false;
    }

    // Metadata and document-provider operations run on a worker thread.
    static void saveSelection(Context context, Intent result) throws IOException {
        Uri directory = result == null ? null : result.getData();
        int access = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        if (directory == null || !"content".equals(directory.getScheme()) || !DocumentsContract.isTreeUri(directory)
                || (result.getFlags() & access) != access || (result.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0)
            throw new IOException("The folder must grant persistent read and write access");
        String name = writableDirectory(context, directory);
        context.getContentResolver().takePersistableUriPermission(directory, access);
        Uri previous = selected(context);
        if ("com.android.externalstorage.documents".equals(directory.getAuthority())) {
            String id = DocumentsContract.getTreeDocumentId(directory);
            name = id.startsWith("primary:") ? id.substring(8) : id;
        }
        preferences(context).edit().putString(URI_KEY, directory.toString()).putString(LABEL_KEY, name).apply();
        releaseUnused(context, previous);
    }

    static void clear(Context context) {
        Uri previous = selected(context);
        preferences(context).edit().remove(URI_KEY).remove(LABEL_KEY).apply();
        releaseUnused(context, previous);
    }

    static void releaseUnused(Context context, Uri directory) {
        if (directory == null || directory.equals(selected(context)) || ArtifactDownloadService.usesDirectory(directory)) return;
        try { context.getContentResolver().releasePersistableUriPermission(directory,
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); }
        catch (SecurityException ignored) { }
    }

    private static String writableDirectory(Context context, Uri directory) throws IOException {
        Uri document = DocumentsContract.buildDocumentUriUsingTree(directory, DocumentsContract.getTreeDocumentId(directory));
        try (var cursor = context.getContentResolver().query(document,
                new String[]{Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst() || !Document.MIME_TYPE_DIR.equals(cursor.getString(1))
                    || (cursor.getInt(2) & Document.FLAG_DIR_SUPPORTS_CREATE) == 0) throw new IOException("The folder is not writable");
            return cursor.getString(0);
        }
    }

    static String filename(String name) {
        String safe = name.replaceAll("[\\\\/\\p{Cntrl}]", "_").trim();
        return safe.isEmpty() || safe.equals(".") || safe.equals("..") ? "download" : safe;
    }

    static Uri createFile(Context context, Uri directory, String requestedName) throws IOException {
        if (!hasPermission(context, directory)) throw new IOException("Folder access has expired");
        writableDirectory(context, directory);
        String id = DocumentsContract.getTreeDocumentId(directory);
        Uri parent = DocumentsContract.buildDocumentUriUsingTree(directory, id);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(directory, id);
        Set<String> names = new HashSet<>();
        try (var cursor = context.getContentResolver().query(children, new String[]{Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor == null) throw new IOException("Cannot read folder contents");
            while (cursor.moveToNext()) names.add(cursor.getString(0));
        }
        String name = filename(requestedName), unique = name;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name, extension = dot > 0 ? name.substring(dot) : "";
        for (int number = 1; names.contains(unique); number++) unique = stem + " (" + number + ")" + extension;
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.isEmpty() ? "" : extension.substring(1).toLowerCase(Locale.ROOT));
        Uri created = DocumentsContract.createDocument(context.getContentResolver(), parent, mime == null ? "application/octet-stream" : mime, unique);
        if (created == null) throw new IOException("Cannot create the download file");
        return created;
    }
}
