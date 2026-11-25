package app.camellia.mobile;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import org.json.JSONObject;

/** One full-screen, network-isolated WebView for a mobile visualization card. */
final class VisualizationDialog extends Dialog {
    private final Palette palette;
    private WebView webView;
    /** Writes the card's interaction state back to the computer. */
    private java.util.function.Consumer<org.json.JSONObject> stateSink;
    private final ProgressBar loading;
    private final boolean chinese;
    private final String selectionKey = "__camelliaSelection" + java.util.UUID.randomUUID().toString().replace("-", "");
    private final String viewportKey = "__camelliaViewport" + java.util.UUID.randomUUID().toString().replace("-", "");
    private final Handler viewerHandler = new Handler(Looper.getMainLooper());
    private final TextView modeButton, zoomLabel, zoomOut, zoomIn, overflowHint;
    private final TextView presentButton, rotateButton;
    private final LinearLayout viewControls;
    private ChoiceDropdown viewMenu;
    private String viewMode = "width";
    /** Toolbar + status/navigation bars stay hidden while a presentation runs. */
    private boolean presenting;
    /** The card viewer owns a sensor orientation only while it is open. */
    private int savedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private boolean ownsOrientation;
    /** True while the rotate control pins the card to landscape. */
    private boolean landscapeLock;
    private LinearLayout header;
    private double manualScale = 1, displayedScale = 1;
    private boolean documentReady;
    private boolean hardwareEditorPending;
    private long lastStateSignature = Long.MIN_VALUE;
    private org.json.JSONObject pendingState;
    private final Runnable flushState = this::flushPendingState;
    private static final String STATE_KEY = "__camelliaCardState";
    private final Runnable pollViewer = new Runnable() {
        @Override public void run() {
            WebView browser = webView;
            if (browser == null || !isShowing() || !documentReady) return;
            browser.evaluateJavascript("(function(){var v=window[" + JSONObject.quote(viewportKey) + "];return v?v.state():null})()", value -> {
                if (browser == webView && isShowing()) readViewportState(value);
            });
            captureState();
            viewerHandler.postDelayed(this, 750);
        }
    };
    private boolean preservingEditor;

