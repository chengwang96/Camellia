package app.camellia.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** A completed download with the current state of its destination document. */
final class DownloadedArtifact {
    final String id;
    final String name;
    final Uri uri;
    final long size;
    final long completedAt;
    final boolean available;
    final boolean missing;

    private DownloadedArtifact(ArtifactDownloadHistory.Entry entry, String name, long size,
                               boolean available, boolean missing) {
        id = entry.id;
        this.name = name;
        uri = entry.destination;
        this.size = size;
        completedAt = entry.completedAt;
        this.available = available;
        this.missing = missing;
    }

    static List<DownloadedArtifact> list(Context context) {
        List<DownloadedArtifact> result = new ArrayList<>();
        if (context == null) return result;
        for (ArtifactDownloadHistory.Entry entry : ArtifactDownloadHistory.all(context)) {
            result.add(inspect(context, entry));
        }
        return result;
    }

    static final class DeleteResult {
        final int deleted;
        final int failed;
        final List<String> removed;

        DeleteResult(int deleted, int failed, List<String> removed) {
            this.deleted = deleted;
            this.failed = failed;
            this.removed = Collections.unmodifiableList(new ArrayList<>(removed));
        }
    }

    static DeleteResult delete(Context context, List<DownloadedArtifact> artifacts) {
        List<String> removed = new ArrayList<>();
        int deleted = 0;
        int failed = 0;
        ContentResolver resolver = context.getContentResolver();
        for (DownloadedArtifact artifact : artifacts) {
            if (artifact.missing || deleteDocument(context, resolver, artifact.uri)) {
                removed.add(artifact.id);
                deleted++;
                releasePermission(context, artifact.uri);
            } else {
                failed++;
            }
        }
        ArtifactDownloadHistory.remove(context, removed);
        return new DeleteResult(deleted, failed, removed);
    }

    static void forget(Context context, List<DownloadedArtifact> artifacts) {
        List<String> ids = new ArrayList<>();
        for (DownloadedArtifact artifact : artifacts) ids.add(artifact.id);
        ArtifactDownloadHistory.remove(context, ids);
        for (DownloadedArtifact artifact : artifacts) releasePermission(context, artifact.uri);
    }

    private static DownloadedArtifact inspect(Context context, ArtifactDownloadHistory.Entry entry) {
        ContentResolver resolver = context.getContentResolver();
        String name = entry.name == null ? "" : entry.name;
        long size = entry.size;
        boolean available = false;
        boolean missing = false;
        Cursor cursor = null;
        try {
            cursor = resolver.query(entry.destination, new String[]{
                OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE
            }, null, null, null);
            if (cursor == null) {
                try (var descriptor = resolver.openAssetFileDescriptor(entry.destination, "r")) {
                    available = descriptor != null;
                    missing = !available;
                } catch (FileNotFoundException error) {
                    missing = true;
                } catch (SecurityException error) {
                    // Keep the record available for explicit removal.
                } catch (Exception error) {
                    // The provider cannot describe the document through this page.
                }
            } else if (!cursor.moveToFirst()) {
                missing = true;
            } else {
                available = true;
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameColumn >= 0 && !cursor.isNull(nameColumn)) {
                    String actual = cursor.getString(nameColumn);
                    if (actual != null && !actual.trim().isEmpty()) name = actual;
                }
                if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) {
                    long actual = cursor.getLong(sizeColumn);
                    if (actual >= 0) size = actual;
                }
            }
        } catch (SecurityException ignored) {
            // The provider may have revoked its grant. It is not safe to claim
            // the file is gone, so keep it as an unavailable record.
        } catch (RuntimeException ignored) {
            try (var descriptor = resolver.openAssetFileDescriptor(entry.destination, "r")) {
                available = descriptor != null;
                missing = !available;
            } catch (FileNotFoundException error) {
                missing = true;
            } catch (SecurityException error) {
                // Keep the record and let the reader remove it explicitly.
            } catch (Exception ignoredRead) {
                // A provider that cannot describe or open the document is
                // unavailable to this page, but the record remains manageable.
            }
        } finally {
            if (cursor != null) cursor.close();
        }
        if (name.trim().isEmpty()) name = "download";
        return new DownloadedArtifact(entry, name, size, available, missing);
    }

    private static boolean deleteDocument(Context context, ContentResolver resolver, Uri uri) {
        try {
            if (DocumentsContract.deleteDocument(resolver, uri)) return true;
        } catch (FileNotFoundException ignored) {
            return true;
        } catch (RuntimeException ignored) {
            // Fall through to the provider-neutral delete.
        }
        try {
            return resolver.delete(uri, null, null) > 0;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static void releasePermission(Context context, Uri uri) {
        int both = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        try {
            context.getContentResolver().releasePersistableUriPermission(uri, both);
            return;
        } catch (RuntimeException ignored) { }
        try {
            context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (RuntimeException ignored) { }
        try {
            context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (RuntimeException ignored) { }
    }

}
