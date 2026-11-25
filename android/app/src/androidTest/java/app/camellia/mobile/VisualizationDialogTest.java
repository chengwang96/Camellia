package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real browser rendering, every exit path, late delivery and repeated open/close collection. */
public class VisualizationDialogTest extends InstrumentationTestCase {
    private MainActivity activity;
    private VisualizationDialog dialog;

    private interface Checked { void run() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try { action.run(); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private static Object field(Object owner, String name) throws Exception {
        var field = owner.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(owner);
    }

    private void ownDialog() throws Exception {
        var field = MainActivity.class.getDeclaredField("visualizationDialog");
        field.setAccessible(true);
        field.set(activity, dialog);
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = (MainActivity) getInstrumentation().startActivitySync(
            new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> {
            if (dialog != null) dialog.dismiss();
            activity.finish();
        });
        getInstrumentation().waitForIdleSync();
        super.tearDown();
    }

    public void testSummaryDeduplicatesRevisionsWithoutCreatingWebViews() {
        ui(() -> {
            String id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
            JSONObject[] opened = {null};
            JSONArray cards = new JSONArray()
                .put(new JSONObject().put("cardId", id).put("title", "Older").put("revision", 1))
                .put(new JSONObject().put("cardId", id).put("title", "Latest").put("revision", 2));
            RemoteVisualizationsView rows = new RemoteVisualizationsView(activity, new ChatStyle(activity),
                cards, false, card -> opened[0] = card);
            assertEquals("One heading and one latest entry", 2, rows.getChildCount());
            assertFalse(containsBrowser(rows));
            assertNull(field(activity, "visualizationDialog"));
            rows.findViewWithTag("visualizationCard:" + id).performClick();
            assertEquals("Latest", opened[0].getString("title"));
        });
    }

    public void testCloseDestroysLoadedCardAndIgnoresLateDelivery() throws Exception {
        ui(() -> {
            dialog = new VisualizationDialog(activity, "Interactive card", false);
            dialog.show();
            dialog.load("<!doctype html><meta name='viewport' content='width=device-width'>"
                + "<button id='choice' onclick='this.textContent=\"Selected\"'>Choose</button>");
        });
        clickLoadedChoice();
        ui(() -> {
            WebView browser = (WebView) field(dialog, "webView");
            View close = dialog.getWindow().getDecorView().findViewWithTag("cardClose");
            assertNotNull("The card must expose its close control", close);
            close.performClick();
            assertReleased(browser);
            dialog.load("<script>throw new Error('late load')</script>");
            dialog.dismiss();
            dialog.cancel();
            dialog.show();
            assertFalse("A disposed dialog cannot revive a browser", dialog.isShowing());
            assertNull(field(dialog, "webView"));
        });
    }

    public void testAuthenticatedCardRequestPassesEndpointValidationAndRenders() throws Exception {
        String conversation = "12345678-1234-1234-1234-123456789abc";
        String card = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
        String token = "r".repeat(43);
        String path = "/v1/conversations/" + conversation + "/visualizations/" + card + "?theme=dark";
        String html = "<!doctype html><meta name='viewport' content='width=device-width'>"
            + "<button id='choice' onclick='this.textContent=\"Selected\"'>Choose from fetched card</button>";
        byte[] body = new JSONObject().put("card", new JSONObject().put("cardId", card).put("html", html))
            .toString().getBytes(StandardCharsets.UTF_8);
        boolean embedded = EmbeddedNetwork.enabled();
        EmbeddedNetwork.setEnabled(false);
        try (RemoteApiResponseTest.Server server = new RemoteApiResponseTest.Server(body)) {
            // Only the socket origin changes for this fixture; the production path validator and parser run unchanged.
            RemoteApi client = RemoteApiResponseTest.client(server);
            try {
                JSONObject response = client.json(path, token, null, 24 * 1024 * 1024);
                ui(() -> {
                    dialog = new VisualizationDialog(activity, "Fetched card", false);
                    dialog.show();
                    dialog.load(response.getJSONObject("card").getString("html"));
                });
                clickLoadedChoice();
                assertEquals("GET " + path + " HTTP/1.1", server.requestLine);
                assertEquals("Bearer " + token, server.authorization);
                ui(() -> {
                    WebView browser = (WebView) field(dialog, "webView");
                    dialog.dismiss();
                    assertReleased(browser);
                });
            } finally { client.cancel(); }
        } finally { EmbeddedNetwork.setEnabled(embedded); }
    }

    private void clickLoadedChoice() throws Exception {
        CountDownLatch rendered = new CountDownLatch(1);
        for (int attempt = 0; attempt < 50 && rendered.getCount() > 0; attempt++) {
            ui(() -> ((WebView) field(dialog, "webView")).evaluateJavascript(
                "(function(){var b=document.getElementById('choice');if(!b)return '';b.click();return b.textContent;})()",
                value -> { if ("\"Selected\"".equals(value)) rendered.countDown(); }));
            rendered.await(100, TimeUnit.MILLISECONDS);
        }
        assertEquals("The fetched card script must be interactive before closing", 0L, rendered.getCount());
    }

