package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.PowerManager;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;

public class PopupPowerSaveTest extends InstrumentationTestCase {
    private Activity activity;
    private LinearLayout page;
    private View anchor;
    private Runnable dismiss;

    @Override protected void setUp() throws Exception {
        super.setUp();
        assertTrue("Power saver tests require a disposable emulator",
            android.os.Build.HARDWARE.equals("ranchu") || android.os.Build.HARDWARE.equals("goldfish"));
        shell("dumpsys battery unplug");
        powerSave(false);
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), PopupTestActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            page = new LinearLayout(activity); page.setOrientation(LinearLayout.VERTICAL); page.setBackgroundColor(Color.BLUE);
            TextView content = new TextView(activity); content.setTextSize(22);
            content.setText("Background text must disappear in power saver.\n".repeat(20));
            page.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
            TextView button = new TextView(activity); button.setText("Open menu"); button.setPadding(16, 16, 16, 16);
            anchor = button; page.addView(anchor); activity.setContentView(page);
        });
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (activity != null) ui(() -> { if (dismiss != null) dismiss.run(); activity.finish(); });
            powerSave(false);
            shell("dumpsys battery reset");
        } finally { super.tearDown(); }
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().waitForIdleSync();
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        getInstrumentation().waitForIdleSync();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private void shell(String command) throws Exception {
        try (var output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
                getInstrumentation().getUiAutomation().executeShellCommand(command))) { while (output.read() != -1) {} }
    }

    private void powerSave(boolean enabled) throws Exception {
        shell("cmd power set-mode " + (enabled ? "1" : "0"));
        PowerManager power = getInstrumentation().getTargetContext().getSystemService(PowerManager.class);
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (power.isPowerSaveMode() != enabled && android.os.SystemClock.uptimeMillis() < deadline) Thread.sleep(25);
        assertEquals("Emulator must apply the requested power mode", enabled, power.isPowerSaveMode());
        getInstrumentation().waitForIdleSync();
    }

    private Object field(Object object, String name) throws Exception {
        var field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object);
    }

    private void awaitBackdrop(PopupSurface surface, boolean visible) throws Exception {
        java.util.concurrent.atomic.AtomicBoolean ready = new java.util.concurrent.atomic.AtomicBoolean();
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        do {
            ui(() -> ready.set((surface.findViewWithTag("glassBackdrop") != null) == visible));
            if (ready.get()) return;
            Thread.sleep(25);
        } while (android.os.SystemClock.uptimeMillis() < deadline);
        fail("Open menu must follow the system power mode");
    }

    private PopupSurface open(String kind) throws Exception {
        java.util.concurrent.atomic.AtomicReference<PopupSurface> result = new java.util.concurrent.atomic.AtomicReference<>();
        ui(() -> {
            Runnable noop = () -> {};
            if (kind.equals("conversation")) {
                ConversationMenu menu = new ConversationMenu(anchor, new ChatStyle(activity), false, false, noop, noop, noop, noop, noop);
                result.set(menu.panel); dismiss = menu::dismiss;
            } else if (kind.equals("computer")) {
                ComputerPickerPopup menu = new ComputerPickerPopup(anchor, new ChatStyle(activity), false,
                    Collections.singletonList(new ComputerPickerPopup.Entry("host", "Computer", "Connected", true, noop)), noop, noop);
                result.set(menu.panel); dismiss = menu::dismiss;
            } else if (kind.equals("remote-model")) {
                JSONObject settings = new JSONObject().put("model", "test").put("thinking", "high")
                    .put("models", new JSONArray().put(new JSONObject().put("id", "test").put("thinking", new JSONArray().put("high"))));
                RemoteSettingsPopup menu = new RemoteSettingsPopup(activity, false, Color.WHITE, Color.BLACK, Color.GRAY, Color.BLUE,
                    settings, (key, value) -> {});
                menu.show(anchor, false); result.set((PopupSurface) field(menu, "surface")); dismiss = menu::dismiss;
            } else {
                ModelPickerPopup menu = new ModelPickerPopup(activity, false, Color.WHITE, Color.LTGRAY, Color.BLACK, Color.GRAY, Color.BLUE,
                    Collections.emptyList(), null, "auto", new ModelPickerPopup.Listener() {
                        public void onModel(LocalChatConfig.Route route) {}
                        public void onThinking(String value) {}
                        public void onImport() {}
                    });
                menu.show(anchor); result.set((PopupSurface) field(menu, "modelSurface")); dismiss = menu::dismiss;
            }
        });
        return result.get();
    }

    private void assertSolid(PopupSurface surface, int color) throws Exception {
        assertNull(surface.findViewWithTag("glassBackdrop"));
        assertNull(surface.findViewWithTag("glassTint"));
        for (String name : new String[] {"snapshot", "scratch", "sourceObserver", "refresh"}) assertNull(name, field(surface, name));
        assertEquals(color, ((GradientDrawable) surface.getBackground()).getColor().getDefaultColor());
        Bitmap pixels = Bitmap.createBitmap(surface.getWidth(), surface.getHeight(), Bitmap.Config.ARGB_8888);
        try {
            surface.draw(new Canvas(pixels));
            int inset = Math.round(3 * activity.getResources().getDisplayMetrics().density);
            assertEquals("Menu must paint an opaque surface", color, pixels.getPixel(pixels.getWidth() / 2, inset));
        } finally { pixels.recycle(); }
    }

    private void screenshot(String name) throws Exception {
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { image.recycle(); }
    }

    public void testMenusUseSolidBackgroundWhenOpenedInPowerSaver() throws Exception {
        powerSave(true);
        for (String kind : new String[] {"conversation", "computer", "remote-model", "local-model"}) {
            PopupSurface surface = open(kind);
            ui(() -> assertSolid(surface, Color.WHITE));
            screenshot("power-save-" + kind);
            ui(() -> { page.setBackgroundColor(Color.GREEN); assertSolid(surface, Color.WHITE); dismiss.run(); });
        }
    }

    public void testOpenMenusFollowPowerModeAndReleaseTheirResources() throws Exception {
        for (String kind : new String[] {"conversation", "computer", "remote-model", "local-model"}) {
            PopupSurface surface = open(kind);
            Bitmap previous = (Bitmap) field(surface, "snapshot"); assertNotNull(previous);
            Bitmap scratch = (Bitmap) field(surface, "scratch");
            powerSave(true);
            awaitBackdrop(surface, false);
            ui(() -> {
                assertSolid(surface, Color.WHITE); assertTrue(previous.isRecycled());
                if (scratch != null) assertTrue(scratch.isRecycled());
            });
            powerSave(false);
            awaitBackdrop(surface, true);
            ui(() -> {
                assertNotNull(surface.findViewWithTag("glassBackdrop")); assertNotNull(field(surface, "snapshot"));
                assertNotSame(previous, field(surface, "snapshot")); assertNotNull(field(surface, "sourceObserver"));
                dismiss.run();
            });
            ui(() -> {
                assertNull(field(surface, "powerReceiver")); assertNull(field(surface, "snapshot"));
                assertNull(field(surface, "scratch")); assertNull(field(surface, "sourceObserver"));
            });
        }
    }

    public void testSwitchBeforeAttachStopsSoftwareFallbackAndForcesOpaqueColor() throws Exception {
        java.util.concurrent.atomic.AtomicReference<PopupSurface> result = new java.util.concurrent.atomic.AtomicReference<>();
        ui(() -> {
            View source = new View(activity); source.setBackgroundColor(Color.BLUE); source.layout(0, 0, 200, 200);
            assertFalse(source.isHardwareAccelerated());
            PopupSurface surface = new PopupSurface(activity, 0x33515151);
            surface.capture(source, 0, 0, 200, 200); result.set(surface);
            assertNotNull(field(surface, "scratch"));
        });
        PopupSurface surface = result.get(); Bitmap previous = (Bitmap) field(surface, "snapshot");
        powerSave(true);
        ui(() -> {
            PopupWindow popup = new PopupWindow(surface, 200, 200, true);
            dismiss = popup::dismiss; popup.showAtLocation(anchor, Gravity.CENTER, 0, 0);
        });
        ui(() -> { assertSolid(surface, 0xff515151); assertTrue(previous.isRecycled()); });
    }
}
