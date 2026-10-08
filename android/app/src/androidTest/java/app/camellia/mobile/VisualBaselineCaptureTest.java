package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import java.io.File;
import java.io.FileOutputStream;

/** Captures the two settings pages whose old "screenshots" showed the launcher. */
public final class VisualBaselineCaptureTest extends InstrumentationTestCase {
    public void testGeneralAndArchivedInBothLanguagesAndThemes() throws Exception {
        Context context = getInstrumentation().getTargetContext();
        String previousLanguage = MobilePreferences.get(context, "language");
        String previousTheme = MobilePreferences.get(context, "theme");
        try {
            for (String language : new String[]{"zh-CN", "en"}) {
                MobilePreferences.set(context, "language", language);
                for (String theme : new String[]{"light", "dark"}) {
                    MobilePreferences.set(context, "theme", theme);
                    for (String section : new String[]{"general", "archived"}) {
                        Activity activity = getInstrumentation().startActivitySync(
                            new Intent(context, SettingsActivity.class)
                                .putExtra("section", section)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        try {
                            getInstrumentation().waitForIdleSync();
                            SystemClock.sleep(800); // Wait for the page transition, not the launcher.
                            Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
                            assertNotNull(screenshot);
                            File target = new File(activity.getExternalCacheDir(),
                                "baseline-" + section + "-" + language + "-" + theme + ".png");
                            try (FileOutputStream output = new FileOutputStream(target)) {
                                assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output));
                            } finally {
                                screenshot.recycle();
                            }
                        } finally {
                            getInstrumentation().runOnMainSync(activity::finish);
                            getInstrumentation().waitForIdleSync();
                        }
                    }
                }
            }
        } finally {
            MobilePreferences.set(context, "language", previousLanguage);
            MobilePreferences.set(context, "theme", previousTheme);
        }
    }
}
