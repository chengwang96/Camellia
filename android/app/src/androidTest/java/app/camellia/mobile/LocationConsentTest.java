package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.location.Location;
import android.test.InstrumentationTestCase;
import java.util.concurrent.atomic.AtomicReference;

public class LocationConsentTest extends InstrumentationTestCase {
    public void testConservativeIntentAndApproximateContext() {
        for (String prompt : new String[]{"我在哪里？", "推荐附近餐厅", "这里天气怎么样", "搜一搜最近今天的天气", "查一下今天天气", "最近天气怎么样", "weather today", "current weather", "Find coffee near me", "where am I?"})
            assertTrue(prompt, LocationConsent.relevant(prompt));
        for (String prompt : new String[]{"你好", "北京天气", "北京今天天气", "上海最近天气", "不要定位，推荐附近餐厅", "不要定位，查一下今天天气", "翻译：我在哪里", "翻译：今天天气怎么样", "Explain GPS permissions", "Find restaurants without using my location"})
            assertFalse(prompt, LocationConsent.relevant(prompt));
        Location location = new Location("network"); location.setLatitude(22.319312); location.setLongitude(114.169487);
        location.setAccuracy(400); location.setElapsedRealtimeNanos(android.os.SystemClock.elapsedRealtimeNanos());
        String context = LocationConsent.context(location);
        assertTrue(context.contains("22.32")); assertTrue(context.contains("114.17")); assertTrue(context.contains("2000 m"));
        assertFalse(context.contains("22.319312"));
        location.setElapsedRealtimeNanos(android.os.SystemClock.elapsedRealtimeNanos() - 180_000_000_000L);
        assertTrue(LocationConsent.context(location).contains("not provided"));
    }

    public void testNoLocationWithoutPerMessageConsent() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        LocationConsent consent = new LocationConsent(activity);
        AtomicReference<String> result = new AtomicReference<>();
        try {
            var dialogField = LocationConsent.class.getDeclaredField("dialog"); dialogField.setAccessible(true);
            var managerField = LocationConsent.class.getDeclaredField("manager"); managerField.setAccessible(true);
            getInstrumentation().runOnMainSync(() -> {
                try {
                    consent.request("北京天气", "Test provider", result::set);
                    assertEquals("", result.get()); assertNull(managerField.get(consent)); assertNull(dialogField.get(consent));
                    result.set(null);
                    consent.request("推荐附近餐厅", "Test provider", result::set);
                    assertNull(result.get()); assertNull(managerField.get(consent));
                    AlertDialog dialog = (AlertDialog) dialogField.get(consent); assertTrue(dialog.isShowing());
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    assertTrue(result.get().contains("not provided")); assertNull(managerField.get(consent));
                    result.set(null);
                    consent.request("where am I?", "Test computer", result::set);
                    ((AlertDialog) dialogField.get(consent)).getButton(AlertDialog.BUTTON_NEUTRAL).performClick();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    assertNull(result.get()); assertNull(managerField.get(consent));
                    consent.permissionResult(LocationConsent.REQUEST_CODE);
                    assertNull(result.get()); assertNull(managerField.get(consent));
                    consent.request("where am I?", "Test computer", result::set);
                    consent.cancel(); assertNull(dialogField.get(consent)); assertNull(result.get());
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            getInstrumentation().runOnMainSync(() -> { consent.cancel(); activity.finish(); });
            getInstrumentation().waitForIdleSync();
        }
    }
}
