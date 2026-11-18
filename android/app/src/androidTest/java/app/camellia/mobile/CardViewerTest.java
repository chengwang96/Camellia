package app.camellia.mobile;

import android.content.Intent;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;
import android.widget.TextView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Viewer controls operate existing live documents, including tall non-responsive cards. */
public class CardViewerTest extends InstrumentationTestCase {
    private MainActivity activity;
    private VisualizationDialog dialog;
    private WebView browser;
    private interface Checked { void run() throws Exception; }
    private interface Condition { boolean check() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private Object field(Object owner, String name) throws Exception {
        var member = owner.getClass().getDeclaredField(name); member.setAccessible(true); return member.get(owner);
    }
    private void await(Condition condition, String message) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 6500;
        while (android.os.SystemClock.uptimeMillis() < deadline) { if (condition.check()) return; Thread.sleep(50); }
        assertTrue(message, condition.check());
    }
    private String evaluate(String code) throws Exception {
        AtomicReference<String> value = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        ui(() -> browser.evaluateJavascript(code, result -> { value.set(result); done.countDown(); }));
        assertTrue("The live document must answer", done.await(4, TimeUnit.SECONDS)); return value.get();
    }
    private JSONObject metrics() throws Exception {
        String key = (String) field(dialog, "viewportKey");
        String value = evaluate("(function(){var v=window[" + JSONObject.quote(key) + "];return v?v.state():{}})()");
        return value == null || value.equals("null") ? new JSONObject() : new JSONObject(value);
    }
    private View control(String tag) { return dialog.getWindow().getDecorView().findViewWithTag(tag); }
    private void mode(int index) throws Exception {
        ui(() -> {
            control("cardViewMode").performClick();
            ChoiceDropdown menu = (ChoiceDropdown) field(dialog, "viewMenu"); assertNotNull(menu);
            View row = menu.panel.findViewWithTag("dropdownChoice:" + index); assertNotNull(row); row.performClick();
        });
        String expected = index == 0 ? "width" : index == 1 ? "page" : "custom";
        await(() -> expected.equals(metrics().optString("mode")), "Viewer mode must be applied");
    }
    @Override protected void setUp() throws Exception {
        super.setUp();
        boolean tablet = getInstrumentation().getTargetContext().getResources().getConfiguration().smallestScreenWidthDp >= 600;
        getInstrumentation().getUiAutomation().setRotation(tablet ? android.app.UiAutomation.ROTATION_FREEZE_90 : android.app.UiAutomation.ROTATION_FREEZE_0);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .putExtra("testing", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            var foreground = MainActivity.class.getDeclaredField("foreground"); foreground.setAccessible(true); foreground.set(activity, false);
            String language = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments().getString("viewerLanguage", "zh");
            dialog = new VisualizationDialog(activity, "Card viewer · 超声硬件原始模型", !language.equals("en"));
            var owner = MainActivity.class.getDeclaredField("visualizationDialog"); owner.setAccessible(true); owner.set(activity, dialog);
            dialog.show(); browser = (WebView) field(dialog, "webView");
            dialog.load("<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><style>html,body{margin:0;min-height:100%;font:16px sans-serif;background:#fff;color:#1c2430}*{box-sizing:border-box}.controls{height:90px}button,input{min-height:44px;font:inherit}canvas{display:block;width:100%;height:100vh;background:#e3e8f1}footer{height:160px;padding:16px}</style>"
                + "<div class='controls'><input id='note' value='abcdef'><button id='choice' onclick='window.picks++'>Choose</button><input id='slider' type='range' value='73'></div>"
                + "<canvas id='drawing' width='160' height='120'></canvas><footer id='end'>Original STL · source and details</footer>"
                + "<script>window.identity={};window.canvasIdentity=drawing;window.picks=0;window.angle=0;drawing.onpointerdown=function(){window.angle++};drawing.getContext('2d').fillRect(0,0,20,20);</script>");
        });
        await(() -> "width".equals(metrics().optString("mode")) && control("cardViewMode").isEnabled(), "The viewer must be ready");
    }
    @Override protected void tearDown() throws Exception {
        try { ui(() -> { if (dialog != null) dialog.dismiss(); }); NativeActivityCleanup.finish(getInstrumentation(), activity); getInstrumentation().getUiAutomation().setRotation(android.app.UiAutomation.ROTATION_UNFREEZE); }
        finally { super.tearDown(); }
    }
    private void assertFits() throws Exception {
        JSONObject state = metrics();
        assertTrue(state.toString(), state.getDouble("contentWidth") * state.getDouble("scale") <= state.getDouble("width") + 2);
        assertTrue(state.toString(), state.getDouble("contentHeight") * state.getDouble("scale") <= state.getDouble("height") + 2);
        JSONObject bounds = new JSONObject(evaluate("({end:end.getBoundingClientRect().bottom,left:document.body.getBoundingClientRect().left,inner:[innerWidth,innerHeight,devicePixelRatio],visual:[visualViewport.width,visualViewport.height,visualViewport.scale],body:[document.body.offsetWidth,document.body.offsetHeight,document.body.scrollWidth,document.body.scrollHeight],rect:[document.body.getBoundingClientRect().width,document.body.getBoundingClientRect().height],zoom:getComputedStyle(document.body).zoom,meta:document.querySelector('meta[name=viewport]').content})"));
        bounds.put("viewer",state);
        if (bounds.getDouble("end") > state.getDouble("height") + 2) capture("fit-failure");
        assertTrue(bounds.toString(), bounds.getDouble("end") <= state.getDouble("height") + 2);
        assertTrue(bounds.toString(), bounds.getDouble("left") >= -2);
    }
    public void testWholeCardShowsTallExistingContentAndKeepsState() throws Exception {
        evaluate("note.value='retained draft';slider.value='41';window.saved=identity;true");
        mode(1); assertFits();
        assertEquals("true", evaluate("note.value==='retained draft'&&slider.value==='41'&&identity===saved&&drawing===canvasIdentity"));
        assertTrue(metrics().getDouble("scale") < 1);
        capture("whole-card");
        mode(0); assertEquals("retained draft", new org.json.JSONArray("[" + evaluate("note.value") + "]").getString(0));
        assertTrue(metrics().getDouble("contentHeight") > metrics().getDouble("height"));
    }
    public void testZoomAndResetLeaveCardControlsAndCanvasLive() throws Exception {
        ui(() -> { control("cardZoomIn").performClick(); control("cardZoomIn").performClick(); });
        await(() -> Math.abs(metrics().optDouble("scale") - 1.5625) < .001, "Rapid zoom taps must each apply");
        ui(() -> control("cardZoomReset").performClick());
        await(() -> Math.abs(metrics().optDouble("scale") - 1) < .001, "Reset must restore actual size");
        mode(1);
        tapElement("choice"); await(() -> "1".equals(evaluate("window.picks")), "Scaled controls must receive actual taps");
        tapElement("drawing"); await(() -> "1".equals(evaluate("window.angle")), "The card's own canvas gesture must still receive input");
        assertEquals("true", evaluate("drawing===canvasIdentity"));
    }
    public void testMoreBelowHintDisappearsAfterScrollingOrFitting() throws Exception {
        await(() -> control("cardMoreBelow").getVisibility() == View.VISIBLE, "Tall content must have a scroll affordance");
        capture("fit-width-more-below");
        ui(() -> browser.scrollTo(0, Math.round(100 * activity.getResources().getDisplayMetrics().density)));
        await(() -> control("cardMoreBelow").getVisibility() == View.GONE, "The hint must not cover scrolled controls");
        mode(1); assertFits();
        await(() -> control("cardMoreBelow").getVisibility() == View.GONE, "A fully visible card needs no overflow hint");
        swipeOverview();
        assertEquals("Overview must not scroll into blank space", 0, browser.getScrollY());
    }
    public void testModesAndManualScaleSurviveBothRotationsWithoutReload() throws Exception {
        evaluate("note.value='rotation draft';window.saved=identity;true"); mode(1);
        int original = activity.getResources().getConfiguration().orientation;
        rotate(original == android.content.res.Configuration.ORIENTATION_LANDSCAPE); assertFits();
        assertEquals("page", metrics().getString("mode"));
        ui(() -> control("cardZoomIn").performClick());
        await(() -> "custom".equals(metrics().optString("mode")), "Explicit zoom must enter manual mode");
        double manual = metrics().getDouble("scale");
        rotate(original != android.content.res.Configuration.ORIENTATION_LANDSCAPE);
        assertEquals(manual, metrics().getDouble("scale"), .001);
        assertSame(browser, field(dialog, "webView")); assertTrue(dialog.isShowing());
        assertEquals("true", evaluate("note.value==='rotation draft'&&identity===saved&&drawing===canvasIdentity"));
    }
    public void testViewerToolbarFitsAndRetainsTouchTargets() throws Exception {
        checkToolbar(); capture("toolbar");
        mode(1); checkToolbar();
        mode(2);
        await(() -> ((TextView)control("cardViewMode")).getText().toString().equals((boolean)field(dialog,"chinese") ? "缩放" : "Zoom"), "The current mode must appear in the toolbar");
        checkToolbar(); capture("toolbar-manual");
    }
    private void checkToolbar() throws Exception {
        ui(() -> {
            View header = control("cardViewerToolbar"); float density = activity.getResources().getDisplayMetrics().density;
            assertTrue(header.getHeight() <= Math.ceil(56 * density));
            for (String tag : new String[]{"cardViewMode","cardZoomOut","cardZoomReset","cardZoomIn"}) {
                View button = control(tag); Rect visible = new Rect(); assertTrue(tag, button.getGlobalVisibleRect(visible));
                assertTrue(tag + " width", visible.width() >= Math.floor(44 * density));
                assertTrue(tag + " height", visible.height() >= Math.floor(44 * density));
                TextView label = (TextView) button;
                assertTrue(tag + " text must fit", label.getPaint().measureText(label.getText().toString()) <= label.getWidth() - label.getCompoundPaddingLeft() - label.getCompoundPaddingRight() + 1);
            }
        });
    }
    public void testDynamicContentRefitsAndCloseReleasesViewerAndMenu() throws Exception {
        mode(1); double previous = metrics().getDouble("scale");
        evaluate("var extra=document.createElement('div');extra.style.height='2400px';extra.textContent='More details';document.body.insertBefore(extra,end);true");
        await(() -> metrics().getDouble("scale") < previous * .6, "Whole-card mode must refit changing content"); assertFits();
        ui(() -> { control("cardViewMode").performClick(); assertNotNull(field(dialog, "viewMenu")); dialog.dismiss(); assertNull(field(dialog, "webView")); assertNull(field(dialog, "viewMenu")); });
        assertFalse(dialog.isShowing());
    }
    public void testTypingContinuesAfterViewerZoomAndReset() throws Exception {
        ui(() -> browser.requestFocus());
        evaluate("note.focus();note.setSelectionRange(2,4);true");
        ui(() -> activity.getSystemService(android.view.inputmethod.InputMethodManager.class).showSoftInput(browser,0));
        await(() -> browser.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime()), "A real keyboard is required");
        ui(() -> control("cardZoomIn").performClick());
        await(() -> Math.abs(metrics().optDouble("scale") - 1.25) < .001, "Viewer zoom must apply while editing");
        getInstrumentation().sendStringSync("x"); await(() -> "\"abxef\"".equals(evaluate("note.value")), "The editor must still receive text at its selection");
        ui(() -> control("cardZoomReset").performClick());
        getInstrumentation().sendStringSync("y"); await(() -> "\"abxyef\"".equals(evaluate("note.value")), "Reset must retain the input connection");
    }
    private void tapElement(String id) throws Exception {
        JSONObject point = new JSONObject(evaluate("(function(){var r=document.getElementById(" + JSONObject.quote(id) + ").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"));
        int[] origin = new int[2]; ui(() -> browser.getLocationOnScreen(origin));
        float density = activity.getResources().getDisplayMetrics().density;
        float x = origin[0] + (float) point.getDouble("x") * density, y = origin[1] + (float) point.getDouble("y") * density;
        long now = android.os.SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0), up = MotionEvent.obtain(now,now+50,MotionEvent.ACTION_UP,x,y,0);
        try { getInstrumentation().sendPointerSync(down); getInstrumentation().sendPointerSync(up); } finally { down.recycle(); up.recycle(); }
    }
    private void swipeOverview() throws Exception {
        int[] origin = new int[2]; ui(() -> browser.getLocationOnScreen(origin));
        float x = origin[0] + browser.getWidth() * .8f;
        float start = origin[1] + browser.getHeight() * .8f, end = origin[1] + browser.getHeight() * .3f;
        long now = android.os.SystemClock.uptimeMillis();
        MotionEvent event = MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,start,0);
        getInstrumentation().sendPointerSync(event); event.recycle();
        for (int index = 1; index <= 8; index++) {
            event = MotionEvent.obtain(now,now+index*20,MotionEvent.ACTION_MOVE,x,start+(end-start)*index/8,0);
            getInstrumentation().sendPointerSync(event); event.recycle();
        }
        event = MotionEvent.obtain(now,now+180,MotionEvent.ACTION_UP,x,end,0);
        getInstrumentation().sendPointerSync(event); event.recycle(); getInstrumentation().waitForIdleSync();
    }
    private void rotate(boolean portrait) throws Exception {
        int oldWidth = browser.getWidth();
        ui(() -> activity.setRequestedOrientation(portrait ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        int orientation = portrait ? android.content.res.Configuration.ORIENTATION_PORTRAIT : android.content.res.Configuration.ORIENTATION_LANDSCAPE;
        await(() -> activity.getResources().getConfiguration().orientation == orientation && browser.getWidth() != oldWidth, "Rotation must resize the retained viewer");
        float density = activity.getResources().getDisplayMetrics().density;
        await(() -> Math.abs(metrics().optDouble("width") - browser.getWidth()/density) < 2, "The new viewport must reach the document");
    }
    private void capture(String name) throws Exception {
        Thread.sleep(120); var bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        var folder = new java.io.File(activity.getExternalFilesDir(null),"card-viewer"); assertTrue(folder.isDirectory() || folder.mkdirs());
        try (var out = new java.io.FileOutputStream(new java.io.File(folder,name+".png"))) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out); } finally { bitmap.recycle(); }
    }
}
