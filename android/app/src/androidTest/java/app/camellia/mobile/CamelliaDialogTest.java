package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;

public class CamelliaDialogTest extends InstrumentationTestCase {
    private Activity activity;
    private CamelliaDialog dialog;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    @Override protected void tearDown() throws Exception {
        getInstrumentation().runOnMainSync(() -> { if (dialog != null) dialog.dismiss(); activity.finish(); });
        super.tearDown();
    }
    public void testButtonOverridesRetainValidationAndSecureWindow() {
        getInstrumentation().runOnMainSync(() -> {
            EditText field = new EditText(activity); field.setTag("formInput");
            dialog = new CamelliaDialog.Builder(activity).setTitle("添加供应商").setView(field)
                .setNegativeButton("取消", null).setPositiveButton("保存", null).create();
            dialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
            dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                if (field.getText().length() > 0) dialog.dismiss();
            }));
            dialog.show();
            assertNotNull(dialog.findViewById(android.R.id.button1));
            assertNotNull(dialog.getWindow().getDecorView().findViewWithTag("camelliaDialog"));
            assertTrue((dialog.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0);
            assertEquals(0, dialog.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            EditText field = dialog.getWindow().getDecorView().findViewWithTag("formInput");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertTrue(dialog.isShowing());
            field.setText("valid"); dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); assertFalse(dialog.isShowing());
        });
    }
    public void testMenuAndCancelCallbacksPreserved() {
        int[] selected = {-1}, cancelled = {0};
        getInstrumentation().runOnMainSync(() -> {
            dialog = new CamelliaDialog.Builder(activity).setTitle("工作区")
                .setItems(new String[]{"重命名", "移除工作区（保留会话）"}, (choice, which) -> selected[0] = which).show();
            dialog.getWindow().getDecorView().findViewWithTag("camelliaDialogItem:1").performClick();
            assertEquals(1, selected[0]); assertFalse(dialog.isShowing());
            dialog = new CamelliaDialog.Builder(activity).setMessage("确认本次位置授权")
                .setNeutralButton("取消发送", (choice, which) -> selected[0] = which)
                .setOnCancelListener(choice -> cancelled[0]++).show();
            dialog.cancel();
        });
        getInstrumentation().waitForIdleSync();
        assertEquals(1, cancelled[0]);
    }
    public void testLongContentStaysScrollableInLightAndDark() throws Exception {
        for (boolean dark : new boolean[]{false, true}) {
            getInstrumentation().runOnMainSync(() -> {
                Configuration config = new Configuration(activity.getResources().getConfiguration());
                config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | (dark ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
                var context = new android.view.ContextThemeWrapper(activity, R.style.AppTheme);
                context.applyOverrideConfiguration(config);
                LinearLayout form = new LinearLayout(context); form.setOrientation(LinearLayout.VERTICAL);
                for (int index = 0; index < 12; index++) {
                    EditText input = new EditText(context); input.setHint("设置字段 " + index); form.addView(input);
                }
                dialog = new CamelliaDialog.Builder(context).setTitle("编辑供应商 · 连接配置").setMessage("与设置页面保持一致，输入内容后保存。")
                    .setView(form).setPositiveButton("保存", null).setNegativeButton("取消", null).show();
            });
            getInstrumentation().waitForIdleSync(); Thread.sleep(150);
            getInstrumentation().runOnMainSync(() -> {
                View positive = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
                android.graphics.Rect rect = new android.graphics.Rect(); assertTrue(positive.getGlobalVisibleRect(rect));
                assertTrue(rect.height() >= 48 * activity.getResources().getDisplayMetrics().density);
                assertTrue(dialog.getWindow().getDecorView().getHeight() <= activity.getResources().getDisplayMetrics().heightPixels);
            });
            var bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
            if (bitmap != null) {
                try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), dark ? "menus-dark.png" : "menus-light.png"))) {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                } finally { bitmap.recycle(); }
            }
            getInstrumentation().runOnMainSync(dialog::dismiss);
        }
    }
}
