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
                var field = RemoteUsageActivity.class.getDeclaredField("dialog"); field.setAccessible(true);
                android.app.Dialog chooser = (android.app.Dialog) field.get(activity);
                chooser.getWindow().getDecorView().findViewWithTag("settingsChoice:" + index).performClick();
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }
    public void testChineseUsageReadingsStatisticsOfflineAndRevocation() throws Exception { runScreen("zh-CN", "light"); }
    public void testEnglishDarkUsageReadingsStatisticsOfflineAndRevocation() throws Exception { runScreen("en", "dark"); }
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
                    var field = RemoteUsageActivity.class.getDeclaredField("dialog"); field.setAccessible(true);
                    android.app.Dialog chooser = (android.app.Dialog) field.get(current);
                    field = RemoteUsageActivity.class.getDeclaredField("computers"); field.setAccessible(true);
                    @SuppressWarnings("unchecked") var targets = (java.util.List<JSONObject>) field.get(current);
                    for (int i = 0; i < targets.size(); i++) if (targets.get(i).optString("address").equals(second)) chooser.getWindow().getDecorView().findViewWithTag("settingsChoice:" + i).performClick();
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
