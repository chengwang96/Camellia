package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.widget.LinearLayout;

public class InlineImageGalleryTest extends InstrumentationTestCase {
    private Activity start() {
        return getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    public void testGalleryUsesFullScreenAndFlingChangesConversationImages() throws Exception {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    LinearLayout root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL);
                    Bitmap first = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888); first.eraseColor(Color.RED);
                    Bitmap second = Bitmap.createBitmap(50, 100, Bitmap.Config.ARGB_8888); second.eraseColor(Color.GREEN);
                    InlineImageView one = image(activity, "First", "first.png", first), two = image(activity, "Second", "second.png", second);
                    root.addView(one); root.addView(two); activity.setContentView(root);
                    assertTrue(two.performClick());
                    InlineImageGallery.GalleryView gallery = active();
                    assertNotNull(gallery); assertTrue(gallery.dialog.isShowing()); assertEquals(2, gallery.images.size()); assertEquals(1, gallery.position);
                    assertEquals("2 / 2", gallery.counter.getText().toString());
                    assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, gallery.dialog.getWindow().getAttributes().width);
                    assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, gallery.dialog.getWindow().getAttributes().height);
                    assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, gallery.image.getLayoutParams().width);
                    assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, gallery.image.getLayoutParams().height);
                    assertEquals(android.widget.ImageView.ScaleType.FIT_CENTER, gallery.image.getScaleType());
                    int width = activity.getResources().getDisplayMetrics().widthPixels, height = activity.getResources().getDisplayMetrics().heightPixels;
                    gallery.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY));
                    gallery.layout(0, 0, width, height);
                    assertEquals(width, gallery.image.getWidth()); assertEquals(height, gallery.image.getHeight());
                    assertTrue(gallery.share.isEnabled()); assertTrue(gallery.save.isEnabled());
                    long now = android.os.SystemClock.uptimeMillis();
                    MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 100, 400, 0);
                    MotionEvent right = MotionEvent.obtain(now, now + 100, MotionEvent.ACTION_UP, 500, 410, 0);
                    assertTrue(gallery.fling(down, right));
                    assertEquals(0, gallery.position); assertEquals("1 / 2", gallery.counter.getText().toString());
                    MotionEvent left = MotionEvent.obtain(now + 200, now + 300, MotionEvent.ACTION_UP, 100, 410, 0);
                    assertTrue(gallery.fling(right, left));
                    assertEquals(1, gallery.position); assertEquals("2 / 2", gallery.counter.getText().toString());
                    down.recycle(); left.recycle(); right.recycle();
                    gallery.dialog.dismiss();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            assertNull(active());
        } finally {
            getInstrumentation().runOnMainSync(() -> {
                try { InlineImageGallery.GalleryView gallery = active(); if (gallery != null) gallery.dialog.dismiss(); }
                catch (Exception ignored) { }
                activity.finish();
            });
        }
    }

    public void testGalleryControlsRespectDisplayCutoutInsets() throws Exception {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    LinearLayout root = new LinearLayout(activity);
                    InlineImageView image = image(activity, "Only", "only.png", Bitmap.createBitmap(80, 80, Bitmap.Config.ARGB_8888));
                    root.addView(image); activity.setContentView(root); assertTrue(image.performClick());
                    InlineImageGallery.GalleryView gallery = active(); assertNotNull(gallery);
                    float density = activity.getResources().getDisplayMetrics().density;
                    gallery.applySafeInsets(120, 80);
                    assertEquals(120 + Math.round(8 * density), gallery.top.getPaddingTop());
                    assertEquals(80 + Math.round(16 * density), gallery.bottom.getPaddingBottom());
                    assertEquals(120 + Math.round(64 * density), gallery.image.getPaddingTop());
                    assertEquals(80 + Math.round(80 * density), gallery.image.getPaddingBottom());
                    gallery.dialog.dismiss();
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testGalleryDragTracksFingerBeforeCommittingOrRebounding() throws Exception {
        Activity activity = start();
        AtomicGallery galleryRef = new AtomicGallery();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    LinearLayout root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL);
                    Bitmap first = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888); first.eraseColor(Color.RED);
                    Bitmap second = Bitmap.createBitmap(50, 100, Bitmap.Config.ARGB_8888); second.eraseColor(Color.GREEN);
                    InlineImageView one = image(activity, "First", "first.png", first), two = image(activity, "Second", "second.png", second);
                    root.addView(one); root.addView(two); activity.setContentView(root); assertTrue(one.performClick());
                    InlineImageGallery.GalleryView gallery = active(); galleryRef.value = gallery;
                    int width = activity.getResources().getDisplayMetrics().widthPixels, height = activity.getResources().getDisplayMetrics().heightPixels;
                    gallery.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY));
                    gallery.layout(0, 0, width, height);
                    gallery.beginDrag(400, 400); gallery.dragTo(300, 400);
                    assertTrue(gallery.dragging); assertEquals(-100f, gallery.image.getTranslationX(), .01f);
                    assertEquals(width - 100f, gallery.incoming.getTranslationX(), .01f);
                    gallery.dragTo(-400, 400);
                    assertEquals(-800f, gallery.image.getTranslationX(), .01f);
                    assertEquals(width - 800f, gallery.incoming.getTranslationX(), .01f);
                    gallery.releaseDrag(-400);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            await(() -> galleryRef.value.position == 1 && !galleryRef.value.settling);
            getInstrumentation().runOnMainSync(() -> {
                InlineImageGallery.GalleryView gallery = galleryRef.value;
                assertEquals(1, gallery.position); assertEquals("2 / 2", gallery.counter.getText().toString());
                assertEquals(0f, gallery.image.getTranslationX(), .01f); assertEquals(android.view.View.GONE, gallery.incoming.getVisibility());
                gallery.beginDrag(100, 400); gallery.dragTo(180, 400);
                assertTrue(gallery.dragging); assertEquals(80f, gallery.image.getTranslationX(), .01f);
                assertEquals(80f - gallery.getWidth(), gallery.incoming.getTranslationX(), .01f);
                gallery.releaseDrag(180);
            });
            await(() -> galleryRef.value.position == 1 && !galleryRef.value.settling);
            getInstrumentation().runOnMainSync(() -> {
                assertEquals(1, galleryRef.value.position); galleryRef.value.dialog.dismiss();
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private static final class AtomicGallery {
        InlineImageGallery.GalleryView value;
    }

    public void testGalleryDragUsesRawCoordinatesAndLowerCommitThreshold() throws Exception {
        Activity activity = start(); AtomicGallery galleryRef = new AtomicGallery();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    LinearLayout root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL);
                    InlineImageView one = image(activity, "First", "first.png", Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888));
                    InlineImageView two = image(activity, "Second", "second.png", Bitmap.createBitmap(50, 100, Bitmap.Config.ARGB_8888));
                    root.addView(one); root.addView(two); activity.setContentView(root); assertTrue(one.performClick());
                    InlineImageGallery.GalleryView gallery = active(); galleryRef.value = gallery;
                    int width = activity.getResources().getDisplayMetrics().widthPixels, height = activity.getResources().getDisplayMetrics().heightPixels;
                    gallery.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY));
                    gallery.layout(0, 0, width, height);
                    long now = android.os.SystemClock.uptimeMillis();
                    MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 400, 400, 0);
                    down.offsetLocation(100, 0);
                    assertEquals(400f, down.getRawX(), .01f); assertEquals(500f, down.getX(), .01f);
                    gallery.image.dispatchTouchEvent(down);
                    MotionEvent move = MotionEvent.obtain(now, now + 50, MotionEvent.ACTION_MOVE, 300, 400, 0);
                    move.offsetLocation(100, 0);
                    assertEquals(300f, move.getRawX(), .01f); assertEquals(400f, move.getX(), .01f);
                    gallery.image.dispatchTouchEvent(move);
                    assertEquals(-100f, gallery.image.getTranslationX(), .01f);
                    down.recycle(); move.recycle(); gallery.previous();
                    float start = gallery.getWidth() / 2f, end = start - (gallery.getWidth() / 8f + 8f);
                    gallery.beginDrag(start, 400); gallery.dragTo(end, 400); gallery.releaseDrag(end);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            await(() -> galleryRef.value.position == 1 && !galleryRef.value.settling);
            getInstrumentation().runOnMainSync(() -> {
                assertEquals(1, galleryRef.value.position); galleryRef.value.dialog.dismiss();
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testShareUriExposesReadableJpeg() throws Exception {
        Activity activity = start();
        try {
            Bitmap bitmap = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.BLUE);
            Uri uri = InlineImageGallery.writeShare(activity, bitmap, "Test");
            try {
                assertEquals("content", uri.getScheme()); assertEquals("app.camellia.mobile.camera", uri.getAuthority());
                assertEquals("image/jpeg", activity.getContentResolver().getType(uri));
                try (var input = activity.getContentResolver().openInputStream(uri)) {
                    Bitmap decoded = BitmapFactory.decodeStream(input); assertNotNull(decoded);
                    assertEquals(64, decoded.getWidth()); assertEquals(32, decoded.getHeight());
                }
                try (var cursor = activity.getContentResolver().query(uri, null, null, null, null)) {
                    assertNotNull(cursor); assertTrue(cursor.moveToFirst());
                    assertTrue(cursor.getLong(cursor.getColumnIndexOrThrow(android.provider.OpenableColumns.SIZE)) > 0);
                }
            } finally { new java.io.File(activity.getCacheDir(), "camera/" + uri.getLastPathSegment()).delete(); }
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testSaveToMediaStoreCreatesVisibleImage() throws Exception {
        Activity activity = start();
        if (Build.VERSION.SDK_INT < 29) { getInstrumentation().runOnMainSync(activity::finish); return; }
        Bitmap bitmap = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.MAGENTA);
        Uri uri = InlineImageGallery.writeGallery(activity, bitmap, "Test");
        try {
            assertEquals("content", uri.getScheme());
            try (var cursor = activity.getContentResolver().query(uri, null, null, null, null)) {
                assertNotNull(cursor); assertTrue(cursor.moveToFirst());
                assertEquals("image/jpeg", cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)));
                assertEquals(0, cursor.getInt(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.IS_PENDING)));
                assertTrue(cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)).contains("Camellia"));
            }
            try (var input = activity.getContentResolver().openInputStream(uri)) {
                Bitmap decoded = BitmapFactory.decodeStream(input); assertNotNull(decoded);
                assertEquals(48, decoded.getWidth()); assertEquals(48, decoded.getHeight());
            }
        } finally {
            activity.getContentResolver().delete(uri, null, null);
            getInstrumentation().runOnMainSync(activity::finish);
        }
    }

    private void await(java.util.function.BooleanSupplier condition) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 5000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            boolean[] ready = { false };
            getInstrumentation().runOnMainSync(() -> ready[0] = condition.getAsBoolean());
            if (ready[0]) return;
            Thread.sleep(30);
        }
        fail("Timed out waiting for gallery animation");
    }

    private InlineImageView image(Activity activity, String alt, String path, Bitmap bitmap) {
        return new InlineImageView(activity, alt, path, Color.WHITE, new MarkdownView.ImageLoader() {
            @Override public void load(String reference, MarkdownView.ImageCallback callback) { callback.loaded(bitmap); }
            @Override public void close() { }
        });
    }

    private InlineImageGallery.GalleryView active() throws Exception {
        var field = InlineImageGallery.class.getDeclaredField("active"); field.setAccessible(true);
        return (InlineImageGallery.GalleryView) field.get(null);
    }
}
