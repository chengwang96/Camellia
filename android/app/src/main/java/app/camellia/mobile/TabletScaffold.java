package app.camellia.mobile;

import android.app.Activity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import java.util.function.Consumer;

/** Shared native tablet chrome. It owns system insets once, outside every pane. */
final class TabletScaffold {
    static final String CATEGORY_SCROLL = "tabletSettingsCategoryY";
    private static final java.util.WeakHashMap<ScrollView, Integer> pendingScroll = new java.util.WeakHashMap<>();
    private TabletScaffold() {}

    static int categoryScroll(View root) {
        ScrollView viewport = root == null ? null : root.findViewWithTag("tabletSettingsCategoryScroll");
        return viewport == null ? 0 : pendingScroll.getOrDefault(viewport, viewport.getScrollY());
    }

    static int savedCategoryScroll(Activity activity) {
        View root = activity.getWindow().getDecorView();
        return root.findViewWithTag("tabletSettingsCategoryScroll") == null
            ? activity.getIntent().getIntExtra(CATEGORY_SCROLL, 0) : categoryScroll(root);
    }

    static int consumeCategoryScroll(Activity activity, int fallback) {
        int y = activity.getIntent().getIntExtra(CATEGORY_SCROLL, fallback);
        activity.getIntent().removeExtra(CATEGORY_SCROLL); return Math.max(0, y);
    }