    VisualizationDialog(Context context, String title, boolean chinese) {
        super(context);
        this.chinese = chinese;
        palette = Palette.of(context);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setTitle(title);

        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(palette.background);

        LinearLayout header = new LinearLayout(context);
        this.header = header;
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setTag("cardViewerToolbar");
        header.setPadding(dp(6), dp(4), dp(6), dp(4));
        android.widget.ImageButton close = new android.widget.ImageButton(context);
        close.setTag("cardClose");
        close.setContentDescription(chinese ? "关闭卡片" : "Close card");
        close.setTooltipText(close.getContentDescription());
        LineIcon closeIcon = new LineIcon("close", palette.ink);
        close.setImageDrawable(closeIcon);
        close.setScaleType(android.widget.ImageView.ScaleType.FIT_XY);
        close.setPadding(dp(12), dp(12), dp(12), dp(12));
        close.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, shape(Color.WHITE, 8)));
        close.setOnClickListener(view -> dismiss());
        header.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
        header.addView(new View(context), new LinearLayout.LayoutParams(0, 0, 1));
        modeButton = viewerButton("", "cardViewMode", chinese ? "卡片查看方式" : "Card view mode", this::showViewMenu);
        modeButton.setTextSize(12);
        modeButton.setPadding(dp(10), 0, dp(8), 0);
        modeButton.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE),
            rounded(palette.card, 9), null));
        updateViewLabel();
        compactModeIndicator(false);
        header.addView(modeButton, new LinearLayout.LayoutParams(-2, dp(44)));
        header.addView(new View(context), new LinearLayout.LayoutParams(0, 0, 1));
        presentButton = viewerButton(chinese ? "演示" : "Present", "cardPresent",
            chinese ? "全屏演示卡片" : "Present the card full screen", this::togglePresenting);
        presentButton.setTextSize(12);
        presentButton.setPadding(dp(10), 0, dp(10), 0);
        boolean dark = Color.luminance(palette.background) < .5f;
        presentButton.setTextColor(dark ? Color.BLACK : Color.WHITE);
        LineIcon play = new LineIcon("play", presentButton.getCurrentTextColor());
        play.setBounds(0, 0, dp(15), dp(15));
        presentButton.setCompoundDrawablePadding(dp(4));
        presentButton.setCompoundDrawablesRelative(play, null, null, null);
        presentButton.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
            rounded(dark ? palette.accent : 0xff225cbd, 9), null));
        header.addView(presentButton, new LinearLayout.LayoutParams(-2, dp(44)));
        root.addView(header, new LinearLayout.LayoutParams(-1, -2));

        viewControls = new LinearLayout(context);
        viewControls.setOrientation(LinearLayout.VERTICAL);
        LinearLayout zoom = new LinearLayout(context);
        zoom.setBackground(rounded(palette.background, 9));
        zoomOut = viewerButton("−", "cardZoomOut", chinese ? "缩小卡片" : "Zoom card out", () -> changeZoom(1 / 1.25));
        zoomLabel = new TextView(context);
        zoomLabel.setText("100%");
        zoomLabel.setTag("cardZoomLevel");
        zoomLabel.setTextSize(13);
        zoomLabel.setGravity(Gravity.CENTER);
        zoomLabel.setTextColor(palette.ink);
        zoomIn = viewerButton("+", "cardZoomIn", chinese ? "放大卡片" : "Zoom card in", () -> changeZoom(1.25));
        for (TextView button : new TextView[]{zoomOut, zoomLabel, zoomIn}) {
            zoom.addView(button, new LinearLayout.LayoutParams(0, dp(44), 1));
        }
        viewControls.addView(zoom, new LinearLayout.LayoutParams(-1, -2));
        rotateButton = viewerButton(chinese ? "切换横屏" : "Rotate to landscape", "cardRotate",
            chinese ? "锁定横屏" : "Lock the card to landscape", this::toggleOrientation);
        viewControls.addView(rotateButton, new LinearLayout.LayoutParams(-1, dp(44)));

        FrameLayout shell = new FrameLayout(context);
        shell.setBackgroundColor(palette.background);
        webView = new WebView(context) {
            @Override public boolean onKeyPreIme(int keyCode, android.view.KeyEvent event) {
                // Key events reinjected by an IME can bypass dispatchKeyEvent.
                // Rebind before the original hardware key reaches that IME,
                // rather than finishing its old composition after dispatch.
                if (hardwareEditorPending && event.getAction() == android.view.KeyEvent.ACTION_DOWN
                    && (event.getFlags() & android.view.KeyEvent.FLAG_SOFT_KEYBOARD) == 0 && event.getUnicodeChar() > 0) {
                    hardwareEditorPending = false;
                    android.view.inputmethod.InputMethodManager input = getContext().getSystemService(android.view.inputmethod.InputMethodManager.class);
                    if (input != null) input.restartInput(this);
                }
                return super.onKeyPreIme(keyCode, event);
            }
            @Override public boolean onTouchEvent(android.view.MotionEvent event) {
                if (event.getActionMasked() == android.view.MotionEvent.ACTION_DOWN) hardwareEditorPending = false;
                return super.onTouchEvent(event);
            }
            @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
                super.onSizeChanged(width, height, oldWidth, oldHeight);
                if (width != oldWidth || height != oldHeight) viewerHandler.post(VisualizationDialog.this::applyViewport);
            }
            @Override protected void onScrollChanged(int x, int y, int oldX, int oldY) {
                super.onScrollChanged(x, y, oldX, oldY);
                if (viewMode.equals("page") && (x != 0 || y != 0)) scrollTo(0, 0);
                viewerHandler.post(VisualizationDialog.this::updateOverflowHint);
            }
            @Override public void onWindowFocusChanged(boolean focused) {
                // Capture before Chromium finalizes the old input connection.
                // By the Activity configuration callback its selection may
                // already have moved to the end of the field.
                if (!focused) preserveEditorForConfiguration();
                super.onWindowFocusChanged(focused);
            }
        };
        webView.getViewTreeObserver().addOnWindowFocusChangeListener(focused -> {
            if (focused && preservingEditor) restoreEditorSelection();
        });
        webView.setBackgroundColor(palette.background);
        webView.setVerticalScrollBarEnabled(true);
        webView.setHorizontalScrollBarEnabled(true);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBlockNetworkLoads(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl() == null ? "" : request.getUrl().getScheme();
                if ("data".equals(scheme) || "about".equals(scheme) || "blob".equals(scheme)) return null;
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (view == webView) {
                    loading.setVisibility(View.GONE); documentReady = true;
                    view.evaluateJavascript("(" + CardViewportScript.read(getContext()) + ")(" + JSONObject.quote(viewportKey) + ")", ignored -> {
                        if (view != webView || !isShowing()) return;
                        notifyDocumentPresentation(presenting);
                        applyViewport(); viewerHandler.removeCallbacks(pollViewer); viewerHandler.post(pollViewer);
                    });
                }
            }
        });
        android.view.GestureDetector gestures = new android.view.GestureDetector(context,
            new android.view.GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onFling(android.view.MotionEvent down, android.view.MotionEvent move,
                                                 float velocityX, float velocityY) {
                    float dx = move.getX() - down.getX(), dy = move.getY() - down.getY();
                    if (Math.abs(dx) < dp(56) || Math.abs(dx) <= Math.abs(dy) * 1.5f) return false;
                    sendPresentationCommand(dx < 0 ? "next" : "previous");
                    return true;
                }
            });
        bindPresentationGestures(gestures);
        shell.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        loading = new ProgressBar(context);
        FrameLayout.LayoutParams loadingParams = new FrameLayout.LayoutParams(dp(36), dp(36), Gravity.CENTER);
        shell.addView(loading, loadingParams);
        overflowHint = new TextView(context); overflowHint.setTag("cardMoreBelow");
        overflowHint.setText(chinese ? "下方还有内容 ↓" : "More below ↓");
        overflowHint.setTextSize(11); overflowHint.setTextColor(palette.ink);
        overflowHint.setPadding(dp(10), dp(5), dp(10), dp(5));
        GradientDrawable hintShape = rounded(palette.background, 12); hintShape.setStroke(dp(1), palette.cardBorder);
        overflowHint.setBackground(hintShape); overflowHint.setVisibility(View.GONE);
        FrameLayout.LayoutParams hintParams = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.END);
        hintParams.setMargins(dp(12), dp(8), dp(12), dp(12)); shell.addView(overflowHint, hintParams);
        root.addView(shell, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);

        Window window = getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(palette.background));
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(palette.background);
            window.setNavigationBarColor(palette.background);
            if (Build.VERSION.SDK_INT >= 30) {
                window.setDecorFitsSystemWindows(true);
                window.getInsetsController().setSystemBarsAppearance(0, 0);
            }
        }
        applyPresenting(false);
        setViewerEnabled(false);
    }

    void load(String html) {
        if (webView == null) return;
        documentReady = false; setViewerEnabled(false); viewerHandler.removeCallbacks(pollViewer);
        overflowHint.setVisibility(View.GONE);
        loading.setVisibility(View.VISIBLE);
        webView.stopLoading();
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /**
     * Cards keep their interaction state in window.camelliaVisualize.state.
     * Desktop persists it through IPC; the phone persists it through the
     * conversation-scoped state endpoint. Only the state object is sent, never
     * the token or the card document.
     */
    void setStateSink(java.util.function.Consumer<org.json.JSONObject> sink) { stateSink = sink; }

    private void captureState() {
        WebView browser = webView;
        java.util.function.Consumer<org.json.JSONObject> sink = stateSink;
        if (browser == null || !documentReady || sink == null) return;
        browser.evaluateJavascript("(function(){var h=window.camelliaVisualize;"
            + "if(!h||!h.state)return null;try{return JSON.stringify(h.state.get()||{});}catch(_){return null;}})()",
            value -> {
                if (browser != webView || value == null || "null".equals(value)) return;
                try {
                    String decoded = new org.json.JSONArray("[" + value + "]").getString(0);
                    org.json.JSONObject state = new org.json.JSONObject(decoded);
                    long signature = decoded.hashCode();
                    if (signature == lastStateSignature) return;
                    lastStateSignature = signature;
                    // Coalesce bursts (a dragged slider emits state on every
                    // tick) into one write a couple of seconds later.
                    pendingState = state;
                    viewerHandler.removeCallbacks(flushState);
                    viewerHandler.postDelayed(flushState, 1800);
                } catch (org.json.JSONException ignored) { /* A card may keep state internal. */ }
            });
    }

    private void flushPendingState() {
        org.json.JSONObject state = pendingState;
        java.util.function.Consumer<org.json.JSONObject> sink = stateSink;
        if (state == null || sink == null) return;
        pendingState = null;
        sink.accept(state);
    }

    @Override public void show() {
        if (webView == null) return;
        super.show();
        updateViewport();
    }

    @Override protected void onStart() { super.onStart(); DialogWindows.shown(getContext(), this); }

    void updateViewport() {
        if (webView == null || !isShowing()) return;
        if (viewMenu != null) { viewMenu.dismiss(); viewMenu = null; }
        Window window = getWindow();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            if (presenting) applyPresenting(true);
            else window.getDecorView().requestApplyInsets();
        }
        // Native viewport changes notify CSS media queries and ResizeObserver
        // without reloading the browser document or its interaction state.
        webView.requestLayout();
        viewerHandler.post(this::applyViewport);
        if (preservingEditor) webView.postOnAnimation(this::restoreEditorSelection);
    }

    private TextView viewerButton(String text, String tag, String description, Runnable action) {
        TextView button = new TextView(getContext()); button.setText(text); button.setTag(tag);
        button.setSingleLine(true);
        button.setTextSize(13); button.setGravity(Gravity.CENTER); button.setTextColor(palette.accent);
        button.setContentDescription(description); button.setTooltipText(description); button.setFocusable(true);
        button.setMinWidth(dp(44)); button.setMinHeight(dp(44));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, shape(Color.WHITE, 8)));
        button.setOnClickListener(ignored -> action.run()); return button;
    }

    private void showViewMenu() {
        if (!documentReady || webView == null) return;
        if (viewMenu != null && viewMenu.isShowing()) { viewMenu.dismiss(); return; }
        String[] labels = chinese ? new String[]{"适应宽度", "完整显示"} : new String[]{"Fit width", "Show whole card"};
        int selected = viewMode.equals("width") ? 0 : viewMode.equals("page") ? 1 : -1;
        viewMenu = new ChoiceDropdown(modeButton, chinese ? "卡片查看方式" : "Card view mode", labels, selected, false, Gravity.CENTER_HORIZONTAL, viewControls,
            index -> setViewMode(index == 0 ? "width" : "page", 1));
        compactModeIndicator(true);
        viewMenu.onDismiss(() -> {
            if (viewControls.getParent() instanceof ViewGroup parent) parent.removeView(viewControls);
            viewMenu = null;
            compactModeIndicator(false);
        });
    }

    private void compactModeIndicator(boolean expanded) {
        LineIcon arrow = new LineIcon(expanded ? "up" : "down", palette.accent);
        arrow.setBounds(0, 0, dp(8), dp(8)); modeButton.setCompoundDrawablePadding(dp(2));
        modeButton.setCompoundDrawablesRelative(null, null, arrow, null); modeButton.setSelected(expanded);
    }

    private void changeZoom(double factor) {
        double current = viewMode.equals("custom") ? manualScale : displayedScale;
        setViewMode("custom", Math.max(.05, Math.min(3, current * factor)));
    }

    private void setViewMode(String mode, double scale) {
        if (!documentReady || webView == null) return;
        viewMode = mode; manualScale = scale;
        webView.setVerticalScrollBarEnabled(!mode.equals("page")); webView.setHorizontalScrollBarEnabled(!mode.equals("page"));
        applyViewport();
    }

    private void applyViewport() {
        WebView browser = webView;
        if (!documentReady || browser == null || !isShowing() || browser.getWidth() == 0 || browser.getHeight() == 0) return;
        float density = getContext().getResources().getDisplayMetrics().density;
        String command = "(function(){var v=window[" + JSONObject.quote(viewportKey) + "];return v?v.update(" + browser.getWidth() / density + "," + browser.getHeight() / density + "," + JSONObject.quote(viewMode) + "," + manualScale + "):null})()";
        browser.evaluateJavascript(command, value -> { if (browser == webView && isShowing()) readViewportState(value); });
    }

    private void readViewportState(String value) {
        try {
            JSONObject state = new JSONObject(value); double scale = state.getDouble("scale");
            if (!viewMode.equals(state.optString("mode")) || !Double.isFinite(scale) || scale <= 0 || scale > 3) return;
            displayedScale = scale; setViewerEnabled(true);
            updateViewLabel();
            zoomOut.setEnabled(scale > .0501); zoomIn.setEnabled(scale < 2.999);
            zoomOut.setAlpha(zoomOut.isEnabled() ? 1 : .35f); zoomIn.setAlpha(zoomIn.isEnabled() ? 1 : .35f);
            viewerHandler.post(this::updateOverflowHint);
        } catch (org.json.JSONException ignored) { /* A closed or not-yet-ready document reports null. */ }
    }

    private void updateViewLabel() {
        String percent = displayedScale < .001 ? "<0.1%" : displayedScale < .1
            ? String.format(java.util.Locale.ROOT, "%.1f%%", displayedScale * 100)
            : Math.round(displayedScale * 100) + "%";
        if (zoomLabel != null) zoomLabel.setText(percent);
        String label = switch (viewMode) {
            case "page" -> chinese ? "全卡" : "All";
            case "width" -> chinese ? "适宽" : "Fit";
            default -> chinese ? "缩放" : "Zoom";
        };
        modeButton.setText(label + " · " + percent);
        modeButton.setContentDescription((chinese ? "卡片查看方式，" : "Card view mode, ") + label + ", " + percent);
        if (viewMenu != null) viewMenu.setSelected(viewMode.equals("width") ? 0 : viewMode.equals("page") ? 1 : -1);
    }

    private void setViewerEnabled(boolean enabled) {
        for (TextView button : new TextView[]{modeButton, zoomOut, zoomIn, presentButton, rotateButton}) {
            button.setEnabled(enabled); button.setAlpha(enabled ? 1 : .35f);
        }
    }

    /**
     * Immersive presentation: the toolbar disappears and the card draws edge to
     * edge. Bars are only transiently revealed by a swipe, which is the same
     * behaviour desktop fullscreen has; Android never lets an app suppress the
     * notification shade itself.
     */
    private void togglePresenting() {
        setPresenting(!presenting);
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (presenting && event.getKeyCode() == android.view.KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == android.view.KeyEvent.ACTION_UP) setPresenting(false);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void setPresenting(boolean active) {
        if (presenting == active) return;
        presenting = active;
        presentButton.setText(active ? (chinese ? "退出" : "Exit") : (chinese ? "演示" : "Present"));
        presentButton.setContentDescription(active
            ? (chinese ? "退出全屏演示" : "Exit the full-screen presentation")
            : (chinese ? "全屏演示卡片" : "Present the card full screen"));
        if (header != null) header.setVisibility(active ? View.GONE : View.VISIBLE);
        if (!active) applyPresenting(false);
        updateViewport();
        notifyDocumentPresentation(active);
    }

    /**
     * Cards key their fullscreen layout off data-viz-presenting. The mobile
     * viewer has no host page, so it sets the same flag the desktop bridge
     * would, letting a deck switch to its presentation stage.
     */
    private void notifyDocumentPresentation(boolean active) {
        WebView browser = webView;
        if (browser == null || !documentReady) return;
        browser.evaluateJavascript("(function(){if(window.__camelliaSetPresenting)window.__camelliaSetPresenting("
            + (active ? "true" : "false") + ");else{if(" + (active ? "true" : "false")
            + ")document.documentElement.setAttribute('data-viz-presenting','1');"
            + "else document.documentElement.removeAttribute('data-viz-presenting');"
            + "window.dispatchEvent(new CustomEvent('camellia:presentation',"
            + "{detail:{active:" + (active ? "true" : "false") + "}}));}})()", null);
    }

    /**
     * Presentation has no toolbar, so a horizontal swipe is the page turn.
     * Ordinary taps stay with the card: the document already handles them so
     * native controls keep working.
     */
    private void bindPresentationGestures(android.view.GestureDetector detector) {
        webView.setOnTouchListener((view, event) -> {
            if (presenting) detector.onTouchEvent(event);
            return false;
        });
    }

    private void sendPresentationCommand(String command) {
        WebView browser = webView;
        if (browser == null || !documentReady || !presenting) return;
        browser.evaluateJavascript("(function(command){if(window.__camelliaPresentationCommand)"
            + "window.__camelliaPresentationCommand(command);"
            + "else window.dispatchEvent(new CustomEvent('camellia:presentation-command',{detail:{command:command}}));"
            + "})(" + JSONObject.quote(command) + ")", null);
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused && presenting) applyPresenting(true);
    }

    @Override public void onBackPressed() {
        if (presenting) setPresenting(false);
        else super.onBackPressed();
    }

    private void applyPresenting(boolean active) {
        Window window = getWindow();
        if (window == null) return;
        if (active) window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        else window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            int cutoutMode = !active ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
                : Build.VERSION.SDK_INT >= 30 ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            if (attrs.layoutInDisplayCutoutMode != cutoutMode) {
                attrs.layoutInDisplayCutoutMode = cutoutMode;
                window.setAttributes(attrs);
            }
        }
        View decor = window.getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(!active);
            android.view.WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                if (active) {
                    controller.hide(android.view.WindowInsets.Type.systemBars());
                    controller.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    controller.show(android.view.WindowInsets.Type.systemBars());
                    controller.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_DEFAULT);
                }
            }
        } else {
            decor.setSystemUiVisibility(active
                ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
        decor.requestApplyInsets();
    }

    /** Locks the viewer to landscape (or releases it back to sensor portrait). */
    private void setOrientation(boolean landscape) {
        android.app.Activity activity = owningActivity();
        if (activity == null) return;
        if (!ownsOrientation) {
            savedOrientation = activity.getRequestedOrientation();
            ownsOrientation = true;
        }
        landscapeLock = landscape;
        activity.setRequestedOrientation(landscape
            ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
            : savedOrientation);
        if (rotateButton != null) {
            rotateButton.setText(landscape ? (chinese ? "跟随设备方向" : "Follow device orientation") : (chinese ? "切换横屏" : "Rotate to landscape"));
            rotateButton.setContentDescription(landscape
                ? (chinese ? "恢复跟随手机方向" : "Follow the device orientation again")
                : (chinese ? "锁定横屏" : "Lock the card to landscape"));
        }
    }

    private void toggleOrientation() {
        if (landscapeLock) releaseOrientation();
        else setOrientation(true);
    }

    private boolean isLandscape() {
        android.app.Activity activity = owningActivity();
        return activity != null
            && activity.getResources().getConfiguration().orientation
                == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
    }

    private void releaseOrientation() {
        android.app.Activity activity = owningActivity();
        if (activity == null) return;
        landscapeLock = false;
        activity.setRequestedOrientation(ownsOrientation ? savedOrientation
            : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        ownsOrientation = false;
        if (rotateButton != null) {
            rotateButton.setText(chinese ? "切换横屏" : "Rotate to landscape");
            rotateButton.setContentDescription(chinese ? "锁定横屏" : "Lock the card to landscape");
        }
    }

    private android.app.Activity owningActivity() {
        Context context = getContext();
        while (context instanceof android.content.ContextWrapper
            && !(context instanceof android.app.Activity)) {
            Context base = ((android.content.ContextWrapper) context).getBaseContext();
            if (base == context) return null;
            context = base;
        }
        return context instanceof android.app.Activity ? (android.app.Activity) context : null;
    }

    private void updateOverflowHint() {
        WebView browser = webView;
        if (browser != null) overflowHint.setVisibility(documentReady && !viewMode.equals("page") && browser.getScrollY() == 0 && browser.canScrollVertically(1) ? View.VISIBLE : View.GONE);
    }

    void preserveEditorForConfiguration() {
        if (webView == null || !isShowing()) return;
        preservingEditor = true;
        hardwareEditorPending = true;
        // Keep this state inside the document. No form text crosses a JS bridge.
        webView.evaluateJavascript("(function(){var k='" + selectionKey + "',old=window[k];if(old&&(old.retain?old.retain():old.restore()))return;if(old)old.clear();"
            + "var el=document.activeElement;if(!el||typeof el.selectionStart!=='number')return;"
            + "var start=el.selectionStart,end=el.selectionEnd,direction=el.selectionDirection,value=el.value,plan=null,compositionValue=null,compositionChanged=false;"
            + "var state={active:true,composing:false,start:start,end:end,retain:function(){return state.active&&el.isConnected&&document.activeElement===el&&(state.composing||state.restore())},restore:function(){if(!state.active||state.composing||!el.isConnected||document.activeElement!==el||el.value!==value)return false;"
            + "el.setSelectionRange(state.start,state.end,direction||'none');return true;},clear:function(){state.active=false;"
            + "el.removeEventListener('input',changed);el.removeEventListener('keydown',key,true);el.removeEventListener('compositionstart',startComposition,true);el.removeEventListener('compositionend',endComposition,true);document.removeEventListener('pointerdown',clear,true);"
            + "if(window[k]===state)delete window[k];}};"
            // A late IME acknowledgment may move the caret after the first
            // committed edit. Keep its known caret until the next user intent;
            // pointer/navigation actions and composition always take precedence.
            + "function clear(){state.clear()}function startComposition(){state.composing=true;compositionValue=el.value;compositionChanged=false;plan=null}"
            + "function endComposition(){state.composing=false;if(compositionChanged||el.value!==compositionValue){clear();return}value=el.value;state.restore();requestAnimationFrame(function(){state.restore()})}"
            + "function changed(){if(state.composing){if(el.value!==compositionValue)compositionChanged=true;return}if(el.value!==value){if(plan&&el.value===plan.value){value=el.value;state.start=state.end=plan.cursor;direction='none';plan=null;state.restore();requestAnimationFrame(function(){state.restore()})}else clear()}else requestAnimationFrame(function(){state.restore()})}"
            + "function key(event){if(event.ctrlKey||event.metaKey||event.altKey){clear();return}var a=state.start,b=state.end,t=null;"
            + "if(event.key.length===1)t=event.key;else if(event.key==='Backspace'){if(a===b)a=Math.max(0,a-1);t=''}else if(event.key==='Delete'){if(a===b)b=Math.min(value.length,b+1);t=''}"
            + "else if(event.key==='Enter'&&el.tagName==='TEXTAREA')t='\\n';else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Tab','Escape','Enter'].indexOf(event.key)>=0){clear();return}"
            + "if(t!==null){state.restore();plan={value:value.slice(0,a)+t+value.slice(b),cursor:a+t.length}}}"
            + "el.addEventListener('input',changed);el.addEventListener('keydown',key,true);el.addEventListener('compositionstart',startComposition,true);el.addEventListener('compositionend',endComposition,true);document.addEventListener('pointerdown',clear,true);"
            + "window[k]=state;})()", null);
    }

    private void restoreEditorSelection() {
        WebView view = webView;
        if (view == null || !isShowing() || !preservingEditor) return;
        view.evaluateJavascript("(function(){var s=window['" + selectionKey + "'];if(!s)return false;"
            + "requestAnimationFrame(function(){requestAnimationFrame(function(){s.restore()})});return s.restore();})()", null);
    }

    @Override public void dismiss() {
        // Dialog.dismiss() may be called by a cancellation worker; WebView teardown may not.
        if (Looper.myLooper() != Looper.getMainLooper()) {
            new Handler(Looper.getMainLooper()).post(this::dismiss);
            return;
        }
        releaseOrientation();
        if (presenting) setPresenting(false);
        releaseWebView();
        super.dismiss();
    }

    @Override protected void onStop() {
        DialogWindows.hidden(getContext(), this);
        releaseWebView();
        super.onStop();
    }

    private void releaseWebView() {
        WebView view = webView;
        if (view == null) return;
        // Clear ownership first: cancellation and late loads must not revive a closed card.
        webView = null;
        hardwareEditorPending = false;
        documentReady = false;
        // Flush the last held state before the timer that would have sent it
        // is cancelled, so closing the viewer never drops the final change.
        flushPendingState();
        viewerHandler.removeCallbacksAndMessages(null);
        if (viewMenu != null) { viewMenu.dismiss(); viewMenu = null; }
        preservingEditor = false;
        view.stopLoading();
        view.onPause();
        view.getSettings().setJavaScriptEnabled(false);
        view.setWebChromeClient(null);
        view.setWebViewClient(null);
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        view.removeAllViews();
        view.destroy();
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    private GradientDrawable shape(int color, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        return shape;
    }

    private GradientDrawable rounded(int color, int radius) { return shape(color, radius); }
}
