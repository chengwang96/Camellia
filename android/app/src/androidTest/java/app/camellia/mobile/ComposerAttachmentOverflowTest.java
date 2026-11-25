package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.test.InstrumentationTestCase;
import android.test.InstrumentationTestRunner;
import android.util.Base64;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/** Exercise hardware-rendered clipping: child geometry alone misses escaped pixels. */
public final class ComposerAttachmentOverflowTest extends InstrumentationTestCase {
    private static final int PHOTO = Color.rgb(231, 43, 173);
    private Activity activity;
    private String language, theme;

    @Override protected void setUp() throws Exception {
        super.setUp();
        language = MobilePreferences.get(getInstrumentation().getTargetContext(), "language");
        theme = MobilePreferences.get(getInstrumentation().getTargetContext(), "theme");
        var arguments = ((InstrumentationTestRunner) getInstrumentation()).getArguments();
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", arguments.getString("overflowLanguage", "zh-CN"));
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", arguments.getString("overflowTheme", "light"));
        LocalChatFixture.clear(getInstrumentation().getTargetContext());
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) {
            getInstrumentation().runOnMainSync(activity::finish);
            long deadline = android.os.SystemClock.uptimeMillis() + 5000;
            while (!activity.isDestroyed() && android.os.SystemClock.uptimeMillis() < deadline) {
                idle(); Thread.sleep(25);
            }
            assertTrue("Stop draft writes before clearing test storage", activity.isDestroyed());
        }
        LocalChatFixture.clear(getInstrumentation().getTargetContext());
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", language);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", theme);
        super.tearDown();
    }

    public void testLocalPhotosStayInsideComposerWhileScrollingAndRemoving() throws Exception {
        LocalChatFixture store = new LocalChatFixture(getInstrumentation().getTargetContext());
        JSONObject provider = new JSONObject().put("id", "fixture").put("name", "Fixture").put("protocol", "openai")
            .put("baseUrl", "https://example.com/v1")
            .put("keys", new JSONArray().put(new JSONObject().put("key", "fixture-key")))
            .put("models", new JSONArray().put(new JSONObject().put("id", "fixture-model").put("upstream", "fixture-model")));
        store.importConfig(LocalChatConfig.parse(new JSONObject().put("format", "camellia-api-routes").put("version", 2)
            .put("config", new JSONObject().put("providers", new JSONArray().put(provider))).toString()));
        String id = store.createConversation("", LocalChatConfig.routes(store.config()).get(0).id).getString("id");
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
        exercise("local");
    }

    public void testRemotePhotosStayInsideComposerWhileScrollingAndRemoving() throws Exception {
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            set("credentials", new JSONObject());
            set("conversationId", "12345678-1234-1234-1234-123456789abc");
            invoke("detailScreen");
            set("imageConversation", field("conversationId"));
            set("imageComputer", "");
            set("connected", true); set("controlAllowed", true);
        });
        exercise("remote");
    }

    public void testRemoteAttachmentSheetCoversTheConversation() throws Exception {
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            set("credentials", new JSONObject());
            set("conversationId", "12345678-1234-1234-1234-123456789abc");
            invoke("detailScreen");
            set("connected", true); set("controlAllowed", true);
            set("canAttachments", true); set("canConversationAttachments", true);
            invoke("pickImage");
        });
        settle();
        ui(() -> {
            android.app.Dialog dialog = (android.app.Dialog) field("computerDialog");
            try {
                View sheet = dialog.getWindow().getDecorView().findViewWithTag("attachContentScroll");
                assertNotNull(sheet);
                assertTrue("The scrolling viewport must have an opaque sheet surface",
                    sheet.getBackground() instanceof GradientDrawable);
                GradientDrawable surface = (GradientDrawable) sheet.getBackground();
                assertEquals(255, Color.alpha(surface.getColor().getDefaultColor()));
                assertNotNull(sheet.findViewWithTag("imageGallery"));
                assertNotNull(sheet.findViewWithTag("attachConversation"));
                assertNotNull(sheet.findViewWithTag("attachArtifacts"));
            } finally { dialog.dismiss(); }
        });
    }

    @SuppressWarnings("unchecked")
    private void exercise(String mode) throws Exception {
        String image = photo();
        HorizontalScrollView strip = (HorizontalScrollView) field("imageStrip");
        LinearLayout tray = (LinearLayout) field("imageTray");
        View bar = activity.getWindow().getDecorView().findViewWithTag(mode.equals("local") ? "localComposerBar" : "composerBar");
        int[] originalWidth = new int[1];
        ui(() -> originalWidth[0] = bar.getWidth());
        // Five images reproduce the supplied screenshot; twenty exercise the capacity limit.
        int[] trayHeight = new int[1];
        for (int count : new int[] {5, 20}) {
            ui(() -> {
                List<String> images = (List<String>) field("selectedImages");
                images.clear();
                for (int index = 0; index < count; index++) images.add(image);
                invoke(mode.equals("local") ? "renderImages" : "renderImage");
                invoke("updateControls");
                strip.scrollTo(0, 0);
            });
            settle();
            ui(() -> {
                assertEquals("Photos must not widen the editor", originalWidth[0], bar.getWidth());
                assertEquals(count, tray.getChildCount());
                assertTrue("The row must overflow its scroll viewport", tray.getWidth() > strip.getWidth());
                if (count == 5) trayHeight[0] = strip.getHeight();
                else assertEquals("More photos must not add rows", trayHeight[0], strip.getHeight());
            });
            assertPixelsStayInside(strip, mode + "-" + count + "-start");
            ui(() -> strip.scrollTo(tray.getWidth() / 2, 0));
            settle();
            assertPixelsStayInside(strip, mode + "-" + count + "-middle");
            ui(() -> strip.fullScroll(View.FOCUS_RIGHT));
            settle();
            ui(() -> {
                assertTrue("All selected images must be reachable", strip.getScrollX() > 0);
                Rect viewport = bounds(strip);
                Rect last = bounds(tray.getChildAt(tray.getChildCount() - 1));
                assertTrue("The last photo must scroll fully into view", viewport.contains(last));
            });
            assertPixelsStayInside(strip, mode + "-" + count + "-end");
        }
        showKeyboard();
        assertPixelsStayInside(strip, mode + "-keyboard");
        int[] previousScroll = new int[1];
        Rect[] dragArea = new Rect[1];
        ui(() -> { previousScroll[0] = strip.getScrollX(); dragArea[0] = bounds(strip); });
        swipeRight(dragArea[0]);
        settle();
        ui(() -> assertTrue("Photos must still scroll with a real touch gesture while typing", strip.getScrollX() < previousScroll[0]));
        assertPixelsStayInside(strip, mode + "-keyboard-swipe");
        ui(() -> strip.fullScroll(View.FOCUS_RIGHT));
        settle();
        ui(() -> {
            ViewGroup last = (ViewGroup) tray.getChildAt(tray.getChildCount() - 1);
            assertTrue("The last remove button stays usable", last.getChildAt(1).performClick());
        });
        settle();
        ui(() -> assertEquals(19, ((List<?>) field("selectedImages")).size()));
        assertPixelsStayInside(strip, mode + "-removed-last");
        ui(() -> {
            ((List<?>) field("selectedImages")).clear();
            invoke(mode.equals("local") ? "renderImages" : "renderImage");
        });
        settle();
        ui(() -> assertEquals(View.GONE, strip.getVisibility()));
    }

    private void showKeyboard() throws Exception {
        ui(() -> {
            View input = (View) field("composer"); input.requestFocus();
            activity.getSystemService(InputMethodManager.class).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
        });
        boolean[] shown = new boolean[1];
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        do {
            settle();
            ui(() -> {
                View decor = activity.getWindow().getDecorView();
                Rect visible = new Rect(); decor.getWindowVisibleDisplayFrame(visible);
                shown[0] = decor.getResources().getDisplayMetrics().heightPixels - visible.bottom
                    > Math.round(150 * decor.getResources().getDisplayMetrics().density);
                if (shown[0]) assertTrue("The attachment row stays above the keyboard", bounds((View) field("imageStrip")).bottom <= visible.bottom);
            });
        } while (!shown[0] && android.os.SystemClock.uptimeMillis() < deadline);
        assertTrue("Exercise the real IME layout from the reported screenshot", shown[0]);
    }

    private void swipeRight(Rect area) {
        long down = android.os.SystemClock.uptimeMillis();
        float start = area.left + area.width() * .2f;
        float y = area.centerY();
        for (int step = 0; step <= 10; step++) {
            int action = step == 0 ? MotionEvent.ACTION_DOWN : step == 10 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
            MotionEvent event = MotionEvent.obtain(down, down + step * 20, action, start + area.width() * .6f * step / 10, y, 0);
            getInstrumentation().sendPointerSync(event); event.recycle();
        }
    }

    private void assertPixelsStayInside(HorizontalScrollView strip, String name) throws Exception {
        Rect[] viewport = new Rect[1];
        Bitmap screen = RenderedFrameFixture.screenshot(getInstrumentation(), strip);
        ui(() -> viewport[0] = bounds(strip));
        assertNotNull(screen);
        try {
            try (FileOutputStream output = new FileOutputStream(new File(activity.getExternalCacheDir(), "composer-overflow-" + name + ".png"))) {
                screen.compress(Bitmap.CompressFormat.PNG, 100, output);
            }
            int inside = 0, outside = 0;
            Rect allowed = viewport[0];
            for (int y = allowed.top; y < Math.min(allowed.bottom, screen.getHeight()); y++) {
                for (int x = 0; x < screen.getWidth(); x++) {
                    int pixel = screen.getPixel(x, y);
                    if (Math.abs(Color.red(pixel) - Color.red(PHOTO)) > 15
                        || Math.abs(Color.green(pixel) - Color.green(PHOTO)) > 15
                        || Math.abs(Color.blue(pixel) - Color.blue(PHOTO)) > 15) continue;
                    if (allowed.contains(x, y)) inside++; else outside++;
                }
            }
            assertTrue(name + ": the rendered screenshot must contain visible photo pixels inside " + allowed, inside > 100);
            assertEquals(name + ": photo pixels escaped the attachment viewport", 0, outside);
        } finally { screen.recycle(); }
    }

    private String photo() {
        Bitmap bitmap = Bitmap.createBitmap(160, 160, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(PHOTO);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); bitmap.recycle();
        return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
    }

    private Rect bounds(View view) {
        int[] location = new int[2]; view.getLocationOnScreen(location);
        return new Rect(location[0], location[1], location[0] + view.getWidth(), location[1] + view.getHeight());
    }

    private Object field(String name) {
        try { var member = activity.getClass().getDeclaredField(name); member.setAccessible(true); return member.get(activity); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    private void set(String name, Object value) {
        try { var member = activity.getClass().getDeclaredField(name); member.setAccessible(true); member.set(activity, value); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    private void invoke(String name) {
        try { var method = activity.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    private void ui(Runnable action) {
        idle();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try { action.run(); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
        idle();
    }

    private void settle() throws Exception {
        Thread.sleep(350); idle();
    }

    private void idle() { LocalChatFixture.idle(getInstrumentation()); }
}
