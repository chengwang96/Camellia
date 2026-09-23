package app.camellia.mobile;

import android.content.res.Configuration;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.List;

public class ArtifactMessageViewTest extends InstrumentationTestCase {
    public void testDesktopStyleRowsCollapseAndActionsRemainAccessible() {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try {
                for (boolean dark : new boolean[]{false, true}) for (float scale : new float[]{1f, 1.5f}) {
                    var base = getInstrumentation().getTargetContext();
                    Configuration configuration = new Configuration(base.getResources().getConfiguration());
                    configuration.uiMode = (configuration.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                        | (dark ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
                    configuration.fontScale = scale;
                    var context = base.createConfigurationContext(configuration);
                    java.util.concurrent.atomic.AtomicInteger opens = new java.util.concurrent.atomic.AtomicInteger();
                    String name = "Camellia-Android-0.3.40-debug-with-a-long-file-name.apk";
                    ArtifactMessageView card = new ArtifactMessageView(context,
                        List.of("研究报告.pdf", "数据.xlsx", "论文.docx", "说明.txt", name, "示意图.png"), true, opens::incrementAndGet);
                    int width = Math.round(320 * context.getResources().getDisplayMetrics().density);
                    card.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                    card.layout(0, 0, width, card.getMeasuredHeight());
                    assertEquals("artifactRow:" + name, card.getChildAt(0).getTag());
                    View overflow = card.findViewWithTag("artifactOverflow");
                    assertEquals(View.GONE, overflow.getVisibility());
                    TextView more = card.findViewWithTag("artifactShowMore");
                    assertEquals("显示另外 2 个文件", more.getText().toString());
                    View action = card.findViewWithTag("artifactAction:" + name);
                    TextView title = card.findViewWithTag("artifactName:" + name);
                    assertTrue(title.getWidth() > 0);
                    assertTrue(action.getHeight() >= Math.round(48 * context.getResources().getDisplayMetrics().density));
                    assertTrue(action.getContentDescription().toString().contains(name));
                    action.performClick();
                    ((LinearLayout) card.getChildAt(0)).getChildAt(0).performClick();
                    assertEquals(2, opens.get());
                    more.performClick(); assertEquals(View.VISIBLE, overflow.getVisibility());
                    more.performClick(); assertEquals(View.GONE, overflow.getVisibility());
                    if (scale == 1f) {
                        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(width, card.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
                        card.draw(new android.graphics.Canvas(bitmap));
                        try (var output = new java.io.FileOutputStream(new java.io.File(base.getCacheDir(), dark ? "artifact-card-dark.png" : "artifact-card-light.png"))) {
                            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                        } finally { bitmap.recycle(); }
                    }
                }
            } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
