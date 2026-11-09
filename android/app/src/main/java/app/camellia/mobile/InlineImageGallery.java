package app.camellia.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class InlineImageGallery {
    private static final int STORAGE_PERMISSION = 927;
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "inline-image-export"); thread.setDaemon(true); return thread;
    });
    private static final Handler HANDLER = new Handler(Looper.getMainLooper());
    private static GalleryView active;
    private static PendingSave pending;

    static void show(Activity activity, InlineImageView selected) {
        List<InlineImageView> images = new ArrayList<>(); collect(activity.getWindow().getDecorView(), images);
        int position = images.indexOf(selected);
        if (position < 0) return;
        if (active != null) active.dialog.dismiss();
        Dialog dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        GalleryView gallery = new GalleryView(activity, images, position, dialog);
        dialog.setContentView(gallery); dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            window.setStatusBarColor(Color.BLACK); window.setNavigationBarColor(Color.BLACK);
        }
        active = gallery;
        dialog.setOnDismissListener(ignored -> {
            gallery.close();
            if (active == gallery) active = null;
        });
    }

    static void close(Activity activity) {
        if (active != null && active.activity == activity) active.dialog.dismiss();
        if (pending != null && pending.activity == activity) pending = null;
    }

    private static void collect(View view, List<InlineImageView> result) {
        if (view instanceof InlineImageView) result.add((InlineImageView) view);
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++)
            collect(((ViewGroup) view).getChildAt(index), result);
    }

    static void share(Activity activity, Bitmap bitmap, String alt) {
        if (bitmap == null) return;
        WORKER.execute(() -> {
            try {
                Uri uri = writeShare(activity, bitmap, alt);
                HANDLER.post(() -> {
                    if (activity.isDestroyed()) return;
                    Intent send = new Intent(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    send.setClipData(ClipData.newRawUri("image", uri));
                    try { activity.startActivity(Intent.createChooser(send, tr(activity, "分享图片", "Share image"))); }
                    catch (Exception error) { toast(activity, tr(activity, "没有可处理图片分享的应用。", "No app can share this image.")); }
                });
            } catch (Exception error) { toast(activity, tr(activity, "图片分享失败，请重试。", "Could not share this image. Try again.")); }
        });
    }

    static Uri writeShare(Context context, Bitmap bitmap, String alt) throws Exception {
        File directory = new File(context.getCacheDir(), "camera");
        if (!directory.exists() && !directory.mkdirs()) throw new java.io.IOException("Share directory unavailable");
        File file = new File(directory, "inline-share-" + UUID.randomUUID() + ".jpg");
        try (var output = new FileOutputStream(file)) {
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)) throw new java.io.IOException("Image encoding failed");
        } catch (Exception error) { file.delete(); throw error; }
        return CameraFileProvider.uri(context, file);
    }

    static void save(Activity activity, Bitmap bitmap, String alt) {
        if (bitmap == null) return;
        if (Build.VERSION.SDK_INT < 29 && activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pending = new PendingSave(activity, bitmap, alt);
            activity.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION);
            return;
        }
        WORKER.execute(() -> {
            try {
                writeGallery(activity, bitmap, alt);
                toast(activity, tr(activity, "已保存到相册。", "Saved to Photos."));
            } catch (Exception error) { toast(activity, tr(activity, "保存到相册失败，请检查相册权限后重试。", "Could not save to Photos. Check permission and try again.")); }
        });
    }

    static Uri writeGallery(Context context, Bitmap bitmap, String alt) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "Camellia-" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        if (Build.VERSION.SDK_INT >= 29) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Camellia");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
        }
        Uri collection = Build.VERSION.SDK_INT >= 29 ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        Uri uri = context.getContentResolver().insert(collection, values);
        if (uri == null) throw new java.io.IOException("Gallery insertion failed");
        try {
            try (var output = context.getContentResolver().openOutputStream(uri, "w")) {
                if (output == null || !bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)) throw new java.io.IOException("Image encoding failed");
            }
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues ready = new ContentValues(); ready.put(MediaStore.Images.Media.IS_PENDING, 0);
                context.getContentResolver().update(uri, ready, null, null);
            }
            return uri;
        } catch (Exception error) {
            context.getContentResolver().delete(uri, null, null); throw error;
        }
    }

    static void permissionResult(Activity activity, int request, int[] grants) {
        if (request != STORAGE_PERMISSION || pending == null || pending.activity != activity) return;
        PendingSave action = pending; pending = null;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) save(action.activity, action.bitmap, action.alt);
        else toast(activity, tr(activity, "需要相册写入权限才能保存图片。", "Photo library permission is required to save images."));
    }

    private static String tr(Context context, String zh, String en) {
        return context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? zh : en;
    }

    private static void toast(Context context, String message) {
        HANDLER.post(() -> Toast.makeText(context, message, Toast.LENGTH_SHORT).show());
    }

    private static final class PendingSave {
        final Activity activity; final Bitmap bitmap; final String alt;
        PendingSave(Activity activity, Bitmap bitmap, String alt) { this.activity = activity; this.bitmap = bitmap; this.alt = alt; }
    }

    @android.annotation.SuppressLint("ViewConstructor")
    static final class GalleryView extends FrameLayout {
        final Activity activity;
        final List<InlineImageView> images;
        final Dialog dialog;
        final ImageView image, incoming;
        final LinearLayout top, bottom;
        final TextView counter, status, share, save;
        final Set<InlineImageView> requested = Collections.newSetFromMap(new IdentityHashMap<>());
        int position, direction;
        float startX, startY;
        boolean tracking, dragging, settling;

        GalleryView(Activity activity, List<InlineImageView> images, int position, Dialog dialog) {
            super(activity); this.activity = activity; this.images = images; this.position = position; this.dialog = dialog;
            setTag("inlineImageGalleryView"); setBackgroundColor(Color.BLACK);
            image = page("inlineImageGalleryBitmap"); addView(image, new FrameLayout.LayoutParams(-1, -1));
            incoming = page("inlineImageGalleryIncoming"); incoming.setVisibility(GONE); addView(incoming, new FrameLayout.LayoutParams(-1, -1));
            status = new TextView(activity); status.setTag("inlineImageGalleryStatus"); status.setTextColor(Color.LTGRAY); status.setTextSize(15);
            status.setGravity(Gravity.CENTER); status.setPadding(dp(24), dp(16), dp(24), dp(16));
            FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER); addView(status, statusParams);
            top = new LinearLayout(activity); top.setGravity(Gravity.CENTER_VERTICAL);
            ImageButton close = new ImageButton(activity); close.setTag("inlineImageGalleryClose"); close.setImageDrawable(new LineIcon("close", Color.WHITE));
            close.setContentDescription(tr(activity, "关闭图片浏览器", "Close gallery")); close.setBackgroundColor(Color.TRANSPARENT); close.setPadding(dp(14), dp(14), dp(14), dp(14));
            close.setOnClickListener(view -> dialog.dismiss()); top.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
            counter = new TextView(activity); counter.setTag("inlineImageGalleryCounter"); counter.setTextColor(Color.WHITE); counter.setTextSize(16);
            counter.setGravity(Gravity.CENTER); top.addView(counter, new LinearLayout.LayoutParams(0, dp(48), 1));
            View spacer = new View(activity); top.addView(spacer, new LinearLayout.LayoutParams(dp(48), dp(48)));
            FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP); addView(top, topParams);
            bottom = new LinearLayout(activity); bottom.setGravity(Gravity.CENTER);
            share = action("inlineImageGalleryShare", tr(activity, "分享", "Share"));
            save = action("inlineImageGallerySave", tr(activity, "保存到相册", "Save to Photos"));
            bottom.addView(share, actionParams()); bottom.addView(save, actionParams());
            FrameLayout.LayoutParams bottomParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM); addView(bottom, bottomParams);
            share.setOnClickListener(view -> { InlineImageView current = current(); InlineImageGallery.share(activity, current.bitmap(), current.alt()); });
            save.setOnClickListener(view -> { InlineImageView current = current(); InlineImageGallery.save(activity, current.bitmap(), current.alt()); });
            image.setOnTouchListener((view, event) -> touch(event));
            setOnApplyWindowInsetsListener((view, insets) -> {
                int topInset, bottomInset;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                    topInset = safe.top; bottomInset = safe.bottom;
                } else {
                    topInset = insets.getSystemWindowInsetTop(); bottomInset = insets.getSystemWindowInsetBottom();
                    if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null)
                        topInset = Math.max(topInset, insets.getDisplayCutout().getSafeInsetTop());
                }
                applySafeInsets(topInset, bottomInset); return insets;
            });
            applySafeInsets(0, 0); showCurrent(); post(this::requestApplyInsets);
        }

        private ImageView page(String tag) {
            ImageView view = new ImageView(activity); view.setTag(tag); view.setScaleType(ImageView.ScaleType.FIT_CENTER); return view;
        }

        private int dp(float value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }

        void applySafeInsets(int topInset, int bottomInset) {
            top.setPadding(dp(8), topInset + dp(8), dp(8), dp(4));
            bottom.setPadding(dp(8), dp(8), dp(8), bottomInset + dp(16));
            image.setPadding(0, topInset + dp(64), 0, bottomInset + dp(80));
            incoming.setPadding(0, topInset + dp(64), 0, bottomInset + dp(80));
        }

        private TextView action(String tag, String label) {
            TextView view = new TextView(activity); view.setTag(tag); view.setText(label); view.setTextColor(Color.WHITE); view.setTextSize(16);
            view.setGravity(Gravity.CENTER); view.setMinHeight(dp(48)); view.setFocusable(true);
            GradientDrawable background = new GradientDrawable(); background.setColor(0xff262629); background.setCornerRadius(dp(14)); view.setBackground(background); return view;
        }

        private LinearLayout.LayoutParams actionParams() {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(52), 1); params.setMargins(dp(4), 0, dp(4), 0); return params;
        }

        InlineImageView current() { return images.get(position); }

        boolean fling(MotionEvent first, MotionEvent second) {
            float dx = second.getX() - first.getX(), dy = second.getY() - first.getY();
            if (Math.abs(dx) < dp(48) || Math.abs(dx) < Math.abs(dy) * 1.2f) return false;
            if (dx < 0) next(); else previous(); return true;
        }

        private boolean touch(MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN -> beginDrag(event.getRawX(), event.getRawY());
                case MotionEvent.ACTION_MOVE -> dragTo(event.getRawX(), event.getRawY());
                case MotionEvent.ACTION_UP -> releaseDrag(event.getRawX());
                case MotionEvent.ACTION_CANCEL -> cancelDrag();
                default -> { }
            }
            return true;
        }

        void beginDrag(float x, float y) {
            if (settling) return;
            startX = x; startY = y; tracking = true; dragging = false; direction = 0;
        }

        void dragTo(float x, float y) {
            if (!tracking || settling) return;
            float dx = x - startX, dy = y - startY;
            if (!dragging) {
                if (Math.abs(dx) < dp(12) && Math.abs(dy) < dp(12)) return;
                if (Math.abs(dx) <= Math.abs(dy) * 1.1f) { tracking = false; return; }
                direction = dx < 0 ? 1 : -1;
                int target = position + direction;
                if (target < 0 || target >= images.size()) { tracking = false; direction = 0; return; }
                dragging = true; prepareIncoming(target);
            }
            image.setTranslationX(dx); incoming.setTranslationX(dx + direction * pageWidth());
        }

        void releaseDrag(float x) {
            if (!tracking) return;
            tracking = false;
            if (!dragging) return;
            dragging = false; settle(Math.abs(x - startX) > pageWidth() / 8f);
        }

        private void cancelDrag() {
            tracking = false;
            if (dragging) { dragging = false; settle(false); }
        }

        private float pageWidth() { return getWidth() > 0 ? getWidth() : activity.getResources().getDisplayMetrics().widthPixels; }

        private void prepareIncoming(int target) {
            InlineImageView source = images.get(target);
            incoming.setImageBitmap(source.bitmap()); incoming.setContentDescription(source.alt());
            incoming.setTranslationX(direction * pageWidth()); incoming.setVisibility(VISIBLE);
            if (source.bitmap() == null) request(source);
        }

        private void settle(boolean commit) {
            settling = true;
            image.animate().translationX(commit ? -direction * pageWidth() : 0).setDuration(180);
            incoming.animate().translationX(commit ? 0 : direction * pageWidth()).setDuration(180).withEndAction(() -> {
                if (commit) position += direction;
                showCurrent();
                image.setTranslationX(0); incoming.setTranslationX(0); incoming.setVisibility(GONE); settling = false;
            });
        }

        private void resetDrag() {
            tracking = dragging = settling = false; direction = 0;
            image.animate().cancel(); incoming.animate().cancel();
            image.setTranslationX(0); incoming.setTranslationX(0); incoming.setVisibility(GONE);
        }

        void next() { resetDrag(); if (position + 1 < images.size()) { position++; showCurrent(); } }
        void previous() { resetDrag(); if (position > 0) { position--; showCurrent(); } }

        private void showCurrent() {
            InlineImageView current = current();
            counter.setText((position + 1) + " / " + images.size());
            image.setContentDescription(current.alt() + " · " + tr(activity, "左右滑动切换图片", "Swipe left or right to change image"));
            if (current.bitmap() != null) {
                image.setImageBitmap(current.bitmap()); status.setVisibility(GONE);
                share.setEnabled(true); save.setEnabled(true); share.setAlpha(1); save.setAlpha(1);
            } else {
                image.setImageDrawable(null); status.setVisibility(VISIBLE); status.setText(current.alt());
                share.setEnabled(false); save.setEnabled(false); share.setAlpha(.4f); save.setAlpha(.4f); request(current);
            }
        }

        private void request(InlineImageView source) {
            if (!requested.add(source)) return;
            source.load(new MarkdownView.ImageCallback() {
                @Override public void loaded(Bitmap bitmap) {
                    source.show(bitmap);
                    if (current() == source) showCurrent();
                    if (dragging && position + direction >= 0 && position + direction < images.size() && images.get(position + direction) == source)
                        incoming.setImageBitmap(bitmap);
                }
                @Override public void failed() {
                    if (current() == source) status.setText(tr(activity, "无法加载图片", "Unable to load image"));
                }
            });
        }

        void close() {
            resetDrag(); image.setImageDrawable(null); incoming.setImageDrawable(null); requested.clear();
        }
    }

    private InlineImageGallery() { }
}
