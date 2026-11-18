package app.camellia.mobile;

import android.app.UiAutomation;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.test.InstrumentationTestCase;
import android.webkit.WebView;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real Activity rotations and real browser reflow, through the card-opening path. */
public class VisualizationRotationTest extends InstrumentationTestCase {
    private MainActivity activity;
    private VisualizationDialog dialog;
    private CardApi request;
    private static final String CONVERSATION = "12345678-1234-1234-1234-123456789abc";
    private static final String CARD = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

    private static final String HTML = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
        + "<style>*{box-sizing:border-box}body{margin:0;padding:16px;font:18px sans-serif;color:#223;background:#f7f8fc}"
        + ".panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;min-width:0}section{padding:16px;background:white;border:1px solid #ccd;border-radius:12px;min-width:0}"
        + "button,input{min-height:44px;max-width:100%;font:inherit}input{width:100%;margin:8px 0}.plot{height:clamp(100px,36vh,360px);width:100%}"
        + "canvas{width:100%;height:100%;display:block}svg{width:100%;height:100px}@media(max-aspect-ratio:1/1){.panels{grid-template-columns:1fr}}"
        + "</style></head><body><h2>旋转适配 / Responsive card</h2><div class='panels'><section><button id='choice'>选择 / Choose</button>"
        + "<input id='note' placeholder='保留输入 / Keep input'><input id='slider' type='range' min='0' max='100' value='37'></section>"
        + "<section><div class='plot'><canvas id='plot'></canvas></div><svg id='diagram' viewBox='0 0 100 40' preserveAspectRatio='xMidYMid meet'>"
        + "<circle cx='50' cy='20' r='16' fill='#5067f5'/></svg></section></div>"
        + "<script>window.cardSession=String(Math.random());window.clicks=0;window.fits=0;choice.onclick=function(){window.clicks++;choice.textContent='Selected '+window.clicks};"
        + "function fit(){var r=plot.parentElement.getBoundingClientRect(),d=window.devicePixelRatio||1;plot.width=Math.round(r.width*d);plot.height=Math.round(r.height*d);"
        + "var c=plot.getContext('2d');c.fillStyle='#dce6ff';c.fillRect(0,0,plot.width,plot.height);c.fillStyle='#2640aa';c.font=(18*d)+'px sans-serif';c.fillText('Canvas '+slider.value,12*d,28*d);"
        + "window.fits++}new ResizeObserver(fit).observe(plot.parentElement);window.addEventListener('resize',fit);fit();</script></body></html>";

