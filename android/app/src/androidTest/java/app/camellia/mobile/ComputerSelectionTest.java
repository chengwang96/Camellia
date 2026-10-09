package app.camellia.mobile;

import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONObject;

public class ComputerSelectionTest extends InstrumentationTestCase {
    private MainActivity activity;
    private CredentialStore encrypted;
    private ComputerStore computers;
    private JSONObject first, second;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        encrypted = new CredentialStore(context, "computer-selection-test"); encrypted.clear(); computers = new ComputerStore(encrypted);
        first = new JSONObject().put("address", "http://100.64.0.11:43127").put("computerName", "HP").put("token", "a".repeat(43));
        second = new JSONObject().put("address", "http://100.64.0.12:43127").put("computerName", "ROG").put("token", "b".repeat(43));
        computers.save(first); computers.save(second);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            invoke("stopNetwork"); field("store", computers); field("credentials", second); field("chinese", true); field("foreground", false);
            invoke("computersScreen"); state(first, "已连接"); state(second, "暂时无法连接");
        });
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> {
            android.app.Dialog dialog = (android.app.Dialog) field("computerDialog");
            if (dialog != null) dialog.dismiss(); activity.finish();
        });
        getInstrumentation().waitForIdleSync(); encrypted.clear(); super.tearDown();
    }

    public void testManagementAndSelectionAreSeparateAndAddingPreservesComputers() throws Exception {
        screenshot("computer-selection");
        ui(() -> {
            ViewGroup card = root().findViewWithTag("computerList");
            View row = root().findViewWithTag("computer:" + first.getString("address"));
            assertSame(card, row.getParent()); assertSame(card, root().findViewWithTag("addComputer").getParent());
            assertFalse(containsText(card, first.getString("address")));
            assertTrue(row.getContentDescription().toString().contains("已连接"));
            root().findViewWithTag("manage:" + first.getString("address")).performClick();
            assertEquals("computers", field("screen"));
            android.app.Dialog dialog = (android.app.Dialog) field("computerDialog");
            assertTrue(dialog.isShowing()); View panel = dialog.getWindow().getDecorView();
            assertTrue(containsText(panel, first.getString("address"))); assertTrue(containsText(panel, "已连接"));
            assertNotNull(panel.findViewWithTag("manageRename")); assertNotNull(panel.findViewWithTag("manageForget"));
            dialog.dismiss(); row.performClick();
            assertEquals("list", field("screen")); assertEquals(first.getString("address"), ((JSONObject) field("credentials")).getString("address"));
            activity.onBackPressed(); assertEquals("computers", field("screen"));
            root().findViewWithTag("addComputer").performClick();
            assertEquals("pair", field("screen")); assertEquals(2, computers.all().size());
        });
    }

    public void testRefreshUpdatesVisibleAndAccessibleStateWithoutKeepingTheOldOnlineDot() throws Exception {
        ui(() -> {
            String address = first.getString("address"); View row = root().findViewWithTag("computer:" + address);
            View dot = root().findViewWithTag("computerPresence:" + address);
            assertTrue("The online presence dot must be visible", dot.isShown());
            int online = ((GradientDrawable) dot.getBackground()).getColor().getDefaultColor();
            assertEquals("The online presence color must be opaque", 255, android.graphics.Color.alpha(online));
            state(first, "正在检查…");
            assertEquals("正在检查…", ((TextView) root().findViewWithTag("computerState:" + address)).getText().toString());
            assertFalse(row.getContentDescription().toString().contains("已连接"));
            assertFalse(online == ((GradientDrawable) dot.getBackground()).getColor().getDefaultColor());
            String failure = RemoteApi.failureMessage(new RemoteApi.Failure(401), true); state(first, failure);
            assertTrue(row.getContentDescription().toString().contains(failure));
            assertFalse(online == ((GradientDrawable) dot.getBackground()).getColor().getDefaultColor());
            TextView footer = (TextView) field("status"); footer.setText("电脑状态已更新"); assertEquals(View.GONE, footer.getVisibility());
            footer.setText("无法检查电脑状态，请下拉重试。"); assertEquals(View.VISIBLE, footer.getVisibility());
        });
    }

    public void testEmptyCardHasOneAddActionAndKeepsPairingReachable() throws Exception {
        ui(() -> { encrypted.clear(); field("credentials", new JSONObject()); invoke("computersScreen"); });
        getInstrumentation().waitForIdleSync(); screenshot("computer-selection-empty");
        ui(() -> {
            View empty = root().findViewWithTag("settingsEmptyState");
            assertNotNull(empty);
            // Outside the card, not inside it. Sharing a surface with the "Add
            // computer" row below made the empty state read as one more thing to
            // tap, which is the opposite of what it is.
            assertNull("the empty state must not sit inside the computer card",
                root().findViewWithTag("computerList").findViewById(empty.getId()));
            assertEquals(1, exactTextCount(root(), "添加电脑"));
            root().findViewWithTag("addComputer").performClick(); assertEquals("pair", field("screen"));
        });
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }
    private View root() { return activity.getWindow().getDecorView(); }
    private Object field(String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private void state(JSONObject computer, String value) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("updateComputerState", String.class, String.class); method.setAccessible(true);
        method.invoke(activity, computer.getString("address"), value);
    }
    private boolean containsText(View view, String text) {
        if (view instanceof TextView && ((TextView) view).getText().toString().contains(text)) return true;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++)
            if (containsText(((ViewGroup) view).getChildAt(i), text)) return true;
        return false;
    }
    private int exactTextCount(View view, String text) {
        int count = view instanceof TextView && ((TextView) view).getText().toString().equals(text) ? 1 : 0;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) count += exactTextCount(((ViewGroup) view).getChildAt(i), text);
        return count;
    }
    private void screenshot(String name) throws Exception {
        ui(() -> ((PageTransitions) field("pages")).finishTransition());
        getInstrumentation().waitForIdleSync(); getInstrumentation().getUiAutomation().waitForIdle(150, 3000);
        var bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }
}