    static void restoreScroll(ScrollView viewport, int y) {
        pendingScroll.put(viewport, Math.max(0, y));
        if (viewport.isLaidOut() && viewport.getHeight() > 0) {
            viewport.scrollTo(0, pendingScroll.remove(viewport)); return;
        }
        viewport.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            public void onLayoutChange(View view, int l, int t, int r, int b, int ol, int ot, int or, int ob) {
                viewport.removeOnLayoutChangeListener(this);
                Integer target = pendingScroll.remove(viewport);
                if (target != null) viewport.scrollTo(0, target);
            }
        });
    }

    static void applyCategoryScroll(Activity activity) {
        ScrollView viewport = activity.getWindow().getDecorView().findViewWithTag("tabletSettingsCategoryScroll");
        if (viewport != null && activity.getIntent().hasExtra(CATEGORY_SCROLL))
            restoreScroll(viewport, consumeCategoryScroll(activity, categoryScroll(activity.getWindow().getDecorView())));
    }

    static void openSettingsCategory(Activity activity, android.content.Intent intent) {
        intent.putExtra(CATEGORY_SCROLL, categoryScroll(activity.getWindow().getDecorView()));
        PageTransitions.openDestination(activity, intent);
    }

    static View wrap(Activity activity, View body, String selected, Runnable home, Runnable sessions,
                     Runnable computers, Runnable settings) {
        SettingsStyle style = new SettingsStyle(activity);
        LinearLayout shell = new LinearLayout(activity); shell.setOrientation(LinearLayout.HORIZONTAL);
        shell.setTag("tabletScaffold"); shell.setBackground(style.palette().pageBackground());
        ScrollView rail = ScrollViews.plain(activity); rail.setFillViewport(true);
        rail.setTag("tabletRailViewport"); rail.setVerticalScrollBarEnabled(false);
        WorkbenchNavigation navigation = new WorkbenchNavigation(activity, selected, home, sessions, computers, settings, true);
        rail.addView(navigation, new ScrollView.LayoutParams(-1, -2));
        shell.addView(rail, new LinearLayout.LayoutParams(navigation.getMinimumWidth(), -1));
        View line = new View(activity); line.setBackgroundColor(style.palette().separator);
        shell.addView(line, new LinearLayout.LayoutParams(Math.max(1, style.dp(1)), -1));
        shell.addView(body, new LinearLayout.LayoutParams(0, -1, 1));
        shell.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = insets.getSystemWindowInsetLeft(), top = insets.getSystemWindowInsetTop();
            int right = insets.getSystemWindowInsetRight();
            int bottom = insets.getSystemWindowInsetBottom();
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout());
                left = safe.left; top = safe.top; right = safe.right;
                bottom = Math.max(safe.bottom, insets.getInsets(android.view.WindowInsets.Type.ime()).bottom);
            }
            view.setPadding(left, top, right, bottom);
            return insets;
        });
        return shell;
    }

    static View categories(Activity activity, String selected, Consumer<String> select) {
        SettingsStyle style = new SettingsStyle(activity);
        boolean zh = activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        LinearLayout panel = new LinearLayout(activity); panel.setOrientation(LinearLayout.VERTICAL);
        panel.setTag("tabletSettingsCategories"); panel.setBackgroundColor(style.background);
        panel.setPadding(style.dp(12), style.dp(10), style.dp(12), 0);
        android.widget.TextView heading = style.label(zh ? "设置" : "Settings", 20, style.ink);
        heading.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        heading.setGravity(android.view.Gravity.CENTER_VERTICAL); heading.setPadding(style.dp(10), 0, 0, 0);
        panel.addView(heading, new LinearLayout.LayoutParams(-1, style.dp(60)));
        ScrollView scroll = ScrollViews.plain(activity); scroll.setTag("tabletSettingsCategoryScroll");
        LinearLayout rows = new LinearLayout(activity); rows.setOrientation(LinearLayout.VERTICAL);
        String[][] items = {
            {"", "账户与连接", "Account & connection"},
            {"providers", "模型服务", "Model services"}, {"usage", "额度与用量", "Quota & usage"},
            {"network", "手机访问", "Mobile access"}, {"", "应用与权限", "Application & permissions"},
            {"general", "通用与外观", "General & appearance"}, {"reading", "阅读与显示", "Reading & display"},
            {"notifications", "通知控制", "Notifications"}, {"deviceName", "本机名称", "Device name"},
            {"", "数据与诊断", "Data & diagnostics"}, {"archived", "已归档", "Archived"},
            {"", "关于", "About"}, {"about", "Camellia 版本", "Camellia version"}
        };
        for (String[] item : items) {
            if (item[0].isEmpty()) {
                android.widget.TextView title = style.label(zh ? item[1] : item[2], Palette.TEXT_SMALL, style.secondary);
                title.setPadding(style.dp(10), style.dp(18), style.dp(10), style.dp(7)); rows.addView(title);
            } else {
                android.widget.TextView row = style.label(zh ? item[1] : item[2], 14, item[0].equals(selected) ? style.accent : style.ink);
                row.setGravity(android.view.Gravity.CENTER_VERTICAL); row.setMinHeight(style.dp(48));
                row.setPadding(style.dp(12), style.dp(7), style.dp(10), style.dp(7));
                row.setTag("tabletSettings:" + item[0]); row.setSelected(item[0].equals(selected)); row.setFocusable(true);
                int tint = item[0].equals(selected) ? android.graphics.Color.argb(20, android.graphics.Color.red(style.accent),
                    android.graphics.Color.green(style.accent), android.graphics.Color.blue(style.accent)) : android.graphics.Color.TRANSPARENT;
                row.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
                    style.round(tint, 10), style.round(android.graphics.Color.WHITE, 10)));
                row.setOnClickListener(v -> select.accept(item[0])); rows.addView(row, new LinearLayout.LayoutParams(-1, -2));
            }
        }
        scroll.addView(rows); panel.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); return panel;
    }

    static View settingsBody(Activity activity, View body, String selected, Consumer<String> select) {
        return settingsBody(activity, body, selected, select, consumeCategoryScroll(activity, 0));
    }

    static View settingsBody(Activity activity, View body, String selected, Consumer<String> select, int scrollY) {
        LinearLayout split = new LinearLayout(activity); split.setOrientation(LinearLayout.HORIZONTAL);
        split.setTag("tabletSettingsSplit"); split.addView(categories(activity, selected, select),
            new LinearLayout.LayoutParams(new SettingsStyle(activity).dp(248), -1));
        restoreScroll(split.findViewWithTag("tabletSettingsCategoryScroll"), scrollY);
        FrameLayout area = new FrameLayout(activity);
        ReadablePane readable = new ReadablePane(activity); readable.addView(body, new FrameLayout.LayoutParams(-1, -1));
        area.addView(readable, new FrameLayout.LayoutParams(-1, -1, android.view.Gravity.CENTER_HORIZONTAL));
        split.addView(area, new LinearLayout.LayoutParams(0, -1, 1)); return split;
    }

    private static final class ReadablePane extends FrameLayout {
        ReadablePane(Activity activity) { super(activity); }
        @Override protected void onMeasure(int width, int height) {
            int available = MeasureSpec.getSize(width);
            int cap = Math.round(864 * getResources().getDisplayMetrics().density);
            super.onMeasure(MeasureSpec.makeMeasureSpec(Math.min(available, cap), MeasureSpec.EXACTLY), height);
        }
    }
}
