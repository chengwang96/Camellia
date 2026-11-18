package app.camellia.mobile;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
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
    private final ProgressBar loading;
    private final boolean chinese;
    private final String selectionKey = "__camelliaSelection" + java.util.UUID.randomUUID().toString().replace("-", "");
    private final String viewportKey = "__camelliaViewport" + java.util.UUID.randomUUID().toString().replace("-", "");
    private final Handler viewerHandler = new Handler(Looper.getMainLooper());
    private final TextView modeButton, zoomLabel, zoomOut, zoomIn, overflowHint;
    private ChoiceDropdown viewMenu;
    private String viewMode = "width";
    private double manualScale = 1, displayedScale = 1;
    private boolean documentReady;
    private boolean hardwareEditorPending;
    private final Runnable pollViewer = new Runnable() {
        @Override public void run() {
            WebView browser = webView;
            if (browser == null || !isShowing() || !documentReady) return;
            browser.evaluateJavascript("(function(){var v=window[" + JSONObject.quote(viewportKey) + "];return v?v.state():null})()", value -> {
                if (browser == webView && isShowing()) readViewportState(value);
            });
            viewerHandler.postDelayed(this, 750);
        }
    };
    private boolean preservingEditor;

    VisualizationDialog(Context context, String title, boolean chinese) {
        super(context);
        this.chinese = chinese;
        palette = Palette.of(context);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(palette.background);

        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setTag("cardViewerToolbar");
        header.setPadding(dp(12), dp(4), dp(4), dp(4));
        TextView heading = new TextView(context);
        heading.setText(title);
        heading.setTextSize(14);
        heading.setContentDescription(title);
        heading.setTextColor(palette.ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setSingleLine(true);
        heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        modeButton = viewerButton(chinese ? "适宽" : "Fit", "cardViewMode", chinese ? "卡片查看方式" : "Card view mode", this::showViewMenu);
        modeButton.setTextSize(12); compactModeIndicator(false);
        header.addView(modeButton, new LinearLayout.LayoutParams(dp(52), dp(44)));
        zoomOut = viewerButton("−", "cardZoomOut", chinese ? "缩小卡片" : "Zoom card out", () -> changeZoom(1 / 1.25));
        header.addView(zoomOut, new LinearLayout.LayoutParams(dp(44), dp(44)));
        zoomLabel = viewerButton("100%", "cardZoomReset", chinese ? "恢复卡片实际大小" : "Restore actual card size", () -> setViewMode("custom", 1));
        zoomLabel.setTextSize(12);
        header.addView(zoomLabel, new LinearLayout.LayoutParams(dp(48), dp(44)));
        zoomIn = viewerButton("+", "cardZoomIn", chinese ? "放大卡片" : "Zoom card in", () -> changeZoom(1.25));
        header.addView(zoomIn, new LinearLayout.LayoutParams(dp(44), dp(44)));
        TextView close = new TextView(context);
        close.setText(chinese ? "关闭" : "Close");
        close.setTextSize(13);
        close.setTextColor(palette.accent);
        close.setGravity(Gravity.CENTER);
        close.setMinWidth(dp(56));
        close.setMinHeight(dp(44));
        close.setPadding(dp(4), 0, dp(4), 0);
        close.setFocusable(true);
        GradientDrawable closeShape = rounded(palette.background, Palette.RADIUS_DIALOG_ACTION);
        closeShape.setStroke(dp(1), palette.cardBorder);
        close.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), closeShape, shape(Color.WHITE, Palette.RADIUS_DIALOG_ACTION)));
        SurfaceElevation.apply(close, 1);
        close.setOnClickListener(view -> dismiss());
        header.addView(close, new LinearLayout.LayoutParams(-2, -2));
        root.addView(header, new LinearLayout.LayoutParams(-1, -2));

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
                        applyViewport(); viewerHandler.removeCallbacks(pollViewer); viewerHandler.post(pollViewer);
                    });
                }
            }
        });
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
            window.getDecorView().requestApplyInsets();
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
        button.setMinHeight(dp(44)); button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, shape(Color.WHITE, 8)));
        button.setOnClickListener(ignored -> action.run()); return button;
    }

    private void showViewMenu() {
        if (!documentReady || webView == null) return;
        if (viewMenu != null) viewMenu.dismiss();
        String[] labels = chinese ? new String[]{"适应宽度", "完整显示", "实际大小（100%）"} : new String[]{"Fit width", "Show whole card", "Actual size (100%)"};
        int selected = viewMode.equals("width") ? 0 : viewMode.equals("page") ? 1 : Math.abs(manualScale - 1) < .001 ? 2 : -1;
        viewMenu = new ChoiceDropdown(modeButton, chinese ? "卡片查看方式" : "Card view mode", labels, selected, false,
            index -> setViewMode(index == 0 ? "width" : index == 1 ? "page" : "custom", 1));
        compactModeIndicator(true);
        viewMenu.onDismiss(() -> compactModeIndicator(false));
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
            zoomLabel.setText(scale < .001 ? "<0.1%" : scale < .1 ? String.format(java.util.Locale.ROOT, "%.1f%%", scale * 100) : Math.round(scale * 100) + "%");
            modeButton.setText(viewMode.equals("page") ? (chinese ? "全卡" : "All") : viewMode.equals("width") ? (chinese ? "适宽" : "Fit") : (chinese ? "缩放" : "Zoom"));
            zoomOut.setEnabled(scale > .0501); zoomIn.setEnabled(scale < 2.999);
            zoomOut.setAlpha(zoomOut.isEnabled() ? 1 : .35f); zoomIn.setAlpha(zoomIn.isEnabled() ? 1 : .35f);
            viewerHandler.post(this::updateOverflowHint);
        } catch (org.json.JSONException ignored) { /* A closed or not-yet-ready document reports null. */ }
    }

    private void setViewerEnabled(boolean enabled) {
        for (TextView button : new TextView[]{modeButton, zoomOut, zoomLabel, zoomIn}) {
            button.setEnabled(enabled); button.setAlpha(enabled ? 1 : .35f);
        }
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
        documentReady = false; viewerHandler.removeCallbacksAndMessages(null);
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
