package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

public class RemoteCodexResetTest extends InstrumentationTestCase {
    private Activity activity;
    private AlertDialog dialog;
    private RemoteSettingsPopup picker;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            if (dialog != null) dialog.dismiss();
            if (picker != null) picker.dismiss();
            activity.finish();
        });
        super.tearDown();
    }

    private JSONObject preview(int count, boolean retry) throws Exception {
        return new JSONObject().put("accountId", "owner").put("account", new JSONObject().put("email", "phone-reset@example.test"))
            .put("credits", new JSONObject().put("availableCount", count)).put("retry", retry)
            .put("confirmationToken", count > 0 || retry ? "12345678-1234-1234-1234-123456789abc" : "");
    }

    private String text(View view) {
        String result = view instanceof TextView ? ((TextView) view).getText().toString() : "";
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) result += "\n" + text(((ViewGroup) view).getChildAt(i));
        return result;
    }

    public void testOpenAndCancelNeverConsumeThenExplicitConfirmationUsesOneCard() throws Exception {
        JSONObject preview = preview(2, false); AtomicInteger calls = new AtomicInteger();
        getInstrumentation().runOnMainSync(() -> {
            dialog = RemoteCodexResetDialog.show(activity, true, preview, calls::incrementAndGet);
            assertEquals(0, calls.get());
            assertTrue(text(dialog.getWindow().getDecorView()).contains("phone-reset@example.test"));
            assertTrue(text(dialog.getWindow().getDecorView()).contains("可用重置卡：2"));
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
            assertEquals(0, calls.get());
            dialog = RemoteCodexResetDialog.show(activity, true, preview, calls::incrementAndGet);
            assertEquals("确认使用一张", dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
        });
        getInstrumentation().waitForIdleSync();
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "remote-codex-reset.png"))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        }
        image.recycle();
        getInstrumentation().runOnMainSync(() -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertEquals(1, calls.get());
        });
    }

    public void testUnavailableAndEmptyCardsDoNotOfferConsumption() throws Exception {
        JSONObject empty = preview(0, false), unknown = preview(0, false).put("credits", JSONObject.NULL);
        getInstrumentation().runOnMainSync(() -> {
            dialog = RemoteCodexResetDialog.show(activity, false, empty, () -> fail("Empty cards cannot be consumed"));
            assertNull(dialog.getButton(AlertDialog.BUTTON_POSITIVE));
            assertTrue(text(dialog.getWindow().getDecorView()).contains("No reset credits")); dialog.dismiss();
            dialog = RemoteCodexResetDialog.show(activity, true, unknown, () -> fail("Unknown cards cannot be consumed"));
            assertNull(dialog.getButton(AlertDialog.BUTTON_POSITIVE));
            assertTrue(text(dialog.getWindow().getDecorView()).contains("信息暂不可用"));
        });
    }

    public void testUncertainRequestCanBeCheckedEvenWhenNoCardsRemain() throws Exception {
        JSONObject retry = preview(0, true);
        getInstrumentation().runOnMainSync(() -> {
            dialog = RemoteCodexResetDialog.show(activity, true, retry, () -> {});
            assertEquals("重试同一请求", dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
            assertTrue(text(dialog.getWindow().getDecorView()).contains("不会新建重置请求"));
        });
    }

    public void testResetEntryRequiresAnAdvertisedCapability() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            FrameLayout fixture = new FrameLayout(activity);
            TextView anchor = new TextView(activity); anchor.setText("Codex");
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(240, 80, Gravity.BOTTOM | Gravity.LEFT);
            params.bottomMargin = 180; fixture.addView(anchor, params); activity.setContentView(fixture);
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            View anchor = ((ViewGroup) activity.findViewById(android.R.id.content)).getChildAt(0);
            anchor = ((ViewGroup) anchor).getChildAt(0);
            picker = new RemoteSettingsPopup(activity, true, -1, 0xff111111, 0xff666666, 0xff4176e6, new JSONObject(), (key, value) -> {});
            picker.show(anchor, false);
            try {
                var field = RemoteSettingsPopup.class.getDeclaredField("popup"); field.setAccessible(true);
                PopupWindow popup = (PopupWindow) field.get(picker);
                assertNull(popup.getContentView().findViewWithTag("remoteCodexReset"));
                picker.dismiss(); picker.setResetCreditsAvailable(true); picker.show(anchor, false);
                assertNotNull(popup.getContentView().findViewWithTag("remoteCodexReset"));
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }
}
