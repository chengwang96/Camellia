package app.camellia.mobile;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.test.InstrumentationTestCase;
import android.view.View;
import java.util.ArrayList;

/** Settings categories are siblings even when their content has a different Activity owner. */
public class TabletSettingsNavigationTest extends InstrumentationTestCase {
    private MainActivity main;
    private final ArrayList<Activity> opened = new ArrayList<>();
    private String previousLanguage, previousTheme;

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        previousLanguage = MobilePreferences.get(context, "language"); previousTheme = MobilePreferences.get(context, "theme");
        boolean night = (context.getResources().getConfiguration().uiMode & 48) == 32;
        var arguments = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        MobilePreferences.set(context, "language", arguments.getString("language", "zh-CN")); MobilePreferences.set(context, "theme", night ? "dark" : "light");
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false); new CredentialStore(context).clear();
        NativeActivityCleanup.prepareTabletLandscape(getInstrumentation());
        main = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        opened.add(main);
        ui(() -> main.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        await(() -> MobileLayout.useTabletRail(main.getResources().getConfiguration()), "These regressions require a real tablet window");
        assertTrue("Navigation tests must run with Android animations enabled", android.animation.ValueAnimator.areAnimatorsEnabled());
    }

    @Override protected void tearDown() throws Exception {
        for (int i = opened.size() - 1; i >= 0; i--) {
            Activity activity = opened.get(i);
            NativeActivityCleanup.finish(getInstrumentation(), activity);
        }
        var context = getInstrumentation().getTargetContext(); new CredentialStore(context).clear();
        MobilePreferences.set(context, "language", previousLanguage); MobilePreferences.set(context, "theme", previousTheme);
        super.tearDown();
    }

    public void testUsageAndMobileAccessRoutesSwitchWithoutPageAnimations() throws Exception {
        SettingsActivity settings = open(main, "nav:settings", SettingsActivity.class);
        awaitSection(settings, "general");
        RemoteUsageActivity usage = open(settings, "tabletSettings:usage", RemoteUsageActivity.class);
        awaitSection(usage, "usage"); assertImmediateActivity(usage);
        ui(() -> find(usage, "tabletSettings:providers").performClick());
        awaitSection(settings, "providers"); assertImmediateActivity(settings);
        ui(() -> find(settings, "tabletSettings:network").performClick());
        awaitSection(main, "network");
        SettingsActivity reading = open(main, "tabletSettings:reading", SettingsActivity.class);
        awaitSection(reading, "reading"); assertImmediateActivity(reading);
        ui(() -> find(reading, "tabletSettings:network").performClick());
        awaitSection(main, "network");
        RemoteUsageActivity fromNetwork = open(main, "tabletSettings:usage", RemoteUsageActivity.class);
        awaitSection(fromNetwork, "usage"); assertImmediateActivity(fromNetwork);
        SettingsActivity providers = open(fromNetwork, "tabletSettings:providers", SettingsActivity.class);
        awaitSection(providers, "providers"); assertImmediateActivity(providers);
        assertTaskBounded();
    }

    public void testOrdinarySettingsCategoriesReplaceOnlyTheContent() throws Exception {
        SettingsActivity settings = open(main, "nav:settings", SettingsActivity.class);
        awaitSection(settings, "general");
        for (String section : new String[]{"providers", "reading", "notifications", "deviceName", "downloads", "archived", "about", "general"}) {
            ui(() -> find(settings, "tabletSettings:" + section).performClick());
            awaitSection(settings, section);
            ui(() -> {
                PageTransitions pages = settings.getWindow().getDecorView().findViewWithTag("pageTransitions");
                assertEquals("Category changes must not draw a sliding snapshot", 1, pages.getChildCount());
                assertEquals(0f, pages.getChildAt(0).getTranslationX());
            });
        }
        assertTaskBounded();
    }

    public void testReturningFromUsageReusesSettingsWithoutAccumulatingScreens() throws Exception {
        SettingsActivity settings = open(main, "nav:settings", SettingsActivity.class);
        awaitSection(settings, "general");
        for (String section : new String[]{"providers", "reading", "notifications", "general"}) {
            RemoteUsageActivity usage = open(settings, "tabletSettings:usage", RemoteUsageActivity.class);
            ui(() -> find(usage, "tabletSettings:" + section).performClick());
            awaitSection(settings, section);
            await(usage::isFinishing, "Usage must close when replacing its category content");
            assertFalse("The original Settings owner must be reused", settings.isFinishing());
            assertTaskBounded();
        }
    }

    public void testLocalChatAndItsProviderSettingsShareTheInstantPolicy() throws Exception {
        LocalChatFixture.clear(getInstrumentation().getTargetContext());
        LocalChatActivity local = open(main, "localChatEntry", LocalChatActivity.class); assertImmediateActivity(local);
        await(() -> find(local, "settingsBlockedAction") != null, "Local setup action must be available");
        SettingsActivity settings = open(local, "settingsBlockedAction", SettingsActivity.class);
        awaitSection(settings, "providers"); assertImmediateActivity(settings);
    }

    public void testCategoryScrollPositionSurvivesEveryActivityBoundary() throws Exception {
        SettingsActivity settings = open(main, "nav:settings", SettingsActivity.class); awaitSection(settings, "general");
        android.widget.ScrollView before = (android.widget.ScrollView) find(settings, "tabletSettingsCategoryScroll");
        ui(() -> before.scrollTo(0, 30));
        assertEquals("Run this regression in a compact landscape window with a scrollable category list", 30, before.getScrollY());
        RemoteUsageActivity usage = open(settings, "tabletSettings:usage", RemoteUsageActivity.class);
        awaitScroll(usage, 30);
        ui(() -> ((android.widget.ScrollView) find(usage, "tabletSettingsCategoryScroll")).scrollTo(0, 45));
        ui(() -> find(usage, "tabletSettings:providers").performClick()); awaitSection(settings, "providers"); awaitScroll(settings, 45);
        ui(() -> find(settings, "tabletSettings:network").performClick()); awaitSection(main, "network"); awaitScroll(main, 45);
        SettingsActivity reading = open(main, "tabletSettings:reading", SettingsActivity.class); awaitSection(reading, "reading"); awaitScroll(reading, 45);
    }

    private void awaitScroll(Activity activity, int y) throws Exception {
        await(() -> ((android.widget.ScrollView) find(activity, "tabletSettingsCategoryScroll")).getScrollY() == y,
            "Keep settings category scroll position " + y + " across " + activity.getClass().getSimpleName());
    }

    public void testMobileAccessRotationPreservesItsSettingsOwnerAndLayout() throws Exception {
        SettingsActivity settings = open(main, "nav:settings", SettingsActivity.class); awaitSection(settings, "general");
        ui(() -> find(settings, "tabletSettings:network").performClick()); awaitSection(main, "network");
        var generation = MainActivity.class.getDeclaredField("generation"); generation.setAccessible(true);
        var login = MainActivity.class.getDeclaredField("loginLaunched"); login.setAccessible(true);
        int owner = generation.getInt(main); ui(() -> login.setBoolean(main, true));
        ui(() -> main.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        await(() -> main.getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
            && find(main, "tabletNavigation") == null && find(main, "networkMode") != null, "Portrait must rebuild Mobile access without the wide shell");
        assertNotNull("Mobile access needs a header back button in the single-pane layout", find(main, "settingsBack"));
        assertEquals(owner, generation.getInt(main)); assertTrue(login.getBoolean(main));
        ui(() -> main.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)); awaitSection(main, "network");
        assertNotNull(find(main, "tabletNavigation")); assertEquals(owner, generation.getInt(main)); assertTrue(login.getBoolean(main));
    }

    public void testSettingsEditsAndKeyboardSurviveRotationWithoutSavingOnCancel() throws Exception {
        SettingsActivity settings = open(main, "nav:settings", SettingsActivity.class); awaitSection(settings, "general");
        String originalName = MobilePreferences.deviceName(settings);
        ui(() -> find(settings, "tabletSettings:deviceName").performClick()); awaitSection(settings, "deviceName");
        ui(() -> {
            android.widget.EditText name = (android.widget.EditText) find(settings, "tabletDeviceNameInput");
            android.view.ViewGroup group = (android.view.ViewGroup) find(settings, "settingsGroup");
            int[] field = new int[2], card = new int[2];
            name.getLocationOnScreen(field); group.getLocationOnScreen(card);
            float density = settings.getResources().getDisplayMetrics().density; int margin = Math.round(density);
            assertTrue("The field border must stay inside the card's clipping edge on the left",
                field[0] - card[0] >= margin);
            assertTrue("The field border must stay inside the card's clipping edge on top",
                field[1] - card[1] >= margin);
            assertTrue("The field border must stay inside the card's clipping edge on the right",
                card[0] + group.getWidth() - (field[0] + name.getWidth()) >= margin);
            assertTrue("The field border must stay inside the card's clipping edge on the bottom",
                card[1] + group.getHeight() - (field[1] + name.getHeight()) >= margin);
            name.setText("Unsaved device name"); name.requestFocus(); name.setSelection(2, 5);
            settings.getSystemService(android.view.inputmethod.InputMethodManager.class).showSoftInput(name, 0);
        });
        await(() -> settings.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()), "The inline settings editor must have a visible keyboard");
        ui(() -> settings.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        await(() -> !settings.isDestroyed() && settings.getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
            && find(settings, "tabletDeviceNameInput") != null && find(settings, "tabletDeviceNameInput").hasFocus(), "Keep the settings editor attached through rotation");
        android.widget.EditText name = (android.widget.EditText) find(settings, "tabletDeviceNameInput");
        await(() -> settings.getSystemService(android.view.inputmethod.InputMethodManager.class).isActive(name)
            && settings.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()), "The replacement settings editor must own the keyboard");
        assertEquals("Unsaved device name", name.getText().toString()); assertEquals(2, name.getSelectionStart()); assertEquals(5, name.getSelectionEnd());
        assertEquals("Rotation must not implicitly save the name", originalName, MobilePreferences.deviceName(settings));
        ui(() -> settings.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)); awaitSection(settings, "deviceName");
        ui(() -> find(settings, "tabletSettings:providers").performClick()); awaitSection(settings, "providers");
        String before = new LocalChatFixture(settings).config().toString();
        ui(() -> find(settings, "providerAdd").performClick());
        var field = SettingsActivity.class.getDeclaredField("dialog"); field.setAccessible(true);
        android.app.AlertDialog dialog = (android.app.AlertDialog) field.get(settings); assertNotNull(dialog);
        android.widget.EditText provider = dialog.getWindow().getDecorView().findViewWithTag("providerName");
        ui(() -> { provider.setText("Draft for rotation"); provider.requestFocus(); provider.setSelection(2, 5);
            settings.getSystemService(android.view.inputmethod.InputMethodManager.class).showSoftInput(provider, 0); });
        await(() -> dialog.getWindow().getDecorView().hasWindowFocus()
            && settings.getSystemService(android.view.inputmethod.InputMethodManager.class).isActive(provider)
            && dialog.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()), "Provider editor must own the visible keyboard");
        ui(() -> settings.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        try {
            await(() -> settings.getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
                && dialog.isShowing() && provider.hasFocus() && dialog.getWindow().getDecorView().hasWindowFocus()
                && settings.getSystemService(android.view.inputmethod.InputMethodManager.class).isActive(provider), "An open provider editor must retain its draft and focus");
        } catch (junit.framework.AssertionFailedError error) {
            fail(error.getMessage() + "; orientation=" + settings.getResources().getConfiguration().orientation
                + ", showing=" + dialog.isShowing() + ", focused=" + provider.hasFocus()
                + ", windowFocus=" + dialog.getWindow().getDecorView().hasWindowFocus()
                + ", imeActive=" + settings.getSystemService(android.view.inputmethod.InputMethodManager.class).isActive(provider)
                + ", destroyed=" + settings.isDestroyed());
        }
        assertEquals("Draft for rotation", provider.getText().toString()); assertEquals(2, provider.getSelectionStart()); assertEquals(5, provider.getSelectionEnd());
        RenderedFrameFixture.awaitFrames(getInstrumentation(), dialog.getWindow().getDecorView());
        InputDeliveryFixture.type(getInstrumentation(), "x");
        assertEquals("Drx for rotation", provider.getText().toString());
        ui(() -> dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).performClick());
        assertEquals(before, new LocalChatFixture(settings).config().toString());
        ui(() -> settings.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)); awaitSection(settings, "providers");
    }

    private <T extends Activity> T open(Activity source, String tag, Class<T> type) throws Exception {
        var monitor = getInstrumentation().addMonitor(type.getName(), null, false);
        try {
            ui(() -> { View action = find(source, tag); assertNotNull(tag, action); action.performClick(); });
            T target = type.cast(monitor.waitForActivityWithTimeout(6000)); assertNotNull("Open " + type.getSimpleName(), target);
            opened.add(target); await(target::hasWindowFocus, "The destination must own the visible window"); return target;
        } finally { getInstrumentation().removeMonitor(monitor); }
    }
    private void awaitSection(Activity activity, String section) throws Exception {
        await(() -> {
            View selected = find(activity, "tabletSettings:" + section);
            return selected != null && selected.isSelected() && activity.hasWindowFocus();
        }, "The existing owner must display " + section);
        assertNotNull("Settings detail must still have a title", find(activity, "settingsTitle"));
        assertNull("The category sidebar replaces the header back button for " + section, find(activity, "settingsBack"));
    }
    private void assertImmediateActivity(Activity activity) {
        assertTrue("Settings category Activities must disable the platform page transition",
            (activity.getIntent().getFlags() & Intent.FLAG_ACTIVITY_NO_ANIMATION) != 0);
        assertTrue("Opening and closing must use the immediate transition policy", activity.getIntent().getBooleanExtra(PageTransitions.MAIN_DESTINATION, false));
    }
    private void assertTaskBounded() {
        for (var task : main.getSystemService(ActivityManager.class).getAppTasks()) {
            var info = task.getTaskInfo();
            if (info.id == main.getTaskId()) {
                assertTrue("Repeated category changes must not accumulate Activities: " + info.numActivities, info.numActivities <= 3);
                return;
            }
        }
        fail("The app task must still exist");
    }
    private View find(Activity activity, String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private interface Step { void run() throws Exception; }
    private interface Check { boolean ready() throws Exception; }
    private void ui(Step step) { getInstrumentation().runOnMainSync(() -> { try { step.run(); } catch (Exception error) { throw new AssertionError(error); } }); getInstrumentation().waitForIdleSync(); }
    private void await(Check check, String message) throws Exception {
        boolean[] ready = {false}; long deadline = android.os.SystemClock.uptimeMillis() + 6000;
        while (!ready[0] && android.os.SystemClock.uptimeMillis() < deadline) {
            ui(() -> ready[0] = check.ready()); if (!ready[0]) android.os.SystemClock.sleep(40);
        }
        assertTrue(message, ready[0]);
    }
}
