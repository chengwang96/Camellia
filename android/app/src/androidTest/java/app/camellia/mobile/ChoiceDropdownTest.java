package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

@android.annotation.TargetApi(30)
public class ChoiceDropdownTest extends InstrumentationTestCase {
    private void ui(Runnable action) {
        AtomicReference<Throwable> error = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable failure) { error.set(failure); } });
        if (error.get() != null) throw new AssertionError(error.get());
    }
    private void await(java.util.function.BooleanSupplier condition) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 6000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            var ready = new java.util.concurrent.atomic.AtomicBoolean(); ui(() -> ready.set(condition.getAsBoolean()));
            if (ready.get()) return; Thread.sleep(30);
        }
        fail("Dropdown did not reach the expected window state");
    }
    private void bounds(ChoiceDropdown menu) {
        android.graphics.Rect visible = new android.graphics.Rect(); menu.panel.getWindowVisibleDisplayFrame(visible);
        int[] xy = new int[2]; menu.panel.getLocationOnScreen(xy);
        assertTrue("left", xy[0] >= visible.left); assertTrue("right", xy[0] + menu.panel.getWidth() <= visible.right);
        assertTrue("top", xy[1] >= visible.top); assertTrue("bottom", xy[1] + menu.panel.getHeight() <= visible.bottom);
    }
    public void testChineseDropdownSearchKeepsOriginalIndicesAndSelection() throws Exception { run("zh-CN", "light", false); }
    public void testEnglishDropdownSearchKeyboardAndCancel() throws Exception { run("en", "dark", true); }
    public void testShortMenuFitsItsLabelsAndAnchorRemovalDismissesIt() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), PopupTestActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ChoiceDropdown[] menu = {null}; android.widget.LinearLayout[] page = {null}; View[] anchor = {null};
        try {
            ui(() -> {
                page[0] = new android.widget.LinearLayout(activity); page[0].setOrientation(android.widget.LinearLayout.VERTICAL);
                android.widget.TextView button = new android.widget.TextView(activity); button.setText("Wide selector"); button.setMinHeight(120);
                anchor[0] = button; page[0].addView(button, new android.widget.LinearLayout.LayoutParams(-1, -2)); activity.setContentView(page[0]);
            });
            getInstrumentation().waitForIdleSync();
            for (int i = 0; i < 5; i++) {
                ui(() -> menu[0] = new ChoiceDropdown(anchor[0], "Short choices", new String[]{"One", "Two"}, 0, false, index -> {}));
                await(() -> menu[0].panel.hasWindowFocus());
                ui(() -> {
                    bounds(menu[0]); assertTrue("Short options must not fill a full-width selector", menu[0].panel.getWidth() < anchor[0].getWidth());
                    page[0].removeView(anchor[0]); assertFalse(menu[0].isShowing());
                    page[0].addView(anchor[0], new android.widget.LinearLayout.LayoutParams(-1, -2));
                });
                getInstrumentation().waitForIdleSync();
            }
            ui(() -> {
                AtomicInteger actions = new AtomicInteger(); String full = "A long action label that must remain available when it is truncated";
                ConversationMenu actionsMenu = new ConversationMenu(anchor[0], new ChatStyle(activity), new String[]{full}, new String[]{"edit"}, new Runnable[]{actions::incrementAndGet});
                android.widget.TextView row = actionsMenu.panel.findViewWithTag("conversationAction:edit");
                assertEquals(full, row.getTooltipText()); assertEquals(1, row.getMaxLines());
                row.performClick(); assertEquals(1, actions.get()); assertFalse(actionsMenu.isShowing());
            });
        } finally { if (menu[0] != null) ui(menu[0]::dismiss); ui(activity::finish); }
    }
    private void run(String language, String theme, boolean keyboard) throws Exception {
        Context context = getInstrumentation().getTargetContext();
        String oldLanguage = MobilePreferences.get(context, "language"), oldTheme = MobilePreferences.get(context, "theme");
        int oldIme = android.provider.Settings.Secure.getInt(context.getContentResolver(), "show_ime_with_hard_keyboard", 0);
        Activity activity = null; ChoiceDropdown[] menu = {null};
        try {
            MobilePreferences.set(context, "language", language); MobilePreferences.set(context, "theme", theme);
            activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, SettingsActivity.class).putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            Activity current = activity; AtomicInteger selected = new AtomicInteger(-1), selections = new AtomicInteger();
            String[] labels = new String[24];
            for (int i = 0; i < labels.length; i++) labels[i] = "Provider / account / upstream-" + i + " with a long model label";
            ui(() -> menu[0] = new ChoiceDropdown(current.getWindow().getDecorView().findViewWithTag("preference:language"), "Models", labels, 5, true,
                index -> { selected.set(index); selections.incrementAndGet(); }));
            await(() -> menu[0].panel.hasWindowFocus());
            ui(() -> {
                bounds(menu[0]); assertTrue(menu[0].panel.findViewWithTag("dropdownChoice:5").isSelected());
                android.widget.ScrollView scroll = menu[0].panel.findViewWithTag("dropdownScroll"); assertTrue(scroll.canScrollVertically(1));
                EditText search = menu[0].panel.findViewWithTag("dropdownSearch"); search.setText("no-such-model");
                assertNotNull(menu[0].panel.findViewWithTag("dropdownEmpty")); assertNull(menu[0].panel.findViewWithTag("dropdownChoice:0"));
                search.setText("UPSTREAM-17");
                assertNotNull(menu[0].panel.findViewWithTag("dropdownChoice:17")); assertNull(menu[0].panel.findViewWithTag("dropdownChoice:0"));
            });
            getInstrumentation().waitForIdleSync();
            ui(() -> assertTrue("A single search result must shrink the menu", menu[0].panel.getHeight() <= Math.round(200 * context.getResources().getDisplayMetrics().density)));
            if (keyboard) {
                try (var descriptor = getInstrumentation().getUiAutomation().executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")) {}
                ui(() -> {
                    EditText search = menu[0].panel.findViewWithTag("dropdownSearch"); search.requestFocus();
                    ((android.view.inputmethod.InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(search, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                });
                await(() -> menu[0].panel.getRootWindowInsets() != null && menu[0].panel.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
                Thread.sleep(300); // Let the IME's surface animation settle before checking and capturing it.
                getInstrumentation().waitForIdleSync(); ui(() -> bounds(menu[0]));
            }
            getInstrumentation().waitForIdleSync();
            var bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var out = new java.io.FileOutputStream(new java.io.File(current.getExternalFilesDir(null), "choice-dropdown-search-" + language + ".png"))) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out); }
            bitmap.recycle();
            ui(() -> menu[0].panel.findViewWithTag("dropdownChoice:17").performClick());
            assertEquals(17, selected.get()); assertEquals(1, selections.get()); assertFalse(menu[0].isShowing());
            ui(() -> menu[0] = new ChoiceDropdown(current.getWindow().getDecorView().findViewWithTag("preference:language"), "Models", labels, 5, false,
                index -> selections.incrementAndGet()));
            await(() -> menu[0].panel.hasWindowFocus());
            ui(() -> menu[0].panel.findViewWithTag("dropdownChoice:5").performClick());
            assertEquals("Reselecting the current choice does not apply twice", 1, selections.get());
            ui(() -> menu[0] = new ChoiceDropdown(current.getWindow().getDecorView().findViewWithTag("preference:language"), "Models", labels, 5, false,
                index -> selections.incrementAndGet()));
            await(() -> menu[0].panel.hasWindowFocus());
            getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            await(() -> !menu[0].isShowing()); assertEquals("Cancel does not select", 1, selections.get());
        } finally {
            if (menu[0] != null) ui(menu[0]::dismiss);
            if (activity != null) { Activity current = activity; ui(current::finish); }
            try (var descriptor = getInstrumentation().getUiAutomation().executeShellCommand("settings put secure show_ime_with_hard_keyboard " + oldIme)) {}
            MobilePreferences.set(context, "language", oldLanguage); MobilePreferences.set(context, "theme", oldTheme);
        }
    }
}
