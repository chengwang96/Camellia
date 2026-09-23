package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@android.annotation.SuppressLint("ViewConstructor")
final class ArtifactMessageView extends LinearLayout {
    private static final int VISIBLE_LIMIT = 4;
    private final ChatStyle style;
    private final boolean chinese;
    private final int border;

    ArtifactMessageView(Context context, List<String> names, boolean chinese, Runnable open) {
        super(context);
        this.chinese = chinese;
        style = new ChatStyle(context);
        border = Color.red(style.background) < 128 ? 0xff3b3b40 : 0xffe2e4e8;
        setOrientation(VERTICAL);
        setBackground(shape(style.background, 14, true));
        setClipToOutline(true);
        setPadding(style.dp(1), style.dp(1), style.dp(1), style.dp(1));
        List<String> files = new ArrayList<>(names);
        files.sort(java.util.Comparator.comparingInt(name -> priority(kind(name), extension(name))));
        LinearLayout overflow = new LinearLayout(context); overflow.setOrientation(VERTICAL);
        for (int index = 0; index < files.size(); index++) {
            LinearLayout parent = index < VISIBLE_LIMIT ? this : overflow;
            if (index > 0) divider(parent);
            parent.addView(fileRow(files.get(index), open), new LinearLayout.LayoutParams(-1, -2));
        }
        if (files.size() > VISIBLE_LIMIT) {
            overflow.setVisibility(GONE); overflow.setTag("artifactOverflow");
            addView(overflow, new LinearLayout.LayoutParams(-1, -2));
            divider(this);
            TextView more = text("", 13, style.muted); more.setTag("artifactShowMore");
            more.setPadding(style.dp(14), style.dp(12), style.dp(14), style.dp(12));
            more.setMinHeight(style.dp(48)); more.setGravity(Gravity.CENTER_VERTICAL);
            String label = chinese ? "显示另外 " + (files.size() - VISIBLE_LIMIT) + " 个文件" : "Show " + (files.size() - VISIBLE_LIMIT) + " more files";
            more.setText(label); more.setFocusable(true); more.setBackground(ripple());
            more.setOnClickListener(view -> {
                boolean expanded = overflow.getVisibility() == VISIBLE;
                overflow.setVisibility(expanded ? GONE : VISIBLE);
                more.setText(expanded ? label : tr("收起文件", "Show fewer files"));
            });
            addView(more, new LinearLayout.LayoutParams(-1, -2));
        }
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }

    private GradientDrawable shape(int color, int radius, boolean outlined) {
        GradientDrawable background = new GradientDrawable(); background.setColor(color); background.setCornerRadius(style.dp(radius));
        if (outlined) background.setStroke(style.dp(1), border);
        return background;
    }

    private RippleDrawable ripple() {
        return new RippleDrawable(ColorStateList.valueOf(0x224176e6), null, shape(Color.WHITE, 8, false));
    }

    private TextView text(String value, int size, int color) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(size); text.setTextColor(color); return text;
    }

    private void divider(LinearLayout parent) {
        View line = new View(getContext()); line.setBackgroundColor(border); line.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        parent.addView(line, new LinearLayout.LayoutParams(-1, style.dp(1)));
    }

    private LinearLayout fileRow(String name, Runnable open) {
        String kind = kind(name), extension = extension(name);
        LinearLayout row = new LinearLayout(getContext()); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(style.dp(12), style.dp(12), style.dp(12), style.dp(12));
        row.setTag("artifactRow:" + name);
        LinearLayout file = new LinearLayout(getContext()); file.setGravity(Gravity.CENTER_VERTICAL);
        file.setFocusable(true); file.setBackground(ripple()); file.setOnClickListener(view -> open.run());
        file.setContentDescription(name + " · " + category(kind) + " · " + tr("查看会话产物", "View conversation files"));
        row.addView(file, new LinearLayout.LayoutParams(0, -2, 1));
        int color = kind.equals("pdf") ? 0xffed5362 : kind.equals("spreadsheet") ? 0xff29875c
            : kind.equals("presentation") ? 0xffc86b31 : kind.equals("package") ? 0xff3b6fd4 : style.accent;
        TextView icon = text(extension, 10, color); icon.setGravity(Gravity.CENTER); icon.setTypeface(null, Typeface.BOLD);
        icon.setBackground(shape(style.surface, 10, false)); icon.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        file.addView(icon, new LinearLayout.LayoutParams(style.dp(38), style.dp(48)));
        LinearLayout info = new LinearLayout(getContext()); info.setOrientation(VERTICAL);
        LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(0, -2, 1); infoParams.setMarginStart(style.dp(10));
        file.addView(info, infoParams);
        TextView title = text(name, 15, style.ink); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setSingleLine(true); title.setEllipsize(TextUtils.TruncateAt.MIDDLE); title.setTag("artifactName:" + name);
        info.addView(title);
        TextView meta = text(category(kind) + " · " + extension, 12, style.muted); meta.setPadding(0, style.dp(4), 0, 0);
        meta.setSingleLine(true); meta.setEllipsize(TextUtils.TruncateAt.END); info.addView(meta);
        TextView action = text(tr("查看", "View"), 13, style.ink); action.setGravity(Gravity.CENTER);
        action.setMinHeight(style.dp(48)); action.setPadding(style.dp(10), style.dp(8), style.dp(10), style.dp(8));
        action.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), shape(Color.TRANSPARENT, 9, true), shape(Color.WHITE, 9, false)));
        action.setTag("artifactAction:" + name); action.setFocusable(true);
        action.setContentDescription(tr("查看会话产物：", "View conversation files: ") + name);
        action.setOnClickListener(view -> open.run());
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-2, -2); actionParams.setMarginStart(style.dp(8)); row.addView(action, actionParams);
        return row;
    }

    private static String extension(String name) { return name.substring(name.lastIndexOf('.') + 1).toUpperCase(Locale.ROOT); }

    private static String kind(String name) {
        String extension = extension(name);
        if (List.of("APK", "EXE", "MSI", "DMG", "DEB", "RPM").contains(extension)) return "package";
        if (extension.equals("PDF")) return "pdf";
        if (List.of("DOC", "DOCX").contains(extension)) return "word";
        if (List.of("XLS", "XLSX", "CSV", "TSV").contains(extension)) return "spreadsheet";
        if (List.of("PPT", "PPTX").contains(extension)) return "presentation";
        if (List.of("PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG").contains(extension)) return "image";
        if (List.of("MP4", "WEBM").contains(extension)) return "video";
        if (List.of("MP3", "WAV").contains(extension)) return "audio";
        return "text";
    }

    private static int priority(String kind, String extension) {
        if (kind.equals("package")) return 0;
        if (List.of("image", "video", "presentation").contains(kind) || List.of("MD", "HTML", "HTM").contains(extension)) return 1;
        return 2;
    }

    private String category(String kind) {
        switch (kind) {
            case "package": return tr("安装包", "Package");
            case "spreadsheet": return tr("表格", "Spreadsheet");
            case "presentation": return tr("演示文稿", "Presentation");
            case "image": return tr("图片", "Image");
            case "video": return tr("视频", "Video");
            case "audio": return tr("音频", "Audio");
            case "text": return tr("文本", "Text");
            default: return tr("文档", "Document");
        }
    }
}
