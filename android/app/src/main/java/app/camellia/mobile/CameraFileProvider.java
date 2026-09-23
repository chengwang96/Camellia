package app.camellia.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

public final class CameraFileProvider extends ContentProvider {
    static Uri uri(android.content.Context context, File file) {
        File directory = new File(context.getCacheDir(), "camera");
        try {
            String root = directory.getCanonicalPath(), path = file.getCanonicalPath();
            if (!path.startsWith(root + File.separator)) throw new IllegalArgumentException("Invalid camera file");
        } catch (java.io.IOException error) { throw new IllegalArgumentException(error); }
        return new Uri.Builder().scheme("content").authority("app.camellia.mobile.camera").appendPath(file.getName()).build();
    }

    private File file(Uri uri) throws FileNotFoundException {
        if (!"app.camellia.mobile.camera".equals(uri.getAuthority()) || uri.getPathSegments().size() != 1) throw new FileNotFoundException();
        File directory = new File(getContext().getCacheDir(), "camera"), file = new File(directory, uri.getLastPathSegment());
        try {
            if (!file.getCanonicalPath().startsWith(directory.getCanonicalPath() + File.separator)) throw new FileNotFoundException();
        } catch (java.io.IOException error) { throw new FileNotFoundException(); }
        return file;
    }

    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File file = file(uri); String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            MatrixCursor cursor = new MatrixCursor(columns); MatrixCursor.RowBuilder row = cursor.newRow();
            for (String column : columns) row.add(column.equals(OpenableColumns.DISPLAY_NAME) ? file.getName() : column.equals(OpenableColumns.SIZE) ? file.length() : null);
            return cursor;
        } catch (FileNotFoundException error) { return null; }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!mode.equals("w") && !mode.equals("wt") && !mode.equals("rw") && !mode.equals("rwt") && !mode.equals("r")) throw new FileNotFoundException();
        int flags = mode.equals("r") ? ParcelFileDescriptor.MODE_READ_ONLY : ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE;
        return ParcelFileDescriptor.open(file(uri), flags);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
