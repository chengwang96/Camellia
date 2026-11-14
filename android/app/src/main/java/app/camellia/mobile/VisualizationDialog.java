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

/** One full-screen, network-isolated WebView for a mobile visualization card. */
final class VisualizationDialog extends Dialog {
    private final Palette palette;
    private final WebView webView;
    private final ProgressBar loading;
    private final boolean chinese;

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
        header.setPadding(dp(16), dp(8), dp(8), dp(8));
        TextView heading = new TextView(context);
        heading.setText(title);
        heading.setTextSize(Palette.TEXT_CARD);
        heading.setTextColor(palette.ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setSingleLine(true);
        heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        TextView close = new TextView(context);
        close.setText(chinese ? "关闭" : "Close");
        close.setTextSize(Palette.TEXT_ROW);
        close.setTextColor(palette.accent);
        close.setGravity(Gravity.CENTER);
        close.setMinWidth(dp(64));
        close.setMinHeight(dp(48));
        close.setPadding(dp(10), 0, dp(10), 0);
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
        webView = new WebView(context);
        webView.setBackgroundColor(palette.background);
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

            @Override public void onPageFinished(WebView view, String url) { loading.setVisibility(View.GONE); }
        });
        shell.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        loading = new ProgressBar(context);
        FrameLayout.LayoutParams loadingParams = new FrameLayout.LayoutParams(dp(36), dp(36), Gravity.CENTER);
        shell.addView(loading, loadingParams);
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
    }

    void load(String html) {
        loading.setVisibility(View.VISIBLE);
        webView.stopLoading();
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override public void show() {
        super.show();
        Window window = getWindow();
        if (window != null) window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
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
