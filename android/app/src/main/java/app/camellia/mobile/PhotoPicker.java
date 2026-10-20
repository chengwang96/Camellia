package app.camellia.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.provider.MediaStore;

/** Photos use a media picker before falling back to the document browser. */
final class PhotoPicker {
    private PhotoPicker() {}

    static void open(Activity activity, int request, int maxImages) {
        int limit = Math.max(1, maxImages);
        if (Build.VERSION.SDK_INT >= 33) {
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
            if (limit > 1) picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, Math.min(limit, MediaStore.getPickImagesMaxLimit()));
            try { activity.startActivityForResult(picker, request); return; }
            catch (ActivityNotFoundException unavailable) { /* Some vendor systems omit the platform picker. */ }
        }

        // ACTION_GET_CONTENT commonly opens DocumentsUI on Huawei phones, even
        // with image/*. ACTION_PICK targets the gallery's image collection.
        Intent gallery = new Intent(Intent.ACTION_PICK).setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, limit > 1);
        try { activity.startActivityForResult(gallery, request); return; }
        catch (ActivityNotFoundException unavailable) { /* Devices without a gallery can still choose image files. */ }

        activity.startActivityForResult(new Intent(Intent.ACTION_GET_CONTENT).setType("image/*")
            .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, limit > 1), request);
    }
}
