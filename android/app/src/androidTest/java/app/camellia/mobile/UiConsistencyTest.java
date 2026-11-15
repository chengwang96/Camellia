package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.ArrayList;

/** Render actual page/dialog action factories, including their disabled states. */
public class UiConsistencyTest extends InstrumentationTestCase {
    private final ArrayList<Activity> opened = new ArrayList<>();
    private String theme, language;
    private CredentialStore vault;
    private JSONObject saved;
    private boolean embedded;
    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        theme = MobilePreferences.get(context, "theme"); language = MobilePreferences.get(context, "language");
        EmbeddedNetwork.initialize(context); embedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        vault = new CredentialStore(context); saved = vault.load(); vault.save(new JSONObject());
        new ComputerStore(vault).save(new JSONObject().put("address", "http://100.80.1.2:43127").put("token", "a".repeat(43)).put("deviceId", "ui-audit"));
    }
    @Override protected void tearDown() throws Exception {
        finish(); vault.save(saved); EmbeddedNetwork.setEnabled(embedded);
        var context = getInstrumentation().getTargetContext(); MobilePreferences.set(context, "theme", theme); MobilePreferences.set(context, "language", language);
        super.tearDown();
    }
    private void finish() {
        getInstrumentation().runOnMainSync(() -> { for (Activity activity : opened) activity.finish(); });
        getInstrumentation().waitForIdleSync(); opened.clear();
    }
    private Activity open(Class<? extends Activity> type) {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), type)
            .putExtra("address", "http://100.80.1.2:43127").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        opened.add(activity); return activity;
    }
    private Object call(Object target, String name, Class<?>[] types, Object... args) throws Exception {
        var method = target.getClass().getDeclaredMethod(name, types); method.setAccessible(true); return method.invoke(target, args);
    }
    private void preferences(boolean dark) {
        var context = getInstrumentation().getTargetContext(); MobilePreferences.set(context, "theme", dark ? "dark" : "light"); MobilePreferences.set(context, "language", dark ? "en" : "zh-CN");
    }
    public void testActionsMatchAcrossPagesAndDialogsInBothThemes() throws Exception {
        for (boolean dark : new boolean[]{false, true}) {
            preferences(dark);
            Activity remote = open(MainActivity.class), local = open(LocalChatActivity.class), discussion = open(RemoteDiscussionsActivity.class);
            java.util.concurrent.atomic.AtomicReference<Throwable> failed = new java.util.concurrent.atomic.AtomicReference<>();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    Runnable noop = () -> {};
                    TextView remoteSecondary = (TextView) call(remote, "button", new Class<?>[]{String.class, Runnable.class, boolean.class}, "Action", noop, false);
                    TextView remotePrimary = (TextView) call(remote, "button", new Class<?>[]{String.class, Runnable.class, boolean.class}, "Action", noop, true);
                    TextView localSecondary = (TextView) call(local, "button", new Class<?>[]{String.class, String.class, Runnable.class}, "Action", "audit", noop);
                    TextView localPrimary = (TextView) call(local, "dialogAction", new Class<?>[]{String.class, String.class, boolean.class, Runnable.class}, "Action", "audit", true, noop);
                    TextView discussionSecondary = (TextView) call(discussion, "button", new Class<?>[]{String.class, String.class, Runnable.class}, "Action", "audit", noop);
                    TextView settingsSecondary = new SettingsStyle(discussion).secondaryButton("Action", "audit", noop);
                    CamelliaDialog confirm = new CamelliaDialog.Builder(discussion).setPositiveButton("Action", null).setNegativeButton("Action", null).create(); confirm.show();
                    ArtifactSheet artifact = new ArtifactSheet(discussion, "Files", "");
                    try {
                        TextView artifactPrimary = artifact.action("Action", true, noop), artifactSecondary = artifact.action("Action", false, noop);
                        TextView[] secondary = {remoteSecondary, localSecondary, discussionSecondary, settingsSecondary, confirm.getButton(-2), artifactSecondary};
                        TextView[] primary = {remotePrimary, localPrimary, confirm.getButton(-1), artifactPrimary};
                        assertAppearance(secondary, false); assertAppearance(primary, true);
                        android.widget.ImageButton composer = new ChatStyle(discussion).composerAction("Send", android.R.drawable.ic_menu_send, noop);
                        assertTrue(contrast(Palette.of(discussion).accent, composer.getImageTintList().getColorForState(composer.getDrawableState(), 0)) > 4.2);
                        composer.setEnabled(false);
                        assertEquals(Palette.of(discussion).muted, composer.getImageTintList().getColorForState(composer.getDrawableState(), 0));
                        for (TextView button : primary) {
                            int background = fill(button);
                            assertTrue("Primary action text must stay readable in " + (dark ? "dark" : "light"), contrast(background, button.getCurrentTextColor()) > 4.2);
                        }
                    } finally { confirm.dismiss(); artifact.dismiss(); }
                } catch (Throwable error) { failed.set(error); }
            });
            if (failed.get() != null) throw new AssertionError(failed.get());
            finish();
        }
    }
    private void assertAppearance(TextView[] buttons, boolean primary) {
        Integer active = null, disabled = null, activeInk = null, disabledInk = null;
        for (TextView view : buttons) {
            int first = fill(view);
            if (active == null) { active = first; activeInk = view.getCurrentTextColor(); }
            assertEquals("Active fill differs across entry points", active.intValue(), first);
            assertEquals(activeInk.intValue(), view.getCurrentTextColor());
            assertTrue(view.getMinimumHeight() >= Math.round(48 * view.getResources().getDisplayMetrics().density));
            view.setEnabled(false); int second = fill(view);
            if (disabled == null) { disabled = second; disabledInk = view.getCurrentTextColor(); }
            assertEquals("Disabled fill differs across entry points", disabled.intValue(), second);
            assertEquals(disabledInk.intValue(), view.getCurrentTextColor());
            assertFalse(view.createAccessibilityNodeInfo().isEnabled());
            view.setEnabled(true); assertEquals("Restored appearance differs for " + view.getContext().getClass().getSimpleName(), first, fill(view));
        }
        if (primary) assertFalse("Disabled primary actions must lose their accent fill", active.equals(disabled));
    }
    private int fill(TextView view) {
        float density = view.getResources().getDisplayMetrics().density;
        view.measure(View.MeasureSpec.makeMeasureSpec(Math.round(260 * density), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        view.layout(0, 0, view.getMeasuredWidth(), view.getMeasuredHeight());
        Bitmap bitmap = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
        try { view.draw(new Canvas(bitmap)); return bitmap.getPixel(bitmap.getWidth() / 2, Math.round(5 * density)); }
        finally { bitmap.recycle(); }
    }
    private double luminance(int color) {
        double[] channels = {Color.red(color) / 255.0, Color.green(color) / 255.0, Color.blue(color) / 255.0};
        for (int i = 0; i < 3; i++) channels[i] = channels[i] <= .04045 ? channels[i] / 12.92 : Math.pow((channels[i] + .055) / 1.055, 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    }
    private double contrast(int first, int second) { double a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }

    public void testErrorDetailsStayReadableAndLongDialogsStayScrollable() throws Exception {
        for (boolean dark : new boolean[]{false, true}) {
            preferences(dark); Activity activity = open(MainActivity.class);
            CamelliaDialog[] dialog = new CamelliaDialog[1]; String message = "Audit details\n".repeat(500);
            getInstrumentation().runOnMainSync(() -> dialog[0] = ErrorDetails.show(activity, !dark, message));
            getInstrumentation().waitForIdleSync();
            try {
                Bitmap frame = getInstrumentation().getUiAutomation().takeScreenshot();
                try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "audit-error-" + (dark ? "dark" : "light") + ".png"))) {
                    frame.compress(Bitmap.CompressFormat.PNG, 100, output);
                } finally { frame.recycle(); }
                getInstrumentation().runOnMainSync(() -> {
                    TextView details = findText(dialog[0].getWindow().getDecorView(), message);
                    assertNotNull(details); assertEquals(Palette.of(activity).ink, details.getCurrentTextColor());
                    ScrollView scroll = (ScrollView) details.getParent().getParent();
                    assertFalse(scroll.isVerticalScrollBarEnabled()); assertTrue(scroll.canScrollVertically(1));
                    scroll.fullScroll(View.FOCUS_DOWN);
                });
            } finally { getInstrumentation().runOnMainSync(dialog[0]::dismiss); }
            finish();
        }
    }
    private TextView findText(View view, String text) {
        if (view instanceof TextView label && text.contentEquals(label.getText())) return label;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) { TextView found = findText(group.getChildAt(i), text); if (found != null) return found; }
        return null;
    }
}
