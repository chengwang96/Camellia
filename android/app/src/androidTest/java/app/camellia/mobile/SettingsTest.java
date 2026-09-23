package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import org.json.JSONObject;

public class SettingsTest extends InstrumentationTestCase {
    public void testEnterPreferenceOffersThreeModes() throws Throwable {
        Activity activity = launch("general");
        try {
            ui(() -> {
                assertEquals("send", MobilePreferences.enterMode(activity));
                root(activity).findViewWithTag("preference:enterMode").performClick();
                AlertDialog choice = dialog(activity);
                View panel = choice.getWindow().getDecorView();
                assertNotNull(panel.findViewWithTag("settingsChoice:2"));
                assertNull(panel.findViewWithTag("settingsChoice:3"));
                assertTrue(panel.findViewWithTag("settingsChoice:0").isSelected());
                panel.findViewWithTag("settingsChoiceCancel").performClick();
                assertFalse(choice.isShowing());
                assertEquals("send", MobilePreferences.enterMode(activity));
            });
        } finally { ui(activity::finish); }
    }

    public void testPreferenceSheetsAppearanceAndAccessibility() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        for (String theme : new String[]{"light", "dark"}) {
            MobilePreferences.set(context, "theme", theme); MobilePreferences.set(context, "language", "zh-CN");
            Activity activity = launch("general");
            try {
                for (String key : new String[]{"language", "theme", "enterMode"}) {
                    ui(() -> root(activity).findViewWithTag("preference:" + key).performClick());
                    ui(() -> {
                        AlertDialog sheet = dialog(activity); View decor = sheet.getWindow().getDecorView();
                        View panel = decor.findViewWithTag("settingsChoicePanel"); assertNotNull(panel);
                        assertEquals(new SettingsStyle(activity).background, ((android.graphics.drawable.GradientDrawable) panel.getBackground()).getColor().getDefaultColor());
                        int selected = key.equals("language") ? 1 : key.equals("theme") ? (theme.equals("dark") ? 2 : 1) : 0;
                        View row = decor.findViewWithTag("settingsChoice:" + selected);
                        android.view.accessibility.AccessibilityNodeInfo info = row.createAccessibilityNodeInfo();
                        assertTrue(info.isCheckable()); assertTrue(info.isChecked()); assertTrue(info.isClickable()); info.recycle();
                        assertTrue(panel.getWidth() < activity.getResources().getDisplayMetrics().widthPixels);
                        assertTrue(decor.findViewWithTag("settingsChoiceCancel").getHeight() >= Math.round(48 * activity.getResources().getDisplayMetrics().density));
                    });
                    capture(activity, "settings-choice-" + key + "-" + theme);
                    ui(() -> dialog(activity).cancel());
                }
            } finally { ui(activity::finish); }
        }
    }

    public void testChoiceSheetSelectsOnceAndCancelDoesNotSelect() throws Throwable {
        Activity activity = launch("general");
        try {
            ui(() -> {
                int[] chosen = {-1};
                SettingsChoiceDialog sheet = new SettingsChoiceDialog(activity, "Enter key", new String[]{"Send", "Newline", "Button only"}, 0, "Cancel", value -> chosen[0] = value);
                sheet.show(); sheet.getWindow().getDecorView().findViewWithTag("settingsChoiceCancel").performClick();
                assertEquals(-1, chosen[0]); assertFalse(sheet.isShowing());
                sheet.show(); sheet.getWindow().getDecorView().findViewWithTag("settingsChoice:0").performClick();
                assertEquals(-1, chosen[0]); assertFalse(sheet.isShowing());
                sheet.show(); sheet.getWindow().getDecorView().findViewWithTag("settingsChoice:2").performClick();
                assertEquals(2, chosen[0]); assertFalse(sheet.isShowing());
            });
        } finally { ui(activity::finish); }
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private").clear();
        getInstrumentation().getTargetContext().getSharedPreferences("mobile-preferences", 0).edit().clear().commit();
    }

    @Override protected void tearDown() throws Exception {
        new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private").clear();
        getInstrumentation().getTargetContext().getSharedPreferences("mobile-preferences", 0).edit().clear().commit();
        super.tearDown();
    }

    public void testManualProviderValidationEditAndClipboardRoundTrip() throws Throwable {
        Activity activity = launch("providers");
        try {
            ui(() -> root(activity).findViewWithTag("providerAdd").performClick());
            ui(() -> {
                AlertDialog dialog = dialog(activity); View form = dialog.getWindow().getDecorView();
                assertEquals(0, dialog.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE);
                field(form, "providerName", "Phone API"); field(form, "providerEndpoint", "http://unsafe.example/v1");
                field(form, "providerKeys", "test-secret\nsecond-secret"); field(form, "providerModels", "phone-model=upstream-model\nother-model");
                EditText keyInput = form.findViewWithTag("providerKeys");
                assertEquals("•••••••••••\n•••••••••••••", keyInput.getTransformationMethod().getTransformation(keyInput.getText(), keyInput).toString());
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertTrue(dialog.isShowing());
                field(form, "providerEndpoint", "https://example.com/v1"); dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                assertFalse(dialog.isShowing());
            });
            LocalChatStore store = new LocalChatStore(activity);
            assertEquals(2, LocalChatConfig.routes(store.config()).size());
            assertEquals("test-secret", LocalChatConfig.routes(store.config()).get(0).key);
            assertEquals("upstream-model", LocalChatConfig.routes(store.config()).get(0).model);
            ui(() -> {
                android.widget.Switch enabled = root(activity).findViewWithTag("providerEnabled:0");
                assertTrue(enabled.isChecked()); enabled.setChecked(false);
            });
            assertTrue(LocalChatConfig.routes(new LocalChatStore(activity).config()).isEmpty());
            ui(() -> ((android.widget.Switch) root(activity).findViewWithTag("providerEnabled:0")).setChecked(true));
            assertEquals(2, LocalChatConfig.routes(new LocalChatStore(activity).config()).size());
            String providerId = store.config().getJSONArray("providers").getJSONObject(0).getString("id");
            ui(() -> root(activity).findViewWithTag("providerEdit:0").performClick());
            ui(() -> {
                AlertDialog dialog = dialog(activity); View form = dialog.getWindow().getDecorView();
                assertEquals(0, dialog.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE);
                assertEquals("", ((EditText) form.findViewWithTag("providerKeys")).getText().toString());
                field(form, "providerName", "Edited API"); dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertFalse(dialog.isShowing());
            });
            store = new LocalChatStore(activity);
            assertEquals(providerId, store.config().getJSONArray("providers").getJSONObject(0).getString("id"));
            assertEquals(2, store.config().getJSONArray("providers").getJSONObject(0).getJSONArray("keys").length());
            ui(() -> root(activity).findViewWithTag("providerEdit:0").performClick());
            ui(() -> {
                AlertDialog edit = dialog(activity);
                ((android.widget.Switch) edit.getWindow().getDecorView().findViewWithTag("providerKeyEnabled:0")).setChecked(false);
                edit.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
            });
            assertEquals("test-secret", LocalChatConfig.routes(new LocalChatStore(activity).config()).get(0).key);
            ui(() -> root(activity).findViewWithTag("providerEdit:0").performClick());
            ui(() -> {
                AlertDialog edit = dialog(activity);
                ((android.widget.Switch) edit.getWindow().getDecorView().findViewWithTag("providerKeyEnabled:0")).setChecked(false);
                edit.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            });
            assertEquals("second-secret", LocalChatConfig.routes(new LocalChatStore(activity).config()).get(0).key);
            ui(() -> root(activity).findViewWithTag("providerEdit:0").performClick());
            ui(() -> {
                AlertDialog edit = dialog(activity);
                android.widget.Switch first = edit.getWindow().getDecorView().findViewWithTag("providerKeyEnabled:0");
                assertFalse(first.isChecked()); first.setChecked(true);
                edit.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            });
            assertEquals("test-secret", LocalChatConfig.routes(new LocalChatStore(activity).config()).get(0).key);
            String[] copied = new String[1];
            ui(() -> root(activity).findViewWithTag("providerExport").performClick());
            ui(() -> dialog(activity).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
            ui(() -> {
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                assertTrue(clipboard.hasPrimaryClip());
                copied[0] = clipboard.getPrimaryClip().getItemAt(0).getText().toString();
                assertTrue(clipboard.getPrimaryClipDescription().getExtras().getBoolean("android.content.extra.IS_SENSITIVE"));
            });
            assertEquals(2, LocalChatConfig.routes(LocalChatConfig.parse(copied[0])).size());
            ui(() -> root(activity).findViewWithTag("providerImport").performClick());
            ui(() -> {
                AlertDialog dialog = dialog(activity); View form = dialog.getWindow().getDecorView();
                field(form, "providerImportText", "bad json"); dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertTrue(dialog.isShowing());
                field(form, "providerImportText", copied[0]); dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertFalse(dialog.isShowing());
            });
            assertEquals("Edited API", new LocalChatStore(activity).config().getJSONArray("providers").getJSONObject(0).getString("name"));
            ui(() -> ((ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText("", "")));
        } finally { ui(activity::finish); }
    }

    public void testProviderScreenshotsMaskKeysAndKeepImportProtectedInBothThemes() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        for (String theme : new String[]{"light", "dark"}) {
            MobilePreferences.set(context, "theme", theme);
            Activity activity = launch("providers");
            try {
                ui(() -> root(activity).findViewWithTag("providerAdd").performClick());
                ui(() -> {
                    AlertDialog sheet = dialog(activity); View form = sheet.getWindow().getDecorView();
                    assertEquals(0, sheet.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE);
                    EditText keys = form.findViewWithTag("providerKeys"); keys.requestFocus();
                    keys.getText().append("secret");
                    CharSequence masked = keys.getTransformationMethod().getTransformation(keys.getText(), keys);
                    assertEquals("••••••", masked.toString());
                    keys.getText().append("7"); assertEquals('•', masked.charAt(masked.length() - 1));
                    keys.clearFocus();
                    SettingsStyle style = new SettingsStyle(activity);
                    for (String tag : new String[]{"providerName", "providerEndpoint", "providerAlternate", "providerKeys", "providerModels"}) {
                        EditText input = form.findViewWithTag(tag);
                        android.graphics.drawable.GradientDrawable fill = (android.graphics.drawable.GradientDrawable) input.getBackground().getCurrent();
                        assertEquals(style.field, fill.getColor().getDefaultColor());
                        assertTrue(style.field != style.background);
                        assertEquals(style.ink, input.getCurrentTextColor());
                    }
                    ((android.view.inputmethod.InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE))
                        .hideSoftInputFromWindow(keys.getWindowToken(), 0);
                });
                capture(activity, "provider-form-" + theme);
                ui(() -> dialog(activity).getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
                ui(() -> root(activity).findViewWithTag("providerImport").performClick());
                ui(() -> {
                    assertTrue((dialog(activity).getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0);
                    dialog(activity).cancel();
                });
            } finally { ui(activity::finish); }
        }
    }

    public void testArchiveHiddenRestoreAndDelete() throws Throwable {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject conversation = store.createConversation("", "missing/model"); String id = conversation.getString("id");
        conversation.put("title", "Archived research"); conversation.put("draft", "Keep this draft"); store.save();
        Activity local = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> root(local).findViewWithTag("localConversation:" + id).performClick());
            ui(() -> root(local).findViewWithTag("localChatMenu").performClick());
            ui(() -> {
                AlertDialog menu = dialog(local);
                menu.getWindow().getDecorView().findViewWithTag("localConversationArchive").performClick();
                assertNull(root(local).findViewWithTag("localConversation:" + id));
            });
        } finally { ui(local::finish); }
        assertTrue(new LocalChatStore(getInstrumentation().getTargetContext()).conversation(id).getBoolean("archived"));
        Activity archived = launch("archived");
        try {
            ui(() -> root(archived).findViewWithTag("archiveRestore:" + id).performClick());
            LocalChatStore restored = new LocalChatStore(archived); assertFalse(restored.conversation(id).getBoolean("archived"));
            assertEquals("Keep this draft", restored.conversation(id).getString("draft"));
        } finally { ui(archived::finish); }
        LocalChatStore next = new LocalChatStore(getInstrumentation().getTargetContext()); next.archiveConversation(id, true);
        Activity deletion = launch("archived");
        try {
            ui(() -> root(deletion).findViewWithTag("archiveDelete:" + id).performClick());
            ui(() -> dialog(deletion).getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
            assertNotNull(new LocalChatStore(deletion).conversation(id));
            ui(() -> root(deletion).findViewWithTag("archiveDelete:" + id).performClick());
            ui(() -> dialog(deletion).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
            assertNull(new LocalChatStore(deletion).conversation(id));
        } finally { ui(deletion::finish); }
    }

    public void testGeneralPreferencesAndHomeSections() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "language", "zh-CN"); MobilePreferences.set(context, "theme", "dark");
        Context configured = MobilePreferences.wrap(context);
        assertEquals("zh", configured.getResources().getConfiguration().getLocales().get(0).getLanguage());
        assertEquals(android.content.res.Configuration.UI_MODE_NIGHT_YES, configured.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK);
        Activity general = launch("general");
        try {
            ui(() -> {
                assertNotNull(root(general).findViewWithTag("preference:language"));
                root(general).findViewWithTag("preference:theme").performClick();
                assertTrue(dialog(general).getWindow().getDecorView().findViewWithTag("settingsChoice:2").isSelected());
                dialog(general).dismiss();
            });
        } finally { ui(general::finish); }
        Activity home = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> {
                View root = root(home); assertNotNull(root.findViewWithTag("localChatEntry")); assertNotNull(root.findViewWithTag("remoteControlEntry"));
                root.findViewWithTag("settingsEntry").performClick();
                assertNotNull(root.findViewWithTag("settings:providers")); assertNotNull(root.findViewWithTag("settings:general")); assertNotNull(root.findViewWithTag("settings:archived"));
                root.findViewWithTag("settings:network").performClick();
                home.onBackPressed(); assertNotNull(root.findViewWithTag("settings:network"));
                home.onBackPressed(); assertNotNull(root.findViewWithTag("localChatEntry"));
            });
        } finally { ui(home::finish); }
    }

    public void testEmptyAndDisabledConfigRoundTrip() throws Exception {
        assertTrue(LocalChatConfig.routes(LocalChatConfig.parse(LocalChatConfig.export(new JSONObject()))).isEmpty());
    }

    public void testHomeVisualLayout() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "language", "zh-CN"); MobilePreferences.set(context, "theme", "light");
        Activity home = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            android.os.SystemClock.sleep(800);
            getInstrumentation().waitForIdleSync();
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new java.io.File(home.getExternalCacheDir(), "mobile-home-light.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
        } finally { ui(home::finish); }
    }

    private Activity launch(String section) {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), SettingsActivity.class)
            .putExtra("section", section).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync(); return activity;
    }

    public void testGroupedSettingsLayoutInBothThemes() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "language", "zh-CN");
        for (String theme : new String[]{"light", "dark"}) {
            MobilePreferences.set(context, "theme", theme);
            Activity activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                ui(() -> root(activity).findViewWithTag("settingsEntry").performClick());
                android.os.SystemClock.sleep(800);
                ui(() -> {
                    View root = root(activity);
                    View providers = root.findViewWithTag("settings:providers"), general = root.findViewWithTag("settings:general");
                    View archived = root.findViewWithTag("settings:archived"), network = root.findViewWithTag("settings:network");
                    assertSame(providers.getParent(), general.getParent()); assertSame(archived.getParent(), network.getParent());
                    assertNotSame(providers.getParent(), archived.getParent());
                    assertEquals(3, ((android.view.ViewGroup) providers.getParent()).getChildCount());
                    assertTrue(providers.isClickable()); assertTrue(providers.isFocusable());
                    assertTrue(providers.getHeight() >= Math.round(64 * activity.getResources().getDisplayMetrics().density));
                    View title = root.findViewWithTag("settingsTitle");
                    android.view.ViewGroup header = (android.view.ViewGroup) title.getParent();
                    assertEquals(header.getWidth() / 2f, title.getLeft() + title.getWidth() / 2f, 1f);
                    assertEquals(Math.round(4 * activity.getResources().getDisplayMetrics().density), root.findViewWithTag("settingsBack").getElevation(), 0f);
                });
                android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
                try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "settings-grouped-" + theme + ".png"))) {
                    screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                } finally { screenshot.recycle(); }
                ui(() -> root(activity).findViewWithTag("settingsBack").performClick());
                ui(() -> assertNotNull(root(activity).findViewWithTag("localChatEntry")));
            } finally { ui(activity::finish); }
        }
    }
    private View root(Activity activity) { return activity.getWindow().getDecorView(); }

    public void testDetailCardsInBothThemes() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "language", "zh-CN");
        JSONObject provider = new JSONObject().put("id", "visual-provider").put("name", "我的 API")
            .put("protocol", "openai").put("baseUrl", "https://example.com/v1")
            .put("keys", new org.json.JSONArray().put(new JSONObject().put("key", "visual-test-key")))
            .put("models", new org.json.JSONArray().put(new JSONObject().put("id", "chat-model").put("upstream", "chat-model")));
        new LocalChatStore(context).importConfig(new JSONObject().put("providers", new org.json.JSONArray().put(provider)));
        for (String theme : new String[]{"light", "dark"}) {
            MobilePreferences.set(context, "theme", theme);
            Activity providers = launch("providers");
            try {
                ui(() -> {
                    View root = root(providers);
                    View toggle = root.findViewWithTag("providerEnabled:0");
                    assertTrue(toggle instanceof android.widget.Switch);
                    assertEquals("settingsGroup", ((View) toggle.getParent().getParent()).getTag());
                    assertSame(root.findViewWithTag("providerEdit:0").getParent(), root.findViewWithTag("providerDelete:0").getParent());
                    assertSame(root.findViewWithTag("providerImport").getParent(), root.findViewWithTag("providerExport").getParent());
                });
                capture(providers, "settings-providers-cards-" + theme);
            } finally { ui(providers::finish); }
            EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
            Activity network = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                ui(() -> { root(network).findViewWithTag("settingsEntry").performClick(); root(network).findViewWithTag("settings:network").performClick(); });
                ui(() -> {
                    android.widget.Switch toggle = root(network).findViewWithTag("networkMode"); assertFalse(toggle.isChecked());
                    assertNotNull(root(network).findViewWithTag("networkLogin")); assertNotNull(root(network).findViewWithTag("networkForget"));
                    assertNotNull(root(network).findViewWithTag("networkLicenses"));
                    root(network).findViewWithTag("networkRefresh").performClick(); assertFalse(EmbeddedNetwork.enabled());
                });
                capture(network, "settings-network-cards-" + theme);
            } finally { ui(network::finish); }
        }
    }

    private void capture(Activity activity, String name) throws Exception {
        android.os.SystemClock.sleep(800); getInstrumentation().waitForIdleSync();
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) {
            screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { screenshot.recycle(); }
    }
    private void field(View form, String tag, String value) { ((EditText) form.findViewWithTag(tag)).setText(value); }
    private AlertDialog dialog(Activity activity) {
        try { var field = activity.getClass().getDeclaredField("dialog"); field.setAccessible(true); return (AlertDialog) field.get(activity); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private void ui(Runnable action) throws Throwable {
        Throwable[] failure = new Throwable[1];
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure[0] = error; } });
        getInstrumentation().waitForIdleSync(); if (failure[0] != null) throw failure[0];
    }
}
