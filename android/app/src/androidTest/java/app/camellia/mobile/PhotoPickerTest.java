package app.camellia.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.provider.MediaStore;
import android.test.InstrumentationTestCase;
import java.util.ArrayList;
import java.util.List;

public final class PhotoPickerTest extends InstrumentationTestCase {
    public void testPrefersPhotosWithRemainingAttachmentLimit() {
        ui(() -> {
            RecordingActivity activity = new RecordingActivity();
            PhotoPicker.open(activity, 700, 3);
            assertEquals(1, activity.attempts.size());
            Intent picker = activity.attempts.get(0);
            if (Build.VERSION.SDK_INT >= 33) {
                assertEquals(MediaStore.ACTION_PICK_IMAGES, picker.getAction());
                assertEquals(3, picker.getIntExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 0));
            } else assertGallery(picker, true);
            assertEquals("image/*", picker.getType());
            assertFalse(picker.hasCategory(Intent.CATEGORY_OPENABLE));
        });
    }

    public void testMissingSystemPhotoPickerOpensGallery() {
        ui(() -> {
            RecordingActivity activity = new RecordingActivity(); activity.missingSystemPicker = true;
            PhotoPicker.open(activity, 700, 20);
            assertGallery(activity.last(), true);
            for (Intent attempt : activity.attempts) assertFalse(Intent.ACTION_GET_CONTENT.equals(attempt.getAction()));
        });
    }

    public void testSinglePhotoDoesNotRequestMultipleSelection() {
        ui(() -> {
            RecordingActivity activity = new RecordingActivity();
            PhotoPicker.open(activity, 700, 1);
            assertFalse(activity.last().hasExtra(MediaStore.EXTRA_PICK_IMAGES_MAX));
            assertFalse(activity.last().getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
            activity = new RecordingActivity(); activity.missingSystemPicker = true;
            PhotoPicker.open(activity, 700, 1);
            assertGallery(activity.last(), false);
        });
    }

    public void testNoGalleryFallsBackToImageFiles() {
        ui(() -> {
            RecordingActivity activity = new RecordingActivity(); activity.missingSystemPicker = true; activity.missingGallery = true;
            PhotoPicker.open(activity, 700, 16);
            assertEquals(Intent.ACTION_GET_CONTENT, activity.last().getAction());
            assertEquals("image/*", activity.last().getType());
            assertTrue(activity.last().hasCategory(Intent.CATEGORY_OPENABLE));
            assertTrue(activity.last().getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
            assertEquals(Build.VERSION.SDK_INT >= 33 ? 3 : 2, activity.attempts.size());
            assertGallery(activity.attempts.get(activity.attempts.size() - 2), true);
        });
    }

    public void testSystemSelectionLimitIsRespected() {
        if (Build.VERSION.SDK_INT < 33) return;
        ui(() -> {
            RecordingActivity activity = new RecordingActivity();
            PhotoPicker.open(activity, 700, Integer.MAX_VALUE);
            assertEquals(MediaStore.getPickImagesMaxLimit(), activity.last().getIntExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 0));
        });
    }

    private static void assertGallery(Intent intent, boolean multiple) {
        assertEquals(Intent.ACTION_PICK, intent.getAction());
        assertEquals(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, intent.getData());
        assertEquals("image/*", intent.getType());
        assertFalse(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals(multiple, intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
    }

    private void ui(Runnable action) {
        Throwable[] failure = {null};
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure[0] = error; } });
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }

    private static final class RecordingActivity extends Activity {
        final List<Intent> attempts = new ArrayList<>();
        boolean missingSystemPicker, missingGallery;

        @Override public void startActivityForResult(Intent intent, int request) {
            assertEquals(700, request); attempts.add(intent);
            if (missingSystemPicker && MediaStore.ACTION_PICK_IMAGES.equals(intent.getAction())
                    || missingGallery && Intent.ACTION_PICK.equals(intent.getAction())) throw new ActivityNotFoundException();
        }

        Intent last() { return attempts.get(attempts.size() - 1); }
    }
}
