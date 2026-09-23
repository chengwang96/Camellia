package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.ScaleDrawable;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ContextThemeWrapper;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class SettingsControlsTest extends InstrumentationTestCase {
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

    public void testInlineValidationAndRoundedProgressInBothThemes() throws Exception {
        for (boolean dark : new boolean[]{false, true}) {
            getInstrumentation().runOnMainSync(() -> {
                Configuration config = new Configuration(activity.getResources().getConfiguration());
                config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | (dark ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
                ContextThemeWrapper context = new ContextThemeWrapper(activity, R.style.AppTheme); context.applyOverrideConfiguration(config);
                SettingsStyle style = new SettingsStyle(context);
                LinearLayout panel = new LinearLayout(context); panel.setOrientation(LinearLayout.VERTICAL);
                EditText input = new EditText(context); input.setTag("settingsName"); input.setHint("工作区名称 / Workspace name"); input.setSingleLine(true);
                SettingsField field = new SettingsField(input); panel.addView(field);
                assertTrue(style.field != style.background);
                assertTrue(style.fieldBorder != style.field);
                android.graphics.drawable.GradientDrawable fill = (android.graphics.drawable.GradientDrawable) input.getBackground().getCurrent();
                assertEquals(style.field, fill.getColor().getDefaultColor());
                assertEquals(style.ink, input.getCurrentTextColor());
                ProgressBar progress = style.progressBar(); progress.setTag("testProgress"); progress.setProgress(42);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.round(6 * context.getResources().getDisplayMetrics().density));
                params.topMargin = Math.round(20 * context.getResources().getDisplayMetrics().density); panel.addView(progress, params);
                dialog = new CamelliaDialog.Builder(context).setTitle("设置 · Settings").setView(panel).setPositiveButton("保存 / Save", null).show();
                field.showError("请输入名称 / Enter a name");
                TextView feedback = panel.findViewWithTag("settingsNameError");
                assertEquals(View.VISIBLE, feedback.getVisibility()); assertNull(input.getError());
                assertTrue(input.createAccessibilityNodeInfo().isContentInvalid());
                assertEquals(feedback.getText().toString(), input.createAccessibilityNodeInfo().getError().toString());
                assertEquals(style.error, feedback.getCurrentTextColor());
                assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, feedback.getAccessibilityLiveRegion());
                input.setText("Research"); assertEquals(View.GONE, feedback.getVisibility());
                assertFalse(input.createAccessibilityNodeInfo().isContentInvalid());
                LayerDrawable layers = (LayerDrawable) progress.getProgressDrawable();
                assertTrue(layers.findDrawableByLayerId(android.R.id.progress) instanceof ScaleDrawable);
                assertEquals(4200, layers.findDrawableByLayerId(android.R.id.progress).getLevel());
                field.showError("请输入名称 / Enter a name");
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                TextView feedback = dialog.getWindow().getDecorView().findViewWithTag("settingsNameError");
                assertTrue(feedback.getGlobalVisibleRect(new android.graphics.Rect()));
            });
            var bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
            if (bitmap != null) {
                try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), dark ? "settings-controls-dark.png" : "settings-controls-light.png"))) {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                } finally { bitmap.recycle(); }
            }
            getInstrumentation().runOnMainSync(dialog::dismiss);
        }
    }
}
