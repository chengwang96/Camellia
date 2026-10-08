package app.camellia.mobile.release;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Only packaged in the disposable Release instrumentation APK. */
public class FixtureProvider extends ContentProvider {
    private File document;
    @Override public boolean onCreate() {
        document = new File(getContext().getCacheDir(), "release-fixture.docx");
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(document))) {
            zip.putNextEntry(new ZipEntry("word/document.xml"));
            zip.write(("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
                + "<w:body><w:p><w:r><w:t>Release Office extraction works</w:t></w:r></w:p></w:body></w:document>").getBytes(StandardCharsets.UTF_8));
            zip.closeEntry(); return true;
        } catch (Exception error) { throw new IllegalStateException(error); }
    }
    private void check(Uri uri) { if (!"/document".equals(uri.getPath())) throw new IllegalArgumentException("Unknown fixture"); }
    @Override public String getType(Uri uri) { check(uri); return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        check(uri); String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns); Object[] values = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) values[i] = columns[i].equals(OpenableColumns.DISPLAY_NAME) ? "release-fixture.docx" : document.length();
        cursor.addRow(values); return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        check(uri); if (!mode.equals("r")) throw new FileNotFoundException("Read-only fixture");
        return ParcelFileDescriptor.open(document, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