    @Override protected void setUp() throws Exception {
        super.setUp(); getInstrumentation().getUiAutomation().setRotation(UiAutomation.ROTATION_FREEZE_90);
        var context = getInstrumentation().getTargetContext(); new CredentialStore(context).clear();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            set("foreground", false); invoke("stopNetwork"); EmbeddedNetwork.setNetworkListener(null);
            set("credentials", new JSONObject().put("address", "http://100.80.1.22:43127").put("token", "r".repeat(43)));
            set("conversationId", CONVERSATION); set("conversationTitle", "Card rotation"); invoke("detailScreen");
        });
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (request != null) request.release.countDown();
            ui(() -> { if (dialog != null) dialog.dismiss(); });
            NativeActivityCleanup.finish(getInstrumentation(), activity);
            new CredentialStore(getInstrumentation().getTargetContext()).clear();
        } finally { super.tearDown(); }
    }

    public void testLoadedCardReflowsBothWaysWithoutReloadingOrLosingState() throws Exception {
        if (!tablet()) return;
        open(false); awaitPage();
        WebView browser = browser(); String session = metrics().getString("session");
        evaluate("choice.click();note.value='旋转后保留';slider.value='73';true");
        JSONObject landscape = metrics(); assertReflow(landscape, false);
        rotate(true);
        assertSame("Rotation must retain the live browser", browser, browser());
        JSONObject portrait = metrics(); assertReflow(portrait, true);
        assertState(portrait, session); assertTrue(portrait.getInt("fits") > landscape.getInt("fits"));
        capture("card-portrait");
        rotate(false);
        assertSame(browser, browser()); assertReflow(metrics(), false); assertState(metrics(), session);
        capture("card-landscape");
        assertEquals("Do not fetch the document again to rotate it", 1, request.calls);
        assertEquals(CONVERSATION, field("conversationId"));
    }

    public void testCardInputAcceptsTypingAfterBothRotations() throws Exception {
        assertTypingAfterRotations(true);
    }

    public void testHardwareKeysAlongsideSoftKeyboardAfterBothRotations() throws Exception {
        assertTypingAfterRotations(false);
    }

    private void assertTypingAfterRotations(boolean software) throws Exception {
        if (!tablet()) return;
        open(false); awaitPage();
        await(() -> dialog.getWindow().getDecorView().hasWindowFocus(), "The card must own its window before editing");
        WebView original = browser();
        ui(() -> original.requestFocus());
        evaluate("window.viewerEvents=[];function recordViewerEvent(e){var keys=Object.keys(window).filter(function(k){return k.indexOf('__camelliaSelection')===0});viewerEvents.push({type:e.type,key:e.key,input:e.inputType,composing:e.isComposing,dataLength:e.data?e.data.length:0,length:note.value.length,start:note.selectionStart,end:note.selectionEnd,cache:keys.map(function(k){return {start:window[k].start,end:window[k].end,active:window[k].active}})});if(viewerEvents.length>70)viewerEvents.shift()}['keydown','keyup','input','beforeinput','compositionstart','compositionend','selectionchange'].forEach(function(type){document.addEventListener(type,recordViewerEvent)});['resize','blur','focus'].forEach(function(type){window.addEventListener(type,recordViewerEvent)});true");
        evaluate("note.value='abcdef';note.focus();note.setSelectionRange(2,4);true");
        ui(() -> activity.getSystemService(android.view.inputmethod.InputMethodManager.class).showSoftInput(original, 0));
        await(() -> dialog.getWindow().getDecorView().getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()), "The card input must have a real keyboard");
        String expected = "abcdef"; int start = 2, end = 4;
        for (boolean portrait : new boolean[]{true, false, true, false}) {
            int oldWidth = original.getWidth(), expectedStart = start, expectedEnd = end;
            rotate(portrait, false);
            assertTrue(dialog.isShowing()); assertSame(original, browser());
            await(() -> original.getWidth() != oldWidth && original.hasWindowFocus(), "The card's resized window must receive input");
            // Activity configuration and window focus arrive before the system
            // rotation/IME animation finishes. Wait for the actual window event
            // stream to settle before exercising the resumed input connection.
            getInstrumentation().getUiAutomation().waitForIdle(500, 5000);
            await(() -> original.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime())
                && activity.getSystemService(android.view.inputmethod.InputMethodManager.class).isActive(original),
                "The rotated keyboard must reconnect to the retained browser");
            try {
                await(() -> "true".equals(evaluate("document.activeElement===note&&note.selectionStart===" + expectedStart + "&&note.selectionEnd===" + expectedEnd)),
                    "The HTML input must retain its selected range after rotation");
            } catch (junit.framework.AssertionFailedError error) {
                fail("Expected " + expectedStart + ":" + expectedEnd + "; " + evaluate("JSON.stringify({active:document.activeElement.id,start:note.selectionStart,end:note.selectionEnd,saved:Object.keys(window).filter(function(k){return k.indexOf('__camelliaSelection')===0}).map(function(k){return {start:window[k].start,end:window[k].end,active:window[k].active}}),events:viewerEvents})"));
            }
            String typed = portrait ? "x" : "y";
            expected = expected.substring(0, start) + typed + expected.substring(end);
            String afterKey = expected;
            if (software) tapSoftwareKey(typed); else getInstrumentation().sendStringSync(typed);
            getInstrumentation().waitForIdleSync();
            await(() -> afterKey.equals(metrics().getString("note")), "The resized card must receive the actual typed character");
            start++; end = start;
        }
        ui(() -> activity.getSystemService(android.view.inputmethod.InputMethodManager.class).hideSoftInputFromWindow(original.getWindowToken(), 0));
        await(() -> !original.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()), "The soft keyboard must close before hardware-only navigation");
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_MOVE_HOME);
        await(() -> "true".equals(evaluate("note.selectionStart===0&&note.selectionEnd===0")), "User navigation must override the retained caret");
        String afterHome = "k" + expected;
        getInstrumentation().sendStringSync("k");
        await(() -> afterHome.equals(metrics().getString("note")), "A new user caret must take precedence over rotation recovery");
        assertFalse("Hardware typing must not reopen a dismissed soft keyboard", original.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()));
    }

    private void tapSoftwareKey(String label) throws Exception {
        android.accessibilityservice.AccessibilityServiceInfo service = getInstrumentation().getUiAutomation().getServiceInfo();
        service.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        getInstrumentation().getUiAutomation().setServiceInfo(service);
        android.graphics.Rect bounds = new android.graphics.Rect();
        boolean found = false;
        for (android.view.accessibility.AccessibilityWindowInfo window : getInstrumentation().getUiAutomation().getWindows()) {
            android.view.accessibility.AccessibilityNodeInfo root = window.getRoot();
            if (root != null && "com.android.inputmethod.latin".contentEquals(root.getPackageName())) {
                android.view.accessibility.AccessibilityNodeInfo key = keyboardKey(root, label);
                if (key != null) { key.getBoundsInScreen(bounds); found = true; break; }
            }
        }
        if (!found) capture("keyboard-probe");
        assertTrue("The real soft keyboard must expose key " + label + "; windows=" + getInstrumentation().getUiAutomation().getWindows(), found && !bounds.isEmpty());
        long now = android.os.SystemClock.uptimeMillis();
        android.view.MotionEvent down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, bounds.exactCenterX(), bounds.exactCenterY(), 0);
        android.view.MotionEvent up = android.view.MotionEvent.obtain(now, now + 60, android.view.MotionEvent.ACTION_UP, bounds.exactCenterX(), bounds.exactCenterY(), 0);
        try {
            assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(down, true));
            assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(up, true));
        } finally { down.recycle(); up.recycle(); }
    }

    private android.view.accessibility.AccessibilityNodeInfo keyboardKey(android.view.accessibility.AccessibilityNodeInfo node, String label) {
        if (label.contentEquals(node.getText() == null ? "" : node.getText()) || label.contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription())) return node;
        for (int index = 0; index < node.getChildCount(); index++) {
            android.view.accessibility.AccessibilityNodeInfo child = node.getChild(index);
            if (child != null) { android.view.accessibility.AccessibilityNodeInfo found = keyboardKey(child, label); if (found != null) return found; }
        }
        return null;
    }

    public void testCardStillLoadingSurvivesRotationAndReceivesItsOriginalResponse() throws Exception {
        if (!tablet()) return;
        open(true); assertTrue(request.started.await(5, TimeUnit.SECONDS));
        WebView browser = browser(); rotate(true);
        assertFalse("Relayout must not cancel the card request", request.cancelled);
        assertSame(browser, browser());
        request.release.countDown(); awaitPage(); assertReflow(metrics(), true);
        assertEquals(1, request.calls); rotate(false); assertSame(browser, browser());
    }

    public void testClosingAfterRotationCancelsLoadingAndCannotReviveTheCard() throws Exception {
        if (!tablet()) return;
        open(true); assertTrue(request.started.await(5, TimeUnit.SECONDS)); rotate(true);
        ui(() -> dialog.dismiss());
        await(() -> field("visualizationDialog") == null, "Closing must release the card owner");
        assertTrue(request.cancelled); request.release.countDown();
        android.os.SystemClock.sleep(250); getInstrumentation().waitForIdleSync();
        rotate(false, false); assertFalse(dialog.isShowing()); assertNull(field("visualizationDialog"));
        assertNull(read(dialog, "webView"));
    }

    private void open(boolean blocked) throws Exception {
        request = new CardApi(blocked);
        ui(() -> {
            set("remoteClientFactory", (java.util.function.Function<String, RemoteApi>) address -> request);
            set("foreground", true);
            var open = MainActivity.class.getDeclaredMethod("openVisualization", JSONObject.class); open.setAccessible(true);
            open.invoke(activity, new JSONObject().put("cardId", CARD).put("title", "旋转适配"));
            dialog = (VisualizationDialog) field("visualizationDialog"); assertNotNull(dialog);
        });
    }

    private static final class CardApi extends RemoteApi {
        final CountDownLatch started = new CountDownLatch(1), release;
        volatile boolean cancelled; volatile int calls;
        CardApi(boolean blocked) { super("http://100.80.1.22:43127"); release = new CountDownLatch(blocked ? 1 : 0); }
        @Override JSONObject json(String path, String token, JSONObject payload, int limit) throws IOException {
            calls++; started.countDown();
            try {
                if (!release.await(20, TimeUnit.SECONDS)) throw new IOException("Fixture response was not released");
                return new JSONObject().put("card", new JSONObject().put("cardId", CARD).put("html", HTML));
            } catch (Exception error) { throw new IOException(error); }
        }
        @Override public void cancel() { cancelled = true; release.countDown(); }
    }

    private void rotate(boolean portrait) throws Exception { rotate(portrait, true); }
    private void rotate(boolean portrait, boolean cardOpen) throws Exception {
        ui(() -> activity.setRequestedOrientation(portrait ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT : ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        await(() -> activity.getResources().getConfiguration().orientation == (portrait ? Configuration.ORIENTATION_PORTRAIT : Configuration.ORIENTATION_LANDSCAPE), "The Activity must complete the real system rotation");
        if (cardOpen) {
            assertTrue("Rotating must not exit the current card", dialog.isShowing());
            assertSame(dialog, field("visualizationDialog"));
            if (request.release.getCount() == 0) await(() -> { JSONObject m=metrics(); return portrait ? m.optDouble("h") > m.optDouble("w") : m.optDouble("w") > m.optDouble("h"); }, "The card viewport must adopt its new aspect ratio");
        }
    }

    private void assertReflow(JSONObject metrics, boolean portrait) throws Exception {
        assertEquals(portrait ? 1 : 2, metrics.getInt("columns"));
        assertEquals("Canvas backing width follows its CSS size and display density", metrics.getDouble("canvasCss") * metrics.getDouble("dpr"), metrics.getDouble("canvasPixels"), 1.1);
        assertEquals("SVG must preserve its aspect ratio", metrics.getDouble("svgX"), metrics.getDouble("svgY"), .001);
        assertTrue(metrics.getDouble("svgWidth") <= metrics.getDouble("w"));
    }

    private void assertState(JSONObject metrics, String session) throws Exception {
        assertEquals(session, metrics.getString("session")); assertEquals(1, metrics.getInt("clicks"));
        assertEquals("旋转后保留", metrics.getString("note")); assertEquals("73", metrics.getString("slider"));
    }

    private JSONObject metrics() throws Exception {
        String encoded = evaluate("JSON.stringify({session:window.cardSession,w:innerWidth,h:innerHeight,columns:getComputedStyle(document.querySelector('.panels')).gridTemplateColumns.split(' ').length,"
            + "clicks:window.clicks,note:note.value,slider:slider.value,fits:window.fits,dpr:devicePixelRatio,canvasCss:plot.getBoundingClientRect().width,canvasPixels:plot.width,"
            + "svgX:diagram.getScreenCTM().a,svgY:diagram.getScreenCTM().d,svgWidth:diagram.getBoundingClientRect().width})");
        return new JSONObject(new JSONArray("[" + encoded + "]").getString(0));
    }

    private void awaitPage() throws Exception { await(() -> "true".equals(evaluate("!!window.cardSession")), "The card document must become interactive"); }
    private WebView browser() throws Exception { return (WebView) read(dialog, "webView"); }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch ready = new CountDownLatch(1);
        ui(() -> browser().evaluateJavascript(script, value -> { result.set(value); ready.countDown(); }));
        assertTrue("Browser script must finish", ready.await(5, TimeUnit.SECONDS)); return result.get();
    }
    private boolean tablet() { return activity.getResources().getConfiguration().smallestScreenWidthDp >= 600; }
    private Object field(String name) throws Exception { return read(activity, name); }
    private static Object read(Object owner, String name) throws Exception { var f=owner.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(owner); }
    private void set(String name,Object value) throws Exception { var f=MainActivity.class.getDeclaredField(name);f.setAccessible(true);f.set(activity,value); }
    private void invoke(String name) throws Exception { var m=MainActivity.class.getDeclaredMethod(name);m.setAccessible(true);m.invoke(activity); }
    private interface Checked { void run() throws Exception; }
    private interface Check { boolean run() throws Exception; }
    private void ui(Checked action) { AtomicReference<Throwable> error=new AtomicReference<>();getInstrumentation().runOnMainSync(()->{try{action.run();}catch(Throwable e){error.set(e);}});if(error.get()!=null)throw new AssertionError(error.get()); }
    private void await(Check check,String message) throws Exception { long deadline=android.os.SystemClock.uptimeMillis()+6000;while(!check.run()&&android.os.SystemClock.uptimeMillis()<deadline){Thread.sleep(80);getInstrumentation().waitForIdleSync();}assertTrue(message,check.run()); }
    private void capture(String name) throws Exception {
        await(() -> ((android.view.View) read(dialog, "loading")).getVisibility() == android.view.View.GONE,
            "The loaded card must replace its loading indicator");
        CountDownLatch painted = new CountDownLatch(1);
        ui(() -> browser().postVisualStateCallback(1, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) { painted.countDown(); }
        }));
        assertTrue("The browser must finish its visual update", painted.await(5, TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync(); android.os.SystemClock.sleep(200);
        var image = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var out = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        } finally { image.recycle(); }
    }
}