    public void testSystemBackCancelsAndReleasesCard() {
        WebView[] browser = {null};
        ui(() -> {
            dialog = new VisualizationDialog(activity, "交互卡片", true);
            dialog.show();
            browser[0] = (WebView) field(dialog, "webView");
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        getInstrumentation().waitForIdleSync();
        ui(() -> assertReleased(browser[0]));
    }

    public void testActivityRotationKeepsLoadedCardOpen() throws Exception {
        if (activity.getResources().getConfiguration().smallestScreenWidthDp < 600) return;
        ui(() -> {
            var foreground = MainActivity.class.getDeclaredField("foreground"); foreground.setAccessible(true); foreground.set(activity, false);
            activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        });
        awaitOrientation(android.content.res.Configuration.ORIENTATION_LANDSCAPE);
        ui(() -> {
            dialog = new VisualizationDialog(activity, "Card rotation", false);
            dialog.show(); ownDialog();
            dialog.load("<!doctype html><meta name='viewport' content='width=device-width'><button id='choice' onclick='this.textContent=\"Selected\"'>Choose</button>");
        });
        clickLoadedChoice(); WebView browser = (WebView) field(dialog, "webView");
        ui(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        awaitOrientation(android.content.res.Configuration.ORIENTATION_PORTRAIT);
        assertTrue("Rotation must keep the current interactive card open", dialog.isShowing());
        assertSame("Keep its live document rather than recreate the browser", browser, field(dialog, "webView"));
        ui(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        awaitOrientation(android.content.res.Configuration.ORIENTATION_LANDSCAPE);
        assertTrue(dialog.isShowing()); assertSame(browser, field(dialog, "webView"));
    }

    private void awaitOrientation(int orientation) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 6000;
        while (activity.getResources().getConfiguration().orientation != orientation && android.os.SystemClock.uptimeMillis() < deadline) Thread.sleep(60);
        getInstrumentation().waitForIdleSync();
        assertEquals(orientation, activity.getResources().getConfiguration().orientation);
    }

    public void testWorkerDismissReleasesBrowserOnUiThread() {
        WebView[] browser = {null};
        ui(() -> {
            dialog = new VisualizationDialog(activity, "Card", false);
            dialog.show();
            browser[0] = (WebView) field(dialog, "webView");
        });
        dialog.dismiss();
        getInstrumentation().waitForIdleSync();
        ui(() -> assertReleased(browser[0]));
    }

    public void testPageReplacementAndBackgroundReleaseOwnedCard() {
        int[] cancelled = {0};
        ui(() -> {
            for (String exit : new String[]{"releasePageViews", "onStop"}) {
                dialog = new VisualizationDialog(activity, "Card", false);
                dialog.show();
                ownDialog();
                WebView browser = (WebView) field(dialog, "webView");
                dialog.setOnDismissListener(ignored -> cancelled[0]++);
                var method = MainActivity.class.getDeclaredMethod(exit);
                method.setAccessible(true);
                method.invoke(activity);
                assertReleased(browser);
                assertNull("The Activity must drop its card owner on " + exit, field(activity, "visualizationDialog"));
            }
        });
        getInstrumentation().waitForIdleSync();
        assertEquals("Both exit paths must deliver the request-cancellation callback", 2, cancelled[0]);
    }

    public void testRepeatedCardCloseReleasesBrowsersWhileActivityStaysAlive() throws Exception {
        List<WeakReference<WebView>> browsers = new ArrayList<>();
        ui(() -> {
            for (int index = 0; index < 8; index++) {
                dialog = new VisualizationDialog(activity, "Card " + index, false);
                dialog.show();
                dialog.load("<p>Card content</p><script>setInterval(function(){},100)</script>");
                browsers.add(new WeakReference<>((WebView) field(dialog, "webView")));
                dialog.dismiss();
            }
            dialog = null;
        });
        for (int attempt = 0; attempt < 40; attempt++) {
            getInstrumentation().waitForIdleSync();
            System.gc(); System.runFinalization();
            if (allCollected(browsers)) return;
            Thread.sleep(150);
        }
        assertTrue("Closed card browsers must be collectable with their Activity still alive", allCollected(browsers));
    }

    private void assertReleased(WebView browser) throws Exception {
        assertFalse(dialog.isShowing());
        assertNull("The dialog must release its browser field", field(dialog, "webView"));
        assertNull("Destroy must detach the browser from its parent", browser.getParent());
    }

    private static boolean allCollected(List<WeakReference<WebView>> browsers) {
        for (WeakReference<WebView> browser : browsers) if (browser.get() != null) return false;
        return true;
    }

    private static boolean containsBrowser(View view) {
        if (view instanceof WebView) return true;
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++)
            if (containsBrowser(((ViewGroup) view).getChildAt(index))) return true;
        return false;
    }

}
