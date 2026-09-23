package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.ImageView;
import android.widget.ImageButton;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Locale;
import java.util.TreeMap;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class MainActivity extends Activity {
    private static final int PICK_IMAGE_REQUEST = 42;
    private static final int TAKE_PHOTO_REQUEST = 43;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final LocationConsent locationConsent = new LocationConsent(this);

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        locationConsent.permissionResult(requestCode);
    }
    private final ExecutorService worker = Executors.newFixedThreadPool(2);
    private final ExecutorService commandWorker = Executors.newSingleThreadExecutor();
    private final java.util.concurrent.ThreadPoolExecutor statusWorker = (java.util.concurrent.ThreadPoolExecutor) Executors.newFixedThreadPool(4);
    private final TreeMap<Long, JSONObject> history = new TreeMap<>();
    private ComputerStore store;
    private RemoteListCache listCache;
    private final RemotePrefetch prefetch = new RemotePrefetch();
    private RemoteReplyState replyState;
    private JSONObject outgoingMessage;
    private long commandCheckDeadline;
    private JSONObject credentials = new JSONObject();
    private long editingSeq = -1;
    private String editingText = "";
    private RemoteApi api;
    private Future<?> job;
    private volatile int generation;
    private boolean foreground;
    private boolean backgroundConnection;
    private JSONObject displayedConversation;
    private boolean chinese;
    private int background, surface, ink, muted, accent;
    private LinearLayout root, content, messages;
    private PageTransitions pages;
    private MarkdownView markdown;
    private final LinkedHashMap<String, View> renderedMessages = new LinkedHashMap<>();
    private TextView status;
    private ScrollView scroll;
    private boolean initialMessageScroll;
    private ScrollView pendingScrollView;
    private android.view.ViewTreeObserver.OnPreDrawListener pendingMessageScroll;
    private int pendingScrollPosition;
    private long messageScrollRevision;
    private EditText addressInput, nameInput, codeInput;
    private String conversationId;
    private String conversationTitle = "";
    private Long nextBefore;
    private boolean historyLimited;
    private boolean olderLoading;
    private int nextOffset;
    private final LinkedHashMap<String, JSONObject> conversations = new LinkedHashMap<>();
    private final LinkedHashMap<String, Boolean> collapsedGroups = new LinkedHashMap<>();
    private Button older;
    private String instance = "";
    private long cursor = -1;
    private JSONObject pendingSnapshot;
    private JSONObject lastLive;
    private boolean snapshotPosted;
    private EditText composer;
    private ChatComposer chatComposer;
    private ImageButton sendButton, stopButton;
    private TextView retryMessage;
    private LinearLayout approvals;
    private boolean controlAllowed, connected, commandBusy;
    private long conversationSeq;
    private String approvalSignature = "";
    private boolean networkScreen;
    private android.app.Dialog computerDialog;
    private android.net.Uri cameraImageUri;
    private java.io.File cameraImageFile;
    private EditText searchInput;
    private JSONArray availableWorkspaces = new JSONArray();
    private boolean canCreate, canCreateWorkspace, canImage, canMultiImage, allowIndependent, canMove, canArchive;
    private ConversationMenu conversationPopup;
    private boolean canManageConversations, selectingConversations;
    private final java.util.Set<String> selectedConversations = new java.util.LinkedHashSet<>();
    private String listInstance = "", imageConversation, imageComputer;
    private long listCursor = -1;
    private final ArrayList<String> selectedImages = new ArrayList<>();
    private boolean loadingImages;
    private boolean listEventsUnavailable;
    private LinearLayout imageTray;
    private android.widget.HorizontalScrollView imageStrip;
    private ImageButton attachButton;
    private TextView modelButton;
    private ImageButton permissionButton;
    private JSONObject remoteSettings;
    private RemoteSettingsPopup settingsPopup;
    private String screen = "home", networkReturn = "settings";
    private String preferenceSignature;
    private final Runnable searchRemote = () -> { if (screen.equals("list")) loadList(false); };
    private final LinkedHashMap<String, String> computerStates = new LinkedHashMap<>();
    private final java.util.Set<RemoteApi> statusClients = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private boolean loginLaunched;
    private final ExecutorService networkWorker = Executors.newSingleThreadExecutor();
    private RemoteEntryGate remoteEntryGate;
    private RemoteEntryGate.State remoteEntryState = RemoteEntryGate.State.CONNECTING;
    private LinearLayout remoteEntryCard;
    private TextView remoteEntryLabel;
    private View remoteEntryArrow, remoteEntrySpinner, remoteEntryRetry;

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private ChatStyle chatStyle;
    private ArtifactDownloads artifactDownloads;

    @Override protected void attachBaseContext(android.content.Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }

    @Override protected void onResume() {
        super.onResume();
        if (foreground && backgroundConnection) {
            backgroundConnection = false;
            RemoteKeepAliveService.finish(this, true);
        }
        if (!MobilePreferences.signature(this).equals(preferenceSignature)) recreate();
        if (getIntent().getBooleanExtra("showDownload", false) && artifactDownloads != null) {
            getIntent().removeExtra("showDownload"); artifactDownloads.showProgress();
        }
    }

    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        EmbeddedNetwork.initialize(getApplicationContext());
        remoteEntryGate = new RemoteEntryGate(networkWorker, () -> {
            if (!EmbeddedNetwork.online()) return RemoteEntryGate.State.OFFLINE;
            if (!EmbeddedNetwork.enabled()) return RemoteEntryGate.State.READY;
            JSONObject state = new JSONObject(EmbeddedNetwork.node().status());
            if (!EmbeddedNetwork.online()) return RemoteEntryGate.State.OFFLINE;
            String phase = state.optString("state");
            if (phase.equals("Running")) return RemoteEntryGate.State.READY;
            if (phase.equals("NeedsLogin") || phase.equals("NeedsMachineAuth") || !state.optString("loginUrl").isEmpty()) return RemoteEntryGate.State.SIGN_IN;
            return RemoteEntryGate.State.CONNECTING;
        }, this::renderRemoteEntry);
        preferenceSignature = MobilePreferences.signature(this);
        chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        chatStyle = new ChatStyle(this);
        artifactDownloads = new ArtifactDownloads(this, saved);
        background = chatStyle.background; surface = chatStyle.surface; ink = chatStyle.ink; muted = chatStyle.muted; accent = chatStyle.accent;
        getWindow().setStatusBarColor(background); getWindow().setNavigationBarColor(background);
        markdown = new MarkdownView(this, ink, muted, surface, accent);
        if (android.os.Build.VERSION.SDK_INT >= 27 && !dark) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        store = new ComputerStore(new CredentialStore(this));
        listCache = new RemoteListCache(new CredentialStore(this, "remote-list-cache"));
        String recovery = null;
        try {
            credentials = store.load();
            if (credentials.has("address")) new Endpoint(credentials.getString("address"));
        } catch (Exception error) {
            credentials = new JSONObject();
            recovery = ErrorDetails.withSummary(tr("无法解密设备凭据，请重新配对。", "Device credentials could not be decrypted. Pair again."), error);
        }
        if (saved != null && credentials.has("token")) {
            conversationId = saved.getString("conversationId");
            conversationTitle = saved.getString("conversationTitle", "");
        }
        String restored = saved == null ? "home" : saved.getString("screen", "home");
        if (restored.equals("detail") && conversationId != null) detailScreen();
        else if (restored.equals("list") && credentials.has("token")) listScreen();
        else if (restored.equals("pair")) pairScreen();
        else if (restored.equals("network")) { networkReturn = saved.getString("networkReturn", "settings"); screen = "network"; showNetwork(); }
        else if (restored.equals("computers")) computersScreen();
        else if (restored.equals("settings")) settingsScreen();
        else homeScreen();
        if (recovery != null) status.setText(recovery);
    }

    @Override protected void onStart() {
        super.onStart();
        boolean retained = backgroundConnection && RemoteKeepAliveService.active() && api != null;
        foreground = true;
        backgroundConnection = false;
        RemoteKeepAliveService.finish(this, true);
        EmbeddedNetwork.setNetworkListener(this::networkRouteChanged);
        EmbeddedNetwork.foreground();
        if (retained) {
            if (screen.equals("detail") && displayedConversation != null) {
                replies().markRead(credentials, displayedConversation);
                syncReplyRead(displayedConversation);
            }
            updateControls();
            return;
        }
        if (networkScreen) { refreshNetwork(false); return; }
        if (screen.equals("computers")) { refreshComputers(); return; }
        if (screen.equals("home")) { refreshHomeNetwork(); return; }
        if (screen.equals("settings")) return;
        if (credentials.has("token")) {
            if (conversationId != null) connectEvents(); else loadList(false);
        } else if (credentials.has("claim")) waitForApproval();
    }

    private void networkRouteChanged() {
        if (!networkActive()) return;
        if (screen.equals("home")) { refreshHomeNetwork(); return; }
        if (!screen.equals("computers") && !screen.equals("list") && !screen.equals("detail")) return;
        artifactDownloads.stop();
        if (!EmbeddedNetwork.online()) {
            stopNetwork(); updateControls();
            status.setText(tr("网络已断开，联网后自动重连。未确认的消息不会重复发送。", "Offline. Reconnecting when the network returns; unconfirmed messages will not be resent."));
            return;
        }
        if (screen.equals("computers")) refreshComputers();
        else if (credentials.has("token")) {
            if (screen.equals("detail")) connectEvents(); else loadList(false);
        }
    }

    @Override protected void onPause() {
        super.onPause();
        if (!isFinishing() && !isChangingConfigurations() && api != null && credentials.has("token")
                && (screen.equals("detail") || screen.equals("list"))) {
            backgroundConnection = RemoteKeepAliveService.begin(this, this::endBackgroundConnection);
        }
    }

    private boolean networkActive() {
        return foreground || backgroundConnection && RemoteKeepAliveService.active();
    }

    private void endBackgroundConnection() {
        backgroundConnection = false;
        if (!foreground) {
            stopNetwork();
            EmbeddedNetwork.setNetworkListener(null);
            EmbeddedNetwork.endBackground();
        }
    }

    @Override protected void onStop() {
        persistDraft();
        artifactDownloads.stop();
        if (conversationPopup != null) conversationPopup.dismiss();
        locationConsent.cancel();
        if (pages != null) pages.finishTransition();
        foreground = false;
        remoteEntryGate.stop();
        prefetch.cancel();
        if (!backgroundConnection || !RemoteKeepAliveService.active() || isFinishing() || isChangingConfigurations()) {
            RemoteKeepAliveService.finish(this, false);
            backgroundConnection = false;
            stopNetwork();
            EmbeddedNetwork.setNetworkListener(null);
        }
        EmbeddedNetwork.background();
        super.onStop();
    }

    @Override public void onUserInteraction() {
        super.onUserInteraction();
        prefetch.interaction();
    }

    @Override protected void onDestroy() {
        RemoteKeepAliveService.finish(this, false);
        artifactDownloads.close();
        if (computerDialog != null) computerDialog.dismiss();
        if (listCache != null) listCache.close();
        prefetch.close();
        stopNetwork(); worker.shutdownNow(); commandWorker.shutdownNow(); statusWorker.shutdownNow(); networkWorker.shutdownNow(); super.onDestroy();
    }

    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        artifactDownloads.save(saved);
        saved.putString("screen", screen); saved.putString("networkReturn", networkReturn);
        if (conversationId != null) { saved.putString("conversationId", conversationId); saved.putString("conversationTitle", conversationTitle); }
    }

    private void stopNetwork() {
        if (remoteEntryGate != null) remoteEntryGate.stop();
        prefetch.cancel();
        olderLoading = false;
        if (settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        connected = false;
        commandBusy = false;
        if (scroll instanceof RefreshScrollView) ((RefreshScrollView) scroll).setRefreshing(false);
        generation++;
        statusWorker.getQueue().clear();
        handler.removeCallbacksAndMessages(null);
        if (job != null) job.cancel(true);
        RemoteApi previous = api;
        api = null;
        if (previous != null) new Thread(previous::cancel, "camellia-disconnect").start();
        for (RemoteApi client : statusClients) new Thread(client::cancel, "camellia-status-disconnect").start();
        statusClients.clear();
        synchronized (this) { pendingSnapshot = null; snapshotPosted = false; }
    }

    private RemoteApi begin() {
        stopNetwork();
        updateControls();
        api = new RemoteApi(credentials.optString("address"));
        return api;
    }

    private void deliver(int ticket, Runnable action) {
        handler.post(() -> { if (networkActive() && ticket == generation) action.run(); });
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setLayoutParams(new LinearLayout.LayoutParams(-1, -2)); return layout;
    }

    private GradientDrawable rounded(int color) {
        return chatStyle.rounded(color);
    }

    private android.graphics.drawable.Drawable interactive(int color) {
        return new RippleDrawable(ColorStateList.valueOf((accent & 0x00ffffff) | 0x22000000), rounded(color), rounded(Color.WHITE));
    }

    private GradientDrawable capsule(int color) {
        return chatStyle.capsule(color);
    }

    private ColorStateList enabledColors(int enabled, int disabled) {
        return new ColorStateList(new int[][] { new int[] { -android.R.attr.state_enabled }, new int[] {} }, new int[] { disabled, enabled });
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextColor(color); view.setTextSize(size);
        view.setLineSpacing(dp(3), 1); view.setPadding(0, dp(6), 0, dp(6)); return view;
    }

    private Button button(String label, Runnable action, boolean primary) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setTextSize(14);
        button.setTextColor(enabledColors(primary ? Color.WHITE : ink, muted));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf((accent & 0x00ffffff) | 0x22000000), capsule(primary ? accent : surface), capsule(Color.WHITE)));
        button.setBackgroundTintList(enabledColors(primary ? accent : surface, surface));
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); button.setStateListAnimator(null);
        button.setMinHeight(dp(48)); button.setPadding(dp(14), dp(8), dp(14), dp(8));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(8), 0, dp(8)); button.setLayoutParams(params);
        button.setOnClickListener(view -> action.run()); return button;
    }

    private void shell(String title, String subtitle) {
        if (conversationPopup != null) conversationPopup.dismiss();
        locationConsent.cancel();
        boolean settingsPage = screen.equals("settings") || screen.equals("network");
        int bottomPadding = screen.equals("list") || screen.equals("detail") ? chatStyle.dockBottomPadding() : dp(24);
        SettingsStyle settingsStyle = new SettingsStyle(this);
        int pageBackground = settingsPage ? settingsStyle.background : background;
        root = column(); root.setBackgroundColor(background); root.setPadding(dp(22), dp(12), dp(22), bottomPadding);
        root.setBackgroundColor(pageBackground); getWindow().setStatusBarColor(pageBackground); getWindow().setNavigationBarColor(pageBackground);
        root.setClipToPadding(false);
        if (screen.equals("detail")) { root.setFocusableInTouchMode(true); root.requestFocus(); }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(18) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(), dp(18) + insets.getSystemWindowInsetRight(), bottomPadding + insets.getSystemWindowInsetBottom());
            return insets;
        });
        if (pages == null) pages = new PageTransitions(this);
        int depth = screen.equals("home") ? 0 : screen.equals("computers") || screen.equals("settings") ? 1
            : screen.equals("detail") || (screen.equals("network") && networkReturn.equals("pair")) ? 3 : 2;
        pages.show(root, screen, depth); root.requestApplyInsets();
        if (settingsPage) {
            root.addView(settingsStyle.header(title, tr("返回上一级", "Back"), this::onBackPressed));
        } else if (screen.equals("computers")) {
            LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(0, dp(4), 0, dp(16));
            header.setClipChildren(false); header.setClipToPadding(false);
            header.addView(chatStyle.backButton(tr("返回上一级", "Back"), this::onBackPressed), new LinearLayout.LayoutParams(dp(48), dp(48)));
            TextView heading = text(title, 20, ink); heading.setTag("remoteControlTitle");
            heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.setPadding(dp(14), 0, 0, 0);
            header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
            if (!subtitle.isEmpty()) root.addView(text(subtitle, 12, muted));
        } else if (screen.equals("list") || screen.equals("detail")) {
            LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(0, 0, 0, dp(18));
            header.setClipChildren(false); header.setClipToPadding(false);
            header.addView(chatStyle.backButton(tr("返回上一级", "Back"), this::onBackPressed), new LinearLayout.LayoutParams(dp(48), dp(48)));
            LinearLayout titles = column(); titles.setPadding(dp(10), 0, 0, 0);
            TextView pageTitle = text(screen.equals("detail") ? conversationTitle : "Camellia", 19, ink);
            pageTitle.setTag("pageTitle"); pageTitle.setMaxLines(1); pageTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            pageTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); titles.addView(pageTitle);
            LinearLayout computer = new LinearLayout(this); computer.setGravity(Gravity.CENTER_VERTICAL);
            ImageView icon = new ImageView(this); icon.setImageDrawable(new LineIcon("computer", muted)); computer.addView(icon, new LinearLayout.LayoutParams(dp(14), dp(14)));
            TextView name = text(computerName(credentials), 12, muted); name.setTag("headerComputerName"); name.setPadding(dp(6), 0, 0, 0);
            name.setMaxLines(1); name.setEllipsize(android.text.TextUtils.TruncateAt.END); computer.addView(name); titles.addView(computer);
            header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
            if (screen.equals("detail")) {
                TextView artifacts = text(tr("产物", "Files"), 13, ink);
                LineIcon folder = new LineIcon("folder", ink); folder.setBounds(0, 0, dp(22), dp(22));
                artifacts.setCompoundDrawables(null, folder, null, null); artifacts.setCompoundDrawablePadding(dp(3));
                artifacts.setSingleLine(true); artifacts.setLineSpacing(0, 1);
                artifacts.setMinHeight(dp(52));
                artifacts.setGravity(Gravity.CENTER); artifacts.setFocusable(true);
                artifacts.setContentDescription(tr("查看产物 · 下载到手机", "Files · Save to phone"));
                artifacts.setBackground(chatStyle.rounded(surface));
                artifacts.setOnClickListener(view -> artifactDownloads.show(credentials.optString("address"), credentials.optString("token"), conversationId));
                artifacts.setTag("remoteArtifacts"); header.addView(artifacts, new LinearLayout.LayoutParams(dp(56), LinearLayout.LayoutParams.WRAP_CONTENT));
            }
        } else {
        LinearLayout brand = new LinearLayout(this); brand.setGravity(Gravity.CENTER_VERTICAL); brand.setPadding(0, dp(4), 0, dp(12));
        brand.setClipChildren(false); brand.setClipToPadding(false);
        ImageView logo = new ImageView(this); logo.setImageResource(R.drawable.desktop_logo); logo.setContentDescription("Camellia");
        brand.addView(logo, new LinearLayout.LayoutParams(dp(32), dp(32)));
        TextView wordmark = text("Camellia", 16, ink); wordmark.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); wordmark.setPadding(dp(10), 0, 0, 0);
        brand.addView(wordmark, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(brand);
        if (!screen.equals("home")) {
            ImageButton back = chatStyle.backButton(tr("返回上一级", "Back"), this::onBackPressed);
            LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(dp(48), dp(48)); backParams.setMarginEnd(dp(12));
            brand.addView(back, 0, backParams);
        }
        if (!title.isEmpty()) {
            TextView heading = text(title, 24, ink); heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); root.addView(heading);
        }
        if (!subtitle.isEmpty()) root.addView(text(subtitle, 12, muted));
        }
        status = text("", 11, muted); status.setTag("connectionStatus"); status.setGravity(Gravity.CENTER); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        bindStatusDetails();
        scroll = new RefreshScrollView(this); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        content = column(); content.setPadding(0, 0, 0, dp(16)); scroll.addView(content);
        if (settingsPage) { content.setPadding(0, dp(12), 0, dp(16)); scroll.setVerticalScrollBarEnabled(false); }
        root.addView(status);
    }

    private ImageButton lineButton(String icon, String label, Runnable action) {
        return chatStyle.lineButton(icon, label, action);
    }

    private LinearLayout bottomBar(String tag) {
        chatStyle.dockStatus(status);
        status.setMaxLines(1); status.setMinLines(1); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        root.removeView(status);
        int scrollIndex = root.indexOfChild(scroll);
        LinearLayout.LayoutParams stageParams = (LinearLayout.LayoutParams) scroll.getLayoutParams();
        root.removeView(scroll);
        android.widget.FrameLayout stage = new android.widget.FrameLayout(this); stage.setTag(tag + "Stage");
        stage.setClipChildren(false); stage.setClipToPadding(false);
        android.widget.FrameLayout viewport = new android.widget.FrameLayout(this);
        viewport.setClipChildren(true); viewport.setClipToPadding(true);
        viewport.addView(scroll, new android.widget.FrameLayout.LayoutParams(-1, -1));
        stage.addView(viewport, new android.widget.FrameLayout.LayoutParams(-1, -1));
        LinearLayout dock = column(); dock.setTag(tag + "Dock"); dock.setBackground(chatStyle.dockBackdrop());
        dock.setClipChildren(false); dock.setClipToPadding(false);
        dock.addView(chatStyle.dockFade(tag), new LinearLayout.LayoutParams(-1, chatStyle.dockFadeHeight()));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setTag(tag);
        bar.setClipChildren(false); bar.setClipToPadding(false);
        if (!tag.equals("searchBar")) chatStyle.floatingBar(bar);
        bar.setPadding(dp(6), dp(6), dp(6), dp(6));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(8));
        dock.addView(bar, params);
        status.setBackgroundColor(background); status.setLayoutParams(new LinearLayout.LayoutParams(-1, -2)); dock.addView(status);
        android.widget.FrameLayout.LayoutParams dockParams = new android.widget.FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        chatStyle.reserveDockSpace(dock, content);
        stage.addView(dock, dockParams); root.addView(stage, scrollIndex, stageParams); return bar;
    }

    private EditText input(String label, String value, int type) {
        return input(content, label, value, type);
    }

    private EditText input(LinearLayout parent, String label, String value, int type) {
        parent.addView(text(label, 12, muted));
        EditText input = new EditText(this); input.setSingleLine(true); input.setTextSize(15); input.setTextColor(ink); input.setHintTextColor(muted);
        input.setInputType(type); input.setText(value); input.setPadding(dp(18), dp(12), dp(18), dp(12)); input.setBackground(capsule(surface));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); input.setContentDescription(label);
        parent.addView(new SettingsField(input), new LinearLayout.LayoutParams(-1, -2)); return input;
    }

    private String computerName(JSONObject computer) {
        return computer.optString("computerName", tr("我的电脑", "My computer"));
    }

    private void homeScreen() {
        stopNetwork(); screen = "home"; networkScreen = false; conversationId = null;
        shell("", "");
        TextView heading = text(tr("开始工作", "Start working"), 28, ink);
        heading.setPadding(0, dp(12), 0, dp(6)); content.addView(heading);
        TextView description = text(tr("选择一种方式，继续你的工作。", "Choose how you want to continue."), 14, muted);
        description.setPadding(0, 0, 0, dp(18)); content.addView(description);
        homeCard("phone", tr("本地聊天", "Local chat"), tr("手机直连 API，在本地工作区中继续会话。", "Connect directly to your API. Keep workspaces and chats on this phone."),
            tr("进入本地聊天", "Open local chat"), "localChatEntry", () -> {
                startActivity(new android.content.Intent(this, LocalChatActivity.class)); PageTransitions.openActivity(this);
            });
        remoteEntryCard = homeCard("computer", tr("远程控制", "Remote control"), tr("连接你的电脑，查看会话并继续远程工作。", "Connect to your computers and continue working remotely."),
            tr("正在连接网络…", "Connecting to network…"), "remoteControlEntry", () -> {
                if (remoteEntryState != RemoteEntryGate.State.READY) return;
                if (!EmbeddedNetwork.online()) { refreshHomeNetwork(); return; }
                computersScreen(); refreshComputers();
            });
        remoteEntryLabel = remoteEntryCard.findViewWithTag("remoteControlEntryAction");
        remoteEntryArrow = remoteEntryCard.findViewWithTag("remoteControlEntryArrow");
        LinearLayout remoteFooter = (LinearLayout) remoteEntryLabel.getParent(); remoteFooter.setGravity(Gravity.CENTER_VERTICAL);
        remoteEntrySpinner = new LoadingIndicator(this); remoteEntrySpinner.setTag("remoteEntryLoading");
        remoteFooter.addView(remoteEntrySpinner, new LinearLayout.LayoutParams(dp(20), dp(20)));
        remoteEntryRetry = button(tr("重试连接", "Retry connection"), this::refreshHomeNetwork, false); remoteEntryRetry.setTag("remoteEntryRetry");
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(-1, -2); retryParams.bottomMargin = dp(16);
        content.addView(remoteEntryRetry, retryParams);
        renderRemoteEntry(RemoteEntryGate.State.CONNECTING);
        LinearLayout settings = new LinearLayout(this); settings.setGravity(Gravity.CENTER_VERTICAL); settings.setPadding(dp(18), dp(14), dp(18), dp(14));
        settings.setBackground(interactive(surface)); settings.setTag("settingsEntry"); settings.setFocusable(true);
        ImageView icon = new ImageView(this); icon.setImageDrawable(new LineIcon("settings", muted)); settings.addView(icon, new LinearLayout.LayoutParams(dp(24), dp(24)));
        LinearLayout labels = column(); labels.setPadding(dp(14), 0, 0, 0);
        labels.addView(text(tr("设置", "Settings"), 16, ink)); labels.addView(text(tr("供应商与 Key、通用、已归档、手机访问", "Providers & keys, general, archived, mobile access"), 12, muted));
        settings.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView settingsArrow = new ImageView(this); settingsArrow.setImageDrawable(new LineIcon("right", muted));
        settingsArrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        settings.addView(settingsArrow, new LinearLayout.LayoutParams(dp(18), dp(18)));
        settings.setOnClickListener(view -> settingsScreen()); content.addView(settings);
        status.setVisibility(View.GONE);
        if (foreground) refreshHomeNetwork();
    }

    private void refreshHomeNetwork() {
        if (!foreground || !screen.equals("home")) return;
        if (!EmbeddedNetwork.enabled()) {
            remoteEntryGate.stop();
            renderRemoteEntry(EmbeddedNetwork.online() ? RemoteEntryGate.State.READY : RemoteEntryGate.State.OFFLINE);
        } else remoteEntryGate.start();
    }

    private void renderRemoteEntry(RemoteEntryGate.State state) {
        if (!screen.equals("home") || remoteEntryCard == null) return;
        remoteEntryState = state;
        boolean ready = state == RemoteEntryGate.State.READY;
        String label = switch (state) {
            case READY -> tr("进入远程控制", "Open remote control");
            case CONNECTING -> tr("正在连接网络…", "Connecting to network…");
            case OFFLINE -> tr("网络已断开，等待联网", "Offline · waiting for network");
            case SIGN_IN -> tr("请先在「设置 → 手机访问」登录或授权设备", "Sign in or authorize this device in Settings → Mobile access");
            case TIMED_OUT -> tr("连接超时，请重试或在「设置 → 手机访问」检查", "Connection timed out · retry, or check Settings → Mobile access");
            case FAILED -> tr("网络初始化失败，请重试", "Network initialization failed · retry");
        };
        remoteEntryCard.setEnabled(ready); remoteEntryCard.setClickable(ready);
        remoteEntryCard.setContentDescription(tr("远程控制。", "Remote control. ") + label);
        if (!label.contentEquals(remoteEntryLabel.getText())) remoteEntryLabel.setText(label);
        remoteEntryLabel.setTextColor(ready ? accent : muted);
        remoteEntryLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        remoteEntryArrow.setVisibility(ready ? View.VISIBLE : View.GONE);
        remoteEntrySpinner.setVisibility(state == RemoteEntryGate.State.CONNECTING ? View.VISIBLE : View.GONE);
        remoteEntryRetry.setVisibility(state == RemoteEntryGate.State.FAILED || state == RemoteEntryGate.State.TIMED_OUT || state == RemoteEntryGate.State.OFFLINE ? View.VISIBLE : View.GONE);
    }

    private LinearLayout homeCard(String iconName, String title, String description, String action, String tag, Runnable click) {
        LinearLayout card = column(); card.setPadding(dp(18), dp(16), dp(18), dp(16));
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        GradientDrawable outline = rounded(background); outline.setCornerRadius(dp(20)); outline.setStroke(dp(1), Color.parseColor(dark ? "#34363A" : "#E6E8EB"));
        card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x144176e6), outline, null)); card.setTag(tag); card.setFocusable(true);
        card.setContentDescription(title + ". " + description); card.setOnClickListener(view -> click.run());
        ImageView icon = new ImageView(this); icon.setImageDrawable(new LineIcon(iconName, accent)); icon.setPadding(dp(7), dp(7), dp(7), dp(7)); icon.setBackground(rounded(surface));
        card.addView(icon, new LinearLayout.LayoutParams(dp(36), dp(36)));
        TextView name = text(title, 19, ink); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); name.setPadding(0, dp(10), 0, dp(4)); card.addView(name);
        TextView copy = text(description, 13, muted); copy.setPadding(0, 0, 0, 0); copy.setLineSpacing(dp(2), 1); card.addView(copy);
        LinearLayout footer = new LinearLayout(this); footer.setPadding(0, dp(10), 0, 0);
        TextView actionLabel = text(action, 15, accent); actionLabel.setTag(tag + "Action");
        TextView arrow = text("↗", 21, accent); arrow.setTag(tag + "Arrow");
        footer.addView(actionLabel, new LinearLayout.LayoutParams(0, -2, 1)); footer.addView(arrow); card.addView(footer);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(16)); content.addView(card, params);
        return card;
    }

    private void settingsScreen() {
        stopNetwork(); screen = "settings"; networkScreen = false; conversationId = null;
        shell(tr("设置", "Settings"), "");
        SettingsStyle settingsStyle = new SettingsStyle(this);
        LinearLayout preferences = settingsStyle.group(content, "");
        LinearLayout data = null;
        for (String section : new String[]{"providers", "general", "archived"}) {
            String label = section.equals("providers") ? tr("供应商与 Key", "Providers & keys") : section.equals("general") ? tr("通用", "General") : tr("已归档", "Archived");
            if (section.equals("archived")) data = settingsStyle.group(content, tr("数据与连接", "Data & connection"));
            String icon = section.equals("providers") ? "key" : section.equals("general") ? "settings" : "archive";
            settingsStyle.row(section.equals("archived") ? data : preferences, icon, label, "", "settings:" + section, () -> {
                startActivity(new android.content.Intent(this, SettingsActivity.class).putExtra("section", section)); PageTransitions.openActivity(this);
            });
        }
        settingsStyle.row(data, "phone", tr("手机访问", "Mobile access"), "", "settings:network", this::showNetwork);
        status.setVisibility(View.GONE);
    }

    private void computersScreen() {
        stopNetwork(); screen = "computers"; networkScreen = false; conversationId = null;
        history.clear(); conversations.clear();
        shell(tr("远程控制", "Remote control"), tr("选择一台电脑，继续工作。", "Choose a computer to continue."));
        content.addView(text(tr("已连接的电脑", "Connected computers"), 18, ink));
        try {
            var computers = store.all();
            if (computers.isEmpty()) content.addView(text(tr("添加电脑后，在这里查看工作区和会话。", "Add a computer to browse its workspaces and conversations here."), 14, muted));
            for (JSONObject computer : computers) {
                String address = computer.getString("address");
                LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL); row.setBackground(rounded(surface));
                LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2); rowParams.setMargins(0, dp(6), 0, dp(6));
                row.setLayoutParams(rowParams);
                LinearLayout card = column(); card.setPadding(dp(16), dp(10), dp(8), dp(10)); card.setBackground(interactive(surface));
                card.setTag("computer:" + address); card.setContentDescription(computerName(computer)); card.setFocusable(true);
                card.addView(text(computerName(computer), 16, ink));
                card.addView(text(address, 11, muted));
                TextView state = text(computerStates.getOrDefault(address, tr("待检查", "Not checked")), 12, muted);
                state.setTag("computerState:" + address); state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); card.addView(state);
                card.setOnClickListener(view -> openComputer(computer));
                row.addView(card, new LinearLayout.LayoutParams(0, -2, 1));
                Button manage = button("⋯", () -> manageComputer(computer), false);
                manage.setTag("manage:" + address); manage.setContentDescription(tr("管理电脑", "Manage computer") + " · " + computerName(computer));
                row.addView(manage, new LinearLayout.LayoutParams(dp(48), dp(48))); content.addView(row);
            }
        } catch (Exception error) { reportError("无法读取电脑列表，请重试。", "Could not load computers. Try again.", error); }
        content.addView(button(tr("添加电脑", "Add computer"), () -> { stopNetwork(); credentials = new JSONObject(); pairScreen(); }, true));
        if (credentials.has("claim")) content.addView(button(tr("继续配对", "Resume pairing"), () -> { pairScreen(); waitForApproval(); }, false));
        ((RefreshScrollView) scroll).setRefreshAction(this::refreshComputers,
            ready -> status.setText(ready ? tr("松开检查状态", "Release to check status") : tr("下拉检查电脑状态", "Pull to check computers")));
    }

    private void openComputer(JSONObject computer) {
        try {
            canCreate = false; canCreateWorkspace = false; canImage = false; availableWorkspaces = new JSONArray();
            stopNetwork(); store.save(computer); credentials = store.load();
            if (credentials.has("token")) { listScreen(); loadList(false); }
            else pairScreen();
        } catch (Exception error) { reportError("无法读取电脑凭据，请重试。", "Could not load computer credentials. Try again.", error); }
    }

    private void manageComputer(JSONObject computer) {
        LinearLayout panel = computerDialogPanel(computerName(computer), computer.optString("address"));
        android.app.Dialog dialog = createComputerDialog(panel);
        panel.addView(button(tr("重命名", "Rename"), () -> { dialog.dismiss(); renameComputer(computer); }, true));
        panel.addView(button(tr("移除电脑", "Forget computer"), () -> { dialog.dismiss(); forget(computer); }, false));
        panel.addView(button(tr("取消", "Cancel"), dialog::dismiss, false));
        showComputerDialog(dialog);
    }

    private LinearLayout computerDialogPanel(String title, String description) {
        LinearLayout panel = column(); panel.setPadding(0, 0, 0, dp(8));
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this); logo.setImageResource(R.drawable.desktop_logo);
        logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(logo, new LinearLayout.LayoutParams(dp(32), dp(32)));
        TextView heading = text(title, 21, ink); heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(dp(12), dp(4), 0, dp(4));
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1)); panel.addView(header);
        TextView subtitle = text(description, 13, muted); subtitle.setPadding(0, dp(12), 0, dp(20)); panel.addView(subtitle);
        return panel;
    }

    private android.app.Dialog createComputerDialog(LinearLayout panel) {
        if (computerDialog != null) computerDialog.dismiss();
        android.app.Dialog dialog = new CamelliaDialog.Builder(this).setView(panel).create();
        computerDialog = dialog;
        return dialog;
    }

    private void showComputerDialog(android.app.Dialog dialog) {
        dialog.show();
    }

    private void renameComputer(JSONObject computer) {
        LinearLayout panel = computerDialogPanel(tr("重命名电脑", "Rename computer"),
            tr("取一个容易辨认的名字，仅在这台手机上显示。", "Choose a familiar name. It only changes on this phone."));
        android.app.Dialog dialog = createComputerDialog(panel);
        TextView label = text(tr("电脑名称", "Computer name"), 12, muted); panel.addView(label);
        EditText name = new EditText(this); name.setTag("computerNameInput"); name.setId(View.generateViewId()); label.setLabelFor(name.getId());
        name.setSingleLine(true); name.setTextSize(16); name.setTextColor(ink); name.setHintTextColor(muted);
        name.setHint(tr("例如：工作电脑", "e.g. Work laptop")); name.setContentDescription(tr("电脑名称", "Computer name"));
        name.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        name.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        name.setPadding(dp(16), dp(14), dp(16), dp(14)); name.setMinHeight(dp(54));
        name.setText(computerName(computer)); panel.addView(new SettingsField(name), new LinearLayout.LayoutParams(-1, -2));
        TextView feedback = text(tr("最多 80 个字符", "Up to 80 characters"), 12, muted);
        feedback.setTag("renameFeedback"); feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); panel.addView(feedback);
        LinearLayout actions = new LinearLayout(this); actions.setPadding(0, dp(10), 0, 0);
        Button cancel = button(tr("取消", "Cancel"), dialog::dismiss, false); cancel.setTag("renameCancel");
        Button save = button(tr("保存", "Save"), () -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty()) { feedback.setText(tr("请输入电脑名称", "Enter a computer name")); name.requestFocus(); return; }
            try {
                store.rename(computer.getString("address"), value); credentials = store.load();
                dialog.dismiss(); computersScreen(); refreshComputers();
            } catch (Exception error) { feedback.setText(ErrorDetails.withSummary(tr("保存失败，请重试", "Could not save. Try again"), error)); }
        }, true); save.setTag("renameSave");
        LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(0, -2, 1); cancelParams.setMargins(0, 0, dp(6), 0);
        LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(0, -2, 1); saveParams.setMargins(dp(6), 0, 0, 0);
        actions.addView(cancel, cancelParams); actions.addView(save, saveParams); panel.addView(actions);
        name.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        name.setOnEditorActionListener((view, action, event) -> {
            if (action != android.view.inputmethod.EditorInfo.IME_ACTION_DONE) return false;
            save.performClick(); return true;
        });
        showComputerDialog(dialog); name.requestFocus(); name.selectAll();
    }

    private void refreshComputers() {
        if (!foreground || !screen.equals("computers")) return;
        stopNetwork(); int ticket = generation;
        try {
            var computers = store.all();
            ((RefreshScrollView) scroll).setRefreshing(!computers.isEmpty());
            status.setText(computers.isEmpty() ? tr("尚未添加电脑", "No computers added") : tr("正在检查电脑状态…", "Checking computers…"));
            int[] remaining = {computers.size()};
            for (JSONObject computer : computers) {
                String address = computer.getString("address");
                String checking = tr("正在检查…", "Checking…");
                computerStates.put(address, checking);
                TextView label = root.findViewWithTag("computerState:" + address);
                if (label != null) label.setText(checking);
            }
            for (JSONObject computer : computers) {
                String address = computer.getString("address");
                statusWorker.submit(() -> {
                    if (ticket != generation) return;
                    String result;
                    JSONObject info = null;
                    boolean revoked = false;
                    RemoteApi client = null;
                    try {
                        if (!computer.has("token")) throw new RemoteApi.Failure(401);
                        client = new RemoteApi(address); statusClients.add(client);
                        if (ticket != generation) { statusClients.remove(client); client.cancel(); return; }
                        info = client.json("/v1/status", computer.getString("token"), null);
                        if (info.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
                        result = tr("已连接", "Connected");
                    } catch (Exception error) {
                        revoked = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 401;
                        result = RemoteApi.failureMessage(error, chinese);
                    }
                    String state = result;
                    boolean unauthorized = revoked;
                    deliver(ticket, () -> {
                        if (unauthorized) { listCache.remove(computer); prefetch.remove(computer, null); }
                        computerStates.put(address, state);
                        TextView label = root.findViewWithTag("computerState:" + address);
                        if (label != null) label.setText(state);
                        if (--remaining[0] == 0) {
                            ((RefreshScrollView) scroll).setRefreshing(false);
                            status.setText(tr("电脑状态已更新", "Computer status updated"));
                        }
                    });
                    try {
                        if (info != null && info.optInt("protocol") == 1 && ticket == generation) {
                            prefetchComputerList(client, computer, info, ticket);
                        }
                    } catch (Exception error) {
                        if (error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 401) {
                            deliver(ticket, () -> { listCache.remove(computer); prefetch.remove(computer, null); });
                        }
                    } finally { if (client != null) { statusClients.remove(client); client.cancel(); } }
                });
            }
        } catch (Exception error) {
            ((RefreshScrollView) scroll).setRefreshing(false);
            reportError("无法检查电脑状态，请下拉重试。", "Could not check computers. Pull to retry.", error);
        }
    }

    private void prefetchComputerList(RemoteApi client, JSONObject computer, JSONObject info, int ticket) throws IOException {
        JSONObject page = client.json("/v1/conversations?offset=0", computer.optString("token"), null);
        JSONArray rows = page.optJSONArray("conversations");
        JSONArray workspaces = info.optJSONArray("workspaces");
        if (rows == null) throw new IOException("Invalid conversation list");
        deliver(ticket, () -> {
            listCache.put(computer, rows, page.optInt("nextOffset", -1),
                workspaces == null ? new JSONArray() : workspaces, info.optBoolean("includeUnassigned"));
            prefetch.schedule(computer, rows, page.optInt("nextOffset", -1));
        });
    }

    private void pairScreen() {
        screen = "pair";
        networkScreen = false;
        conversationId = null;
        shell(tr("连接你的电脑", "Connect your computer"), "TAILSCALE · " + tr("安全配对", "DEVICE PAIRING"));
        content.addView(button(tr("内置网络 / Tailscale 登录", "Embedded network / Tailscale login"), this::showNetwork, false));
        content.addView(text(tr("手机可使用内置 Tailscale，无需另装 App。先登录电脑所在的网络，再在电脑「手机访问」中生成配对码。", "Use built-in Tailscale without another app. Sign into the computer's tailnet, then generate a pairing code in desktop Mobile access."), 15, ink));
        addressInput = input(tr("电脑地址", "Computer address"), credentials.optString("address", "http://100."), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        nameInput = input(tr("设备名称", "Device name"), credentials.optString("name", android.os.Build.MODEL), InputType.TYPE_CLASS_TEXT);
        codeInput = input(tr("一次性配对码", "One-time pairing code"), "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        codeInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(24)});
        content.addView(button(tr("请求配对", "Request pairing"), this::requestPairing, true));
        if (credentials.has("claim")) content.addView(button(tr("继续等待电脑确认", "Resume pairing request"), this::waitForApproval, false));
        content.addView(text(tr("电脑端确认授权后，即可查看会话、发送、停止和审批，无需另设权限。", "Once authorized on the computer, you can read, send, stop and approve without separate permission settings."), 12, muted));
    }

    private void requestPairing() {
        if (!foreground) return;
        try {
            String address = new Endpoint(addressInput.getText().toString()).origin();
            String name = nameInput.getText().toString().trim();
            String code = codeInput.getText().toString().trim();
            if (name.isEmpty() || name.length() > 80 || !code.matches("[a-fA-F0-9]{24}")) throw new IllegalArgumentException();
            String displayName = credentials.optString("computerName");
            credentials = new JSONObject().put("address", address).put("name", name);
            if (!displayName.isEmpty()) credentials.put("computerName", displayName);
            store.save(credentials);
            RemoteApi client = begin(); int ticket = generation;
            status.setText(tr("正在请求配对…", "Requesting pairing…"));
            JSONObject payload = new JSONObject().put("code", code.toLowerCase(Locale.ROOT)).put("name", name);
            job = worker.submit(() -> {
                try {
                    JSONObject result = client.json("/v1/pair/request", null, payload);
                    deliver(ticket, () -> {
                        try {
                            credentials.put("id", result.getString("id")).put("claim", result.getString("claim")).put("expiresAt", result.getLong("expiresAt"));
                            store.save(credentials); codeInput.setText(""); waitForApproval();
                        } catch (Exception error) { reportError("无法保存配对，请重新生成配对码。", "Could not save pairing. Generate a new code.", error); }
                    });
                } catch (Exception error) { deliver(ticket, () -> showFailure(error, false)); }
            });
        } catch (Exception error) { reportError("请检查 Tailscale 地址、设备名称和 24 位配对码。", "Check the Tailscale address, device name and 24-character pairing code.", error); }
    }

    private void waitForApproval() {
        if (!foreground || !credentials.has("claim")) return;
        RemoteApi client = begin(); int ticket = generation;
        status.setText(tr("请在电脑端点击「允许查看」。", "Select Allow reading on your computer."));
        pollPair(client, ticket);
    }

    private void pollPair(RemoteApi client, int ticket) {
        if (!foreground || ticket != generation) return;
        if (credentials.optLong("expiresAt") <= System.currentTimeMillis()) {
            credentials.remove("claim"); credentials.remove("id");
            try { store.save(credentials); } catch (Exception ignored) { }
            status.setText(tr("配对已过期，请在电脑重新生成配对码。", "Pairing expired. Generate another code on the computer.")); return;
        }
        final JSONObject payload = new JSONObject();
        try { payload.put("id", credentials.getString("id")).put("claim", credentials.getString("claim")); }
        catch (Exception error) { reportError("配对信息不完整，请重新生成配对码。", "Pairing information is incomplete. Generate a new code.", error); return; }
        job = worker.submit(() -> {
            try {
                JSONObject result = client.json("/v1/pair/claim", null, payload);
                deliver(ticket, () -> {
                    if (!result.optString("state").equals("approved")) {
                        handler.postDelayed(() -> pollPair(client, ticket), 5000); return;
                    }
                    try {
                        String token = result.getString("token");
                        if (!token.matches("[A-Za-z0-9_-]{43}") || !(result.optString("permission").equals("control") || result.optString("permission").equals("read"))) throw new IOException();
                        JSONObject next = new JSONObject().put("address", credentials.getString("address")).put("name", credentials.getString("name"))
                            .put("token", token).put("deviceId", result.getString("deviceId"));
                        if (credentials.has("computerName")) next.put("computerName", credentials.getString("computerName"));
                        store.save(next); credentials = next; listScreen(); loadList(false);
                    } catch (Exception error) { reportError("无法安全保存凭据，请重试领取。", "Could not securely save credentials. Resume pairing to retry.", error); }
                });
            } catch (Exception error) {
                deliver(ticket, () -> {
                    showFailure(error, false);
                    if (!(error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 401)) handler.postDelayed(() -> pollPair(client, ticket), 10_000);
                });
            }
        });
    }

    private void listScreen() {
        screen = "list";
        networkScreen = false;
        stopNetwork(); conversationId = null; history.clear(); conversations.clear(); nextOffset = -1;
        canCreate = false; canCreateWorkspace = false; canMove = false; canArchive = false; canManageConversations = false;
        selectingConversations = false; selectedConversations.clear();
        availableWorkspaces = new JSONArray(); allowIndependent = false;
        listEventsUnavailable = false;
        shell("", "");
        root.setClipChildren(false);
        LinearLayout bar = bottomBar("searchBar");
        bar.setElevation(0); bar.setPadding(0, dp(6), 0, dp(6));
        LinearLayout search = new LinearLayout(this); search.setGravity(Gravity.CENTER_VERTICAL); chatStyle.floatingBar(search);
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(0, -2, 1); searchParams.setMargins(0, 0, dp(10), 0); bar.addView(search, searchParams);
        ImageView searchIcon = new ImageView(this); searchIcon.setImageDrawable(new LineIcon("search", ink)); searchIcon.setPadding(dp(10), dp(10), dp(10), dp(10));
        search.addView(searchIcon, new LinearLayout.LayoutParams(dp(44), dp(44)));
        searchInput = new EditText(this); searchInput.setSingleLine(true); searchInput.setTextSize(16); searchInput.setTextColor(ink); searchInput.setHintTextColor(muted);
        searchInput.setHint(tr("搜索会话", "Search conversations")); searchInput.setContentDescription(tr("搜索会话", "Search conversations")); searchInput.setBackgroundColor(Color.TRANSPARENT);
        searchInput.setPadding(dp(2), dp(12), dp(8), dp(12)); searchInput.setMinHeight(dp(48));
        search.addView(searchInput, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton create = lineButton("new", tr("新建独立会话", "New independent conversation"), () -> createConversation(null));
        create.setElevation(dp(2));
        create.setTag("newIndependent"); bar.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48)));
        searchInput.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                renderConversations(); handler.removeCallbacks(searchRemote);
                if (nextOffset >= 0 && value.length() > 0) handler.postDelayed(searchRemote, 400);
            }
            @Override public void afterTextChanged(android.text.Editable value) {}
        });
        if (credentials.has("pendingCreate")) content.addView(button(tr("查询新建结果 / 重试", "Check creation / retry"), this::retryCreate, false));
        content.addView(chatStyle.workspaceHeader(tr("工作区", "Workspaces"), tr("新建工作区", "New workspace"), "remoteNewWorkspace", this::createWorkspace));
        ((RefreshScrollView) scroll).setRefreshAction(() -> loadList(false), ready -> status.setText(ready
            ? tr("松开刷新", "Release to refresh") : computerStates.getOrDefault(credentials.optString("address"), tr("下拉刷新", "Pull to refresh"))));
        JSONObject cached = listCache.get(credentials);
        if (cached != null) {
            availableWorkspaces = cached.optJSONArray("workspaces");
            if (availableWorkspaces == null) availableWorkspaces = new JSONArray();
            allowIndependent = cached.optBoolean("includeUnassigned");
            applyConversationPage(cached, false);
            status.setText(tr("显示上次缓存，正在同步…", "Showing cached conversations; syncing…"));
        }
    }

    private void applyConversationPage(JSONObject page, boolean append) {
        if (!append) conversations.clear();
        JSONArray entries = page.optJSONArray("conversations");
        if (entries != null) for (int index = 0; index < entries.length(); index++) {
            JSONObject conversation = entries.optJSONObject(index);
            if (conversation != null && !conversation.optString("id").isEmpty()) conversations.put(conversation.optString("id"), conversation);
        }
        nextOffset = page.optInt("nextOffset", -1);
        renderConversations();
    }

    private void cacheConversations() {
        JSONArray rows = new JSONArray();
        for (JSONObject conversation : conversations.values()) rows.put(conversation);
        listCache.put(credentials, rows, nextOffset, availableWorkspaces, allowIndependent);
        if (foreground) prefetch.schedule(credentials, rows, nextOffset);
    }

    private void renderConversations() {
        if (conversationPopup != null) conversationPopup.dismiss();
        int position = scroll.getScrollY();
        content.removeAllViews();
        selectedConversations.retainAll(conversations.keySet());
        if (selectingConversations) {
            LinearLayout actions = new LinearLayout(this);
            Button cancel = button(tr("取消多选", "Cancel selection"), () -> {
                selectingConversations = false; selectedConversations.clear(); renderConversations();
            }, false); cancel.setTag("selectionCancel"); actions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
            Button delete = button(tr("删除所选", "Delete selected") + " (" + selectedConversations.size() + ")",
                () -> confirmConversationDelete(new java.util.LinkedHashSet<>(selectedConversations)), false);
            delete.setTag("selectionDelete"); delete.setEnabled(!selectedConversations.isEmpty() && canManageConversations && !commandBusy && !credentials.has("pendingCreate"));
            actions.addView(delete, new LinearLayout.LayoutParams(0, -2, 1)); content.addView(actions);
        }
        if (credentials.has("pendingCreate")) content.addView(button(tr("查询操作结果 / 重试", "Check operation / retry"), this::retryCreate, false));
        content.addView(chatStyle.workspaceHeader(tr("工作区", "Workspaces"), tr("新建工作区", "New workspace"), "remoteNewWorkspace", this::createWorkspace));
        LinkedHashMap<String, ArrayList<JSONObject>> groups = new LinkedHashMap<>();
        String query = searchInput == null ? "" : searchInput.getText().toString().trim().toLowerCase(Locale.ROOT);
        if (query.isEmpty()) for (int index = 0; index < availableWorkspaces.length(); index++) {
            JSONObject workspace = availableWorkspaces.optJSONObject(index); if (workspace != null) groups.put(workspace.optString("id"), new ArrayList<>());
        }
        for (JSONObject conversation : conversations.values()) {
            if (!query.isEmpty() && !conversation.optString("title").toLowerCase(Locale.ROOT).contains(query)) continue;
            String workspace = conversation.isNull("workspaceId") ? "" : conversation.optString("workspaceId");
            groups.computeIfAbsent(workspace, key -> new ArrayList<>()).add(conversation);
        }
        ArrayList<JSONObject> independent = groups.remove("");
        if (independent != null || allowIndependent) groups.put("", independent == null ? new ArrayList<>() : independent);
        for (var entry : groups.entrySet()) {
            String workspace = entry.getKey(); ArrayList<JSONObject> entries = entry.getValue();
            String name = workspace.isEmpty() ? tr("独立会话", "Independent conversations") : workspace;
            for (int index = 0; index < availableWorkspaces.length(); index++) {
                JSONObject item = availableWorkspaces.optJSONObject(index); if (item != null && item.optString("id").equals(workspace)) name = item.optString("name", workspace);
            }
            if (!entries.isEmpty() && !workspace.isEmpty()) name = entries.get(0).optString("workspaceName", name);
            String key = credentials.optString("address") + "/" + workspace;
            boolean collapsed = collapsedGroups.computeIfAbsent(key, value -> getPreferences(MODE_PRIVATE).getBoolean("collapsed:" + value, false));
            LinearLayout group = column();
            LinearLayout.LayoutParams groupParams = new LinearLayout.LayoutParams(-1, -2); groupParams.setMargins(0, dp(12), 0, dp(4)); group.setLayoutParams(groupParams);
            LinearLayout groupHeader = new LinearLayout(this); groupHeader.setGravity(Gravity.CENTER_VERTICAL);
            if (!workspace.isEmpty()) {
                ImageView folder = new ImageView(this); folder.setImageDrawable(new LineIcon("folder", ink)); folder.setPadding(dp(2), 0, dp(10), 0);
                groupHeader.addView(folder, new LinearLayout.LayoutParams(dp(32), dp(24)));
            }
            DisclosureHeader heading = new DisclosureHeader(this, name, workspace.isEmpty() ? muted : ink, muted, collapsed);
            heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            heading.setPadding(0, dp(8), dp(4), dp(8)); heading.setBackground(interactive(background));
            heading.setTag("group:" + workspace); heading.setFocusable(true);
            heading.setContentDescription(name + " · " + entries.size() + " · " + (collapsed ? tr("展开", "Expand") : tr("折叠", "Collapse")));
            heading.setOnClickListener(view -> {
                collapsedGroups.put(key, !collapsed);
                getPreferences(MODE_PRIVATE).edit().putBoolean("collapsed:" + key, !collapsed).apply();
                renderConversations();
            });
            groupHeader.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
            ImageButton create = lineButton("new", workspace.isEmpty()
                ? tr("新建独立会话", "New independent conversation")
                : tr("新建会话：", "New conversation: ") + name,
                () -> createConversation(workspace.isEmpty() ? null : workspace));
            create.setTag(workspace.isEmpty() ? "newStandalone" : "newWorkspace:" + workspace);
            groupHeader.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48)));
            group.addView(groupHeader);
            entries.sort(java.util.Comparator.comparing(entryValue -> !entryValue.optBoolean("pinned")));
            if (!collapsed || !query.isEmpty()) for (JSONObject conversation : entries) group.addView(conversationCard(conversation));
            content.addView(group);
        }
        if (groups.isEmpty()) content.addView(text(query.isEmpty() ? tr("暂无可见会话，请先在电脑授权。", "No conversations yet. Check desktop access permissions.") : tr("没有匹配的会话", "No matching conversations"), 14, muted));
        if (nextOffset >= 0) content.addView(button(tr("加载更多会话", "Load more conversations"), () -> loadList(true), false));
        scroll.post(() -> scroll.scrollTo(0, position));
    }

    private View conversationCard(JSONObject conversation) {
        String title = conversation.optString("title");
        String state = conversation.optString("activity", "");
        boolean unread = replies().unread(credentials, conversation);
        String indicator = state.equals("running") || state.equals("permission") || state.equals("question") ? activity(conversation) : "";
        if (unread) indicator += (indicator.isEmpty() ? "" : " · ") + tr("新消息", "New reply");
        if (conversation.optBoolean("pinned")) indicator += (indicator.isEmpty() ? "" : " · ") + tr("已置顶", "Pinned");
        ConversationRow card = new ConversationRow(this, chatStyle, !conversation.isNull("workspaceId") && !conversation.optString("workspaceId").isEmpty(),
            title, indicator, "conversation:" + conversation.optString("id"), "conversationStatus:" + conversation.optString("id"),
            () -> {
                String id = conversation.optString("id");
                if (selectingConversations) {
                    if (!selectedConversations.add(id)) selectedConversations.remove(id);
                    renderConversations();
                } else { conversationId = id; conversationTitle = title; detailScreen(); connectEvents(); }
            }, () -> conversationMenu(conversation));
        card.setContentDescription(title + " · " + activity(conversation) + (unread ? " · " + tr("新消息", "New reply") : ""));
        card.selection(selectingConversations, selectedConversations.contains(conversation.optString("id")));
        return card;
    }

    private void conversationMenu(JSONObject conversation) {
        if (!canManageConversations || commandBusy || credentials.has("pendingCreate")) {
            status.setText(canManageConversations ? tr("请等待当前操作完成。", "Wait for the current operation to finish.") : tr("会话管理需要控制权限，并更新重启电脑端。", "Conversation actions require control permission and an updated, restarted desktop."));
            return;
        }
        if (conversationPopup != null) conversationPopup.dismiss();
        View anchor = root.findViewWithTag("conversation:" + conversation.optString("id"));
        if (anchor == null) return;
        String id = conversation.optString("id");
        conversationPopup = new ConversationMenu(anchor, chatStyle, chinese, conversation.optBoolean("pinned"),
            () -> renameConversation(conversation), () -> {
                selectingConversations = true; selectedConversations.add(id); renderConversations();
            }, () -> manageConversations("pin", java.util.Set.of(id), "", !conversation.optBoolean("pinned")),
            () -> confirmConversationDelete(java.util.Set.of(id)));
    }

    private void renameConversation(JSONObject conversation) {
        EditText name = new EditText(this); name.setSingleLine(true); name.setText(conversation.optString("title")); name.setTag("remoteRename");
        SettingsField field = new SettingsField(name);
        AlertDialog dialog = new CamelliaDialog.Builder(this).setTitle(tr("重命名", "Rename")).setView(field)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("保存", "Save"), null).create();
        dialog.setOnShowListener(event -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty() || value.length() > 100) { field.showError(tr("请输入 1–100 字标题", "Enter a title of 1–100 characters")); return; }
            manageConversations("rename", java.util.Set.of(conversation.optString("id")), value, false); dialog.dismiss();
        })); dialog.show();
    }

    private void confirmConversationDelete(java.util.Set<String> targets) {
        new CamelliaDialog.Builder(this).setTitle(tr("删除会话？", "Delete conversations?"))
            .setMessage(tr("将永久删除电脑端所选聊天记录，无法撤销；不会删除工作区文件。", "Permanently deletes the selected chats on your computer, not workspace files. This cannot be undone.") + " (" + targets.size() + ")")
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("删除", "Delete"), (dialog, which) -> manageConversations("delete", targets, "", false)).show();
    }

    private void manageConversations(String action, java.util.Set<String> ids, String title, boolean pinned) {
        if (!canManageConversations || commandBusy || credentials.has("pendingCreate") || ids.isEmpty()) return;
        if (ids.size() > 100) { status.setText(tr("每次最多选择 100 个会话。", "Select at most 100 chats at a time.")); return; }
        try {
            JSONArray targets = new JSONArray();
            for (String id : ids) {
                JSONObject conversation = conversations.get(id);
                if (conversation == null) throw new IllegalStateException(tr("会话已变化，请刷新。", "Conversation changed; refresh first."));
                targets.put(new JSONObject().put("id", id).put("seq", conversation.optLong("seq")));
            }
            JSONObject payload = command(action).put("targets", targets);
            if (action.equals("rename")) payload.put("title", title);
            if (action.equals("pin")) payload.put("pinned", pinned);
            JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload);
            store.save(saved); credentials = saved; retryCreate();
        } catch (Exception error) { reportError("无法保存会话操作", "Could not save conversation action", error); }
    }

    private void archiveConversation(JSONObject conversation) {
        if (!canArchive || commandBusy || credentials.has("pendingCreate")) return;
        try {
            JSONObject payload = command("archive")
                .put("conversationId", conversation.optString("id"))
                .put("expectedSeq", conversation.optLong("seq"));
            JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload);
            store.save(saved); credentials = saved; retryCreate();
        } catch (Exception error) {
            reportError("无法保存归档请求", "Could not save archive request", error);
        }
    }

    private RemoteReplyState replies() {
        if (replyState == null) replyState = new RemoteReplyState(getSharedPreferences("remote-replies", MODE_PRIVATE));
        return replyState;
    }

    private void loadList(boolean append) {
        if (!networkActive()) return;
        RemoteApi client = begin(); int ticket = generation;
        ((RefreshScrollView) scroll).setRefreshing(true);
        String token = credentials.optString("token"); int offset = append ? nextOffset : 0;
        boolean searching = searchInput != null && !searchInput.getText().toString().trim().isEmpty();
        status.setText(conversations.isEmpty() ? tr("正在同步…", "Syncing…")
            : tr("显示上次缓存，正在同步…", "Showing cached conversations; syncing…"));
        job = worker.submit(() -> {
            try {
                JSONObject page = client.json("/v1/conversations?offset=" + offset, token, null);
                JSONObject info = listInfo(client, token, page);
                long pageCursor = page.optLong("cursor", -1);
                if (searching) {
                    JSONArray results = page.optJSONArray("conversations"); if (results == null) results = new JSONArray();
                    int following = page.optInt("nextOffset", -1);
                    while (following >= 0 && ticket == generation) {
                        JSONObject next = client.json("/v1/conversations?offset=" + following, token, null);
                        JSONArray rows = next.optJSONArray("conversations");
                        if (rows != null) for (int index = 0; index < rows.length(); index++) results.put(rows.optJSONObject(index));
                        following = next.optInt("nextOffset", -1);
                    }
                    page.put("conversations", results).put("nextOffset", JSONObject.NULL);
                }
                deliver(ticket, () -> {
                    updateCapabilities(info);
                    listCursor = append ? -1 : pageCursor;
                    applyConversationPage(page, append);
                    cacheConversations();
                    ((RefreshScrollView) scroll).setRefreshing(false);
                    computerStates.put(credentials.optString("address"), tr("已连接", "Connected"));
                    watchList(client, ticket);
                });
            } catch (Exception error) { deliver(ticket, () -> { ((RefreshScrollView) scroll).setRefreshing(false); showFailure(error, true); }); }
        });
    }

    private JSONObject listInfo(RemoteApi client, String token, JSONObject page) throws IOException {
        JSONObject info = page.has("protocol") ? page : client.json("/v1/status", token, null);
        if (info.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
        return info;
    }

    private void updateCapabilities(JSONObject info) {
        String capabilities = String.valueOf(info.optJSONArray("capabilities"));
        canCreate = info.optString("permission").equals("control") && capabilities.contains("\"create\"");
        canCreateWorkspace = info.optString("permission").equals("control") && capabilities.contains("\"create-workspace\"");
        canImage = capabilities.contains("\"image\"");
        canMultiImage = capabilities.contains("\"multi-image\"");
        canMove = info.optString("permission").equals("control") && capabilities.contains("\"move\"");
        canArchive = info.optString("permission").equals("control") && capabilities.contains("\"archive\"");
        canManageConversations = info.optString("permission").equals("control") && capabilities.contains("\"conversation-actions\"");
        listInstance = info.optString("instanceId"); allowIndependent = info.optBoolean("includeUnassigned");
        availableWorkspaces = info.optJSONArray("workspaces"); if (availableWorkspaces == null) availableWorkspaces = new JSONArray();
    }

    private void moveConversation(String id, String workspace, String target, boolean after) {
        if (!canMove || commandBusy || credentials.has("pendingCreate")) return;
        try {
            JSONObject payload = command("move").put("instanceId", listInstance)
                .put("workspaceId", workspace.isEmpty() ? JSONObject.NULL : workspace)
                .put("targetSessionId", target == null ? JSONObject.NULL : target)
                .put("placement", after ? "after" : "before").put("moveSessionId", id);
            JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload);
            store.save(saved); credentials = saved; retryCreate();
        } catch (Exception error) { reportError("无法保存移动请求", "Could not save move request", error); }
    }

    private void createWorkspace() {
        if (!canCreateWorkspace) {
            status.setText(tr("请更新电脑端，并授权控制所有工作区后再新建。", "Update the desktop and authorize control of all workspaces to create one.")); return;
        }
        if (commandBusy) return;
        if (credentials.has("pendingCreate")) { retryCreate(); return; }
        LinearLayout panel = computerDialogPanel(tr("新建工作区", "New workspace"),
            tr("填写电脑上已存在文件夹的完整路径，不是手机路径。", "Enter the full path of an existing folder on the computer, not this phone."));
        EditText name = input(panel, tr("工作区名称", "Workspace name"), "", android.text.InputType.TYPE_CLASS_TEXT);
        name.setTag("remoteWorkspaceName"); name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(200)});
        EditText folder = input(panel, tr("电脑文件夹绝对路径", "Absolute computer folder path"), "", android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        folder.setTag("remoteWorkspacePath"); folder.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(1024)});
        android.app.Dialog dialog = createComputerDialog(panel);
        Button submit = button(tr("创建", "Create"), () -> {
            if (name.getText().toString().trim().isEmpty()) { ((SettingsField) name.getParent()).showError(tr("请输入名称", "Enter a name")); return; }
            if (folder.getText().toString().trim().isEmpty()) { ((SettingsField) folder.getParent()).showError(tr("请输入电脑文件夹路径", "Enter a computer folder path")); return; }
            try {
                JSONObject payload = command("create-workspace").put("instanceId", listInstance).put("name", name.getText().toString().trim()).put("path", folder.getText().toString().trim());
                JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload); store.save(saved); credentials = saved;
                dialog.dismiss(); retryCreate();
            } catch (Exception error) { reportError("无法保存新建请求", "Could not save creation request", error); }
        }, true);
        submit.setTag("remoteWorkspaceCreate"); panel.addView(submit);
        panel.addView(button(tr("取消", "Cancel"), dialog::dismiss, false)); showComputerDialog(dialog);
    }

    private void createConversation(String workspace) {
        if (!canCreate || workspace == null && !allowIndependent) {
            status.setText(tr("请更新电脑端，并授权控制及对应会话范围。", "Update the desktop and authorize control and this workspace scope.")); return;
        }
        if (credentials.has("pendingCreate")) { retryCreate(); return; }
        LinearLayout panel = computerDialogPanel(tr("新建会话", "New conversation"), tr("选择执行引擎，沿用电脑端的连接设置。", "Choose an engine using your desktop connection settings."));
        android.app.Dialog dialog = createComputerDialog(panel);
        for (String engine : new String[]{"codex", "claude", "kimi", "dsh", "antigravity"}) panel.addView(button(engine.toUpperCase(Locale.ROOT), () -> {
            try {
                JSONObject payload = command("create").put("instanceId", listInstance).put("workspaceId", workspace == null ? JSONObject.NULL : workspace).put("engine", engine);
                JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload); store.save(saved); credentials = saved;
                dialog.dismiss(); retryCreate();
            } catch (Exception error) { reportError("无法保存新建请求", "Could not save creation request", error); }
        }, false));
        showComputerDialog(dialog);
    }

    private void retryCreate() {
        if (!foreground || !screen.equals("list") || !credentials.has("pendingCreate") || commandBusy) return;
        RemoteApi client = begin(); int ticket = generation; commandBusy = true;
        JSONObject payload = credentials.optJSONObject("pendingCreate"); String token = credentials.optString("token");
        boolean workspaceCreation = payload != null && payload.optString("action").equals("create-workspace");
        boolean moving = payload != null && payload.optString("action").equals("move");
        boolean archiving = payload != null && payload.optString("action").equals("archive");
        boolean managing = payload != null && java.util.Set.of("rename", "pin", "delete").contains(payload.optString("action"));
        status.setText(archiving ? tr("正在归档会话…", "Archiving conversation…") : moving ? tr("正在移动会话…", "Moving conversation…") : workspaceCreation ? tr("正在新建工作区…", "Creating workspace…") : tr("正在新建会话…", "Creating conversation…"));
        if (managing) status.setText(tr("正在更新会话…", "Updating conversations…"));
        job = worker.submit(() -> {
            try {
                JSONObject request = new JSONObject(payload.toString());
                String targetId = request.optString("moveSessionId"); request.remove("moveSessionId");
                JSONObject result = client.json(moving ? "/v1/conversations/" + targetId + "/commands" : "/v1/commands", token, request);
                deliver(ticket, () -> {
                    commandBusy = false;
                    if (result.optString("state").equals("pending")) {
                        renderConversations();
                        status.setText(tr("电脑正在准备操作，请稍后重试同一请求查询结果。", "The computer is preparing the operation. Retry the same request shortly to check its result."));
                        return;
                    }
                    try {
                        JSONObject saved = new JSONObject(credentials.toString()); saved.remove("pendingCreate"); store.save(saved); credentials = saved;
                        JSONObject conversation = result.optJSONObject("conversation");
                        if (result.optBoolean("ok") && managing) {
                            selectingConversations = false; selectedConversations.clear(); loadList(false);
                        } else if (result.optBoolean("ok") && moving) {
                            String workspace = payload.isNull("workspaceId") ? "" : payload.optString("workspaceId");
                            String key = credentials.optString("address") + "/" + workspace;
                            collapsedGroups.put(key, false); getPreferences(MODE_PRIVATE).edit().putBoolean("collapsed:" + key, false).apply();
                            loadList(false);
                        } else if (result.optBoolean("ok") && archiving) {
                            loadList(false);
                            status.setText(tr("会话已归档", "Conversation archived"));
                        } else if (result.optBoolean("ok") && workspaceCreation && result.optJSONObject("workspace") != null) {
                            loadList(false);
                        } else if (result.optBoolean("ok") && conversation != null) {
                            conversationId = conversation.getString("id"); conversationTitle = conversation.optString("title"); detailScreen(); connectEvents();
                        } else { renderConversations(); status.setText(tr("操作未确认成功，请先在电脑核对。", "Operation not confirmed. Check the desktop before retrying.") + " " + result.optString("error")); }
                    } catch (Exception error) { reportError("无法保存结果，请重试同一请求。", "Could not save result. Retry the same request.", error); }
                });
            } catch (Exception error) { deliver(ticket, () -> {
                commandBusy = false;
                if (error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status >= 400 && ((RemoteApi.Failure) error).status < 500 && ((RemoteApi.Failure) error).status != 429) {
                    try { credentials.remove("pendingCreate"); store.save(credentials); } catch (Exception ignored) { }
                }
                renderConversations(); showFailure(error, true);
            }); }
        });
    }

    private void pickImage() {
        if (loadingImages) return;
        if (!connected || !controlAllowed || !canImage || commandBusy || credentials.has("pendingCommand")) {
            status.setText(tr("添加图片需要更新并重启电脑端。", "Images require an updated and restarted desktop.")); return;
        }
        if (selectedImages.size() >= (canMultiImage ? 9 : 1)) {
            status.setText(canMultiImage ? tr("最多添加 9 张图片。", "Add up to 9 images.") : tr("多图发送需要更新并重启电脑端。", "Multiple images require an updated and restarted desktop.")); return;
        }
        imageConversation = conversationId; imageComputer = credentials.optString("address");
        LinearLayout panel = computerDialogPanel(tr("添加图片", "Add image"), tr("选择图片来源", "Choose an image source"));
        android.app.Dialog dialog = createComputerDialog(panel);
        panel.addView(button(tr("从相册选择", "Choose from gallery"), () -> { dialog.dismiss(); openGallery(); }, true));
        panel.addView(button(tr("使用相机拍摄", "Take a photo"), () -> { dialog.dismiss(); openCamera(); }, false));
        panel.addView(button(tr("取消", "Cancel"), dialog::dismiss, false));
        showComputerDialog(dialog);
    }

    private void openGallery() {
        android.content.Intent picker = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
        picker.setType("image/*"); picker.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        picker.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, canMultiImage);
        try { startActivityForResult(picker, PICK_IMAGE_REQUEST); }
        catch (Exception error) { reportError("无法打开图片选择器", "Cannot open the image picker", error); }
    }

    private void openCamera() {
        try {
            java.io.File directory = new java.io.File(getCacheDir(), "camera");
            if (!directory.exists() && !directory.mkdirs()) throw new IOException();
            cameraImageFile = java.io.File.createTempFile("photo-", ".jpg", directory);
            cameraImageUri = CameraFileProvider.uri(this, cameraImageFile);
            android.content.Intent camera = new android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(android.provider.MediaStore.EXTRA_OUTPUT, cameraImageUri)
                .addFlags(android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(camera, TAKE_PHOTO_REQUEST);
        } catch (Exception error) {
            clearCameraImage(); reportError("无法打开相机", "Cannot open the camera", error);
        }
    }

    @Override protected void onActivityResult(int request, int result, android.content.Intent data) {
        super.onActivityResult(request, result, data);
        if (request == ArtifactDownloads.SAVE_REQUEST) {
            artifactDownloads.result(result, data, credentials.optString("address"), credentials.optString("token")); return;
        }
        if (request != PICK_IMAGE_REQUEST && request != TAKE_PHOTO_REQUEST) return;
        ArrayList<android.net.Uri> uris = new ArrayList<>();
        if (result == RESULT_OK) {
            if (request == TAKE_PHOTO_REQUEST && cameraImageUri != null) uris.add(cameraImageUri);
            else if (data != null && data.getClipData() != null) {
                for (int index = 0; index < data.getClipData().getItemCount(); index++) uris.add(data.getClipData().getItemAt(index).getUri());
            } else if (data != null && data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) { if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); return; }
        if (loadingImages || selectedImages.size() + uris.size() > (canMultiImage ? 9 : 1)) {
            status.setText(canMultiImage ? tr("最多添加 9 张图片。", "Add up to 9 images.") : tr("多图发送需要更新并重启电脑端。", "Multiple images require an updated and restarted desktop."));
            if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); return;
        }
        String target = imageConversation, computer = imageComputer;
        loadingImages = true; updateControls();
        worker.submit(() -> {
            try {
                ArrayList<String> encodedImages = new ArrayList<>();
                for (android.net.Uri uri : uris) {
                    android.graphics.BitmapFactory.Options options = new android.graphics.BitmapFactory.Options(); options.inJustDecodeBounds = true;
                    try (var input = getContentResolver().openInputStream(uri)) { android.graphics.BitmapFactory.decodeStream(input, null, options); }
                    if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException();
                    options.inJustDecodeBounds = false; options.inSampleSize = 1;
                    while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 1600) options.inSampleSize *= 2;
                    android.graphics.Bitmap bitmap;
                    try (var input = getContentResolver().openInputStream(uri)) { bitmap = android.graphics.BitmapFactory.decodeStream(input, null, options); }
                    if (bitmap == null) throw new IOException();
                    java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                    try { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, bytes); } finally { bitmap.recycle(); }
                    if (bytes.size() > 1024 * 1024) throw new IOException();
                    encodedImages.add(android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP));
                }
                handler.post(() -> {
                    if (isDestroyed() || !screen.equals("detail") || !java.util.Objects.equals(target, conversationId) || !computer.equals(credentials.optString("address"))) return;
                    selectedImages.addAll(encodedImages); renderImage(); updateControls();
                });
            } catch (Exception error) { handler.post(() -> { if (!isDestroyed() && screen.equals("detail") && java.util.Objects.equals(target, conversationId) && java.util.Objects.equals(computer, credentials.optString("address"))) status.setText(ErrorDetails.withSummary(tr("无法读取图片，请选择较小的图片。", "Cannot read image. Choose a smaller image."), error)); }); }
            finally { handler.post(() -> { loadingImages = false; if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); if (!isDestroyed() && screen.equals("detail")) updateControls(); }); }
        });
    }

    private void clearCameraImage() {
        if (cameraImageFile != null) cameraImageFile.delete();
        cameraImageFile = null; cameraImageUri = null;
    }

    private void renderImage() {
        if (imageTray == null) return;
        imageTray.removeAllViews();
        if (!java.util.Objects.equals(imageConversation, conversationId) || !java.util.Objects.equals(imageComputer, credentials.optString("address"))) selectedImages.clear();
        imageStrip.setVisibility(selectedImages.isEmpty() ? View.GONE : View.VISIBLE);
        for (int index = 0; index < selectedImages.size(); index++) {
            final int position = index;
            byte[] bytes = android.util.Base64.decode(selectedImages.get(index), android.util.Base64.NO_WRAP);
            android.graphics.BitmapFactory.Options options = new android.graphics.BitmapFactory.Options(); options.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            options.inJustDecodeBounds = false; options.inSampleSize = 1;
            while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > dp(144)) options.inSampleSize *= 2;
            ImageView preview = new ImageView(this); preview.setImageBitmap(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options));
            preview.setContentDescription(tr("待发送图片 ", "Image to send ") + (index + 1));
            preview.setScaleType(ImageView.ScaleType.CENTER_CROP);
            GradientDrawable shape = new GradientDrawable(); shape.setColor(surface); shape.setCornerRadius(dp(14));
            preview.setBackground(shape); preview.setClipToOutline(true);
            android.widget.FrameLayout tile = new android.widget.FrameLayout(this);
            android.widget.FrameLayout.LayoutParams previewParams = new android.widget.FrameLayout.LayoutParams(dp(72), dp(72));
            previewParams.setMargins(dp(4), dp(8), 0, 0); tile.addView(preview, previewParams);
            ImageButton close = new ImageButton(this);
            close.setImageDrawable(new LineIcon("close", Color.WHITE)); close.setPadding(dp(12), dp(12), dp(12), dp(12));
            GradientDrawable circle = new GradientDrawable(); circle.setShape(GradientDrawable.OVAL); circle.setColor(0xb3000000);
            close.setBackground(new android.graphics.drawable.InsetDrawable(circle, dp(8)));
            close.setContentDescription(tr("移除图片 ", "Remove image ") + (index + 1));
            close.setOnClickListener(view -> { selectedImages.remove(position); renderImage(); updateControls(); });
            tile.addView(close, new android.widget.FrameLayout.LayoutParams(dp(40), dp(40), Gravity.TOP | Gravity.RIGHT));
            imageTray.addView(tile, new LinearLayout.LayoutParams(dp(88), dp(88)));
        }
    }

    private void watchList(RemoteApi client, int ticket) {
        if (listEventsUnavailable) {
            status.setText(tr("已连接，定时刷新列表。更新并重启电脑端可启用实时同步。", "Connected; refreshing periodically. Update and restart the desktop for live sync."));
            handler.postDelayed(() -> {
                if (networkActive() && ticket == generation && screen.equals("list")) loadList(false);
            }, 15_000);
        } else {
            status.setText(tr("已连接", "Connected"));
            streamList(client, ticket, 0);
        }
    }

    private void streamList(RemoteApi client, int ticket, int attempt) {
        if (!networkActive() || ticket != generation || !screen.equals("list")) return;
        String token = credentials.optString("token");
        int limit = Math.max(100, conversations.size());
        long syncedCursor = listCursor;
        String syncedInstance = listInstance;
        job = worker.submit(() -> {
            boolean[] received = { false };
            boolean[] streamOpened = { false };
            Exception failure = null;
            try {
                client.listEvents(token, snapshot -> {
                    boolean initial = !streamOpened[0];
                    streamOpened[0] = true;
                    if (initial && attempt == 0 && syncedCursor >= 0 && syncedCursor == snapshot.optLong("cursor", -1)
                            && syncedInstance.equals(snapshot.optString("instanceId"))) {
                        received[0] = true;
                        deliver(ticket, () -> status.setText(tr("已连接", "Connected")));
                        return;
                    }
                    JSONArray entries = new JSONArray();
                    int offset = 0;
                    JSONObject page;
                    JSONObject info = null;
                    do {
                        page = client.json("/v1/conversations?offset=" + offset, token, null);
                        if (info == null) info = listInfo(client, token, page);
                        JSONArray rows = page.optJSONArray("conversations");
                        if (rows != null) for (int index = 0; index < rows.length(); index++) entries.put(rows.optJSONObject(index));
                        offset = page.optInt("nextOffset", -1);
                    } while (offset >= 0 && entries.length() < limit);
                    try { page.put("conversations", entries); }
                    catch (org.json.JSONException error) { throw new IOException("Invalid conversation list", error); }
                    JSONObject updated = page;
                    JSONObject updatedInfo = info;
                    received[0] = true;
                    deliver(ticket, () -> {
                        updateCapabilities(updatedInfo);
                        listCursor = snapshot.optLong("cursor", -1);
                        applyConversationPage(updated, false);
                        cacheConversations();
                        computerStates.put(credentials.optString("address"), tr("已连接", "Connected"));
                        status.setText(tr("已连接", "Connected"));
                    });
                });
            } catch (Exception error) { failure = error; }
            final Exception error = failure;
            int nextAttempt = received[0] ? 0 : Math.min(attempt + 1, 5);
            deliver(ticket, () -> {
                if (!streamOpened[0] && error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 404) {
                    listEventsUnavailable = true;
                    watchList(client, ticket); return;
                }
                if (error instanceof RemoteApi.Failure && (((RemoteApi.Failure) error).status == 401 || ((RemoteApi.Failure) error).status == 403 || ((RemoteApi.Failure) error).status == 404)) {
                    showFailure(error, true); return;
                }
                status.setText(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                long delay = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : Math.min(30_000, 1000L << nextAttempt);
                handler.postDelayed(() -> streamList(client, ticket, nextAttempt), delay);
            });
        });
    }

    private String activity(JSONObject conversation) {
        String activity = conversation.optString("activity", "");
        if (activity.equals("running")) return tr("正在运行", "Running");
        if (activity.equals("permission") || activity.equals("question")) return tr("等待电脑处理", "Waiting for desktop input");
        return tr("空闲", "Idle");
    }

    private void detailScreen() {
        initialMessageScroll = true;
        renderedMessages.clear();
        processState.clear();
        screen = "detail"; networkScreen = false;
        stopNetwork(); history.clear(); instance = ""; cursor = -1; nextBefore = null; lastLive = null; historyLimited = false; editingSeq = -1;
        remoteSettings = null;
        displayedConversation = null;
        outgoingMessage = credentials.optJSONObject("pendingCommand");
        if (outgoingMessage != null && !conversationId.equals(outgoingMessage.optString("conversationId"))) outgoingMessage = null;
        if (outgoingMessage != null) {
            try { outgoingMessage = new JSONObject(outgoingMessage.toString()).put("delivery", "unconfirmed"); }
            catch (Exception ignored) { outgoingMessage = null; }
        }
        shell(conversationTitle, tr("电脑执行 · 手机查看", "Runs on your computer · Read on your phone"));
        scroll.setVerticalScrollBarEnabled(false);
        older = button(tr("加载更早消息", "Load earlier messages"), this::loadOlder, false); older.setEnabled(false);
        older.setVisibility(View.GONE);
        older.setBackgroundColor(Color.TRANSPARENT); older.setTextSize(12); content.addView(older);
        messages = column(); content.addView(messages);
        approvals = column(); content.addView(approvals); approvalSignature = "";
        LinearLayout composerBar = bottomBar("composerBar");
        chatComposer = new ChatComposer(composerBar, chatStyle, chinese, tr("发消息，继续任务…", "Message your computer…"), 16000,
            () -> showRemoteSettings(false), this::sendMessage, this::stopRun, this::cancelEdit);
        composer = chatComposer.input;
        modelButton = chatComposer.model; modelButton.setTag("remoteModelPicker");
        sendButton = chatComposer.send; stopButton = chatComposer.stop;
        attachButton = lineButton("plus", tr("添加图片", "Add image"), this::pickImage);
        imageStrip = new android.widget.HorizontalScrollView(this); imageStrip.setHorizontalScrollBarEnabled(false);
        imageTray = new LinearLayout(this); imageTray.setOrientation(LinearLayout.HORIZONTAL);
        imageStrip.addView(imageTray); composerBar.addView(imageStrip, 0, new LinearLayout.LayoutParams(-1, -2)); renderImage();
        chatComposer.addTool(attachButton);
        permissionButton = lineButton("shield", tr("安全级别", "Safety level"), () -> showRemoteSettings(true)); permissionButton.setTag("remotePermissionPicker");
        chatComposer.addTool(permissionButton);
        composer.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                updateControls();
            }
            @Override public void afterTextChanged(android.text.Editable text) {}
        });
        String draft = savedDraft();
        if (!draft.isEmpty() || savedDraftEdit() > 0) {
            composer.setText(draft); composer.setSelection(composer.length());
            long edit = savedDraftEdit();
            if (edit > 0) editingSeq = edit;
        }
        renderMessages(null);
        showPrefetchedConversation();
        updateControls();
    }

    // Unsent text is kept per conversation in the encrypted computer profile so
    // returning to the list, leaving the app or restarting does not lose it. An
    // unfinished edit keeps its target too, so it stays an edit instead of
    // silently turning into a new message; the desktop still validates the seq.
    private String savedDraft() {
        JSONObject drafts = credentials.optJSONObject("drafts");
        return drafts == null || conversationId == null ? "" : drafts.optString(conversationId, "");
    }

    private long savedDraftEdit() {
        JSONObject edits = credentials.optJSONObject("draftEdits");
        return edits == null || conversationId == null ? -1 : edits.optLong(conversationId, -1);
    }

    private void persistDraft() {
        if (composer == null || conversationId == null || !screen.equals("detail") || !credentials.has("token")) return;
        try {
            JSONObject saved = new JSONObject(credentials.toString());
            JSONObject drafts = saved.optJSONObject("drafts");
            if (drafts == null) drafts = new JSONObject();
            JSONObject edits = saved.optJSONObject("draftEdits");
            if (edits == null) edits = new JSONObject();
            String text = composer.getText().toString();
            if (text.isEmpty()) drafts.remove(conversationId); else drafts.put(conversationId, text);
            if (editingSeq > 0) edits.put(conversationId, editingSeq); else edits.remove(conversationId);
            saved.put("drafts", drafts).put("draftEdits", edits);
            store.save(saved);
            credentials = saved;
        } catch (Exception error) { reportError("无法保存草稿，请重试。", "Could not save the draft. Try again.", error); }
    }

    private void showPrefetchedConversation() {
        JSONObject cached = prefetch.get(credentials, conversationId);
        if (cached == null) return;
        JSONArray rows = cached.optJSONArray("messages");
        if (rows == null) return;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row != null) history.put(row.optLong("seq"), row);
        }
        connected = false; controlAllowed = false; lastLive = null; remoteSettings = null;
        trimHistory(); renderMessages(null);
        status.setText(tr("显示预加载内容，正在同步最新消息…", "Showing preloaded messages; syncing latest…"));
    }

    private void connectEvents() {
        if (!networkActive()) return;
        RemoteApi client = begin(); int ticket = generation;
        status.setText(history.isEmpty() ? tr("正在连接…", "Connecting…")
            : tr("显示缓存内容，正在同步最新消息…", "Showing cached messages; syncing latest…"));
        String token = credentials.optString("token");
        worker.submit(() -> {
            try {
                JSONObject info = client.json("/v1/status", token, null);
                deliver(ticket, () -> { updateCapabilities(info); stream(client, ticket, 0); });
            } catch (Exception error) { deliver(ticket, () -> stream(client, ticket, 0)); }
        });
    }

    private void stream(RemoteApi client, int ticket, int attempt) {
        if (!networkActive() || ticket != generation) return;
        String id = conversationId, token = credentials.optString("token");
        job = worker.submit(() -> {
            boolean[] received = { false };
            Exception failure = null;
            try {
                client.events(id, token, snapshot -> { received[0] = true; queueSnapshot(ticket, snapshot); });
            } catch (Exception error) { failure = error; }
            final Exception error = failure;
            int nextAttempt = received[0] ? 0 : Math.min(attempt + 1, 5);
            deliver(ticket, () -> {
                if (error instanceof RemoteApi.Failure && (((RemoteApi.Failure) error).status == 401 || ((RemoteApi.Failure) error).status == 403 || ((RemoteApi.Failure) error).status == 404)) {
                    connected = false; updateControls();
                    showFailure(error, true); return;
                }
                connected = false; updateControls();
                status.setText(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                long delay = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : Math.min(30_000, 1000L << nextAttempt);
                handler.postDelayed(() -> stream(client, ticket, nextAttempt), delay);
            });
        });
    }

    private void queueSnapshot(int ticket, JSONObject snapshot) {
        synchronized (this) {
            if (ticket != generation) return;
            pendingSnapshot = snapshot;
            if (snapshotPosted) return;
            snapshotPosted = true;
        }
        handler.postDelayed(() -> {
            JSONObject latest;
            synchronized (this) { latest = pendingSnapshot; pendingSnapshot = null; snapshotPosted = false; }
            if (networkActive() && ticket == generation && latest != null) applySnapshot(latest);
        }, 120);
    }

    private void applySnapshot(JSONObject snapshot) {
        JSONObject conversation = snapshot.optJSONObject("conversation");
        if (conversation == null || !conversation.optString("id").equals(conversationId)) return;
        boolean resumePrefetch = !connected;
        connected = true; controlAllowed = snapshot.optString("permission").equals("control"); conversationSeq = conversation.optLong("seq");
        String server = snapshot.optString("instanceId"); long nextCursor = snapshot.optLong("cursor", -1);
        if (server.equals(instance) && nextCursor < cursor) return;
        prefetch.put(credentials, snapshot);
        if (foreground && resumePrefetch) {
            JSONObject page = listCache.get(credentials);
            if (page != null && page.optJSONArray("conversations") != null) prefetch.scheduleIdle(credentials, page.optJSONArray("conversations"), page.optInt("nextOffset", -1));
        }
        if (!server.equals(instance)) { history.clear(); historyLimited = false; }
        boolean following = initialMessageScroll || pendingScrollView == scroll && pendingScrollPosition == Integer.MAX_VALUE
            || scroll.getChildCount() == 0 || scroll.getChildAt(0).getHeight() - scroll.getHeight() - scroll.getScrollY() < dp(120);
        instance = server; cursor = nextCursor;
        conversationTitle = conversation.optString("title", conversationTitle);
        TextView pageTitle = root.findViewWithTag("pageTitle");
        if (pageTitle != null) pageTitle.setText(conversationTitle);
        JSONObject settings = snapshot.optJSONObject("settings");
        if (settingsPopup != null && (settings == null || remoteSettings == null || !settings.optString("version").equals(remoteSettings.optString("version")) || !settings.optBoolean("editable"))) {
            settingsPopup.dismiss(); settingsPopup = null;
        }
        remoteSettings = settings;
        JSONArray rows = snapshot.optJSONArray("messages");
        if (rows == null) return;
        long first = rows.length() == 0 ? 0 : rows.optJSONObject(0).optLong("seq");
        history.tailMap(first).clear();
        for (int index = 0; index < rows.length(); index++) { JSONObject row = rows.optJSONObject(index); if (row != null) history.put(row.optLong("seq"), row); }
        if (history.isEmpty() || history.firstKey() >= first) nextBefore = snapshot.isNull("nextBefore") ? null : snapshot.optLong("nextBefore");
        trimHistory();
        lastLive = snapshot.optJSONObject("live");
        displayedConversation = conversation;
        renderMessages(lastLive);
        if (foreground) replies().markRead(credentials, conversation);
        syncReplyRead(conversation);
        renderApprovals(); updateControls();
        updateOlderControl();
        status.setText(controlAllowed ? credentials.has("pendingCommand")
            ? tr("操作待确认，请重试同一请求；不要重复发送。", "Operation awaiting confirmation. Retry the same request; do not send another copy.")
            : String.format(tr("已连接 · %s", "Connected · %s"), activity(conversation))
            : tr("请更新并重启电脑端以操作会话", "Update and restart the desktop to control conversations"));
        if (following && !olderLoading) positionMessages(Integer.MAX_VALUE);
    }

    private void syncReplyRead(JSONObject conversation) {
        long reply = conversation.optLong("lastReplyAt", 0);
        if (!foreground || api == null || !conversation.has("replyReadAt") || reply <= conversation.optLong("replyReadAt", 0)) return;
        RemoteApi client = api;
        String token = credentials.optString("token"), target = conversation.optString("id");
        commandWorker.submit(() -> {
            try { client.json("/v1/conversations/" + target + "/read", token, new JSONObject().put("lastReplyAt", reply)); }
            catch (Exception ignored) { }
        });
    }

    private void renderMessages(JSONObject live) {
        int position = scroll.getScrollY(); messages.removeAllViews();
        java.util.HashSet<String> retained = new java.util.HashSet<>();
        JSONArray pendingProcess = new JSONArray();
        long turn = 0;
        for (JSONObject row : history.values()) {
            String role = row.optString("role");
            if (role.equals("user")) { pendingProcess = new JSONArray(); turn = row.optLong("seq"); }
            if (role.equals("tool")) {
                JSONArray process = row.optJSONArray("process");
                if (process != null) for (int index = 0; index < process.length(); index++) pendingProcess.put(process.opt(index));
                continue;
            }
            String label = role.equals("user") ? tr("你", "You") : role.equals("assistant") ? "Camellia" : tr("提示", "Notice");
            String key = "message:" + row.optLong("seq"); retained.add(key);
            JSONArray process = row.optJSONArray("process");
            if (role.equals("assistant") && (process == null || process.length() == 0)) process = pendingProcess;
            addMessage(key, label, row.optString("text"), role.equals("user"), row.optBoolean("textTruncated"), process, false, "turn:" + turn, row.optLong("at"), row.optLong("seq"));
            if (role.equals("assistant")) pendingProcess = new JSONArray();
        }
        if (live != null) {
            retained.add("live");
            JSONArray process = live.optJSONArray("process");
            if (process == null || process.length() == 0) process = pendingProcess;
            addMessage("live", tr("正在回复", "Reply in progress"), live.optString("text"), false, live.optBoolean("textTruncated"), process, true, "turn:" + live.optLong("userSeq", turn), live.optLong("startedAt"), 0);
            if (live.optInt("pendingApprovals") > 0 && !controlAllowed) messages.addView(text(tr("有待处理授权，请回到电脑处理。", "Approval is pending. Respond on the computer."), 13, accent));
        } else if (pendingProcess.length() > 0) {
            retained.add("pendingProcess");
            addMessage("pendingProcess", "", "", false, false, pendingProcess, false, "turn:" + turn, 0, 0);
        }
        renderOutgoing(retained);
        renderedMessages.keySet().retainAll(retained);
        if (initialMessageScroll && messages.getChildCount() > 0) {
            initialMessageScroll = false;
            positionMessages(Integer.MAX_VALUE);
        } else {
            ScrollView target = scroll;
            long revision = messageScrollRevision;
            boolean restoring = pendingScrollView != target;
            target.post(() -> {
                if (restoring && revision == messageScrollRevision && scroll == target && pendingScrollView != target) target.scrollTo(0, position);
            });
        }
    }

    private void positionMessages(int position) {
        messageScrollRevision++;
        if (pendingScrollView != null && pendingMessageScroll != null && pendingScrollView.getViewTreeObserver().isAlive()) {
            pendingScrollView.getViewTreeObserver().removeOnPreDrawListener(pendingMessageScroll);
        }
        ScrollView target = scroll;
        pendingScrollView = target;
        pendingScrollPosition = position;
        pendingMessageScroll = new android.view.ViewTreeObserver.OnPreDrawListener() {
            @Override public boolean onPreDraw() {
                if (target.isLayoutRequested() || target.getChildCount() > 0 && target.getChildAt(0).isLayoutRequested()) return true;
                target.getViewTreeObserver().removeOnPreDrawListener(this);
                pendingScrollView = null;
                pendingMessageScroll = null;
                if (scroll == target && screen.equals("detail")) {
                    int destination = position == Integer.MAX_VALUE && target.getChildCount() > 0 ? target.getChildAt(0).getHeight() : position;
                    target.scrollTo(0, destination);
                }
                return true;
            }
        };
        target.getViewTreeObserver().addOnPreDrawListener(pendingMessageScroll);
        target.invalidate();
    }

    private void beginEdit(long seq, String text) {
        if (!screen.equals("detail") || !connected || !controlAllowed || lastLive != null || commandBusy || credentials.has("pendingCommand") || awaitingSentMessage()) return;
        JSONObject latest = null;
        for (JSONObject row : history.values()) if (row.optString("role").equals("user")) latest = row;
        if (latest == null || latest.optLong("seq") != seq) return;
        editingText = text;
        composer.setText(text); composer.setSelection(composer.length());
        editingSeq = seq;
        composer.requestFocus();
        ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(composer, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        status.setText(tr("正在编辑上一条消息 · 发送后将重新生成回复", "Editing previous message · sending regenerates the reply"));
        updateControls();
    }

    private void cancelEdit() {
        if (composer == null || commandBusy || credentials.has("pendingCommand") || lastLive != null) return;
        locationConsent.cancel();
        editingSeq = -1; editingText = ""; composer.setText("");
        persistDraft(); status.setText(""); updateControls();
    }

    private void renderOutgoing(java.util.Set<String> retained) {
        retryMessage = null;
        if (outgoingMessage == null || !conversationId.equals(outgoingMessage.optString("conversationId"))) return;
        JSONObject payload = outgoingMessage.optJSONObject("payload");
        if (payload == null || !(payload.optString("action").equals("send") || payload.optString("action").equals("resend"))) return;
        boolean synced = false;
        if (instance.equals(payload.optString("instanceId"))) for (JSONObject row : history.values()) {
            if (row.optString("role").equals("user") && (outgoingMessage.has("userSeq")
                    ? row.optLong("seq") == outgoingMessage.optLong("userSeq")
                    : row.optLong("seq") == payload.optLong("expectedSeq") + 1
                        && row.optString("text").equals(payload.optString("prompt")))) { synced = true; break; }
        }
        String state = outgoingMessage.optString("delivery", "unconfirmed");
        if (synced && state.equals("accepted")) { outgoingMessage = null; return; }
        if (!synced) {
            String key = "outgoing:" + payload.optString("requestId");
            boolean first = !renderedMessages.containsKey(key);
            retained.add(key);
            String value = outgoingMessage.optString("draft", payload.optString("prompt"));
            if (payload.has("image")) value += tr("\n[图片]", "\n[Image]");
            addMessage(key, tr("你", "You"), value, true, false, null, false, key, outgoingMessage.optLong("at"), 0);
            if (first && android.animation.ValueAnimator.areAnimatorsEnabled()) {
                View bubble = renderedMessages.get(key);
                bubble.setAlpha(0f); bubble.setTranslationY(dp(12));
                bubble.animate().alpha(1f).translationY(0f).setDuration(180).start();
            }
        }
        LinearLayout delivery = new LinearLayout(this); delivery.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        delivery.setTag("outgoingDelivery");
        if (state.equals("sending") || state.equals("preparing")) {
            LoadingIndicator progress = new LoadingIndicator(this);
            delivery.addView(progress, new LinearLayout.LayoutParams(dp(18), dp(18)));
        }
        String label = state.equals("sending") ? tr("正在发送…", "Sending…")
            : state.equals("preparing") ? tr("电脑正在准备…", "Computer is preparing…")
            : state.equals("accepted") ? tr("电脑已接收，等待同步…", "Accepted; waiting for sync…")
            : state.equals("failed") ? tr("发送失败，内容已恢复到输入框", "Send failed; draft restored")
            : tr("未收到确认：连接失败或超时，点击重试", "Unconfirmed: connection failed or timed out. Tap to retry.");
        TextView deliveryText = text(label, 12, muted);
        if (state.equals("unconfirmed")) {
            retryMessage = deliveryText;
            retryMessage.setTag("outgoingRetry");
            retryMessage.setMinHeight(dp(48));
            retryMessage.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            retryMessage.setContentDescription(label + tr("（重试同一请求，不会重复执行）", " (retries the same request without duplicate execution)"));
            retryMessage.setOnClickListener(view -> retryCommand());
            retryMessage.setEnabled(connected && controlAllowed && !commandBusy && credentials.has("pendingCommand"));
        }
        delivery.addView(deliveryText); messages.addView(delivery);
    }

    private void outgoingState(String state) {
        if (outgoingMessage == null) return;
        try { outgoingMessage.put("delivery", state); } catch (Exception ignored) { }
        renderMessages(lastLive);
    }

    private boolean awaitingSentMessage() {
        return outgoingMessage != null && outgoingMessage.optString("delivery").equals("accepted");
    }

    private final ExecutionProcessView.State processState = new ExecutionProcessView.State();

    private void addMessage(String key, String label, String value, boolean user, boolean truncated, JSONArray process, boolean live, String turn, long at, long seq) {
        long latestUserSeq = -1;
        if (user) for (JSONObject row : history.values()) if (row.optString("role").equals("user")) latestUserSeq = row.optLong("seq");
        boolean editable = user && !live && !truncated && seq > 0 && seq == latestUserSeq;
        String signature = label + "\u0000" + user + truncated + live + editable + "\u0000" + at + "\u0000" + value + "\u0000" + String.valueOf(process);
        View existing = renderedMessages.get(key);
        if (existing != null && signature.equals(existing.getTag())) { messages.addView(existing); return; }
        LinearLayout block = chatStyle.messageBlock(user);
        if (!user && process != null && process.length() > 0) {
            ExecutionProcessView processView = new ExecutionProcessView(this, chatStyle, processState, conversationId + ":" + turn);
            processView.update(process, live); block.addView(processView);
        }
        if (truncated) block.addView(text(tr("内容过长，仅显示末尾片段。", "Long message: showing the final portion."), 12, accent));
        TextView body = null;
        if (user || value.isEmpty() && (process == null || process.length() == 0)) {
            body = text(value.isEmpty() ? tr("等待输出…", "Waiting for output…") : value, 15, ink); body.setTextIsSelectable(true); chatStyle.messageTypography(body); block.addView(body);
        } else if (!value.isEmpty()) block.addView(markdown.render(value));
        if (!user && !live && !value.isEmpty()) {
            java.util.List<String> files = ArtifactReferences.names(value);
            if (!files.isEmpty()) {
                ArtifactMessageView download = new ArtifactMessageView(this, files, chinese,
                    () -> artifactDownloads.show(credentials.optString("address"), credentials.optString("token"), conversationId));
                download.setTag("messageArtifacts:" + key);
                LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.topMargin = dp(18);
                block.addView(download, layout);
            }
        }
        LinearLayout wrapper = value.isEmpty() ? block : chatStyle.messageWithFooter(block, user, () -> value, at, chinese);
        if (editable) {
            View.OnClickListener edit = view -> beginEdit(seq, value);
            block.setOnClickListener(edit);
            if (body != null) body.setOnClickListener(edit);
            String hint = tr("点击编辑上一条消息", "Tap to edit previous message");
            block.setContentDescription(hint);
            if (body != null) body.setContentDescription(hint);
        }
        wrapper.setTag(signature); renderedMessages.put(key, wrapper); messages.addView(wrapper);
    }

    private void updateOlderControl() {
        boolean available = nextBefore != null && !historyLimited;
        older.setEnabled(available && !olderLoading);
        older.setVisibility(available ? View.VISIBLE : View.GONE);
        ((RefreshScrollView) scroll).setRefreshAction(available ? this::loadOlder : null, ready -> {
            if (ready) status.setText(tr("松开加载更早消息", "Release to load earlier messages"));
        });
    }

    private void loadOlder() {
        if (olderLoading) return;
        if (!foreground || nextBefore == null || api == null || historyLimited) {
            ((RefreshScrollView) scroll).setRefreshing(false); return;
        }
        RemoteApi client = api; int ticket = generation; long before = nextBefore;
        String server = instance;
        String id = conversationId, token = credentials.optString("token"); older.setEnabled(false);
        olderLoading = true;
        ((RefreshScrollView) scroll).setRefreshing(true);
        status.setText(tr("正在加载更早消息…", "Loading earlier messages…"));
        worker.submit(() -> {
            try {
                JSONObject snapshot = client.json("/v1/conversations/" + id + "?before=" + before, token, null);
                deliver(ticket, () -> {
                    olderLoading = false;
                    ((RefreshScrollView) scroll).setRefreshing(false);
                    if (!server.equals(instance) || !server.equals(snapshot.optString("instanceId", server))) { updateOlderControl(); return; }
                    View anchor = null;
                    for (int index = 0; index < messages.getChildCount(); index++) {
                        View candidate = messages.getChildAt(index);
                        if (messages.getTop() + candidate.getBottom() > scroll.getScrollY()) { anchor = candidate; break; }
                    }
                    View retainedAnchor = anchor;
                    int anchorOffset = anchor == null ? 0 : messages.getTop() + anchor.getTop() - scroll.getScrollY();
                    JSONArray rows = snapshot.optJSONArray("messages");
                    if (rows != null) for (int index = 0; index < rows.length(); index++) { JSONObject row = rows.optJSONObject(index); if (row != null) history.put(row.optLong("seq"), row); }
                    nextBefore = snapshot.isNull("nextBefore") ? null : snapshot.optLong("nextBefore");
                    boolean trimmed = trimHistory();
                    renderMessages(lastLive); updateOlderControl();
                    ScrollView targetScroll = scroll;
                    targetScroll.post(() -> {
                        if (ticket == generation && retainedAnchor != null && retainedAnchor.getParent() == messages) {
                            targetScroll.scrollTo(0, messages.getTop() + retainedAnchor.getTop() - anchorOffset);
                        }
                    });
                    if (trimmed) status.setText(tr("已达到历史显示上限，请在电脑查看更早消息。", "History display limit reached. Read earlier messages on the computer."));
                    else status.setText(nextBefore == null ? tr("已加载全部消息", "All messages loaded") : tr("已加载更早消息", "Earlier messages loaded"));
                });
            } catch (Exception error) { deliver(ticket, () -> {
                olderLoading = false; ((RefreshScrollView) scroll).setRefreshing(false);
                updateOlderControl(); showFailure(error, true);
            }); }
        });
    }

    private boolean trimHistory() {
        long size = 0;
        for (JSONObject row : history.values()) size += row.toString().length();
        boolean trimmed = false;
        while (history.size() > 600 || size > 4 * 1024 * 1024 && history.size() > 1) {
            size -= history.pollFirstEntry().getValue().toString().length(); trimmed = true;
        }
        if (trimmed) { nextBefore = null; historyLimited = true; }
        return trimmed;
    }

    private void showFailure(Exception error, boolean authenticated) {
        if (authenticated) computerStates.put(credentials.optString("address"), RemoteApi.failureMessage(error, chinese));
        if (error instanceof RemoteApi.Failure) {
            int code = ((RemoteApi.Failure) error).status;
            if (!foreground && (code == 401 || code == 403 || code == 404)) RemoteKeepAliveService.finish(this, false);
            if (code == 401) {
                if (authenticated) {
                    stopNetwork();
                    listCache.remove(credentials);
                    prefetch.remove(credentials, null);
                    credentials.remove("token");
                    try { store.save(credentials); } catch (Exception ignored) { }
                    pairScreen();
                }
                status.setText(tr("凭据已失效、配对已过期或被拒绝，请重新配对。", "Access was revoked, expired or rejected. Pair again.")
                    + "\n" + RemoteApi.failureMessage(error, chinese)); return;
            }
            if (code == 404) {
                prefetch.cancel();
                prefetch.remove(credentials, screen.equals("detail") ? conversationId : null);
                if (screen.equals("detail") && conversationId != null) {
                    history.clear(); if (messages != null) messages.removeAllViews();
                    status.setText(tr("会话不可用，可能已归档或不再授权。", "Conversation unavailable, archived or no longer authorized.")
                        + "\n" + RemoteApi.failureMessage(error, chinese));
                } else status.setText(tr("电脑端不支持此接口，请更新并重启电脑端。", "This endpoint is unavailable. Update and restart the desktop.")
                    + "\n" + RemoteApi.failureMessage(error, chinese));
                return;
            }
            if (code == 403) {
                prefetch.cancel();
                prefetch.remove(credentials, null);
                if (screen.equals("detail")) { history.clear(); if (messages != null) messages.removeAllViews(); }
            }
            if (code == 429 || code == 403 || code == 409) { status.setText(RemoteApi.failureMessage(error, chinese)); return; }
        }
        status.setText(RemoteApi.failureMessage(error, chinese) + tr(" 当前内容可能是缓存。", " Displayed content may be cached."));
    }

    private void bindStatusDetails() {
        ErrorDetails.bindStatus(this, status, chinese);
    }

    private void reportError(String zh, String en, Exception error) {
        status.setText(ErrorDetails.withSummary(tr(zh, en), error));
    }

    private void updateControls() {
        if (sendButton == null || conversationId == null) return;
        boolean pending = credentials.has("pendingCommand");
        boolean available = connected && controlAllowed && !commandBusy;
        boolean configurable = available && !pending && remoteSettings != null && remoteSettings.optBoolean("editable");
        if (!configurable && settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        if (modelButton != null) {
            String model = remoteSettings == null ? tr("模型", "Model") : remoteSettings.optString("model", tr("模型", "Model"));
            String thinking = remoteSettings == null ? "" : remoteSettings.optString("thinking");
            chatComposer.model(model, thinking.isEmpty() ? tr("默认", "Default") : thinking, configurable);
        }
        chatComposer.editing(editingSeq > 0, !commandBusy && !pending && lastLive == null);
        if (permissionButton != null) {
            String level = remoteSettings == null ? "ask" : remoteSettings.optString("permissionMode");
            permissionButton.setEnabled(configurable); permissionButton.setAlpha(configurable ? 1f : .45f);
            permissionButton.setContentDescription(tr("安全级别：", "Safety level: ") + RemoteSettingsPopup.permissionLabel(level, chinese));
            permissionButton.setImageDrawable(new LineIcon("shield", level.equals("full") ? 0xffc28a35 : ink));
        }
        sendButton.setEnabled(available && lastLive == null && !pending && !loadingImages && !awaitingSentMessage() && (!composer.getText().toString().trim().isEmpty() || !selectedImages.isEmpty()));
        if (attachButton != null) attachButton.setEnabled(available && !pending && !loadingImages);
        stopButton.setEnabled(available && lastLive != null && !pending);
        sendButton.setVisibility(lastLive == null ? View.VISIBLE : View.GONE);
        stopButton.setVisibility(lastLive != null ? View.VISIBLE : View.GONE);
        composer.setEnabled(!commandBusy && !pending);
        if (retryMessage != null) retryMessage.setEnabled(available && pending);
        status.setOnClickListener(pending && retryMessage == null ? view -> retryCommand() : null);
        status.setClickable(available && pending && retryMessage == null);
        status.setFocusable(available && pending && retryMessage == null);
        if (screen.equals("detail") && editingSeq > 0 && available && !pending && lastLive == null) {
            status.setText(tr("正在编辑上一条消息 · 发送后将重新生成回复", "Editing previous message · sending regenerates the reply"));
        }
        if (approvals != null) for (int index = 0; index < approvals.getChildCount(); index++) {
            View child = approvals.getChildAt(index);
            if (child instanceof Button) child.setEnabled(available && !pending);
        }
    }

    private JSONObject command(String action) throws Exception {
        return new JSONObject().put("action", action).put("requestId", java.util.UUID.randomUUID().toString()).put("instanceId", instance);
    }

    private void sendMessage() {
        if (composer == null || !connected || !controlAllowed || lastLive != null || commandBusy || credentials.has("pendingCommand") || awaitingSentMessage()) return;
        String prompt = composer.getText().toString(), target = conversationId, address = credentials.optString("address"), server = instance;
        ArrayList<String> images = new ArrayList<>(selectedImages);
        EditText input = composer;
        locationConsent.request(prompt, computerName(credentials) + tr("（电脑及其模型服务商；会保存到会话历史）", " (computer and its model provider; saved in conversation history)"), context -> {
            if (input == composer && prompt.equals(input.getText().toString()) && target.equals(conversationId)
                    && address.equals(credentials.optString("address")) && server.equals(instance)
                    && images.equals(selectedImages)) sendMessage(context);
        });
    }

    private void sendMessage(String locationContext) {
        if (!connected || !controlAllowed || lastLive != null || commandBusy || credentials.has("pendingCommand") || awaitingSentMessage()) return;
        String prompt = composer.getText().toString();
        if (loadingImages || (prompt.trim().isEmpty() && selectedImages.isEmpty())) return;
        if (selectedImages.size() > 1 && !canMultiImage) { status.setText(tr("多图发送需要更新并重启电脑端。", "Multiple images require an updated and restarted desktop.")); return; }
        try {
            boolean editing = editingSeq > 0;
            JSONObject payload = command(editing ? "resend" : "send").put("prompt", (prompt.trim().isEmpty() ? tr("请查看这些图片。", "Please review these images.") : prompt) + locationContext).put("expectedSeq", conversationSeq);
            if (editing) payload.put("editSeq", editingSeq);
            if (selectedImages.size() == 1) payload.put("image", selectedImages.get(0));
            else if (!selectedImages.isEmpty()) payload.put("images", new JSONArray(selectedImages));
            submitCommand(payload);
        }
        catch (Exception error) { reportError("无法保存操作，请重试。", "Could not save the operation. Retry.", error); }
    }

    private void stopRun() {
        if (!connected || !controlAllowed || lastLive == null || commandBusy || credentials.has("pendingCommand")) return;
        long runId = lastLive.optLong("runId");
        String server = instance;
        new CamelliaDialog.Builder(this).setTitle(tr("停止当前任务？", "Stop the current run?"))
            .setMessage(tr("仅停止当前这轮任务，不撤销已经执行的文件操作；关联的自动任务可能暂停。", "Stops this run without undoing completed file operations. Related automatic tasks may be paused."))
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("停止", "Stop"), (dialog, which) -> {
                try { submitCommand(command("stop").put("instanceId", server).put("runId", runId)); }
                catch (Exception error) { reportError("无法保存操作。", "Could not save operation.", error); }
            }).show();
    }

    private void renderApprovals() {
        JSONArray requests = controlAllowed && lastLive != null ? lastLive.optJSONArray("approvals") : null;
        String signature = instance + ":" + (lastLive == null ? "" : lastLive.optLong("runId")) + ":" + String.valueOf(requests);
        if (signature.equals(approvalSignature)) return;
        approvalSignature = signature; approvals.removeAllViews();
        if (requests == null) return;
        for (int index = 0; index < requests.length(); index++) {
            JSONObject request = requests.optJSONObject(index); if (request == null) continue;
            approvals.addView(text(request.optString("toolName"), 17, accent));
            TextView details = text(request.optString("details"), 13, ink); details.setTypeface(Typeface.MONOSPACE); details.setTextIsSelectable(true); approvals.addView(details);
            if (!request.optBoolean("actionable")) {
                approvals.addView(text(tr("此请求需要电脑处理（问答或内容过长）。", "Handle this request on the computer (questions or oversized details)."), 13, muted)); continue;
            }
            long runId = lastLive.optLong("runId"); String server = instance;
            for (boolean allow : new boolean[]{false, true}) {
                approvals.addView(button(allow ? tr("允许一次", "Allow once") : tr("拒绝", "Deny"), () -> {
                    if (!connected || !controlAllowed || commandBusy || credentials.has("pendingCommand")) return;
                    new CamelliaDialog.Builder(this).setTitle(allow ? tr("确认允许此操作？", "Allow this operation?") : tr("拒绝此操作？", "Deny this operation?"))
                        .setMessage(request.optString("toolName") + "\n" + request.optString("details"))
                        .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(allow ? tr("允许一次", "Allow once") : tr("拒绝", "Deny"), (dialog, which) -> {
                            try { submitCommand(command("approve").put("instanceId", server).put("runId", runId).put("approvalId", request.getString("requestId"))
                                .put("fingerprint", request.getString("fingerprint")).put("allow", allow)); }
                            catch (Exception error) { reportError("无法保存审批操作。", "Could not save approval.", error); }
                        }).show();
                }, allow));
            }
        }
    }

    private void showRemoteSettings(boolean permissions) {
        if (!connected || !controlAllowed || commandBusy || credentials.has("pendingCommand") || remoteSettings == null || !remoteSettings.optBoolean("editable")) return;
        if (settingsPopup != null) settingsPopup.dismiss();
        String version = remoteSettings.optString("version"), server = instance, target = conversationId;
        settingsPopup = new RemoteSettingsPopup(this, chinese, background, ink, muted, accent, remoteSettings, (key, value) -> {
            if (!target.equals(conversationId) || !server.equals(instance) || remoteSettings == null || !version.equals(remoteSettings.optString("version"))) return;
            try {
                submitCommand(command("configure").put("instanceId", server).put("expectedSettings", version).put("settings", new JSONObject().put(key, value)));
            } catch (Exception error) { reportError("无法保存设置，请重试。", "Could not save settings. Try again.", error); }
        });
        settingsPopup.show(permissions ? permissionButton : modelButton, permissions);
    }

    private void submitCommand(JSONObject payload) throws Exception {
        if (!foreground || !connected || !controlAllowed || commandBusy || credentials.has("pendingCommand")) return;
        JSONObject saved = new JSONObject(credentials.toString());
        JSONObject pending = new JSONObject().put("conversationId", conversationId).put("payload", payload);
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) pending.put("draft", composer.getText().toString()).put("at", System.currentTimeMillis());
        saved.put("pendingCommand", pending);
        store.save(saved); credentials = saved;
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) {
            outgoingMessage = pending;
            editingSeq = -1; editingText = "";
            composer.setText(""); selectedImages.clear(); renderImage();
            persistDraft();
            outgoingState("sending");
            scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        }
        commandCheckDeadline = 0;
        updateControls();
        retryCommand();
    }

    private void retryCommand() {
        JSONObject pending = credentials.optJSONObject("pendingCommand");
        if (!foreground || !connected || !controlAllowed || commandBusy || pending == null || api == null) return;
        String target = pending.optString("conversationId"); JSONObject payload = pending.optJSONObject("payload");
        if (!target.equals(conversationId)) {
            new CamelliaDialog.Builder(this).setMessage(tr("另一会话有未确认操作。请先打开该会话核对结果。", "Another conversation has an unconfirmed operation. Open it to check the result."))
                .setPositiveButton(tr("打开", "Open"), (dialog, which) -> { conversationId = target; conversationTitle = tr("待确认操作", "Unconfirmed operation"); detailScreen(); connectEvents(); })
                .setNegativeButton(tr("取消", "Cancel"), null).show(); return;
        }
        commandBusy = true; updateControls();
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("sending");
        if (android.os.SystemClock.elapsedRealtime() >= commandCheckDeadline) commandCheckDeadline = android.os.SystemClock.elapsedRealtime() + 30_000;
        RemoteApi client = api; int ticket = generation; String token = credentials.optString("token");
        status.setText(tr("正在提交操作…", "Submitting operation…"));
        commandWorker.submit(() -> {
            try {
                JSONObject result = client.json("/v1/conversations/" + target + "/commands", token, payload);
                deliver(ticket, () -> finishCommand(payload, result));
            } catch (Exception error) {
                deliver(ticket, () -> {
                    commandBusy = false;
                    if (error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status >= 400 && ((RemoteApi.Failure) error).status < 500 && ((RemoteApi.Failure) error).status != 429) {
                        finishCommand(payload, new JSONObject());
                        showFailure(error, true);
                    } else {
                        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("unconfirmed");
                        status.setText(ErrorDetails.withSummary(tr("发送未确认：连接失败或超时。请重试同一请求，避免重复发送。", "Send unconfirmed: connection failed or timed out. Retry the same request to avoid duplicates."), error));
                        updateControls();
                        new CamelliaDialog.Builder(this).setMessage(ErrorDetails.withSummary(
                            tr("未收到电脑确认。操作可能已执行，请勿重复新建发送；点击未确认提示，重试同一请求。", "No confirmation received. The operation may have executed. Tap the unconfirmed status to retry the same request; do not send a new copy."),
                            error))
                            .setPositiveButton(tr("知道了", "OK"), null).show();
                    }
                });
            }
        });
    }

    private void finishCommand(JSONObject payload, JSONObject result) {
        commandBusy = false;
        if (result.optString("state").equals("pending")) {
            if (android.os.SystemClock.elapsedRealtime() >= commandCheckDeadline) {
                if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("unconfirmed");
                status.setText(tr("等待电脑确认超时，操作可能已执行。请重试同一请求，不要重复发送。", "Timed out waiting for confirmation; the operation may have executed. Retry the same request, not a new copy."));
                updateControls(); return;
            }
            if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("preparing");
            status.setText(tr("电脑正在准备操作，正在查询结果…", "The computer is preparing the operation; checking its result…"));
            int ticket = generation;
            handler.postDelayed(() -> {
                JSONObject pending = credentials.optJSONObject("pendingCommand");
                if (foreground && ticket == generation && pending != null && pending.optJSONObject("payload") != null
                        && payload.optString("requestId").equals(pending.optJSONObject("payload").optString("requestId"))) {
                    if (android.os.SystemClock.elapsedRealtime() >= commandCheckDeadline) finishCommand(payload, result);
                    else retryCommand();
                }
            }, 1500);
            updateControls();
            return;
        }
        if (result.optString("state").equals("unknown")) {
            if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("unconfirmed");
            status.setText(tr("电脑无法确认该请求结果，请先到电脑核对；不会自动重复发送。", "The computer cannot confirm this request. Inspect it on the computer; it will not be resent automatically."));
            updateControls(); return;
        }
        try {
            JSONObject queued = credentials.optJSONObject("pendingCommand");
            String target = queued == null ? null : queued.optString("conversationId");
            boolean submitted = payload.optString("action").equals("send") || payload.optString("action").equals("resend");
            JSONObject saved = new JSONObject(credentials.toString()); saved.remove("pendingCommand");
            // An accepted send is the only moment the stored draft is known to be
            // delivered, so it is the safe place to drop it for good.
            if (result.optBoolean("ok") && submitted && target != null) {
                JSONObject drafts = saved.optJSONObject("drafts"); if (drafts != null) drafts.remove(target);
                JSONObject edits = saved.optJSONObject("draftEdits"); if (edits != null) edits.remove(target);
            }
            store.save(saved); credentials = saved;
            if (result.optBoolean("ok")) {
                if (submitted && outgoingMessage != null) {
                    if (result.has("userSeq")) outgoingMessage.put("userSeq", result.getLong("userSeq"));
                    outgoingState("accepted");
                }
                status.setText(tr("电脑已接收操作", "Computer accepted the operation"));
            } else {
                if (submitted && outgoingMessage != null) {
                    // A refused edit stays an edit: keep its target so the restored
                    // draft does not silently become a brand new message.
                    if (payload.has("editSeq") && conversationId.equals(target)) editingSeq = payload.optLong("editSeq");
                    composer.setText(outgoingMessage.optString("draft", payload.optString("prompt")));
                    selectedImages.clear();
                    JSONArray images = payload.optJSONArray("images");
                    if (images != null) for (int index = 0; index < images.length(); index++) selectedImages.add(images.getString(index));
                    else if (payload.has("image")) selectedImages.add(payload.getString("image"));
                    imageConversation = conversationId; imageComputer = credentials.optString("address"); renderImage();
                    persistDraft();
                    outgoingState("failed");
                }
                new CamelliaDialog.Builder(this).setTitle(tr("操作未确认成功", "Operation not confirmed successful"))
                    .setMessage(tr("请先检查最新会话状态，再决定是否重新操作。", "Inspect the latest conversation before deciding whether to submit a new operation.") + "\n" + result.optString("error"))
                    .setPositiveButton(tr("知道了", "OK"), null).show();
            }
        } catch (Exception error) { reportError("无法保存操作结果，请重试同一请求。", "Could not save result. Retry the same request.", error); }
        updateControls();
    }

    private void forget(JSONObject computer) {
        new CamelliaDialog.Builder(this).setTitle(tr("移除这台电脑？", "Forget this computer?"))
            .setMessage(tr("将删除手机上的凭据。若要撤销权限，还需在电脑端撤销此设备。", "This deletes credentials on the phone. Also revoke this device on the computer to remove its authorization."))
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("移除", "Forget"), (dialog, which) -> {
                try { store.remove(computer.getString("address")); listCache.remove(computer); prefetch.remove(computer, null); credentials = store.load(); computersScreen(); refreshComputers(); }
                catch (Exception error) { reportError("无法清除凭据，请重试。", "Could not remove credentials. Try again.", error); }
            }).show();
    }

    @Override public void onBackPressed() {
        if (selectingConversations && screen.equals("list")) {
            selectingConversations = false; selectedConversations.clear(); renderConversations(); return;
        }
        if (networkScreen) { leaveNetwork(); return; }
        if (screen.equals("detail")) { persistDraft(); listScreen(); loadList(false); }
        else if (screen.equals("list") || screen.equals("pair")) { computersScreen(); refreshComputers(); }
        else if (!screen.equals("home")) homeScreen();
        else super.onBackPressed();
    }

    private void showNetwork() {
        if (!screen.equals("network")) networkReturn = screen;
        screen = "network";
        stopNetwork(); networkScreen = true; loginLaunched = false;
        shell(tr("手机访问", "Mobile access"), tr("网络连接 · 仅连接 Camellia，不接管其他 App 流量", "Network connection · Camellia only, no device-wide VPN"));
        SettingsStyle settingsStyle = new SettingsStyle(this);
        LinearLayout connection = settingsStyle.group(content, "");
        settingsStyle.toggle(connection, tr("内置 Tailscale", "Built-in Tailscale"),
            tr("无需另装应用，仅连接 Camellia，不接管其他应用流量。", "No extra app required. Connects only Camellia, not other apps."), "networkMode", EmbeddedNetwork.enabled(), (button, checked) -> {
            stopNetwork(); EmbeddedNetwork.setEnabled(checked); refreshNetwork(false);
        });
        settingsStyle.action(connection, tr("登录 Tailscale", "Sign in to Tailscale"), tr("登录与电脑相同的网络", "Sign into the same tailnet as your computer"),
            "networkLogin", false, () -> { loginLaunched = false; refreshNetwork(true); });
        settingsStyle.action(connection, tr("刷新网络状态", "Refresh network status"), "", "networkRefresh", false, () -> refreshNetwork(false));
        settingsStyle.note(content, tr("浏览器授权后返回此处刷新，再继续配对。关闭内置模式可使用外部 Tailscale；不会自动降级为未加密公网连接。", "After browser authorization, refresh here and continue pairing. Disable built-in mode to use external Tailscale; no unencrypted public-network fallback."));
        LinearLayout identity = settingsStyle.group(content, tr("网络与隐私", "Network & privacy"));
        settingsStyle.info(identity, tr("独立网络身份", "Separate network identity"), tr("手机以 camellia-android 加入网络，仍受网络访问策略控制。", "This phone joins as camellia-android and follows your tailnet access rules."));
        settingsStyle.action(identity, tr("清除内置网络身份", "Forget embedded identity"), tr("清除后需要重新登录", "Requires signing in again"), "networkForget", true, () -> new CamelliaDialog.Builder(this)
            .setMessage(tr("将删除手机本地网络身份，之后需要重新登录。请另外在 Tailscale 管理后台撤销旧节点。", "Deletes the local node identity. Sign in again afterwards; also revoke the old node in the Tailscale admin console."))
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("清除", "Forget"), (dialog, which) -> {
                stopNetwork(); int ticket = generation;
                networkWorker.submit(() -> {
                    try { EmbeddedNetwork.forget(); deliver(ticket, () -> status.setText(tr("已清除，请重新登录。", "Identity removed. Sign in again."))); }
                    catch (Exception error) { deliver(ticket, () -> status.setText(ErrorDetails.withSummary(tr("清除失败，请重试。", "Could not clear identity. Retry."), error))); }
                });
            }).show());
        LinearLayout about = settingsStyle.group(content, tr("关于", "About"));
        settingsStyle.action(about, tr("开源许可", "Open-source licenses"), "", "networkLicenses", false, () -> {
            try (var bytes = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                for (String asset : new String[]{"third-party-notices.txt", "markdown-notices.txt"}) {
                    try (var input = getAssets().open(asset)) { while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count); }
                    bytes.write('\n');
                }
                TextView licenses = text(bytes.toString("UTF-8"), 12, ink); licenses.setTextIsSelectable(true); licenses.setPadding(dp(16), dp(12), dp(16), dp(12));
                ScrollView page = new ScrollView(this); page.addView(licenses);
                new CamelliaDialog.Builder(this).setTitle(tr("开源许可", "Open-source licenses")).setView(page).setPositiveButton(tr("关闭", "Close"), null).show();
            } catch (Exception error) { reportError("无法读取许可文件。", "Could not read licenses.", error); }
        });
        refreshNetwork(false);
    }

    private void leaveNetwork() {
        stopNetwork(); networkScreen = false;
        if (networkReturn.equals("pair")) { pairScreen(); if (credentials.has("claim")) waitForApproval(); }
        else if (networkReturn.equals("home")) homeScreen();
        else settingsScreen();
    }

    private void refreshNetwork(boolean login) {
        if (!foreground || !networkScreen) return;
        if (!EmbeddedNetwork.enabled()) { status.setText(tr("外部模式：请自行连接 Tailscale App。", "External mode: connect the Tailscale app separately.")); return; }
        int ticket = generation;
        status.setText(tr("正在检查内置连接…", "Checking embedded connection…"));
        networkWorker.submit(() -> {
            try {
                var node = EmbeddedNetwork.node();
                if (login) node.login();
                JSONObject state = new JSONObject(node.status());
                deliver(ticket, () -> {
                    if (!networkScreen) return;
                    String phase = state.optString("state");
                    status.setText(phase.equals("Running") ? tr("已连接，可以返回配对。", "Connected. Return to pairing.") : tr("网络状态：", "Network state: ") + phase);
                    String url = EmbeddedNetwork.loginUrl(state.optString("loginUrl"));
                    if (login && url != null && !loginLaunched) {
                        loginLaunched = true;
                        try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))); }
                        catch (Exception error) { reportError("找不到浏览器，无法打开登录页面。", "No browser available to open the login page.", error); }
                    } else if (login && !phase.equals("Running")) handler.postDelayed(() -> refreshLoginStatus(ticket), 2000);
                });
            } catch (Exception error) { deliver(ticket, () -> status.setText(RemoteApi.failureMessage(error, chinese))); }
        });
    }

    private void refreshLoginStatus(int ticket) {
        if (ticket != generation || !foreground || !networkScreen || loginLaunched) return;
        networkWorker.submit(() -> {
            try {
                JSONObject state = new JSONObject(EmbeddedNetwork.node().status());
                deliver(ticket, () -> {
                    String url = EmbeddedNetwork.loginUrl(state.optString("loginUrl"));
                    if (url != null) {
                        loginLaunched = true;
                        try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))); }
                        catch (Exception error) { reportError("无法打开登录浏览器。", "Could not open sign-in browser.", error); }
                    } else if (!state.optString("state").equals("Running")) handler.postDelayed(() -> refreshLoginStatus(ticket), 2000);
                    else status.setText(tr("已连接，可以返回配对。", "Connected. Return to pairing."));
                });
            } catch (Exception error) { deliver(ticket, () -> status.setText(ErrorDetails.withSummary(tr("登录连接中断，请重试。", "Login connection interrupted. Retry."), error))); }
        });
    }
}
