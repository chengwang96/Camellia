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
        Inspection inspection = inspectDestination(context, entry.destination);
        String name = entry.name == null ? "" : entry.name;
        long size = entry.size;
        if (inspection.name != null && !inspection.name.trim().isEmpty()) name = inspection.name;
        if (inspection.size >= 0) size = inspection.size;
        if (name.trim().isEmpty()) name = "download";
        return new DownloadedArtifact(entry, name, size, inspection.available, inspection.missing);
    }

    static final class Inspection {
        final boolean available;
        final boolean missing;
        final String name;
        final long size;

        Inspection(boolean available, boolean missing, String name, long size) {
            this.available = available;
            this.missing = missing;
            this.name = name;
            this.size = size;
        }
    }

    /**
     * Checks that a downloaded document still exists and can be read.
     *
     * A history entry only records that a write completed once. The user can
     * remove the file in the system file manager without notifying Camellia,
     * so an "Open" action must inspect the provider instead of trusting the
     * record. Revoked access also hides "Open"; the record stays removable.
     */
    static Inspection inspectDestination(Context context, Uri uri) {
        if (context == null || uri == null) return new Inspection(false, false, null, -1);
        ContentResolver resolver = context.getContentResolver();
        String name = null;
        long size = -1;
        Cursor cursor = null;
        try {
            cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
                null, null, null);
            if (cursor == null) {
                try (var descriptor = resolver.openAssetFileDescriptor(uri, "r")) {
                    boolean available = descriptor != null;
                    return new Inspection(available, !available, null, -1);
                } catch (java.io.IOException error) {
                    return new Inspection(false, false, null, -1);
                }
            }
            if (!cursor.moveToFirst()) return new Inspection(false, true, null, -1);
            int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
            int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
            if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn);
            if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn);
            return new Inspection(true, false, name, size);
        } catch (SecurityException error) {
            return new Inspection(false, false, name, size);
        } catch (RuntimeException error) {
            try (var descriptor = resolver.openAssetFileDescriptor(uri, "r")) {
                boolean available = descriptor != null;
                return new Inspection(available, !available, name, size);
            } catch (FileNotFoundException missing) {
                return new Inspection(false, true, name, size);
            } catch (SecurityException denied) {
                return new Inspection(false, false, name, size);
            } catch (Exception ignored) {
                return new Inspection(false, false, name, size);
            }
        } finally {
            if (cursor != null) cursor.close();
        }
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
