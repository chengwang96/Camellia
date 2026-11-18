package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicBoolean;

public class RemoteUsageTest extends InstrumentationTestCase {
    private static final String ADDRESS = "http://100.80.1.2:43127";
    private JSONObject snapshot() throws Exception {
        return new JSONObject("""
            {"version":1,"updatedAt":"2026-11-15T04:00:00.000Z","refreshAvailable":true,
             "accounts":[{"id":"api:a","source":"api","provider":"DeepSeek","label":"Wallet","enabled":true,"supported":true,
                            "updatedAt":"2026-11-15T03:55:00.000Z","balances":[{"currency":"CNY","value":0},{"currency":"USD","value":null}],"windows":[]},
                         {"id":"subscription:b","source":"subscription","provider":"Codex","label":"Personal","enabled":true,"supported":true,
                            "balances":[],"updatedAt":"2026-11-15T03:55:00.000Z","windows":[{"id":"5h","label":"5h","usedPercent":25,"resetsAt":"2026-11-15T08:00:00.000Z"}]}],
             "ranges":{"7":[{"accountId":"api:a","model":"deepseek-model","inputTokens":20,"outputTokens":10,"requests":3},
                                {"accountId":"subscription:b","model":"codex-model","inputTokens":50,"outputTokens":20,"requests":4,"pricedTokens":70,"estimatedCostUsd":0.01}],
                       "all":[{"accountId":"api:a","model":"","requests":10}],"1":[],"30":[]}}
            """);
    }
    private String text(View view) {
        StringBuilder text = new StringBuilder();
        if (view instanceof TextView) text.append(((TextView) view).getText()).append('\n');
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) text.append(text(((ViewGroup) view).getChildAt(i)));
        return text.toString();
    }
    private void screenshot(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        Thread.sleep(200); // Allow the compositor to present the newly built tab.
        var bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), name))) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        bitmap.recycle();
    }
    private void waitFor(Activity activity, String... expected) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 8000;
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            AtomicBoolean found = new AtomicBoolean();
            getInstrumentation().runOnMainSync(() -> { String all = text(activity.getWindow().getDecorView()); for (String value : expected) if (all.contains(value)) found.set(true); });
            if (found.get()) return;
            Thread.sleep(40);
        }
        fail("Did not render " + java.util.Arrays.toString(expected));
    }
    private void choose(Activity activity, String tag, int index) {
        getInstrumentation().runOnMainSync(() -> {
            try {
                activity.getWindow().getDecorView().findViewWithTag(tag).performClick();
                var field = RemoteUsageActivity.class.getDeclaredField("choiceDropdown"); field.setAccessible(true);
                ChoiceDropdown chooser = (ChoiceDropdown) field.get(activity);
                chooser.panel.findViewWithTag("dropdownChoice:" + index).performClick();
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }
    private ComputerPickerPopup computerPicker(Activity activity) {
        try {
            var field = RemoteUsageActivity.class.getDeclaredField("computerPicker"); field.setAccessible(true);
            return (ComputerPickerPopup) field.get(activity);
        } catch (Exception error) { throw new AssertionError(error); }
    }
    private void waitForComputerMenu(Activity activity, boolean open) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            AtomicBoolean ready = new AtomicBoolean();
            getInstrumentation().runOnMainSync(() -> {
                ComputerPickerPopup picker = computerPicker(activity);
                ready.set(open ? picker != null && picker.isShowing() && picker.panel.hasWindowFocus() : picker == null);
            });
            if (ready.get()) return;
            Thread.sleep(25);
        }
        fail(open ? "Dropdown did not receive window focus" : "Dropdown did not close");
    }
    public void testChineseComputerDropdownAnchorsScrollsAndDismisses() throws Exception { runComputerDropdown("zh-CN", "light"); }
    public void testEnglishComputerDropdownAnchorsScrollsAndDismisses() throws Exception { runComputerDropdown("en", "dark"); }
    private void runComputerDropdown(String language, String theme) throws Exception {
        var context = getInstrumentation().getTargetContext(); var vault = new CredentialStore(context);
        var cachedVault = new CredentialStore(context, "remote-account-usage");
        JSONObject original = vault.load(), originalCache = cachedVault.load();
        String oldLanguage = MobilePreferences.get(context, "language"), oldTheme = MobilePreferences.get(context, "theme");
        var factory = RemoteUsageActivity.clientFactory; Activity activity = null;
        String second = "http://100.80.1.3:43127";
        JSONObject oldData = new JSONObject(snapshot().toString().replace("Wallet", "Old Wallet"));
        JSONObject newData = new JSONObject(snapshot().toString().replace("Wallet", "New Wallet"));
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        boolean longList = language.equals("en");
        try {
            MobilePreferences.set(context, "language", language); MobilePreferences.set(context, "theme", theme);
            vault.save(new JSONObject()); cachedVault.save(new JSONObject()); ComputerStore computers = new ComputerStore(vault);
            for (int i = 0; i < (longList ? 16 : 5); i++) computers.save(new JSONObject().put("address", "http://100.80.1." + (i + 2) + ":43127")
                .put("token", "a".repeat(43)).put("computerName", i < 5 ? new String[]{"HP", "ROG", "MacBook", "CUHK", "Mac mini"}[i] : "A very long computer name for dropdown overflow " + i));
            String activeChatAddress = computers.load().optString("address");
            RemoteUsageActivity.clientFactory = address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                    if (path.equals("/v1/status")) try { return new JSONObject().put("capabilities", new org.json.JSONArray().put("account-usage")); } catch (Exception e) { throw new java.io.IOException(e); }
                    reads.incrementAndGet(); return address.equals(second) ? newData : oldData;
                }
            };
            activity = getInstrumentation().startActivitySync(new Intent(context, RemoteUsageActivity.class).putExtra("address", ADDRESS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitFor(activity, "Old Wallet"); Activity current = activity; int initialReads = reads.get();
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageComputer").performClick());
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View anchor = current.getWindow().getDecorView().findViewWithTag("usageComputer");
                ComputerPickerPopup picker = computerPicker(current); assertNotNull(picker); assertTrue(picker.isShowing());
                int[] origin = new int[2], menu = new int[2]; anchor.getLocationOnScreen(origin); picker.panel.getLocationOnScreen(menu);
                int gap = menu[1] - origin[1] - anchor.getHeight();
                assertTrue("Dropdown stays below its anchor", gap >= 0 && gap <= Math.round(12 * context.getResources().getDisplayMetrics().density));
                android.graphics.Rect visible = new android.graphics.Rect(); anchor.getWindowVisibleDisplayFrame(visible);
                assertTrue(menu[0] >= visible.left && menu[0] + picker.panel.getWidth() <= visible.right);
                assertTrue(menu[1] + picker.panel.getHeight() <= visible.bottom);
                assertNull(picker.panel.findViewWithTag("pickerAddComputer")); assertNull(picker.panel.findViewWithTag("pickerManageComputers"));
                assertTrue(picker.panel.findViewWithTag("switchComputer:" + ADDRESS).isSelected());
                assertFalse(picker.panel.findViewWithTag("switchComputer:" + second).isSelected());
                android.widget.ScrollView scroll = picker.panel.findViewWithTag("computerPickerScroll");
                assertEquals("Only long lists need to scroll", longList, scroll.canScrollVertically(1));
                scroll.fullScroll(View.FOCUS_DOWN);
            });
            screenshot("quota-usage-computer-dropdown-long-" + language + ".png");
            getInstrumentation().runOnMainSync(() -> {
                ComputerPickerPopup picker = computerPicker(current);
                android.widget.ScrollView scroll = picker.panel.findViewWithTag("computerPickerScroll"); assertEquals(longList, scroll.getScrollY() > 0);
                picker.panel.findViewWithTag("switchComputer:" + ADDRESS).performClick();
                assertNull(computerPicker(current)); assertFalse(current.getWindow().getDecorView().findViewWithTag("usageComputer").isSelected());
                current.getWindow().getDecorView().findViewWithTag("usageComputer").performClick();
            });
            assertEquals("Reselecting the current device does not refetch", initialReads, reads.get());
            waitForComputerMenu(current, true);
            getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK); waitForComputerMenu(current, false);
            getInstrumentation().runOnMainSync(() -> {
                assertNull(computerPicker(current)); assertFalse(current.isFinishing());
                current.getWindow().getDecorView().findViewWithTag("usageComputer").performClick();
            });
            waitForComputerMenu(current, true);
            int[] outside = new int[2];
            getInstrumentation().runOnMainSync(() -> {
                View header = current.getWindow().getDecorView().findViewWithTag("settingsHeader"); header.getLocationOnScreen(outside);
                outside[0] += header.getWidth() / 2; outside[1] += header.getHeight() / 2;
            });
            long time = android.os.SystemClock.uptimeMillis();
            for (int action : new int[]{android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP}) {
                android.view.MotionEvent event = android.view.MotionEvent.obtain(time, android.os.SystemClock.uptimeMillis(), action, outside[0], outside[1], 0);
                getInstrumentation().getUiAutomation().injectInputEvent(event, true); event.recycle();
            }
            waitForComputerMenu(current, false);
            getInstrumentation().runOnMainSync(() -> {
                assertNull("Outside tap closes the dropdown", computerPicker(current));
                current.getWindow().getDecorView().findViewWithTag("usageComputer").performClick();
                computerPicker(current).panel.findViewWithTag("switchComputer:" + second).performClick();
            });
            waitFor(activity, "New Wallet");
            assertEquals("Usage selection must not switch the active chat", activeChatAddress, computers.load().optString("address"));
            getInstrumentation().runOnMainSync(() -> {
                current.getWindow().getDecorView().findViewWithTag("usageComputer").performClick();
                assertTrue(computerPicker(current).panel.findViewWithTag("switchComputer:" + second).isSelected());
            });
            screenshot("quota-usage-computer-dropdown-" + language + ".png");
            getInstrumentation().runOnMainSync(current::finish); activity = null;
            getInstrumentation().waitForIdleSync();
            assertNull("Leaving the page dismisses its menu", computerPicker(current));
        } finally {
            if (activity != null) { Activity current = activity; getInstrumentation().runOnMainSync(current::finish); }
            getInstrumentation().waitForIdleSync(); RemoteUsageActivity.clientFactory = factory;
            vault.save(original); cachedVault.save(originalCache);
            MobilePreferences.set(context, "language", oldLanguage); MobilePreferences.set(context, "theme", oldTheme);
        }
    }
    public void testChineseUsageReadingsStatisticsOfflineAndRevocation() throws Exception { runScreen("zh-CN", "light"); }
    public void testEnglishDarkUsageReadingsStatisticsOfflineAndRevocation() throws Exception { runScreen("en", "dark"); }
    public void testChineseLargeUsageUsesWanYiAndStyledControls() throws Exception { runLargeUsage("zh-CN", "light"); }
    public void testEnglishLargeUsageUsesCompactUnitsAndStyledControls() throws Exception { runLargeUsage("en", "dark"); }
    private void runLargeUsage(String language, String theme) throws Exception {
        var context = getInstrumentation().getTargetContext();
        var vault = new CredentialStore(context); var cachedVault = new CredentialStore(context, "remote-account-usage");
        JSONObject original = vault.load(), originalCache = cachedVault.load();
        String oldLanguage = MobilePreferences.get(context, "language"), oldTheme = MobilePreferences.get(context, "theme");
        var factory = RemoteUsageActivity.clientFactory; Activity activity = null;
        boolean chinese = language.startsWith("zh");
        JSONObject data = snapshot();
        data.getJSONArray("accounts").getJSONObject(0).getJSONArray("balances").getJSONObject(0).put("value", 12345678.25);
        var rows = new org.json.JSONArray("""
            [{"accountId":"api:a","model":"deepseek-flash","inputTokens":4820772039,"cacheReadTokens":4740982266,
              "outputTokens":12895895,"cacheWriteTokens":0,"requests":14072,"failures":1603,"unreported":1},
             {"accountId":"api:a","model":"deepseek-v4.1-flash:1017","inputTokens":27055375731,"requests":32083,"cancelled":11473}]
            """);
        for (String period : new String[]{"7", "30", "all"}) data.getJSONObject("ranges").put(period, rows);
        try {
            MobilePreferences.set(context, "language", language); MobilePreferences.set(context, "theme", theme);
            vault.save(new JSONObject()); cachedVault.save(new JSONObject());
            new ComputerStore(vault).save(new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43)).put("computerName", "HP"));
            RemoteUsageActivity.clientFactory = address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                    if (path.equals("/v1/status")) try { return new JSONObject().put("capabilities", new org.json.JSONArray().put("account-usage")); } catch (Exception e) { throw new java.io.IOException(e); }
                    return data;
                }
            };
            activity = getInstrumentation().startActivitySync(new Intent(context, RemoteUsageActivity.class).putExtra("address", ADDRESS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitFor(activity, "75%"); Activity current = activity;
            getInstrumentation().runOnMainSync(() -> {
                View root = current.getWindow().getDecorView();
                assertTrue("Money must retain its precision", text(root).contains("12,345,678.25 CNY"));
                root.findViewWithTag("usageTabHistory").performClick();
                TextView total = root.findViewWithTag("usageTotalTokens");
                assertEquals(chinese ? "318.9亿" : "31.9B", total.getText().toString());
                assertTrue(total.getContentDescription().toString().contains("31,889,043,665"));
                assertEquals("31,889,043,665", total.getTooltipText());
                String all = text(root);
                assertTrue("Input and output must be shown separately", all.contains(chinese ? "输入 Token\n318.8亿\n输出 Token\n1289.6万" : "Input tokens\n31.9B\nOutput tokens\n12.9M"));
                for (String value : chinese ? new String[]{"48.2亿", "47.4亿", "4.6万", "失败/取消 1.1万"} : new String[]{"4.8B", "4.7B", "46.2K", "Failed/canceled 11.5K"}) assertTrue(value, all.contains(value));
                try {
                    var count = RemoteUsageActivity.class.getDeclaredMethod("count", double.class); count.setAccessible(true);
                    double[] values = {0, 999, 10000, 99999999, 100000000, 1000000000000d};
                    String[] expected = chinese ? new String[]{"0", "999", "1万", "1亿", "1亿", "1万亿"} : new String[]{"0", "999", "10K", "100M", "100M", "1T"};
                    for (int i = 0; i < values.length; i++) assertEquals(expected[i], count.invoke(current, values[i]));
                } catch (Exception e) { throw new AssertionError(e); }
                for (String tag : new String[]{"usageRange", "usageFiltersToggle"}) {
                    TextView control = root.findViewWithTag(tag);
                    assertTrue(control.getBackground() instanceof android.graphics.drawable.RippleDrawable);
                    assertTrue(control.getCompoundDrawablesRelative()[2] instanceof LineIcon);
                    assertFalse(control.getText().toString().contains("⌄"));
                }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                TextView total = current.getWindow().getDecorView().findViewWithTag("usageTotalTokens");
                assertEquals(1, total.getLineCount());
                assertTrue(total.getLayout().getLineWidth(0) <= total.getWidth() - total.getPaddingLeft() - total.getPaddingRight());
            });
            screenshot("quota-usage-compact-" + language + ".png");
            choose(current, "usageRange", 3);
            getInstrumentation().runOnMainSync(() -> {
                View root = current.getWindow().getDecorView();
                assertEquals(chinese ? "318.9亿" : "31.9B", ((TextView) root.findViewWithTag("usageTotalTokens")).getText().toString());
                root.findViewWithTag("usageFiltersToggle").performClick();
                assertTrue(root.findViewWithTag("usageFiltersToggle").isSelected());
                root.findViewWithTag("usageSource").performClick();
            });
            screenshot("quota-usage-choice-" + language + ".png");
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var field = RemoteUsageActivity.class.getDeclaredField("choiceDropdown"); field.setAccessible(true);
                    ChoiceDropdown chooser = (ChoiceDropdown) field.get(current);
                    assertNotNull(chooser.panel.findViewWithTag("choiceDropdown"));
                    chooser.dismiss();
                    assertEquals(chinese ? "318.9亿" : "31.9B", ((TextView) current.getWindow().getDecorView().findViewWithTag("usageTotalTokens")).getText().toString());
                } catch (Exception e) { throw new AssertionError(e); }
            });
            choose(current, "usageSource", 1);
            getInstrumentation().runOnMainSync(() -> assertEquals("0", ((TextView) current.getWindow().getDecorView().findViewWithTag("usageTotalTokens")).getText().toString()));
        } finally {
            if (activity != null) { Activity current = activity; getInstrumentation().runOnMainSync(current::finish); }
            getInstrumentation().waitForIdleSync(); RemoteUsageActivity.clientFactory = factory;
            vault.save(original); cachedVault.save(originalCache);
            MobilePreferences.set(context, "language", oldLanguage); MobilePreferences.set(context, "theme", oldTheme);
        }
    }
    private void runScreen(String language, String theme) throws Exception {
        var context = getInstrumentation().getTargetContext();
        String oldLanguage = MobilePreferences.get(context, "language"), oldTheme = MobilePreferences.get(context, "theme");
        var vault = new CredentialStore(context); var cachedVault = new CredentialStore(context, "remote-account-usage");
        JSONObject original = vault.load(), originalCache = cachedVault.load();
        var factory = RemoteUsageActivity.clientFactory;
        Activity activity = null;
        AtomicBoolean offline = new AtomicBoolean();
        AtomicBoolean denied = new AtomicBoolean();
        JSONObject data = snapshot();
        try {
            MobilePreferences.set(context, "language", language); MobilePreferences.set(context, "theme", theme);
            vault.save(new JSONObject());
            new ComputerStore(vault).save(new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43)).put("computerName", "Usage QA"));
            RemoteUsageActivity.clientFactory = address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                    if (denied.get()) throw new RemoteApi.Failure(401);
                    if (offline.get()) throw new java.io.IOException("CAMELLIA_CONNECT_TIMEOUT");
                    if (path.equals("/v1/status")) try { return new JSONObject().put("capabilities", new org.json.JSONArray().put("account-usage")); } catch (Exception e) { throw new java.io.IOException(e); }
                    return data;
                }
            };
            activity = getInstrumentation().startActivitySync(new Intent(context, RemoteUsageActivity.class).putExtra("address", ADDRESS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitFor(activity, "75%");
            screenshot("quota-usage-balances-" + language + ".png");
            Activity current = activity;
            getInstrumentation().runOnMainSync(() -> {
                String all = text(current.getWindow().getDecorView());
                assertTrue(all.contains("0 CNY")); assertTrue(all.contains("DeepSeek")); assertTrue(all.contains("Codex"));
                current.getWindow().getDecorView().findViewWithTag("usageTabHistory").performClick();
                all = text(current.getWindow().getDecorView()); assertTrue(all.contains("100")); assertTrue(all.contains("deepseek-model")); assertTrue(all.contains("codex-model"));
                assertNull(current.getWindow().getDecorView().findViewWithTag("usageSource"));
                current.getWindow().getDecorView().findViewWithTag("usageFiltersToggle").performClick();
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> assertEquals(current.getWindow().getDecorView().findViewWithTag("usageTabQuota").getHeight(), current.getWindow().getDecorView().findViewWithTag("usageTabHistory").getHeight()));
            choose(current, "usageSource", 2);
            getInstrumentation().runOnMainSync(() -> {
                String all = text(current.getWindow().getDecorView());
                assertTrue(all.contains("deepseek-model")); assertFalse(all.contains("codex-model"));
                assertTrue(text(current.getWindow().getDecorView().findViewWithTag("usageSummary")).contains("30"));
            });
            choose(current, "usageAccount", 1); choose(current, "usageModel", 1);
            getInstrumentation().runOnMainSync(() -> assertTrue(text(current.getWindow().getDecorView().findViewWithTag("usageFiltersToggle")).contains("3")));
            screenshot("quota-usage-filters-" + language + ".png");
            choose(current, "usageRange", 0);
            getInstrumentation().runOnMainSync(() -> {
                assertFalse(text(current.getWindow().getDecorView()).contains("deepseek-model"));
                assertTrue(text(current.getWindow().getDecorView().findViewWithTag("usageSummary")).contains("0"));
            });
            choose(current, "usageRange", 1); choose(current, "usageSource", 0);
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageFiltersToggle").performClick());
            screenshot("quota-usage-history-" + language + ".png");
            offline.set(true);
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageRefresh").performClick());
            waitFor(activity, "正在显示上次保存的数据", "Showing saved data");
            getInstrumentation().runOnMainSync(() -> assertTrue(text(current.getWindow().getDecorView()).contains("deepseek-model")));
            getInstrumentation().runOnMainSync(current::finish); activity = null;
            activity = getInstrumentation().startActivitySync(new Intent(context, RemoteUsageActivity.class).putExtra("address", ADDRESS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitFor(activity, "75%"); // Persisted quota remains visible after a cold page open offline.
            waitFor(activity, "正在显示上次保存的数据", "Showing saved data");
            denied.set(true); Activity reopened = activity;
            getInstrumentation().runOnMainSync(() -> reopened.getWindow().getDecorView().findViewWithTag("usageRefresh").performClick());
            waitFor(activity, "需要重新配对", "Pair this computer again");
            getInstrumentation().runOnMainSync(() -> assertFalse(text(reopened.getWindow().getDecorView()).contains("Personal")));
            assertNull(new AccountUsageCache(context).load(new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43))));
        } finally {
            if (activity != null) { Activity current = activity; getInstrumentation().runOnMainSync(current::finish); }
            getInstrumentation().waitForIdleSync(); RemoteUsageActivity.clientFactory = factory;
            vault.save(original); cachedVault.save(originalCache);
            MobilePreferences.set(context, "language", oldLanguage); MobilePreferences.set(context, "theme", oldTheme);
        }
    }
    public void testOldDesktopIsExplainedWithoutPostingAndRefreshRecoversAfterRestart() throws Exception {
        runUnsupportedDesktop(404, "zh-CN", "light");
    }
    public void test405DetailsAreCollapsedInEnglishDarkAndScopedDenialStaysDistinct() throws Exception {
        runUnsupportedDesktop(405, "en", "dark");
    }
    private void runUnsupportedDesktop(int oldStatus, String language, String theme) throws Exception {
        var context = getInstrumentation().getTargetContext();
        var vault = new CredentialStore(context); var cachedVault = new CredentialStore(context, "remote-account-usage");
        JSONObject original = vault.load(), originalCache = cachedVault.load();
        String oldLanguage = MobilePreferences.get(context, "language"), oldTheme = MobilePreferences.get(context, "theme");
        var factory = RemoteUsageActivity.clientFactory; Activity activity = null;
        var restarted = new AtomicBoolean(); var scoped = new AtomicBoolean();
        var posts = new java.util.concurrent.atomic.AtomicInteger(); var reads = new java.util.concurrent.atomic.AtomicInteger();
        JSONObject data = snapshot();
        try {
            MobilePreferences.set(context, "language", language); MobilePreferences.set(context, "theme", theme);
            vault.save(new JSONObject()); cachedVault.save(new JSONObject());
            new ComputerStore(vault).save(new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43)).put("computerName", "HP"));
            RemoteUsageActivity.clientFactory = address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                    if (path.equals("/v1/status")) try {
                        return new JSONObject().put("permission", "control").put("capabilities", restarted.get() ? new org.json.JSONArray().put("account-usage") : new org.json.JSONArray());
                    } catch (Exception e) { throw new java.io.IOException(e); }
                    if (payload != null) posts.incrementAndGet(); else reads.incrementAndGet();
                    if (scoped.get()) throw new RemoteApi.Failure(403, "Full-device control permission required");
                    if (!restarted.get()) throw new RemoteApi.Failure(oldStatus, "Remote access is read-only");
                    return data;
                }
            };
            activity = getInstrumentation().startActivitySync(new Intent(context, RemoteUsageActivity.class).putExtra("address", ADDRESS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            waitFor(activity, "电脑端需要更新或重启", "Update or restart the desktop"); Activity current = activity;
            getInstrumentation().runOnMainSync(() -> {
                assertFalse(text(current.getWindow().getDecorView()).contains("Remote access is read-only"));
                View tabs = current.getWindow().getDecorView().findViewWithTag("usageTabs");
                assertTrue(tabs.getHeight() <= Math.round(80 * context.getResources().getDisplayMetrics().density));
                current.getWindow().getDecorView().findViewWithTag("usageRefresh").performClick();
            });
            waitFor(activity, "电脑端需要更新或重启", "Update or restart the desktop");
            assertEquals(0, posts.get()); assertEquals(2, reads.get());
            screenshot("quota-usage-update-" + language + ".png");
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageDetailsToggle").performClick());
            waitFor(activity, "HTTP " + oldStatus);
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageDetailsToggle").performClick());
            scoped.set(true);
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageRefresh").performClick());
            waitFor(activity, "需要完整电脑权限", "Full-device permission required");
            scoped.set(false); restarted.set(true);
            getInstrumentation().runOnMainSync(() -> current.getWindow().getDecorView().findViewWithTag("usageRefresh").performClick());
            waitFor(activity, "75%"); assertEquals(1, posts.get());
            getInstrumentation().runOnMainSync(() -> assertFalse(text(current.getWindow().getDecorView()).contains("HTTP")));
        } finally {
            if (activity != null) { Activity current = activity; getInstrumentation().runOnMainSync(current::finish); }
            getInstrumentation().waitForIdleSync(); RemoteUsageActivity.clientFactory = factory;
            vault.save(original); cachedVault.save(originalCache);
            MobilePreferences.set(context, "language", oldLanguage); MobilePreferences.set(context, "theme", oldTheme);
        }
    }
    public void testUsageCacheCannotCrossPairingsOrRestoreForgottenComputers() throws Exception {
        var context = getInstrumentation().getTargetContext(); var vault = new CredentialStore(context);
        var cachedVault = new CredentialStore(context, "remote-account-usage"); JSONObject original = vault.load(), originalCache = cachedVault.load();
        try {
            vault.save(new JSONObject()); ComputerStore computers = new ComputerStore(vault);
            JSONObject computer = new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43)); computers.save(computer);
            AccountUsageCache cache = new AccountUsageCache(context);
            assertTrue(cache.save(computer, snapshot())); assertNotNull(cache.load(computer));
            JSONObject rotated = new JSONObject(computer.toString()).put("token", "b".repeat(43)); computers.save(rotated);
            assertNull(cache.load(rotated)); assertFalse(cache.save(computer, snapshot()));
            assertTrue(cache.save(rotated, snapshot()));
            cache.remove(computer);
            assertNotNull("A late denial from the old pairing must preserve the new cache", cache.load(rotated));
            cache.remove(rotated);
            assertNull("A denial for the current pairing must clear its cache", cache.load(rotated));
            assertTrue(cache.save(rotated, snapshot()));
            computers.remove(ADDRESS); assertNull(cache.load(computer)); assertFalse(cache.save(computer, snapshot()));
            assertNull(cache.load(rotated));
        } finally { vault.save(original); cachedVault.save(originalCache); }
    }
    public void testLateResponseCannotReplaceTheNewlySelectedComputer() throws Exception {
        var context = getInstrumentation().getTargetContext(); var vault = new CredentialStore(context);
        var cachedVault = new CredentialStore(context, "remote-account-usage"); JSONObject original = vault.load(), originalCache = cachedVault.load();
        var factory = RemoteUsageActivity.clientFactory; Activity activity = null;
        String second = "http://100.80.1.3:43127";
        var started = new java.util.concurrent.CountDownLatch(1); var release = new java.util.concurrent.CountDownLatch(1);
        JSONObject oldData = new JSONObject(snapshot().toString().replace("Wallet", "Old Wallet"));
        JSONObject newData = new JSONObject(snapshot().toString().replace("Wallet", "New Wallet"));
        try {
            vault.save(new JSONObject()); ComputerStore computers = new ComputerStore(vault);
            computers.save(new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43)).put("computerName", "First computer"));
            computers.save(new JSONObject().put("address", second).put("token", "b".repeat(43)).put("computerName", "Second computer"));
            RemoteUsageActivity.clientFactory = address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                    if (address.equals(ADDRESS)) {
                        started.countDown();
                        try { release.await(8, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException error) { throw new java.io.IOException(error); }
                    }
                    return address.equals(ADDRESS) ? oldData : newData;
                }
                @Override public void cancel() { if (address.equals(ADDRESS)) release.countDown(); super.cancel(); }
            };
            activity = getInstrumentation().startActivitySync(new Intent(context, RemoteUsageActivity.class).putExtra("address", ADDRESS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            assertTrue(started.await(8, java.util.concurrent.TimeUnit.SECONDS)); Activity current = activity;
            getInstrumentation().runOnMainSync(() -> {
                try {
                    current.getWindow().getDecorView().findViewWithTag("usageComputer").performClick();
                    computerPicker(current).panel.findViewWithTag("switchComputer:" + second).performClick();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            waitFor(activity, "New Wallet");
            getInstrumentation().runOnMainSync(() -> assertFalse(text(current.getWindow().getDecorView()).contains("Old Wallet")));
        } finally {
            release.countDown();
            if (activity != null) { Activity current = activity; getInstrumentation().runOnMainSync(current::finish); }
            getInstrumentation().waitForIdleSync(); RemoteUsageActivity.clientFactory = factory;
            vault.save(original); cachedVault.save(originalCache);
        }
    }
}
