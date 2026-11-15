package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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
    private static final int PICK_DOCUMENT_REQUEST = 45;
    private static final int SCAN_QR_REQUEST = 44;
    private static final long COMMAND_CONFIRM_TIMEOUT_MS = 30_000;
    private static final long COMMAND_POLL_INTERVAL_MS = 1_500;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Handler commandHandler = new Handler(Looper.getMainLooper());
    private final LocationConsent locationConsent = new LocationConsent(this);

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        locationConsent.permissionResult(requestCode);
        InlineImageGallery.permissionResult(this, requestCode, grantResults);
    }
    private final ExecutorService worker = Executors.newFixedThreadPool(2);
    private ExecutorService eventWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService commandWorker = Executors.newFixedThreadPool(2);
    private final ExecutorService urgentWorker = Executors.newSingleThreadExecutor();
    private final java.util.Set<String> commandRequests = new java.util.HashSet<>();
    private final java.util.Set<String> scheduledCommandChecks = new java.util.HashSet<>();
    private final java.util.Map<String, RemoteApi> commandClients = new java.util.HashMap<>();
    private final java.util.concurrent.ThreadPoolExecutor statusWorker = (java.util.concurrent.ThreadPoolExecutor) Executors.newFixedThreadPool(4);
    private final TreeMap<Long, JSONObject> history = new TreeMap<>();
    private long historyBytes;
    private ComputerStore store;
    private RemoteListCache listCache;
    private final java.util.function.Function<String, RemoteApi> remoteClientFactory = address -> new RemoteApi(this, address);
    private final RemoteConversationSync conversationSync = new RemoteConversationSync(address -> remoteClientFactory.apply(address));
    private long conversationListRevision;
    private final RemotePrefetch prefetch = new RemotePrefetch();
    private final ArrayList<View> prefetchRows = new ArrayList<>();
    private boolean prefetchViewportPosted;
    private final Runnable prefetchViewportUpdate = () -> {
        prefetchViewportPosted = false; updatePrefetchViewport();
    };
    private RemoteReplyState replyState;
    private final RemoteReadSync replyReadSync = new RemoteReadSync();
    private String replyReadError = "";
    private JSONObject outgoingMessage;
    private long commandCheckDeadline;
    private long listCommandDeadline;
    private boolean canCommandReceipts, canStopStart, canStopBackgroundWork, canIncremental;
    private LinearLayout backgroundWorkBar;
    private TextView backgroundWorkLabel, backgroundWorkStop;
    private TextView workSummaryBar;
    private LinearLayout workInline;
    private boolean canListQuery;
    private String capabilityAddress = "", capabilityToken = "", remoteListQuery = "";
    private JSONObject remotePreparation;
    private Future<?> listRefreshJob;
    private JSONObject listRefreshSnapshot;
    private boolean listRefreshBusy;
    private JSONObject credentials = new JSONObject();
    private java.util.function.Function<Long, MarkdownView.ImageLoader> inlineImageFactory = seq -> new InlineRemoteImages(this, credentials.optString("address"), credentials.optString("token"), this.conversationId, seq);
    private long editingSeq = -1;
    private String editingText = "";
    private RemoteApi api;
    private ConnectionTestDialog connectionTest;
    private Future<?> job;
    private RemoteStreamHealth streamHealth;
    private final Runnable inspectStream = this::inspectStream;
    private volatile int generation;
    private boolean foreground;
    private boolean backgroundConnection;
    private JSONObject displayedConversation;
    private boolean chinese;
    private int background, surface, ink, muted, accent;
    private LinearLayout root, content, messages;
    private PageTransitions pages;
    private final LinkedHashMap<String, View> renderedMessages = new LinkedHashMap<>();
    private final LinkedHashMap<String, ReplyMessage> replyMessages = new LinkedHashMap<>();
    private final LinkedHashMap<String, String> renderedText = new LinkedHashMap<>();
    private final java.util.ArrayList<View> pendingMessageViews = new java.util.ArrayList<>();
    private TextView status, headerConnection;
    private ChatStatusLine workStatus;
    private boolean reconnecting, connectionBlocked;
    private boolean destinationSwitch;
    private volatile boolean homeRefreshBusy;
    private long homeRefreshAt;
    private boolean homeRunningExpanded;
    private WorkbenchList homeConversations;
    private TextView homeHeading, homeEmptyHint;
    private ConversationSidebar detailSidebar;
    private int sidebarScrollRestore = -1;
    private boolean splitDetail;
    private WorkbenchNavigation workbenchNavigation;
    private volatile boolean sidebarRefreshBusy;
    private long sidebarRefreshAt;
    private JSONArray discussionGroups = new JSONArray();
    private boolean moreDiscussions;
    private boolean canDiscussions;
    private ScrollView scroll;
    private boolean initialMessageScroll;
    private ScrollView pendingScrollView;
    private android.view.ViewTreeObserver.OnPreDrawListener pendingMessageScroll;
    private final Handler viewHandler = new Handler(Looper.getMainLooper());
    private int pendingScrollPosition;
    private long messageScrollRevision;
    private EditText addressInput, portInput, nameInput, codeInput;
    private Button pairButton, scanButton;
    private boolean pendingScannedPairing, pairingBusy;
    private Bundle pairingDraft;
    private String conversationId;
    private String conversationTitle = "";
    private String detailReturn = "list";
    private Long nextBefore;
    private boolean historyDetached;
    private String historyInstance = "";
    private boolean olderLoading;
    private boolean olderAutomatic;
    private RemoteHistoryLoad historyLoad = new RemoteHistoryLoad();
    private String historyVersion = "";
    private boolean automaticHistoryScheduled;
    private final Runnable automaticHistoryLoad = () -> { automaticHistoryScheduled = false; loadOlder(true); };
    private int nextOffset;
    private final LinkedHashMap<String, JSONObject> conversations = new LinkedHashMap<>();
    private final LinkedHashMap<String, JSONObject> archivedConversations = new LinkedHashMap<>();
    private boolean archivedLoaded, archivedLoading;
    private int archivedNextOffset = -1;
    private String conversationFilter = "all";
    private final LinkedHashMap<String, Boolean> collapsedGroups = new LinkedHashMap<>();
    private Button older;
    private String instance = "";
    private long cursor = -1;
    private JSONObject pendingSnapshot;
    private JSONObject lastLive;
    private JSONArray remoteSubtasks = new JSONArray();
    private final java.util.Map<Long, Boolean> expandedSubtasks = new java.util.HashMap<>();
    private SubtaskPage subtaskPage;
    private JSONObject remoteCompaction;
    private boolean snapshotPosted;
    private EditText composer;
    private ChatComposer chatComposer;
    private ImageButton sendButton, stopButton;
    private TextView retryMessage;
    private LinearLayout approvals;
    private LinearLayout automationBar;
    private JSONObject remoteGoal;
    private JSONArray remoteTasks = new JSONArray();
    private android.app.Dialog workDialog;
    private LinearLayout workAutomationSection;
    private String workAutomationSignature = "";
    private LinearLayout queueBar;
    private LinearLayout queueSheetPanel;
    private android.app.Dialog queueDialog;
    private JSONArray remoteQueue = new JSONArray();
    private boolean canQueue;
    private long queueVersion = -1;
    private String queueSignature = "";
    private String queueSteeringGoalId = "";
    private final RemoteGoalVisibility goalVisibility = new RemoteGoalVisibility();
    private boolean controlAllowed, connected, commandBusy;
    private long conversationSeq;
    private String approvalSignature = "";
    private android.app.AlertDialog remoteApprovalDialog;
    private String remoteApprovalKey = "";
    private VisualizationDialog visualizationDialog;
    private boolean networkScreen;
    private android.app.Dialog computerDialog;
    private android.net.Uri cameraImageUri;
    private java.io.File cameraImageFile;
    private EditText searchInput;
    private LinearLayout searchBar;
    private JSONArray availableWorkspaces = new JSONArray();
    private java.util.List<String> availableEngines = RemoteEngines.available(null);
    private boolean canCreate, canCreateWorkspace, canImage, canMultiImage, allowIndependent, canArchive;
    private boolean canFork;
    private boolean canCodexReset;
    private android.app.AlertDialog codexResetDialog;
    private boolean canAttachments, canFileAttachments;
    private ConversationMenu conversationPopup;
    private ComputerPickerPopup computerPicker;
    private View remoteEmptyState;
    private boolean canManageConversations, selectingConversations;
    private final java.util.Set<String> selectedConversations = new java.util.LinkedHashSet<>();
    private String listInstance = "", imageConversation, imageComputer;
    private long listCursor = -1;
    private final ArrayList<String> selectedImages = new ArrayList<>();
    private final ArrayList<JSONObject> selectedDocuments = new ArrayList<>();
    private boolean loadingImages;
    private boolean listEventsUnavailable;
    private boolean listLoaded, listLoadFailed;
    private LinearLayout imageTray;
    private android.widget.HorizontalScrollView imageStrip;
    private ImageButton attachButton;
    private TextView modelButton;
    private PermissionTool permissionButton;
    private JSONObject remoteSettings;
    private RemoteSettingsPopup settingsPopup;
    private String screen = "home", networkReturn = "settings";
    private String preferenceSignature;
    private final ChatNotifications chatNotifications = new ChatNotifications();
    private final Runnable searchRemote = () -> { if (screen.equals("list")) loadList(false); };
    private final LinkedHashMap<String, String> computerStates = new LinkedHashMap<>();
    private final java.util.Set<RemoteApi> statusClients = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.function.Function<String, RemoteApi> statusClientFactory = RemoteApi::new;
    private final java.util.function.Function<String, RemoteApi> homeClientFactory = RemoteApi::new;
    private boolean loginLaunched;
    private final ExecutorService networkWorker = Executors.newSingleThreadExecutor();
    // The settings index's Mobile access row, kept so its state label can be
    // refreshed when the reader comes back from that page rather than only when
    // the index is rebuilt.
    private LinearLayout settingsRowMobileAccess;
    // The pairing page's Tailscale row, refreshed when that page is shown and
    // when the network state changes underneath it.
    private LinearLayout pairNetworkRow;
    // The Mobile access page's own state line, above its content. `status` is
    // shared with every screen and filtered per screen, so it cannot be the only
    // place this page's answer appears.
    private TextView networkStatusBanner;

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private ChatStyle chatStyle;
    private ArtifactDownloads artifactDownloads;
    private AttachmentMaintenance.Lease composerAttachments;

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

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) notifyApprovalRequests();
    }

    @Override protected void onPostResume() {
        super.onPostResume();
        // Results arrive before onStart/onResume. Wait until the foreground
        // guard and network lifecycle are ready to receive the pairing reply.
        if (screen.equals("pair") && pendingScannedPairing) {
            pendingScannedPairing = false;
            requestPairing();
        }
    }

    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        openNotificationConversation();
    }

    private void openNotificationConversation() {
        String id = getIntent().getStringExtra("noticeConversation");
        String address = getIntent().getStringExtra("noticeAddress");
        getIntent().removeExtra("noticeConversation"); getIntent().removeExtra("noticeAddress");
        if (id == null || address == null) return;
        if (id.equals(conversationId) && address.equals(credentials.optString("address")) && screen.equals("detail")) return;
        try {
            for (JSONObject computer : store.all()) if (address.equals(computer.optString("address")) && computer.has("token")) {
                persistDraft(); stopNetwork(); store.save(computer); credentials = store.load();
                conversationId = id; conversationTitle = ""; detailScreen();
                if (foreground) connectEvents();
                return;
            }
        } catch (Exception error) { reportError("无法打开通知中的会话。", "Could not open the chat from this notification.", error); }
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        MobileOrientation.lockPhonePortrait(this);
        composerAttachments = AttachmentMaintenance.protect(this);
        EmbeddedNetwork.initialize(getApplicationContext());
        preferenceSignature = MobilePreferences.signature(this);
        chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        chatStyle = new ChatStyle(this);
        artifactDownloads = new ArtifactDownloads(this, saved);
        background = chatStyle.background; surface = chatStyle.surface; ink = chatStyle.ink; muted = chatStyle.muted; accent = chatStyle.accent;
        getWindow().setStatusBarColor(background); getWindow().setNavigationBarColor(background);
        if (android.os.Build.VERSION.SDK_INT >= 27 && !dark) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        store = new ComputerStore(new CredentialStore(this));
        listCache = RemoteListCache.get(this);
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
            detailReturn = saved.getString("detailReturn", "list");
        }
        String restored = saved == null ? "home" : saved.getString("screen", "home");
        if (saved != null) {
            pairingDraft = saved.getBundle("pairingDraft");
            pendingScannedPairing = saved.getBoolean("pendingScannedPairing");
        }
        if (restored.equals("detail") && conversationId != null) detailScreen();
        else if (restored.equals("list") && credentials.has("token")) listScreen();
        else if (restored.equals("pair")) pairScreen();
        else if (restored.equals("network")) { networkReturn = saved.getString("networkReturn", "settings"); screen = "network"; showNetwork(); }
        else if (restored.equals("computers")) computersScreen();
        else if (restored.equals("settings")) settingsScreen();
        else homeScreen();
        if (recovery != null) setStatusNotice(recovery);
        openNotificationConversation();
    }

    @Override protected void onStart() {
        super.onStart();
        AttachmentMaintenance.foreground(this);
        boolean retained = backgroundConnection && RemoteKeepAliveService.active() && api != null;
        foreground = true;
        backgroundConnection = false;
        RemoteKeepAliveService.finish(this, true);
        EmbeddedNetwork.setNetworkListener(this::networkRouteChanged);
        EmbeddedNetwork.foreground();
        resumePendingCommands();
        if (retained) {
            // Deep sleep can suspend callbacks without changing the route.
            // Inspect monotonic age before reusing the retained connection.
            inspectStream();
            if (screen.equals("detail") && displayedConversation != null) {
                replies().markRead(credentials, displayedConversation);
                replyReadSync.retry();
                syncReplyRead(displayedConversation);
            }
            updateControls();
            refreshDetailSidebar();
            return;
        }
        if (networkScreen) { refreshNetwork(false); return; }
        if (screen.equals("computers")) { refreshComputers(); return; }
        if (screen.equals("home")) { startConversationSync(); refreshHomeConversations(); return; }
        // Coming back from Mobile access, which is where the mode is actually
        // changed. Without this the row kept whatever it said when the index
        // was built, so toggling Tailscale off and back left it claiming to be
        // connected.
        if (screen.equals("settings")) { refreshMobileAccessRow(); return; }
        if (screen.equals("pair")) {
            if (!pendingScannedPairing && credentials.has("claim")) waitForApproval();
            return;
        }
        if (credentials.has("token")) {
            if (conversationId != null) connectEvents(); else loadList(false);
        } else if (credentials.has("claim")) waitForApproval();
    }

    private void networkRouteChanged() {
        if (!networkActive()) return;
        if (EmbeddedNetwork.online()) resumePendingCommands();
        if (screen.equals("home")) { conversationSync.stop(); startConversationSync(); refreshHomeConversations(); return; }
        // These two report the network state on a row, and a route change flips
        // it without rebuilding the page.
        if (screen.equals("settings")) { refreshMobileAccessRow(); return; }
        if (screen.equals("pair")) { refreshPairNetworkRow(); return; }
        if (!screen.equals("computers") && !screen.equals("list") && !screen.equals("detail")) return;
        artifactDownloads.stop();
        if (!EmbeddedNetwork.online()) {
            stopNetwork(); updateControls();
            connectionFailure(tr("网络已断开，联网后自动重连。未确认的消息不会重复发送。", "Offline. Reconnecting when the network returns; unconfirmed messages will not be resent."));
            return;
        }
        if (screen.equals("computers")) refreshComputers();
        else if (credentials.has("token")) {
            if (screen.equals("detail")) {
                connectEvents();
                refreshDetailSidebar();
            } else loadList(false);
        }
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (screen.equals("detail")) {
            rebuildDetailForConfiguration();
        } else if (screen.equals("list") && scroll != null && content != null) {
            renderConversations();
        }
        updateNavigationWidth();
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
        if (connectionTest != null) { connectionTest.close(); connectionTest = null; }
        persistDraft();
        if (listCache != null) listCache.flush();
        artifactDownloads.stop();
        if (conversationPopup != null) conversationPopup.dismiss();
        locationConsent.cancel();
        if (pages != null) pages.finishTransition();
        foreground = false;
        handler.removeCallbacks(prefetchViewportUpdate); prefetchViewportPosted = false;
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
        if (connectionTest != null) { connectionTest.close(); connectionTest = null; }
        stopNetwork();
        conversationSync.close();
        closeCommandClients();
        if (pages != null) { pages.finishTransition(); pages = null; }
        releasePageViews();
        if (composerAttachments != null) composerAttachments.close();
        RemoteKeepAliveService.finish(this, false);
        artifactDownloads.close();
        InlineImageGallery.close(this);
        if (listCache != null) listCache.flush();
        prefetch.close();
        worker.shutdownNow(); eventWorker.shutdownNow(); commandWorker.shutdownNow(); urgentWorker.shutdownNow(); statusWorker.shutdownNow(); networkWorker.shutdownNow(); super.onDestroy();
    }

    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        artifactDownloads.save(saved);
        saved.putString("screen", screen); saved.putString("networkReturn", networkReturn);
        saved.putString("detailReturn", detailReturn);
        if (screen.equals("pair")) rememberPairingDraft();
        saved.putBundle("pairingDraft", pairingDraft);
        saved.putBoolean("pendingScannedPairing", pendingScannedPairing);
        if (conversationId != null) { saved.putString("conversationId", conversationId); saved.putString("conversationTitle", conversationTitle); }
    }

    private void stopNetwork() {
        conversationSync.stop();
        if (subtaskPage != null) { subtaskPage.dismiss(); subtaskPage = null; }
        replyReadSync.reset();
        if (computerPicker != null) { computerPicker.dismiss(); computerPicker = null; }
        setPairingBusy(false);
        handler.removeCallbacks(prefetchViewportUpdate); prefetchViewportPosted = false;
        prefetch.cancel();
        olderLoading = false;
        olderAutomatic = false;
        automaticHistoryScheduled = false;
        if (settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        connected = false;
        commandBusy = false;
        if (scroll instanceof RefreshScrollView) ((RefreshScrollView) scroll).setRefreshing(false);
        generation++;
        streamHealth = null;
        statusWorker.getQueue().clear();
        handler.removeCallbacksAndMessages(null);
        if (job != null) job.cancel(true);
        eventWorker.shutdownNow();
        if (listRefreshJob != null) listRefreshJob.cancel(true);
        listRefreshBusy = false; listRefreshSnapshot = null;
        RemoteApi previous = api;
        api = null;
        if (previous != null) new Thread(previous::cancel, "camellia-disconnect").start();
        for (RemoteApi client : statusClients) new Thread(client::cancel, "camellia-status-disconnect").start();
        statusClients.clear();
        synchronized (this) { pendingSnapshot = null; snapshotPosted = false; }
    }

    private RemoteApi begin() {
        stopNetwork();
        connectionBlocked = false;
        updateControls();
        // A socket/native read may take time to observe cancellation. Its
        // executor belongs to the old generation and cannot delay this one.
        eventWorker = Executors.newSingleThreadExecutor();
        api = remoteClientFactory.apply(credentials.optString("address"));
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
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setTextSize(Palette.TEXT_BODY);
        button.setTextColor(enabledColors(primary ? Color.WHITE : ink, muted));
        GradientDrawable enabledFace = capsule(primary ? accent : surface);
        enabledFace.setStroke(dp(1), primary ? accent : Palette.of(this).cardBorder);
        GradientDrawable disabledFace = capsule(surface);
        disabledFace.setStroke(dp(1), Palette.of(this).cardBorder);
        android.graphics.drawable.StateListDrawable faces = new android.graphics.drawable.StateListDrawable();
        faces.addState(new int[]{-android.R.attr.state_enabled}, disabledFace);
        faces.addState(new int[]{}, enabledFace);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf((accent & 0x00ffffff) | 0x22000000), faces, capsule(Color.WHITE)));
        SurfaceElevation.apply(button, primary ? 2 : 1);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setMinHeight(dp(48)); button.setPadding(dp(14), dp(8), dp(14), dp(8));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(8), 0, dp(8)); button.setLayoutParams(params);
        button.setOnClickListener(view -> action.run()); return button;
    }

    private void shell(String title, String subtitle) {
        releasePageViews();
        if (!screen.equals("detail")) composerAttachments.replace();
        reconnecting = false; connectionBlocked = false;
        boolean settingsPage = screen.equals("settings") || screen.equals("network") || screen.equals("pair");
        boolean showNavigation = screen.equals("home") || screen.equals("list") || screen.equals("computers") || screen.equals("settings");
        int bottomPadding = screen.equals("list") || screen.equals("detail") ? chatStyle.dockBottomPadding() : dp(24);
        if (showNavigation) bottomPadding = dp(8);
        final int pageBottomPadding = bottomPadding;
        SettingsStyle settingsStyle = new SettingsStyle(this);
        int pageBackground = settingsPage || screen.equals("computers") ? settingsStyle.background : background;
        splitDetail = screen.equals("detail") && MobileLayout.useDetailSplit(getResources().getConfiguration());
        root = column(); root.setBackground(Palette.of(this).pageBackground());
        root.setPadding(dp(16), dp(10), dp(16), bottomPadding);
        root.setBackgroundColor(pageBackground); getWindow().setStatusBarColor(pageBackground); getWindow().setNavigationBarColor(pageBackground);
        root.setClipToPadding(false);
        if (screen.equals("list") || screen.equals("detail")) { root.setFocusableInTouchMode(true); root.requestFocus(); }
        View page = root;
        LinearLayout split = null;
        if (splitDetail) {
            split = new LinearLayout(this);
            split.setOrientation(LinearLayout.HORIZONTAL);
            split.setTag("detailSplitLayout");
            split.setBackground(Palette.of(this).pageBackground());
            split.setClipChildren(false);
            split.setClipToPadding(false);
            detailSidebar = new ConversationSidebar(this, chinese, detailSidebarItems(), new ConversationSidebar.Listener() {
                @Override public void open(ConversationSidebar.Item item) { openSidebarConversation(item); }
                @Override public void all() { navigateSessions(); }
                @Override public void refresh() { sidebarRefreshAt = 0; refreshDetailSidebar(); }
            });
            int restoreSidebarScroll = sidebarScrollRestore;
            sidebarScrollRestore = -1;
            if (restoreSidebarScroll > 0) detailSidebar.restoreScroll(restoreSidebarScroll);
            int sidebarWidth = dp(MobileLayout.detailSidebarWidthDp(getResources().getConfiguration().screenWidthDp));
            split.addView(detailSidebar, new LinearLayout.LayoutParams(sidebarWidth, -1));
            View divider = new View(this);
            divider.setBackgroundColor(Palette.of(this).separator);
            split.addView(divider, new LinearLayout.LayoutParams(Math.max(1, dp(1)), -1));
            split.addView(root, new LinearLayout.LayoutParams(0, -1, 1));
            page = split;
        } else {
            sidebarScrollRestore = -1;
        }
        if (settingsPage) settingsStyle.pagePadding(root, showNavigation ? 8 : 20);
        else if (splitDetail) {
            LinearLayout splitPage = split;
            ConversationSidebar sidebar = detailSidebar;
            LinearLayout pane = root;
            splitPage.setOnApplyWindowInsetsListener((view, insets) -> {
                sidebar.setPadding(dp(12) + insets.getSystemWindowInsetLeft(), dp(8) + insets.getSystemWindowInsetTop(),
                    dp(10), dp(10) + insets.getSystemWindowInsetBottom());
                pane.setPadding(dp(16), dp(10) + insets.getSystemWindowInsetTop(),
                    dp(16) + insets.getSystemWindowInsetRight(), pageBottomPadding + insets.getSystemWindowInsetBottom());
                return insets;
            });
        }
        else root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(16) + insets.getSystemWindowInsetLeft(), dp(10) + insets.getSystemWindowInsetTop(), dp(16) + insets.getSystemWindowInsetRight(), pageBottomPadding + insets.getSystemWindowInsetBottom());
            return insets;
        });
        if (pages == null) pages = new PageTransitions(this);
        int depth = screen.equals("home") ? 0 : screen.equals("computers") || screen.equals("settings") ? 1
            : screen.equals("detail") || (screen.equals("network") && networkReturn.equals("pair")) ? 3 : 2;
        pages.show(page, screen, depth, destinationSwitch); page.requestApplyInsets();
        if (settingsPage) {
            root.addView(screen.equals("settings") ? settingsStyle.header(title)
                : settingsStyle.header(title, tr("返回上一级", "Back"), this::onBackPressed));
        } else if (screen.equals("computers")) {
            LinearLayout header = settingsStyle.topLevelHeader(title);
            header.findViewWithTag("settingsTitle").setTag("remoteControlTitle"); root.addView(header);
        } else if (screen.equals("list") || screen.equals("detail")) {
            LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(0, 0, 0, dp(12));
            header.setClipChildren(false); header.setClipToPadding(false);
            boolean detail = screen.equals("detail");
            if (detail) {
                header.addView(chatStyle.backButton(tr("返回上一级", "Back"), this::onBackPressed),
                    new LinearLayout.LayoutParams(dp(48), dp(48)));
            }
            boolean paired = credentials.has("token");
            LinearLayout titles = column(); titles.setPadding(detail ? dp(8) : 0, 0, 0, 0);
            TextView pageTitle = text(detail ? conversationTitle : tr("会话", "Conversations"),
                detail ? Palette.TEXT_ROW : Palette.TEXT_HERO, ink);
            pageTitle.setTag("pageTitle"); pageTitle.setMaxLines(1); pageTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            pageTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); titles.addView(pageTitle);
            LinearLayout computer = new LinearLayout(this); computer.setGravity(Gravity.CENTER_VERTICAL);
            ImageView icon = new ImageView(this);
            icon.setImageDrawable(new LineIcon("computer", muted));
            computer.addView(icon, new LinearLayout.LayoutParams(dp(14), dp(14)));
            TextView name = text(paired ? computerName(credentials) : tr("尚未连接电脑", "No computer connected"),
                Palette.TEXT_SMALL, muted);
            name.setTag("headerComputerName"); name.setPadding(dp(6), 0, 0, 0);
            name.setMaxLines(1); name.setEllipsize(android.text.TextUtils.TruncateAt.END);
            computer.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
            if (paired) {
                headerConnection = text("", Palette.TEXT_SMALL, muted); headerConnection.setTag("headerConnectionState");
                headerConnection.setSingleLine(true); headerConnection.setMaxWidth(dp(112)); headerConnection.setEllipsize(android.text.TextUtils.TruncateAt.END);
                headerConnection.setPadding(dp(6), 0, dp(6), 0); headerConnection.setVisibility(View.GONE);
                computer.addView(headerConnection);
            }
            titles.addView(computer);
            header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
            ImageButton search = null, switcher = null;
            if (screen.equals("list") && paired) {
                search = lineButton("search", tr("搜索会话", "Search conversations"), this::showConversationSearch);
                search.setTag("remoteSearchButton");
            }
            if (paired || detail) {
                switcher = lineButton("switch-computer", tr("切换电脑", "Switch computer"), () -> showComputerPicker());
                switcher.setTag("remoteComputerPicker");
            }
            if (search != null && switcher != null) {
                LinearLayout actions = new LinearLayout(this);
                actions.setOrientation(LinearLayout.HORIZONTAL);
                actions.setGravity(Gravity.CENTER_VERTICAL);
                actions.setTag("remoteHeaderActions");
                actions.setBackground(chatStyle.capsule(Palette.of(this).card));
                actions.setClipToOutline(true);
                actions.addView(search, new LinearLayout.LayoutParams(dp(48), dp(48)));
                actions.addView(switcher, new LinearLayout.LayoutParams(dp(48), dp(48)));
                header.addView(actions, new LinearLayout.LayoutParams(dp(96), dp(48)));
            } else if (switcher != null) {
                header.addView(switcher, new LinearLayout.LayoutParams(dp(48), dp(48)));
            } else {
                ImageButton manage = lineButton("computer", tr("管理电脑", "Manage computers"), this::navigateComputers);
                manage.setTag("sessionsManageComputers");
                header.addView(manage, new LinearLayout.LayoutParams(dp(48), dp(48)));
            }
        } else {
        LinearLayout brand = new LinearLayout(this); brand.setGravity(Gravity.CENTER_VERTICAL); brand.setPadding(0, dp(4), 0, dp(12));
        brand.setClipChildren(false); brand.setClipToPadding(false);
        ImageView logo = new ImageView(this); logo.setImageResource(R.drawable.desktop_logo); logo.setContentDescription("Camellia");
        brand.addView(logo, new LinearLayout.LayoutParams(dp(32), dp(32)));
        TextView wordmark = text("Camellia", Palette.TEXT_ROW, ink); wordmark.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); wordmark.setPadding(dp(10), 0, 0, 0);
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
        if (!subtitle.isEmpty()) root.addView(text(subtitle, Palette.TEXT_SMALL, muted));
        }
        status = text("", Palette.TEXT_TINY, muted); status.setTag("connectionStatus"); status.setGravity(Gravity.CENTER); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        // Destination pages keep a fixed navigation area; their status updates
        // must not insert a footer between the scrolling content and navigation.
        status.setVisibility(showNavigation ? View.GONE : View.VISIBLE);
        bindStatusDetails();
        if (screen.equals("detail")) workStatus = new ChatStatusLine(status, chatStyle, chinese);
        updateConnectionHeader();
        scroll = new RefreshScrollView(this); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        ((RefreshScrollView) scroll).setRefreshIndicatorVisible(!showNavigation);
        if (screen.equals("list")) {
            scroll.setOnScrollChangeListener((view, x, y, oldX, oldY) -> {
                prefetch.interaction(); requestPrefetchViewport();
            });
            scroll.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> requestPrefetchViewport());
        }
        android.widget.FrameLayout navigationViewport = null;
        if (showNavigation) {
            navigationViewport = new android.widget.FrameLayout(this);
            navigationViewport.setTag(screen.equals("list") ? "remoteListViewport" : "workbenchViewport");
            // Content may flow behind the floating bar inside this viewport,
            // but must never paint over the header above it.
            navigationViewport.setClipChildren(true);
            navigationViewport.setClipToPadding(true);
            navigationViewport.addView(scroll, new android.widget.FrameLayout.LayoutParams(-1, -1));
            root.addView(navigationViewport, new LinearLayout.LayoutParams(-1, 0, 1));
            // Keep content flowing behind the floating glass, but allow the
            // final row to scroll fully above it instead of hiding an action.
            scroll.setClipToPadding(false);
            scroll.setPadding(0, 0, 0, dp(WorkbenchNavigation.HEIGHT_DP + WorkbenchNavigation.CONTENT_GAP_DP));
        } else root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        content = column(); content.setPadding(0, 0, 0, dp(16)); scroll.addView(content);
        if (settingsPage) { content.setPadding(0, dp(4), 0, dp(16)); scroll.setVerticalScrollBarEnabled(false); }
        if (!showNavigation) root.addView(status);
        if (showNavigation) {
            String navigationSelection = screen.equals("list") ? "sessions" : screen;
            workbenchNavigation = new WorkbenchNavigation(this, navigationSelection,
                this::navigateHome, this::navigateSessions, this::navigateComputers, this::openSettingsPage);
            android.widget.FrameLayout.LayoutParams navigationParams = new android.widget.FrameLayout.LayoutParams(
                navigationWidth(), dp(WorkbenchNavigation.HEIGHT_DP), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
            navigationViewport.addView(workbenchNavigation, navigationParams);
            workbenchNavigation.setBackdropSource(scroll);
        }
    }

    private int navigationWidth() {
        return Math.min(dp(440), Math.max(dp(300),
            Math.round(getResources().getDisplayMetrics().widthPixels * .78f)));
    }

    private void updateNavigationWidth() {
        if (workbenchNavigation == null) return;
        ViewGroup.LayoutParams params = workbenchNavigation.getLayoutParams();
        if (!(params instanceof android.widget.FrameLayout.LayoutParams)) return;
        android.widget.FrameLayout.LayoutParams updated = (android.widget.FrameLayout.LayoutParams) params;
        int width = navigationWidth();
        if (updated.width == width) return;
        updated.width = width;
        workbenchNavigation.setLayoutParams(updated);
    }

    private ImageButton lineButton(String icon, String label, Runnable action) {
        return chatStyle.lineButton(icon, label, action);
    }

    private RippleDrawable accentActionBackground() {
        GradientDrawable face = new GradientDrawable();
        face.setColor(Color.argb(20, Color.red(accent), Color.green(accent), Color.blue(accent)));
        face.setCornerRadius(dp(999));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(Color.WHITE);
        mask.setCornerRadius(dp(999));
        return new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, mask);
    }

    private LinearLayout bottomBar(String tag) {
        chatStyle.dockStatus(status);
        status.setSingleLine(true); status.setMinLines(1); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
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
        chatStyle.floatingBar(bar);
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
        parent.addView(text(label, Palette.TEXT_SMALL, muted));
        EditText input = new EditText(this); input.setSingleLine(true); input.setTextSize(Palette.TEXT_INPUT); input.setTextColor(ink); input.setHintTextColor(muted);
        input.setInputType(type); input.setText(value); input.setPadding(dp(18), dp(12), dp(18), dp(12)); input.setBackground(capsule(surface));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); input.setContentDescription(label);
        parent.addView(new SettingsField(input), new LinearLayout.LayoutParams(-1, -2)); return input;
    }

    private String computerName(JSONObject computer) {
        return computer.optString("computerName", tr("我的电脑", "My computer"));
    }

    private void navigateHome() {
        if (!screen.equals("home")) switchDestination(this::homeScreen);
    }

    private void navigateSessions() {
        switchDestination(() -> {
            if (!credentials.has("token")) {
                if (!screen.equals("list")) listScreen();
                return;
            }
            if (!screen.equals("list")) {
                listScreen();
                loadList(false);
            } else if (scroll != null) {
                scroll.scrollTo(0, 0);
            }
        });
    }

    private void navigateComputers() {
        switchDestination(() -> {
            if (!screen.equals("computers")) {
                computersScreen();
                refreshComputers();
            } else {
                refreshComputers();
            }
        });
    }

    private void openSettingsPage() {
        if (!screen.equals("settings")) switchDestination(this::settingsScreen);
    }

    private void switchDestination(Runnable action) {
        destinationSwitch = true;
        try { action.run(); }
        finally { destinationSwitch = false; }
    }

    private void homeScreen() {
        stopNetwork(); screen = "home"; networkScreen = false; conversationId = null;
        renderHomeContent();
        if (foreground) { startConversationSync(); refreshHomeConversations(); }
    }

    private void renderHomeContent() {
        shell("", "");
        homeHeading = text(tr("继续工作", "Continue working"), Palette.TEXT_HERO, ink);
        content.addView(homeHeading);
        homeEmptyHint = text(tr("本地聊天和远程电脑，从这里继续。",
            "Continue with local chat or a remote computer."), Palette.TEXT_BODY, muted);
        homeEmptyHint.setPadding(0, 0, 0, dp(14)); homeEmptyHint.setTag("homeEmptyHint");
        content.addView(homeEmptyHint);
        homeConversations = new WorkbenchList(this, scroll);
        content.addView(homeConversations, new LinearLayout.LayoutParams(-1, -2));
        updateHomeConversations();
        renderHomeShortcuts();
        status.setVisibility(View.GONE);
    }

    private void refreshHomeContent() {
        if (!screen.equals("home") || homeConversations == null) return;
        ((ChatScrollView) scroll).whenScrollIdle(this::updateHomeConversations);
    }

    private void updateHomeConversations() {
        if (!screen.equals("home") || homeConversations == null) return;
        JSONArray cached = homeCachedConversations();
        int padding = cached.length() > 0 ? dp(12) : dp(5);
        if (homeHeading.getPaddingBottom() != padding) homeHeading.setPadding(0, dp(8), 0, padding);
        homeEmptyHint.setVisibility(cached.length() == 0 ? View.VISIBLE : View.GONE);
        java.util.Set<String> shown = new java.util.LinkedHashSet<>();
        ArrayList<WorkbenchList.Item> items = new ArrayList<>();
        renderHomeRunning(cached, shown, items);
        renderHomeRecent(cached, shown, items);
        homeConversations.show(items);
    }

    private JSONArray homeCachedConversations() {
        if (!credentials.has("token") || listCache == null) return new JSONArray();
        JSONObject cached = listCache.get(credentials);
        JSONArray rows = cached == null ? null : cached.optJSONArray("conversations");
        return rows == null ? new JSONArray() : rows;
    }

    private void renderHomeRunning(JSONArray cached, java.util.Set<String> shown, ArrayList<WorkbenchList.Item> items) {
        ArrayList<JSONObject> active = new ArrayList<>();
        for (int index = 0; index < cached.length(); index++) {
            JSONObject conversation = cached.optJSONObject(index);
            if (conversation != null && homeConversationActive(conversation)) active.add(conversation);
        }
        if (active.isEmpty()) return;
        items.add(new WorkbenchList.Item("running", active.size() > 3 ? active.size() + ":" + homeRunningExpanded : "",
            () -> homeRunningHeader(active.size())));
        int count = homeRunningExpanded ? active.size() : Math.min(3, active.size());
        for (int index = 0; index < count; index++) {
            JSONObject conversation = active.get(index);
            String id = conversation.optString("id");
            shown.add(id);
            items.add(homeConversationItem(conversation, true, "homeActive:" + id, "homeActiveStatus:" + id));
        }
    }

    private View homeRunningHeader(int count) {
        LinearLayout section = new LinearLayout(this);
        section.setTag("homeRunningSection");
        section.setGravity(Gravity.CENTER_VERTICAL);
        section.setPadding(0, dp(2), 0, dp(2));
        TextView label = text(tr("运行中", "Running"), Palette.TEXT_CARD, ink);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        section.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (count > 3) {
            TextView toggle = text(homeRunningExpanded ? tr("收起", "Collapse")
                    : tr("展开全部 " + count, "Show all " + count),
                Palette.TEXT_SMALL, accent);
            toggle.setGravity(Gravity.CENTER);
            toggle.setMinHeight(dp(48));
            toggle.setPadding(dp(12), 0, dp(2), 0);
            toggle.setTag("homeRunningToggle");
            toggle.setOnClickListener(view -> {
                homeRunningExpanded = !homeRunningExpanded;
                refreshHomeContent();
            });
            section.addView(toggle);
        }
        return section;
    }

    private boolean homeConversationActive(JSONObject conversation) {
        String state = conversation.optString("activity");
        return state.equals("running") || state.equals("permission") || state.equals("question")
            || RemoteWorkStatus.backgroundCount(conversation) > 0;
    }

    private WorkbenchList.Item homeConversationItem(JSONObject conversation, boolean active, String tag, String statusTag) {
        Palette palette = Palette.of(this);
        String state = conversation.optString("activity");
        int statusColor = state.equals("running") ? palette.success
            : state.equals("permission") || state.equals("question") ? palette.warning
            : RemoteWorkStatus.backgroundCount(conversation) > 0 ? palette.accent : palette.muted;
        String indicator = active ? activity(conversation) : "";
        String engine = conversationEngine(conversation), title = conversation.optString("title");
        String meta = conversationMeta(conversation), time = conversationTime(conversation);
        // Ignore stream counters, previews and other metadata that this page does not display.
        String presentation = new JSONArray().put(engine).put(title).put(meta).put(indicator).put(statusColor).put(time).toString();
        return new WorkbenchList.Item(tag, presentation, () -> new ConversationRow(this, chatStyle, false, engine,
            title, meta, indicator, statusColor, time, tag, statusTag, () -> {
                conversationId = conversation.optString("id");
                conversationTitle = conversation.optString("title");
                detailReturn = "home";
                detailScreen();
                connectEvents();
            }, () -> {}));
    }

    private void renderHomeRecent(JSONArray cached, java.util.Set<String> shown, ArrayList<WorkbenchList.Item> items) {
        boolean available = false;
        for (int index = 0; index < cached.length(); index++) {
            JSONObject conversation = cached.optJSONObject(index);
            if (conversation != null && !homeConversationActive(conversation)
                && !shown.contains(conversation.optString("id"))) { available = true; break; }
        }
        if (!available) return;
        items.add(new WorkbenchList.Item("recent", "", this::homeRecentHeader));
        int added = 0;
        for (int index = 0; index < cached.length() && added < 3; index++) {
            JSONObject conversation = cached.optJSONObject(index);
            if (conversation == null) continue;
            String id = conversation.optString("id");
            if (id.isEmpty() || shown.contains(id) || homeConversationActive(conversation)) continue;
            shown.add(id); added++;
            items.add(homeConversationItem(conversation, false, "homeRecent:" + id, "homeRecentStatus:" + id));
        }
    }

    private View homeRecentHeader() {
        LinearLayout section = new LinearLayout(this);
        section.setTag("homeRecentSection");
        section.setGravity(Gravity.CENTER_VERTICAL);
        section.setPadding(0, dp(12), 0, dp(2));
        TextView label = text(tr("最近", "Recent"), Palette.TEXT_CARD, ink);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        section.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        TextView all = text(tr("查看全部", "View all"), Palette.TEXT_SMALL, accent);
        all.setGravity(Gravity.CENTER); all.setMinHeight(dp(48)); all.setPadding(dp(12), 0, dp(2), 0); all.setTag("homeRecentAll");
        all.setOnClickListener(view -> navigateSessions());
        section.addView(all);
        return section;
    }

    private void renderHomeShortcuts() {
        Palette palette = Palette.of(this);
        LinearLayout group = column();
        GradientDrawable face = rounded(palette.card);
        face.setCornerRadius(dp(Palette.RADIUS_HOME_CARD));
        face.setStroke(dp(1), palette.homeCardEdge());
        group.setBackground(face);
        group.setClipToOutline(true);
        group.setElevation(dp(1));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            group.setOutlineAmbientShadowColor(0x10000000); group.setOutlineSpotShadowColor(0x1c000000);
        }
        group.setTag("homeShortcuts");
        LinearLayout.LayoutParams groupParams = new LinearLayout.LayoutParams(-1, -2);
        groupParams.setMargins(0, dp(10), 0, dp(10));
        content.addView(group, groupParams);

        homeShortcut(group, "phone", tr("本地聊天", "Local chat"),
            tr("手机直连 · 本地工作区", "On this phone · local workspace"), "localChatEntry", () -> {
                startActivity(new android.content.Intent(this, LocalChatActivity.class));
                PageTransitions.openActivity(this);
            });
        settingsShortcut(group, palette);
    }

    private LinearLayout homeShortcut(LinearLayout group, String iconName, String title, String description,
                                      String tag, Runnable click) {
        if (group.getChildCount() > 0) group.addView(shortcutDivider());
        LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(64)); row.setPadding(dp(14), dp(9), dp(12), dp(9));
        row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new ColorDrawable(Color.WHITE)));
        row.setContentDescription(title);
        row.setOnClickListener(view -> click.run());
        ImageView icon = new ImageView(this); icon.setImageDrawable(new LineIcon(iconName, accent));
        icon.setPadding(dp(9), dp(9), dp(9), dp(9)); icon.setBackground(accentActionBackground());
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(34), dp(34)); iconParams.setMarginEnd(dp(12));
        row.addView(icon, iconParams);
        LinearLayout labels = column();
        TextView name = text(title, Palette.TEXT_ROW, ink);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        labels.addView(name);
        TextView note = text(description, Palette.TEXT_SMALL, muted);
        note.setSingleLine(true); note.setEllipsize(android.text.TextUtils.TruncateAt.END);
        note.setPadding(0, dp(1), 0, 0); note.setTag(tag + "Action");
        labels.addView(note);
        row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout tail = new LinearLayout(this); tail.setGravity(Gravity.CENTER_VERTICAL);
        TextView arrow = text("›", Palette.TEXT_CARD, accent);
        arrow.setTag(tag + "Arrow"); arrow.setGravity(Gravity.CENTER); arrow.setPadding(dp(5), 0, 0, 0);
        tail.addView(arrow, new LinearLayout.LayoutParams(dp(18), dp(48)));
        row.addView(tail);
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }

    private void settingsShortcut(LinearLayout group, Palette palette) {
        if (group.getChildCount() > 0) group.addView(shortcutDivider());
        LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(64)); row.setPadding(dp(14), dp(9), dp(12), dp(9));
        row.setTag("settingsEntry"); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new ColorDrawable(Color.WHITE)));
        row.setContentDescription(tr("设置", "Settings"));
        row.setOnClickListener(view -> openSettingsPage());
        ImageView icon = new ImageView(this); icon.setImageDrawable(new LineIcon("settings", muted));
        icon.setPadding(dp(9), dp(9), dp(9), dp(9)); icon.setBackground(rounded(palette.controlFill));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(34), dp(34)); iconParams.setMarginEnd(dp(12));
        row.addView(icon, iconParams);
        LinearLayout labels = column();
        labels.addView(text(tr("设置", "Settings"), Palette.TEXT_ROW, ink));
        TextView note = text(tr("模型、连接、语言与诊断", "Models, connection, language and diagnostics"), Palette.TEXT_SMALL, muted);
        note.setSingleLine(true); note.setEllipsize(android.text.TextUtils.TruncateAt.END);
        labels.addView(note);
        row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView arrow = new ImageView(this); arrow.setTag("settingsEntryArrow"); arrow.setImageDrawable(new LineIcon("right", muted));
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(18), dp(18));
        arrowParams.setMarginStart(dp(8));
        row.addView(arrow, arrowParams);
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    private View shortcutDivider() {
        View line = new View(this);
        line.setBackgroundColor(Palette.of(this).divider);
        line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
        params.setMargins(dp(60), 0, dp(14), 0);
        line.setLayoutParams(params);
        return line;
    }

    private void refreshHomeConversations() {
        if (!foreground || !screen.equals("home") || homeRefreshBusy || !credentials.has("token")
                || !EmbeddedNetwork.online() || listCache == null) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - homeRefreshAt < 5_000) return;
        homeRefreshAt = now;
        homeRefreshBusy = true;
        int ticket = generation;
        long revision = conversationListRevision;
        JSONObject snapshot;
        JSONObject before;
        try {
            snapshot = new JSONObject(credentials.toString());
            before = listCache.get(snapshot);
        } catch (Exception error) {
            homeRefreshBusy = false;
            return;
        }
        String token = snapshot.optString("token");
        RemoteApi request = homeClientFactory.apply(snapshot.optString("address"));
        worker.submit(() -> {
            try {
                JSONObject page = request.json("/v1/conversations?offset=0", token, null);
                deliver(ticket, () -> {
                    // A slow pull must not overwrite a newer pushed state.
                    if (revision != conversationListRevision || !screen.equals("home")) return;
                    JSONArray rows = page.optJSONArray("conversations");
                    if (rows == null) return;
                    JSONArray workspaces = page.optJSONArray("workspaces");
                    if (workspaces == null) workspaces = before == null ? null : before.optJSONArray("workspaces");
                    if (workspaces == null) workspaces = new JSONArray();
                    boolean independent = page.has("includeUnassigned")
                        ? page.optBoolean("includeUnassigned") : before != null && before.optBoolean("includeUnassigned");
                    listCache.put(snapshot, rows, page.optInt("nextOffset", -1), workspaces, independent);
                    conversationListRevision++;
                    JSONObject after = listCache.get(snapshot);
                    boolean changed = before == null ? after != null : after != null && !before.toString().equals(after.toString());
                    if (!changed) return;
                    refreshHomeContent();
                });
            } catch (Exception ignored) {
                // Keep the cached list; the next home resume will retry.
            } finally {
                homeRefreshBusy = false;
                request.cancel();
            }
        });
    }

    private void settingsScreen() {
        stopNetwork(); screen = "settings"; networkScreen = false; conversationId = null;
        shell(tr("设置", "Settings"), "");
        SettingsStyle settingsStyle = new SettingsStyle(this);
        LinearLayout summary = settingsStyle.group(content, tr("账户与连接", "Account & connection"));
        settingsStyle.row(summary, "key", tr("模型服务", "Model services"),
            tr("API、订阅与 Key", "APIs & keys"), "settings:summaryModels", () -> openSettingsSection("providers"));
        settingsStyle.row(summary, "archive", tr("额度与用量", "Quota & usage"),
            tr("查看电脑端订阅与 API", "Desktop subscriptions & APIs"), "settings:usage", () -> openAccountUsage(null));
        settingsStyle.row(summary, "phone", tr("手机访问", "Mobile access"), mobileAccessState(), "settings:network", this::showNetwork);
        settingsRowMobileAccess = (LinearLayout) summary.findViewWithTag("settings:network");

        LinearLayout application = settingsStyle.group(content, tr("应用与权限", "Application & permissions"));
        settingsStyle.row(application, "settings", tr("通用与外观", "General & appearance"), "", "settings:general",
            () -> openSettingsSection("general"));
        settingsStyle.row(application, "file", tr("阅读与显示", "Reading & display"),
            tr("字号、代码与过程", "Text, code & process"), "settings:reading", () -> openSettingsSection("reading"));
        settingsStyle.row(application, "settings", tr("通知控制", "Notifications"), "", "settings:notifications",
            () -> openSettingsSection("notifications"));
        settingsStyle.row(application, "phone", tr("本机名称", "Phone name"), MobilePreferences.deviceName(this),
            "settings:deviceName", this::editDeviceName);
        settingsStyle.info(application, tr("会话权限", "Conversation permissions"),
            tr("模型、思考等级和权限在会话内调整，沿用电脑端授权范围。", "Model, thinking level and permissions are adjusted inside a conversation within the desktop's authorized scope."));

        LinearLayout data = settingsStyle.group(content, tr("数据与诊断", "Data & diagnostics"));
        settingsStyle.row(data, "archive", tr("已归档", "Archived"), "", "settings:archived",
            () -> openSettingsSection("archived"));

        LinearLayout about = settingsStyle.group(content, tr("关于", "About"));
        String version;
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception ignored) { version = ""; }
        settingsStyle.valueRow(about, "file", tr("Camellia 版本", "Version"), version, "settings:about");
        status.setVisibility(View.GONE);
    }

    private void openSettingsSection(String section) {
        startActivity(new android.content.Intent(this, SettingsActivity.class).putExtra("section", section));
        PageTransitions.openActivity(this);
    }

    private void openAccountUsage(JSONObject computer) {
        startActivity(new android.content.Intent(this, RemoteUsageActivity.class)
            .putExtra("address", computer == null ? credentials.optString("address") : computer.optString("address")));
        PageTransitions.openActivity(this);
    }

    /**
     * Which network mode this phone is in, in the words the Mobile access page
     * itself uses. Kept to the mode so it is answerable without touching the
     * node — the alternative would mean the settings index and the pairing page
     * each started a Tailscale query on every visit.
     *
     * <p>One method for both places that show it. They are the same question and
     * they were the same three lines; two copies is how one of them ends up
     * disagreeing with the other.
     */
    private String mobileAccessState() {
        if (!EmbeddedNetwork.enabled()) return tr("外部模式", "External");
        return EmbeddedNetwork.online() ? tr("已连接", "Connected") : tr("未连接", "Not connected");
    }

    /**
     * Repaints the Mobile access row's state label in place.
     *
     * <p>Only the label. The row is not rebuilt, so this does not cost a layout
     * pass over the whole page or lose the reader's scroll position, and a
     * failure to find the row is ignored — it means the page is gone.
     */
    private void refreshMobileAccessRow() {
        if (settingsRowMobileAccess == null || !screen.equals("settings")) return;
        new SettingsStyle(this).setRowValue(settingsRowMobileAccess, mobileAccessState());
    }

    /**
     * Repaints the pairing page's Tailscale row the same way.
     *
     * <p>Called from {@link #pairScreen()} rather than from {@code onStart},
     * because pairing is where a reader arrives when the network is the thing
     * stopping them — it is the page that has to report it.
     */
    private void refreshPairNetworkRow() {
        if (pairNetworkRow == null || !screen.equals("pair")) return;
        new SettingsStyle(this).setRowValue(pairNetworkRow, mobileAccessState());
    }

    private void editDeviceName() {
        SettingsStyle style = new SettingsStyle(this);
        LinearLayout panel = computerDialogPanel(tr("本机名称", "This phone name"),
            tr("配对时默认提交这个名称，电脑端可以在授权时确认。最多 80 个字符。", "This name is submitted by default when pairing; the computer confirms it when authorizing. Up to 80 characters."), "phone");
        TextView label = text(tr("设备名称", "Device name"), Palette.TEXT_SMALL, muted); panel.addView(label);
        EditText name = new EditText(this); name.setId(View.generateViewId()); label.setLabelFor(name.getId());
        name.setSingleLine(true); name.setTextSize(Palette.TEXT_ROW); name.setTextColor(ink); name.setHintTextColor(muted);
        name.setText(MobilePreferences.deviceName(this)); name.setContentDescription(tr("设备名称", "Device name"));
        name.setTag("deviceNameInput"); name.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        name.setPadding(dp(16), dp(14), dp(16), dp(14)); name.setMinHeight(dp(54));
        panel.addView(new SettingsField(name), new LinearLayout.LayoutParams(-1, -2));
        android.app.AlertDialog dialog = (android.app.AlertDialog) createComputerDialog(panel, tr("保存", "Save"), tr("取消", "Cancel"));
        showComputerDialog(dialog);
        Button save = dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE); save.setTag("deviceNameSave");
        save.setOnClickListener(view -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty() || value.length() > 80) { ((SettingsField) name.getParent()).showError(tr("请输入 1–80 个字符的名称。", "Enter a name of 1–80 characters.")); return; }
            MobilePreferences.set(this, "deviceName", value);
            dialog.dismiss(); settingsScreen();
        });
        name.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        name.setOnEditorActionListener((view, action, event) -> {
            if (action != android.view.inputmethod.EditorInfo.IME_ACTION_DONE) return false;
            save.performClick(); return true;
        });
        name.requestFocus(); name.selectAll();
    }

    private void computersScreen() {
        stopNetwork(); screen = "computers"; networkScreen = false; conversationId = null;
        clearHistory(); conversations.clear();
        shell(tr("电脑与连接", "Computers & connections"), "");
        root.setClipChildren(false);
        SettingsStyle style = new SettingsStyle(this);
        TextView introduction = text(tr("管理配对与连接；打开一台电脑会进入它的会话。",
            "Manage pairing and connections. Open a computer to see its conversations."), Palette.TEXT_BODY, style.secondary);
        introduction.setPadding(dp(2), dp(2), dp(2), dp(12)); content.addView(introduction);
        LinearLayout group = style.group(content, tr("我的电脑", "My computers")); group.setTag("computerList");
        status.setVisibility(View.GONE);
        try {
            var computers = store.all();
            if (computers.isEmpty()) {
                // Outside the card, not inside it. Inside, it shared a surface
                // with the "Add computer" row below it and read as one more
                // thing to tap; and the group's own "My computers" heading above
                // an empty list says nothing the heading did not already say.
                style.emptyState(content, tr("连接你的第一台电脑", "Connect your first computer"),
                    tr("扫描电脑上的配对二维码，即可在手机继续工作。", "Scan the pairing QR code on your computer to continue working here."),
                    "", null);
            }
            for (JSONObject computer : computers) {
                computerDivider(group, style); group.addView(computerRow(computer));
            }
        } catch (Exception error) { reportError("无法读取电脑列表，请重试。", "Could not load computers. Try again.", error); }
        computerDivider(group, style);
        LinearLayout add = new LinearLayout(this); add.setGravity(Gravity.CENTER_VERTICAL); add.setMinimumHeight(dp(72));
        add.setPadding(dp(18), dp(14), dp(18), dp(14)); add.setTag("addComputer"); add.setFocusable(true);
        add.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        add.setContentDescription(tr("添加电脑", "Add computer")); add.setOnClickListener(view -> addComputer());
        ImageView plus = new ImageView(this); plus.setImageDrawable(new LineIcon("plus", style.ink));
        plus.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); add.addView(plus, new LinearLayout.LayoutParams(dp(32), dp(32)));
        TextView addLabel = text(tr("添加电脑", "Add computer"), Palette.TEXT_ROW_STRONG, style.ink); addLabel.setPadding(dp(12), 0, 0, 0);
        addLabel.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); add.addView(addLabel, new LinearLayout.LayoutParams(0, -2, 1));
        group.addView(add, new LinearLayout.LayoutParams(-1, -2));
        if (credentials.has("claim")) content.addView(button(tr("继续配对", "Resume pairing"), () -> { pairScreen(); waitForApproval(); }, false));
        ((RefreshScrollView) scroll).setRefreshAction(this::refreshComputers,
            ready -> setStatusNotice(ready ? tr("松开检查状态", "Release to check status") : tr("下拉检查电脑状态", "Pull to check computers")));
    }

    private void computerDivider(LinearLayout group, SettingsStyle style) {
        if (group.getChildCount() == 0) return;
        View divider = new View(this); divider.setBackgroundColor(style.divider);
        divider.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
        params.setMargins(dp(16), 0, dp(16), 0); group.addView(divider, params);
    }

    private View computerRow(JSONObject computer) throws Exception {
        String address = computer.getString("address"), name = computerName(computer);
        String state = computerStates.getOrDefault(address, tr("待检查", "Not checked"));
        ComputerRow row = new ComputerRow(this, new SettingsStyle(this), chinese, name, address,
            () -> openComputer(computer), () -> manageComputer(computer));
        row.state(state, state.equals(tr("已连接", "Connected")), checkingComputer(state)); return row;
    }

    private boolean checkingComputer(String state) {
        return state.equals(tr("待检查", "Not checked")) || state.equals(tr("正在检查…", "Checking…"))
            || state.equals(tr("正在重启…", "Restarting…"));
    }

    private void updateComputerState(String address, String state) {
        computerStates.put(address, state);
        View row = root.findViewWithTag("computer:" + address);
        if (row instanceof ComputerRow) ((ComputerRow) row).state(state, state.equals(tr("已连接", "Connected")), checkingComputer(state));
    }

    private void openComputer(JSONObject computer) {
        try {
            persistDraft();
            canCreate = false; canCreateWorkspace = false; canImage = false; availableWorkspaces = new JSONArray();
            stopNetwork(); store.save(computer); credentials = store.load();
            if (credentials.has("token")) switchDestination(() -> { listScreen(); loadList(false); });
            else pairScreen();
        } catch (Exception error) { reportError("无法读取电脑凭据，请重试。", "Could not load computer credentials. Try again.", error); }
    }

    private void manageComputer(JSONObject computer) {
        SettingsStyle style = new SettingsStyle(this);
        String address = computer.optString("address"), state = computerStates.getOrDefault(address, "");
        LinearLayout panel = computerDialogPanel(computerName(computer), address + (state.isEmpty() ? "" : "\n" + state));
        android.app.Dialog dialog = createComputerDialog(panel);
        LinearLayout group = style.group(panel, "");
        if (computer.has("token")) style.action(group, tr("额度与用量", "Quota & usage"),
            tr("查看这台电脑的订阅额度、API 余额和调用记录", "View subscription quota, API balances and usage on this computer"),
            "manageUsage", false, () -> { dialog.dismiss(); openAccountUsage(computer); });
        style.action(group, tr("连接稳定性测试", "Connection stability test"), tr("检测手机与电脑的连接，约 30 秒", "Test the phone-to-computer connection for about 30 seconds"),
            "manageConnectionTest", false, () -> { dialog.dismiss(); testComputerConnection(computer); });
        if (computer.has("token")) style.action(group, tr("重启桌面端 Camellia", "Restart desktop Camellia"),
            tr("保存设置并重新启动电脑上的 Camellia", "Save settings and relaunch Camellia on this computer"),
            "manageRestart", false, () -> { dialog.dismiss(); restartComputer(computer); });
        style.action(group, tr("重命名", "Rename"), tr("更改这台电脑在本机显示的名称", "Change the name shown on this phone"),
            "manageRename", false, () -> { dialog.dismiss(); renameComputer(computer); });
        style.action(group, tr("移除电脑", "Forget computer"), tr("删除手机上的凭据，电脑上的会话不受影响", "Deletes the credentials on this phone; chats stay on the computer"),
            "manageForget", true, () -> { dialog.dismiss(); forget(computer); });
        showComputerDialog(dialog);
    }

    private void testComputerConnection(JSONObject computer) {
        if (connectionTest != null) connectionTest.close();
        connectionTest = new ConnectionTestDialog(this, computer, chinese);
        computerDialog = connectionTest.show();
    }

    private void restartComputer(JSONObject computer) {
        String address = computer.optString("address"), token = computer.optString("token");
        String requestId = java.util.UUID.randomUUID().toString();
        LinearLayout panel = computerDialogPanel(tr("重启桌面端 Camellia？", "Restart desktop Camellia?"),
            computerName(computer) + "\n" + tr("正在运行的回复会停止，目标和定时检查会暂停。远程连接将暂时断开。", "Running replies will stop, and goals and scheduled checks will pause. The remote connection will briefly disconnect."));
        TextView feedback = text("", Palette.TEXT_SMALL, muted); feedback.setTag("restartFeedback");
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); panel.addView(feedback);
        android.app.AlertDialog dialog = (android.app.AlertDialog) createComputerDialog(panel, tr("重启", "Restart"), tr("取消", "Cancel"));
        showComputerDialog(dialog);
        Button confirm = dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE); confirm.setTag("restartConfirm");
        Button cancel = dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE); cancel.setTag("restartCancel");
        confirm.setOnClickListener(view -> {
            confirm.setEnabled(false); cancel.setEnabled(false); dialog.setCancelable(false);
            feedback.setText(tr("正在发送重启请求…", "Sending restart request…"));
            commandWorker.submit(() -> {
                RemoteApi client = statusClientFactory.apply(address); statusClients.add(client);
                boolean sent = false;
                try {
                    JSONObject info = client.json("/v1/status", token, null);
                    if (!"control".equals(info.optString("permission"))) throw new IllegalStateException(tr("需要这台电脑的完整控制权限。", "Full-device control permission is required."));
                    JSONArray capabilities = info.optJSONArray("capabilities");
                    boolean supported = false;
                    if (capabilities != null) for (int i = 0; i < capabilities.length(); i++) supported |= "desktop-restart".equals(capabilities.optString(i));
                    if (!supported || info.optString("instanceId").isEmpty()) throw new IllegalStateException(tr("需要完整控制权限，并更新重启电脑端。", "Full-device control and an updated, restarted desktop are required."));
                    JSONObject payload = new JSONObject().put("requestId", requestId).put("instanceId", info.getString("instanceId")).put("confirmed", true);
                    sent = true;
                    JSONObject reply = client.json("/v1/desktop/restart", token, payload);
                    if (!reply.optBoolean("ok") || !("accepted".equals(reply.optString("state")) || "complete".equals(reply.optString("state"))))
                        throw new IOException(reply.optString("error", "Desktop restart was not accepted"));
                    runOnUiThread(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        dialog.dismiss(); updateComputerState(address, tr("正在重启…", "Restarting…"));
                        android.widget.Toast.makeText(this, tr("重启请求已发送，稍后下拉刷新重新连接。", "Restart requested. Pull to refresh shortly to reconnect."), android.widget.Toast.LENGTH_LONG).show();
                    });
                } catch (Exception error) {
                    boolean uncertain = sent && !(error instanceof RemoteApi.Failure);
                    String message = uncertain ? tr("请求结果不确定，请刷新电脑状态确认后再试。", "Request outcome is uncertain. Refresh the computer status before trying again.")
                        : error instanceof IllegalStateException ? error.getMessage() : RemoteApi.failureMessage(error, chinese);
                    runOnUiThread(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        feedback.setText(ErrorDetails.withSummary(message, error)); feedback.setTextColor(Palette.of(this).error);
                        cancel.setEnabled(true); cancel.setText(tr("关闭", "Close")); dialog.setCancelable(true);
                    });
                } finally { statusClients.remove(client); client.cancel(); }
            });
        });
    }

    private LinearLayout computerDialogPanel(String title, String description) {
        return computerDialogPanel(title, description, "computer");
    }

    private LinearLayout computerDialogPanel(String title, String description, String iconKind) {
        LinearLayout panel = column(); panel.setPadding(0, 0, 0, dp(8));
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        SettingsStyle style = new SettingsStyle(this);
        ImageView icon = new ImageView(this); icon.setImageDrawable(new LineIcon(iconKind, accent));
        icon.setPadding(dp(8), dp(8), dp(8), dp(8)); icon.setBackground(rounded(style.card));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(icon, new LinearLayout.LayoutParams(dp(40), dp(40)));
        TextView heading = text(title, Palette.TEXT_TITLE, ink); heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(dp(13), 0, 0, 0);
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton close = chatStyle.composerToolButton("close", tr("关闭", "Close"), muted,
            () -> { if (computerDialog != null) computerDialog.dismiss(); });
        close.setImageDrawable(new LineIcon("close", muted)); close.setTag("sheetClose");
        header.addView(close, new LinearLayout.LayoutParams(dp(40), dp(40))); panel.addView(header);
        TextView subtitle = text(description, Palette.TEXT_NOTE, muted); subtitle.setPadding(0, dp(10), 0, description.isEmpty() ? dp(10) : dp(16));
        panel.addView(subtitle);
        return panel;
    }

    private android.app.Dialog createComputerDialog(LinearLayout panel) {
        return createComputerDialog(panel, null, null);
    }

    private android.app.Dialog createComputerDialog(LinearLayout panel, CharSequence positive, CharSequence negative) {
        if (computerDialog != null) computerDialog.dismiss();
        CamelliaDialog.Builder builder = new CamelliaDialog.Builder(this).setView(panel);
        if (positive != null) builder.setPositiveButton(positive, null);
        if (negative != null) builder.setNegativeButton(negative, null);
        android.app.Dialog dialog = builder.create();
        computerDialog = dialog;
        return dialog;
    }

    private void showComputerDialog(android.app.Dialog dialog) {
        dialog.show();
    }

    private void renameComputer(JSONObject computer) {
        LinearLayout panel = computerDialogPanel(tr("重命名电脑", "Rename computer"),
            tr("取一个容易辨认的名字，仅在这台手机上显示。", "Choose a familiar name. It only changes on this phone."));
        TextView label = text(tr("电脑名称", "Computer name"), Palette.TEXT_SMALL, muted); panel.addView(label);
        EditText name = new EditText(this); name.setTag("computerNameInput"); name.setId(View.generateViewId()); label.setLabelFor(name.getId());
        name.setSingleLine(true); name.setTextSize(Palette.TEXT_ROW); name.setTextColor(ink); name.setHintTextColor(muted);
        name.setHint(tr("例如：工作电脑", "e.g. Work laptop")); name.setContentDescription(tr("电脑名称", "Computer name"));
        name.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        name.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        name.setPadding(dp(16), dp(14), dp(16), dp(14)); name.setMinHeight(dp(54));
        name.setText(computerName(computer)); panel.addView(new SettingsField(name), new LinearLayout.LayoutParams(-1, -2));
        TextView feedback = text(tr("最多 80 个字符", "Up to 80 characters"), Palette.TEXT_SMALL, muted);
        feedback.setTag("renameFeedback"); feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); panel.addView(feedback);
        android.app.Dialog dialog = createComputerDialog(panel, tr("保存", "Save"), tr("取消", "Cancel"));
        showComputerDialog(dialog);
        android.app.AlertDialog alert = (android.app.AlertDialog) dialog;
        Button save = alert.getButton(android.app.AlertDialog.BUTTON_POSITIVE); save.setTag("renameSave");
        alert.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).setTag("renameCancel");
        save.setOnClickListener(view -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty()) { feedback.setText(tr("请输入电脑名称", "Enter a computer name")); name.requestFocus(); return; }
            try {
                store.rename(computer.getString("address"), value); credentials = store.load();
                dialog.dismiss(); computersScreen(); refreshComputers();
            } catch (Exception error) { feedback.setText(ErrorDetails.withSummary(tr("保存失败，请重试", "Could not save. Try again"), error)); }
        });
        name.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        name.setOnEditorActionListener((view, action, event) -> {
            if (action != android.view.inputmethod.EditorInfo.IME_ACTION_DONE) return false;
            save.performClick(); return true;
        });
        name.requestFocus(); name.selectAll();
    }

    private void refreshComputers() {
        if (!foreground || !screen.equals("computers")) return;
        stopNetwork(); int ticket = generation;
        try {
            var computers = store.all();
            ((RefreshScrollView) scroll).setRefreshing(false);
            setStatusNotice(computers.isEmpty() ? tr("尚未添加电脑", "No computers added") : tr("正在检查电脑状态…", "Checking computers…"));
            int[] remaining = {computers.size()};
            for (JSONObject computer : computers) {
                String address = computer.getString("address");
                String checking = tr("正在检查…", "Checking…");
                updateComputerState(address, checking);
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
                        client = statusClientFactory.apply(address); statusClients.add(client);
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
                        updateComputerState(address, state);
                        if (--remaining[0] == 0) {
                            ((RefreshScrollView) scroll).setRefreshing(false);
                            setStatusNotice(tr("电脑状态已更新", "Computer status updated"));
                        }
                    });
                    if (client != null) { statusClients.remove(client); client.cancel(); }
                });
            }
        } catch (Exception error) {
            ((RefreshScrollView) scroll).setRefreshing(false);
            reportError("无法检查电脑状态，请下拉重试。", "Could not check computers. Pull to retry.", error);
        }
    }

    private void pairScreen() {
        stopNetwork();
        closeCommandClients();
        screen = "pair";
        networkScreen = false;
        conversationId = null;
        shell(tr("配对电脑", "Pair computer"), "");
        root.setFocusableInTouchMode(true); root.requestFocus();
        SettingsStyle style = new SettingsStyle(this);
        LinearLayout network = style.group(content, "");
        // The state, not "Sign in / Settings". A row whose value is the name of
        // the page it opens tells the reader nothing they cannot find out by
        // going there — and on this page in particular they may not be able to
        // pair at all until this is sorted, so it has to say so here.
        style.row(network, "shield", tr("Tailscale 网络", "Tailscale network"),
            mobileAccessState(), "pairNetwork", this::showNetwork);
        pairNetworkRow = (LinearLayout) network.findViewWithTag("pairNetwork");
        style.note(content, tr("手机与电脑需登录同一个 Tailscale 网络。", "Sign into the same Tailscale network on both devices."));

        LinearLayout scanner = style.group(content, "");
        scanner.setPadding(dp(18), dp(16), dp(18), dp(12));
        LinearLayout scanHeading = new LinearLayout(this); scanHeading.setGravity(Gravity.CENTER_VERTICAL);
        ImageView scanIcon = new ImageView(this); scanIcon.setImageDrawable(new LineIcon("camera", style.accent));
        scanIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        scanHeading.addView(scanIcon, new LinearLayout.LayoutParams(dp(26), dp(26)));
        TextView scanTitle = text(tr("扫描电脑二维码", "Scan your computer's QR"), Palette.TEXT_ROW_STRONG, style.ink);
        scanTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); scanTitle.setPadding(dp(12), 0, 0, 0);
        scanHeading.addView(scanTitle, new LinearLayout.LayoutParams(0, -2, 1)); scanner.addView(scanHeading);
        TextView scanHint = text(tr("打开电脑「手机访问」生成二维码。\n扫描后自动发起配对。", "Generate a QR code in desktop Mobile access.\nScanning starts pairing automatically."), Palette.TEXT_BODY, style.secondary);
        scanHint.setPadding(0, dp(12), 0, dp(8)); scanner.addView(scanHint);
        scanButton = button(tr("扫描二维码", "Scan QR code"), this::scanPairingCode, false);
        scanButton.setBackgroundTintList(enabledColors(style.divider, style.card));
        scanButton.setTag("pairScan"); scanner.addView(scanButton);

        LinearLayout fields = style.group(content, tr("配对信息 · 也可手动填写", "Pairing details · or enter manually"));
        fields.setPadding(dp(18), dp(8), dp(18), dp(18));
        Endpoint savedEndpoint = credentials.has("address") ? new Endpoint(credentials.optString("address")) : null;
        LinearLayout endpointRow = new LinearLayout(this); endpointRow.setGravity(Gravity.TOP);
        LinearLayout host = column(), port = column();
        LinearLayout.LayoutParams hostParams = new LinearLayout.LayoutParams(0, -2, 1); hostParams.setMarginEnd(dp(12));
        endpointRow.addView(host, hostParams); endpointRow.addView(port, new LinearLayout.LayoutParams(dp(96), -2)); fields.addView(endpointRow);
        addressInput = input(host, tr("电脑 IP（Tailscale）", "Computer IP (Tailscale)"), savedEndpoint == null ? "" : savedEndpoint.host(), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressInput.setTag("pairAddress");
        addressInput.setHint("100.x.y.z");
        portInput = input(port, tr("端口", "Port"), savedEndpoint == null ? "43127" : savedEndpoint.port(), InputType.TYPE_CLASS_NUMBER);
        portInput.setTag("pairPort");
        portInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(5)});
        codeInput = input(fields, tr("一次性配对码", "One-time pairing code"), "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        codeInput.setTag("pairCode"); codeInput.setHint(tr("24 位配对码", "24-character code"));
        codeInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(24)});
        nameInput = input(fields, tr("本机名称", "This phone's name"), MobilePreferences.deviceName(this), InputType.TYPE_CLASS_TEXT);
        nameInput.setTag("pairName"); nameInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(80)});
        if (pairingDraft != null) {
            addressInput.setText(pairingDraft.getString("address", "")); portInput.setText(pairingDraft.getString("port", "43127"));
            codeInput.setText(pairingDraft.getString("code", ""));
            if (pairingDraft.getBoolean("customName", false)) nameInput.setText(pairingDraft.getString("name", MobilePreferences.deviceName(this)));
        }
        style.note(content, tr("请求发出后，在电脑端确认授权即可连接。", "After sending the request, approve it on your computer to connect."));
        status.setTextSize(Palette.TEXT_NOTE); status.setTextColor(style.secondary); status.setPadding(dp(8), dp(8), dp(8), dp(4));
        pairButton = button(tr("请求配对", "Request pairing"), () -> {
            if (credentials.has("claim") && codeInput.getText().toString().trim().isEmpty()) waitForApproval(); else requestPairing();
        }, true);
        pairButton.setTag("pairRequest"); root.addView(pairButton);
        codeInput.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) { setPairingBusy(pairingBusy); }
            @Override public void afterTextChanged(android.text.Editable value) {}
        });
        setPairingBusy(false);
    }

    private void addComputer() {
        persistDraft(); pairingDraft = null; stopNetwork(); credentials = new JSONObject(); pairScreen();
    }

    private void showComputerPicker() {
        if (computerPicker != null) computerPicker.dismiss();
        try {
            var computers = store.all();
            String current = credentials.optString("address");
            computers.sort(java.util.Comparator.comparing((JSONObject computer) -> !computer.optString("address").equals(current))
                .thenComparing(this::computerName, String.CASE_INSENSITIVE_ORDER));
            var entries = new ArrayList<ComputerPickerPopup.Entry>();
            for (JSONObject computer : computers) {
                String address = computer.optString("address"); boolean selected = address.equals(current);
                entries.add(new ComputerPickerPopup.Entry(address, computerName(computer), tr("正在检查…", "Checking…"), selected,
                    () -> { if (!selected) openComputer(computer); }));
            }
            computerPicker = new ComputerPickerPopup(root.findViewWithTag("remoteComputerPicker"), chatStyle, chinese, entries,
                this::addComputer, () -> { persistDraft(); navigateComputers(); });
            ComputerPickerPopup picker = computerPicker;
            int ticket = generation;
            for (JSONObject computer : computers) statusWorker.submit(() -> {
                if (ticket != generation || !picker.isShowing()) return;
                String address = computer.optString("address"), state; boolean online = false;
                RemoteApi client = null;
                try {
                    if (!computer.has("token")) throw new RemoteApi.Failure(401);
                    client = new RemoteApi(address); statusClients.add(client);
                    if (ticket != generation || !picker.isShowing()) return;
                    JSONObject info = client.json("/v1/status", computer.optString("token"), null);
                    if (info.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
                    state = tr("已连接", "Connected"); online = true;
                } catch (Exception error) { state = RemoteApi.failureMessage(error, chinese); }
                finally { if (client != null) { statusClients.remove(client); client.cancel(); } }
                String value = state; boolean available = online;
                deliver(ticket, () -> {
                    if (computerPicker == picker && picker.isShowing()) {
                        computerStates.put(address, value); picker.state(address, value, available);
                    }
                });
            });
        } catch (Exception error) { reportError("无法读取电脑列表。", "Could not load computers.", error); }
    }

    private void rememberPairingDraft() {
        if (addressInput == null) return;
        pairingDraft = new Bundle();
        pairingDraft.putString("address", addressInput.getText().toString()); pairingDraft.putString("port", portInput.getText().toString());
        pairingDraft.putString("name", nameInput.getText().toString()); pairingDraft.putString("code", codeInput.getText().toString());
        pairingDraft.putBoolean("customName", !nameInput.getText().toString().trim().equals(MobilePreferences.deviceName(this)));
    }

    private void setPairingBusy(boolean busy) {
        pairingBusy = busy;
        if (pairButton == null) return;
        boolean waiting = credentials.has("claim") && (busy || codeInput == null || codeInput.getText().toString().trim().isEmpty());
        pairButton.setEnabled(!busy);
        pairButton.setText(busy ? waiting ? tr("等待电脑确认…", "Waiting for approval…") : tr("正在请求配对…", "Requesting pairing…")
            : waiting ? tr("继续等待电脑确认", "Resume pairing request") : tr("请求配对", "Request pairing"));
        if (scanButton != null) scanButton.setEnabled(!busy);
        for (EditText field : new EditText[]{addressInput, portInput, nameInput, codeInput}) if (field != null) field.setEnabled(!busy);
    }

    private void pairingFieldError(EditText field, String message) {
        ((SettingsField) field.getParent()).showError(message);
        setStatusNotice(message);
        viewHandler.post(() -> { if (screen.equals("pair")) field.requestRectangleOnScreen(new android.graphics.Rect(0, 0, field.getWidth(), field.getHeight()), false); });
    }

    private void scanPairingCode() {
        if (!foreground) return;
        try { startActivityForResult(new android.content.Intent(this, QrScanActivity.class), SCAN_QR_REQUEST); }
        catch (Exception error) { reportError("无法打开二维码扫描", "Cannot open the QR scanner", error); }
    }

    private void applyScannedPairing(String address, String code) {
        Endpoint endpoint = new Endpoint(address);
        if (code == null || !code.matches("[a-fA-F0-9]{24}")) throw new IllegalArgumentException("Invalid pairing code");
        if (!screen.equals("pair")) pairScreen();
        // The QR carries an origin, while the form and Endpoint(ip, port) need
        // only the host here. Otherwise submission builds http://http://…:port:port.
        addressInput.setText(endpoint.host()); portInput.setText(endpoint.port());
        codeInput.setText(code.toLowerCase(Locale.ROOT));
        rememberPairingDraft();
        setStatusNotice(tr("已填入二维码中的地址和配对码。", "Address and pairing code filled in from the QR code."));
        pendingScannedPairing = true;
    }

    private void requestPairing() {
        if (!foreground || pairingBusy || !screen.equals("pair")) return;
        pendingScannedPairing = false;
        final String address;
        try { address = new Endpoint(addressInput.getText().toString(), portInput.getText().toString()).origin(); }
        catch (IllegalArgumentException error) {
            try { new Endpoint(addressInput.getText().toString(), "43127"); }
            catch (IllegalArgumentException invalidHost) {
                pairingFieldError(addressInput, tr("请填写电脑的 Tailscale IP，例如 100.80.1.2。", "Enter the computer's Tailscale IP, such as 100.80.1.2.")); return;
            }
            pairingFieldError(portInput, tr("端口应为 1–65535。", "Use a port between 1 and 65535.")); return;
        }
        String name = nameInput.getText().toString().trim(), code = codeInput.getText().toString().trim();
        if (name.isEmpty() || name.length() > 80) { pairingFieldError(nameInput, tr("请输入本机名称，最多 80 个字符。", "Enter a phone name, up to 80 characters.")); return; }
        if (!code.matches("[a-fA-F0-9]{24}")) { pairingFieldError(codeInput, tr("请填写电脑生成的 24 位配对码，或重新扫码。", "Enter the 24-character code from your computer, or scan again.")); return; }
        try {
            rememberPairingDraft();
            View focus = getCurrentFocus();
            if (focus != null) ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(focus.getWindowToken(), 0);
            MobilePreferences.set(this, "deviceName", name);
            String displayName = address.equals(credentials.optString("address")) ? credentials.optString("computerName") : "";
            credentials = new JSONObject().put("address", address).put("name", name);
            if (!displayName.isEmpty()) credentials.put("computerName", displayName);
            store.save(credentials);
            RemoteApi client = begin(); int ticket = generation;
            setPairingBusy(true);
            setStatusNotice(tr("正在请求配对…", "Requesting pairing…"));
            JSONObject payload = new JSONObject().put("code", code.toLowerCase(Locale.ROOT)).put("name", name);
            job = worker.submit(() -> {
                try {
                    JSONObject result = client.json("/v1/pair/request", null, payload);
                    deliver(ticket, () -> {
                        try {
                            credentials.put("id", result.getString("id")).put("claim", result.getString("claim")).put("expiresAt", result.getLong("expiresAt"));
                            // The desktop reports its own display name with the request;
                            // keep it as this computer's initial label unless the user
                            // already renamed it on this phone.
                            String computer = result.optString("computerName", "");
                            if (!computer.isEmpty() && credentials.optString("computerName").isEmpty()) credentials.put("computerName", computer);
                            store.save(credentials); codeInput.setText(""); rememberPairingDraft(); waitForApproval();
                        } catch (Exception error) { setPairingBusy(false); reportError("无法保存配对，请重新生成配对码。", "Could not save pairing. Generate a new code.", error); }
                    });
                } catch (Exception error) { deliver(ticket, () -> { setPairingBusy(false); setStatusNotice(RemoteApi.failureMessage(error, chinese)); }); }
            });
        } catch (Exception error) { setPairingBusy(false); reportError("无法发起配对，请重试。", "Could not start pairing. Try again.", error); }
    }

    private void waitForApproval() {
        if (!foreground || !credentials.has("claim")) return;
        RemoteApi client = begin(); int ticket = generation;
        setPairingBusy(true);
        setStatusNotice(tr("请求已发送，请在电脑端确认授权。", "Request sent. Approve it on your computer."));
        pollPair(client, ticket);
    }

    private void pollPair(RemoteApi client, int ticket) {
        if (!foreground || ticket != generation) return;
        if (credentials.optLong("expiresAt") <= System.currentTimeMillis()) {
            credentials.remove("claim"); credentials.remove("id");
            try { store.save(credentials); } catch (Exception ignored) { }
            setPairingBusy(false);
            setStatusNotice(tr("配对已过期，请在电脑重新生成配对码。", "Pairing expired. Generate another code on the computer.")); return;
        }
        final JSONObject payload = new JSONObject();
        try { payload.put("id", credentials.getString("id")).put("claim", credentials.getString("claim")); }
        catch (Exception error) { setPairingBusy(false); reportError("配对信息不完整，请重新生成配对码。", "Pairing information is incomplete. Generate a new code.", error); return; }
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
                        store.save(next); credentials = next; pairingDraft = null; listScreen(); loadList(false);
                    } catch (Exception error) { setPairingBusy(false); reportError("无法安全保存凭据，请重试领取。", "Could not securely save credentials. Resume pairing to retry.", error); }
                });
            } catch (Exception error) {
                deliver(ticket, () -> {
                    if (error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 401) {
                        credentials.remove("claim"); credentials.remove("id");
                        try { store.save(credentials); } catch (Exception ignored) { }
                    }
                    setPairingBusy(false);
                    setStatusNotice(RemoteApi.failureMessage(error, chinese));
                });
            }
        });
    }

    private void listScreen() {
        screen = "list";
        networkScreen = false;
        stopNetwork(); conversationId = null; clearHistory(); conversations.clear(); nextOffset = -1;
        archivedConversations.clear(); archivedLoaded = false; archivedLoading = false; archivedNextOffset = -1;
        canCreate = false; canCreateWorkspace = false; canArchive = false; canManageConversations = false;
        canDiscussions = false;
        selectingConversations = false; selectedConversations.clear();
        conversationFilter = "all";
        availableWorkspaces = new JSONArray(); allowIndependent = false;
        listEventsUnavailable = false;
        listLoaded = false; listLoadFailed = false;
        shell("", "");
        root.setClipChildren(false);
        if (!credentials.has("token")) {
            status.setVisibility(View.GONE);
            ChatEmptyState empty = new ChatEmptyState(this, chatStyle, "computer",
                tr("尚未连接电脑", "No computer connected"),
                tr("会话按电脑分开显示。先在「电脑」页配对或选择一台，再回来查看它的会话。",
                    "Conversations are grouped by computer. Pair or choose one in Computers, then return here to browse its sessions."));
            empty.addAction(tr("管理电脑", "Manage computers"), "sessionsEmptyManageComputers", this::navigateComputers);
            if (credentials.has("claim")) {
                empty.addAction(tr("继续配对", "Resume pairing"), "sessionsEmptyResumePairing", () -> {
                    pairScreen();
                    waitForApproval();
                });
            }
            content.addView(empty);
            return;
        }
        chatStyle.dockStatus(status);
        status.setSingleLine(true); status.setMinLines(1); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        status.setVisibility(View.GONE);
        searchBar = new LinearLayout(this); searchBar.setTag("remoteSearchBar"); searchBar.setGravity(Gravity.CENTER_VERTICAL);
        chatStyle.floatingBar(searchBar); searchBar.setVisibility(View.GONE);
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(-1, -2); searchParams.bottomMargin = dp(12);
        root.addView(searchBar, 1, searchParams);
        ImageView searchIcon = new ImageView(this); searchIcon.setImageDrawable(new LineIcon("search", ink)); searchIcon.setPadding(dp(10), dp(10), dp(10), dp(10));
        searchBar.addView(searchIcon, new LinearLayout.LayoutParams(dp(44), dp(44)));
        searchInput = new EditText(this); searchInput.setSingleLine(true); searchInput.setTextSize(Palette.TEXT_ROW); searchInput.setTextColor(ink); searchInput.setHintTextColor(muted);
        searchInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(200)});
        searchInput.setTag("remoteSearchInput"); searchInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        searchInput.setHint(tr("搜索会话", "Search conversations")); searchInput.setContentDescription(tr("搜索会话", "Search conversations")); searchInput.setBackgroundColor(Color.TRANSPARENT);
        searchInput.setPadding(dp(2), dp(12), dp(8), dp(12)); searchInput.setMinHeight(dp(48));
        searchBar.addView(searchInput, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton close = chatStyle.composerToolButton("close", tr("关闭搜索", "Close search"), muted,
            this::closeConversationSearch);
        close.setTag("remoteSearchClose"); searchBar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        searchInput.setOnEditorActionListener((view, action, event) -> {
            if (action != android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) return false;
            ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(view.getWindowToken(), 0);
            root.requestFocus(); return true;
        });
        searchInput.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                renderConversations(); handler.removeCallbacks(searchRemote);
                if (canListQuery && !remoteListQuery.equals(value.toString().trim().toLowerCase(Locale.ROOT))
                    || nextOffset >= 0 && value.length() > 0) handler.postDelayed(searchRemote, 400);
            }
            @Override public void afterTextChanged(android.text.Editable value) {}
        });
        ((RefreshScrollView) scroll).setRefreshAction(() -> loadList(false), ready -> setStatusNotice(ready
            ? tr("松开刷新", "Release to refresh") : computerStates.getOrDefault(credentials.optString("address"), tr("下拉刷新", "Pull to refresh"))));
        JSONObject cached = listCache.get(credentials);
        if (cached != null) {
            availableWorkspaces = cached.optJSONArray("workspaces");
            if (availableWorkspaces == null) availableWorkspaces = new JSONArray();
            allowIndependent = cached.optBoolean("includeUnassigned");
            applyConversationPage(cached, false);
            setStatusNotice(tr("显示上次缓存，正在同步…", "Showing cached conversations; syncing…"));
        } else renderConversations();
    }

    private void showConversationSearch() {
        if (!screen.equals("list") || searchBar == null || searchInput == null) return;
        searchBar.setVisibility(View.VISIBLE);
        EditText input = searchInput; input.requestFocus();
        input.post(() -> {
            if (screen.equals("list") && searchInput == input && input.hasFocus())
                ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(input, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        });
    }

    private void closeConversationSearch() {
        if (searchBar == null || searchInput == null) return;
        ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(searchInput.getWindowToken(), 0);
        searchInput.setText(""); searchInput.clearFocus(); searchBar.setVisibility(View.GONE); root.requestFocus();
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
        if (remoteListQuery.isEmpty()) listCache.put(credentials, rows, nextOffset, availableWorkspaces, allowIndependent);
        requestPrefetchViewport();
    }

    private void requestPrefetchViewport() {
        if (!foreground || !screen.equals("list") || prefetchViewportPosted) return;
        prefetchViewportPosted = true; handler.postDelayed(prefetchViewportUpdate, 50);
    }

    private void updatePrefetchViewport() {
        if (!foreground || !screen.equals("list") || selectingConversations || !credentials.has("token")) { prefetch.cancel(); return; }
        if (scroll.getHeight() == 0 || !prefetchRows.isEmpty() && prefetchRows.get(0).getHeight() == 0) return;
        int top = scroll.getScrollY() + scroll.getPaddingTop();
        int bottom = scroll.getScrollY() + scroll.getHeight() - scroll.getPaddingBottom();
        android.graphics.Rect bounds = new android.graphics.Rect();
        int first = prefetchBoundary(top, true, bounds), end = prefetchBoundary(bottom - 1, false, bounds);
        JSONArray visible = new JSONArray(), nearby = new JSONArray();
        for (int index = first; index < end && visible.length() < RemotePrefetch.VISIBLE_LIMIT; index++) {
            JSONObject row = conversations.get(prefetchRows.get(index).getTag().toString().substring("conversation:".length()));
            if (row != null) visible.put(row);
        }
        for (int index = end; index < prefetchRows.size() && nearby.length() < RemotePrefetch.NEARBY_LIMIT; index++) {
            View card = prefetchRows.get(index); card.getDrawingRect(bounds); content.offsetDescendantRectToMyCoords(card, bounds);
            if (bounds.top >= bottom + scroll.getHeight()) break;
            JSONObject row = conversations.get(card.getTag().toString().substring("conversation:".length()));
            if (row != null) nearby.put(row);
        }
        prefetch.schedule(credentials, visible, nearby);
    }

    // Conversation cards follow vertical display order, so locating the viewport takes O(log n) bounds checks.
    private int prefetchBoundary(int y, boolean lowerEdge, android.graphics.Rect bounds) {
        int low = 0, high = prefetchRows.size();
        while (low < high) {
            int middle = (low + high) >>> 1; View card = prefetchRows.get(middle);
            card.getDrawingRect(bounds); content.offsetDescendantRectToMyCoords(card, bounds);
            if ((lowerEdge ? bounds.bottom : bounds.top) <= y) low = middle + 1; else high = middle;
        }
        return low;
    }

    static boolean matchesConversationFilter(String filter, String activity) {
        if (activity == null) return filter == null || filter.equals("all");
        return switch (filter == null ? "all" : filter) {
            case "running" -> activity.equals("running");
            case "waiting" -> activity.equals("permission") || activity.equals("question");
            default -> true;
        };
    }

    private boolean matchesConversationFilter(JSONObject conversation) {
        return matchesConversationFilter(conversationFilter, conversation);
    }

    static boolean matchesConversationFilter(String filter, JSONObject conversation) {
        filter = filter == null || filter.equals("files") ? "all" : filter;
        if (filter.equals("archived")) return conversation.optLong("archivedAt", 0) > 0;
        return matchesConversationFilter(filter, conversation.optString("activity"));
    }

    private void addConversationFilters() {
        LinearLayout filters = new LinearLayout(this);
        filters.setOrientation(LinearLayout.VERTICAL);
        filters.setTag("conversationFilters");
        if (conversationFilter.equals("files")) conversationFilter = "all";
        LinearLayout row = conversationFilterRow();
        addConversationFilter(row, "all", tr("全部", "All"));
        addConversationFilter(row, "running", tr("运行中", "Running"));
        addConversationFilter(row, "waiting", tr("等待处理", "Waiting"));
        addConversationFilter(row, "archived", tr("已归档", "Archived"));
        filters.addView(row, new LinearLayout.LayoutParams(-1, -2));
        filters.setPadding(0, 0, 0, dp(8));
        content.addView(filters, new LinearLayout.LayoutParams(-1, -2));
    }

    private LinearLayout conversationFilterRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        return row;
    }

    private void addConversationFilter(LinearLayout row, String value, String label) {
        boolean active = conversationFilter.equals(value);
        TextView chip = new TextView(this);
        chip.setText(label);
        chip.setTextSize(Palette.TEXT_SMALL);
        chip.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        chip.setTextColor(active ? accent : muted);
        chip.setGravity(Gravity.CENTER);
        chip.setMinHeight(dp(48));
        chip.setMinimumWidth(dp(48));
        chip.setPadding(dp(12), dp(8), dp(12), dp(8));
        chip.setTag("sessionFilter:" + value);
        chip.setFocusable(true);
        GradientDrawable face = active
            ? chatStyle.capsule(Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent)))
            : null;
        chip.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE),
            face, chatStyle.capsule(Color.WHITE)));
        chip.setElevation(0);
        chip.setOnClickListener(view -> {
            if (!conversationFilter.equals(value)) {
                conversationFilter = value;
                if (value.equals("archived") && !archivedLoaded) loadArchived(false);
                renderConversations();
            }
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        params.setMarginEnd(dp(4));
        row.addView(chip, params);
    }

    private void renderConversations() {
        if (conversationPopup != null) conversationPopup.dismiss();
        int position = scroll.getScrollY();
        content.removeAllViews(); prefetchRows.clear();
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
        String query = searchInput == null ? "" : searchInput.getText().toString().trim().toLowerCase(Locale.ROOT);
        boolean filtered = !conversationFilter.equals("all");
        boolean archivedFilter = conversationFilter.equals("archived");
        if (archivedFilter && !archivedLoaded && !archivedLoading) loadArchived(false);
        if (!selectingConversations && query.isEmpty()) addConversationFilters();
        LinkedHashMap<String, ArrayList<JSONObject>> groups = new LinkedHashMap<>();
        if (query.isEmpty() && !filtered) for (int index = 0; index < availableWorkspaces.length(); index++) {
            JSONObject workspace = availableWorkspaces.optJSONObject(index); if (workspace != null) groups.put(workspace.optString("id"), new ArrayList<>());
        }
        int visibleConversations = 0;
        java.util.Collection<JSONObject> source = archivedFilter ? archivedConversations.values() : conversations.values();
        for (JSONObject conversation : source) {
            if (!query.isEmpty() && !conversation.optString("title").toLowerCase(Locale.ROOT).contains(query)) continue;
            if (!matchesConversationFilter(conversation)) continue;
            visibleConversations++;
            String workspace = conversation.isNull("workspaceId") ? "" : conversation.optString("workspaceId");
            groups.computeIfAbsent(workspace, key -> new ArrayList<>()).add(conversation);
        }
        ArrayList<JSONObject> independent = groups.remove("");
        if (independent != null || allowIndependent && query.isEmpty() && !filtered) groups.put("", independent == null ? new ArrayList<>() : independent);
        boolean matchingDiscussion = false;
        if (canDiscussions && !filtered) for (int index = 0; index < discussionGroups.length(); index++) {
            JSONObject discussion = discussionGroups.optJSONObject(index);
            if (discussion != null && discussion.optString("title").toLowerCase(Locale.ROOT).contains(query)) { matchingDiscussion = true; break; }
        }
        boolean hasContent = visibleConversations > 0 || !filtered && availableWorkspaces.length() > 0 || matchingDiscussion || !filtered && canDiscussions && moreDiscussions;
        boolean dataLoaded = archivedFilter ? archivedLoaded : listLoaded;
        if (!hasContent && !dataLoaded) {
            content.addView(new ChatEmptyState(this, chatStyle, "computer",
                listLoadFailed && !archivedFilter ? tr("暂时无法读取会话", "Could not load conversations")
                    : archivedFilter ? tr("正在读取已归档会话…", "Loading archived conversations…") : tr("正在同步会话…", "Syncing conversations…"),
                listLoadFailed && !archivedFilter ? tr("请检查连接后重试。", "Check your connection and try again.")
                    : archivedFilter ? tr("归档会话只在你主动打开此筛选时读取。", "Archived conversations are read only when you open this filter.")
                    : tr("连接电脑后，将显示授权范围内的工作区与会话。", "Your authorized workspaces and conversations will appear after connecting."),
                listLoadFailed && !archivedFilter ? tr("重新同步", "Retry sync") : "",
                listLoadFailed && !archivedFilter ? () -> loadList(false) : null));
            layoutConversationList(true, position); return;
        }
        if (!query.isEmpty() && groups.values().stream().allMatch(java.util.List::isEmpty) && !matchingDiscussion) {
            content.addView(new ChatEmptyState(this, chatStyle, "search", tr("没有找到会话", "No conversations found"),
                tr("试试更短的关键词，或清除搜索查看全部会话。", "Try a shorter keyword, or clear the search to see all conversations."),
                tr("清除搜索", "Clear search"), () -> searchInput.setText("")));
            layoutConversationList(true, position); return;
        }
        if (filtered && visibleConversations == 0 && !matchingDiscussion && dataLoaded) {
            content.addView(new ChatEmptyState(this, chatStyle, "sessions", archivedFilter ? tr("没有已归档会话", "No archived conversations") : tr("没有符合筛选的会话", "No matching conversations"),
                archivedFilter ? tr("归档后仍可在这里找到会话。", "Archived conversations remain available here.") : tr("清除筛选，查看全部会话。", "Clear the filter to see all conversations."),
                tr("查看全部", "Show all"), () -> { conversationFilter = "all"; renderConversations(); }));
            layoutConversationList(true, position); return;
        }
        if (!hasContent) {
            ChatEmptyState welcome = new ChatEmptyState(this, chatStyle, "brand", tr("在这里开始新的工作", "Start something new"),
                canCreate && allowIndependent
                    ? tr("新建独立会话直接开始，或创建工作区整理会话。", "Start a standalone chat, or create a workspace to organize your conversations.")
                    : canCreateWorkspace ? tr("先新建工作区，再在其中创建会话。", "Create a workspace, then start a conversation inside it.")
                    : tr("授权范围内暂无工作区或会话。", "There are no workspaces or conversations in your authorized scope."));
            if (canCreate && allowIndependent) welcome.addAction(tr("新建独立会话", "New standalone chat"), "newStandalone", () -> createConversation(null));
            if (canCreateWorkspace) welcome.addAction(tr("新建工作区", "New workspace"), "remoteNewWorkspace", this::createWorkspace);
            if (canDiscussions) welcome.addAction(tr("新建讨论群", "New discussion"), "newDiscussion", () -> openDiscussion(null, true, false));
            if (!(canCreate && allowIndependent) && !canCreateWorkspace && !canDiscussions) welcome.addAction(tr("刷新列表", "Refresh conversations"), "emptyStateAction", () -> loadList(false));
            for (int index = 0; index < welcome.getChildCount(); index++) if (welcome.getChildAt(index).isClickable())
                welcome.getChildAt(index).setEnabled(!commandBusy && !credentials.has("pendingCreate"));
            content.addView(welcome); layoutConversationList(true, position); return;
        }
        if (!filtered && (availableWorkspaces.length() > 0 || canCreateWorkspace)) {
            LinearLayout workspaceHeader = chatStyle.workspaceHeader(availableWorkspaces.length() == 0 ? tr("新建工作区", "New workspace") : tr("工作区", "Workspaces"),
                tr("新建工作区", "New workspace"), "remoteNewWorkspace", this::createWorkspace);
            View create = workspaceHeader.findViewWithTag("remoteNewWorkspace");
            create.setVisibility(canCreateWorkspace ? View.VISIBLE : View.GONE);
            create.setEnabled(!commandBusy && !credentials.has("pendingCreate")); content.addView(workspaceHeader);
            workspaceHeader.setPadding(0, dp(4), 0, dp(2));
        }
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
            LinearLayout.LayoutParams groupParams = new LinearLayout.LayoutParams(-1, -2); groupParams.setMargins(0, dp(6), 0, dp(2)); group.setLayoutParams(groupParams);
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
            ImageButton create = chatStyle.composerToolButton("new", workspace.isEmpty()
                ? tr("新建独立会话", "New independent conversation")
                : tr("新建会话：", "New conversation: ") + name,
                accent, () -> createConversation(workspace.isEmpty() ? null : workspace));
            create.setTag(workspace.isEmpty() ? "newStandalone" : "newWorkspace:" + workspace);
            create.setVisibility(canCreate && (!workspace.isEmpty() || allowIndependent) ? View.VISIBLE : View.GONE);
            create.setEnabled(!commandBusy && !credentials.has("pendingCreate"));
            groupHeader.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48)));
            group.addView(groupHeader);
            entries.sort(java.util.Comparator.comparing(entryValue -> !entryValue.optBoolean("pinned")));
            if (!collapsed || !query.isEmpty()) for (JSONObject conversation : entries) group.addView(conversationCard(conversation));
            if (entries.isEmpty() && !collapsed) {
                TextView hint = text(tr("暂无会话", "No conversations yet"), 13, muted);
                hint.setPadding(dp(workspace.isEmpty() ? 2 : 32), dp(8), dp(8), dp(8)); group.addView(hint);
            }
            content.addView(group);
        }
        if (!filtered && (query.isEmpty() || matchingDiscussion)) renderDiscussionSection(query);
        if (archivedFilter && archivedNextOffset >= 0) content.addView(button(tr("加载更多归档会话", "Load more archived conversations"), () -> loadArchived(true), false));
        else if (!archivedFilter && nextOffset >= 0) content.addView(button(tr("加载更多会话", "Load more conversations"), () -> loadList(true), false));
        layoutConversationList(false, position);
    }

    private void layoutConversationList(boolean centered, int position) {
        boolean wasCentered = (content.getGravity() & Gravity.VERTICAL_GRAVITY_MASK) == Gravity.CENTER_VERTICAL;
        content.setGravity(centered ? Gravity.CENTER_VERTICAL : Gravity.TOP);
        ScrollView target = scroll;
        viewHandler.post(() -> target.scrollTo(0, centered || wasCentered ? 0 : position));
        if (!centered) requestPrefetchViewport();
    }

    private boolean renderDiscussionSection(String query) {
        if (!canDiscussions) return false;
        String key = credentials.optString("address") + "/discussions";
        boolean collapsed = collapsedGroups.computeIfAbsent(key, value -> getPreferences(MODE_PRIVATE).getBoolean("collapsed:" + value, false));
        LinearLayout section = column(); section.setTag("remoteDiscussionsSection");
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(12), 0, dp(4)); section.setLayoutParams(params);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        String label = tr("Agent 讨论 (beta)", "Agent discussions (beta)");
        DisclosureHeader heading = new DisclosureHeader(this, label, muted, muted, collapsed);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.setPadding(0, dp(8), dp(4), dp(8));
        heading.setBackground(interactive(background)); heading.setTag("group:discussions"); heading.setFocusable(true);
        heading.setContentDescription(label + " · " + discussionGroups.length() + " · " + (collapsed ? tr("展开", "Expand") : tr("折叠", "Collapse")));
        heading.setOnClickListener(view -> { collapsedGroups.put(key, !collapsed); getPreferences(MODE_PRIVATE).edit().putBoolean("collapsed:" + key, !collapsed).apply(); renderConversations(); });
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton create = chatStyle.composerToolButton("new", tr("新建讨论群", "New discussion"), accent,
            () -> openDiscussion(null, true, false));
        create.setTag("newDiscussion"); header.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48))); section.addView(header);
        boolean found = false;
        for (int i = 0; i < discussionGroups.length(); i++) {
            JSONObject group = discussionGroups.optJSONObject(i); if (group == null) continue;
            String title = group.optString("title"), id = group.optString("id");
            if (!query.isEmpty() && !title.toLowerCase(Locale.ROOT).contains(query)) continue;
            found = true; if (collapsed && query.isEmpty()) continue;
            String indicator = group.optBoolean("active") ? tr("运行中", "Running") : "";
            if (group.optBoolean("pinned")) indicator += (indicator.isEmpty() ? "" : " · ") + tr("已置顶", "Pinned");
            section.addView(new ConversationRow(this, chatStyle, false, title, indicator, "discussion:" + id, "discussionStatus:" + id,
                () -> openDiscussion(id, false, false), () -> openDiscussion(id, false, true)));
        }
        if (!collapsed || !query.isEmpty()) {
            if (!found && query.isEmpty()) { TextView hint = text(tr("暂无讨论群，点击 + 新建", "No discussions yet. Tap + to create one."), 13, muted); hint.setPadding(0, dp(8), 0, dp(12)); section.addView(hint); }
            if (moreDiscussions) section.addView(button(tr("查看全部讨论群", "View all discussions"), () -> openDiscussion(null, false, false), false));
        }
        content.addView(section); return found;
    }

    private void openDiscussion(String id, boolean create, boolean actions) {
        if (!canDiscussions) return;
        persistDraft(); stopNetwork();
        startActivity(new android.content.Intent(this, RemoteDiscussionsActivity.class).putExtra("address", credentials.optString("address"))
            .putExtra("groupId", id).putExtra("createGroup", create).putExtra("showActions", actions).putExtra("fromNavigation", true));
    }

    private View conversationCard(JSONObject conversation) {
        String title = conversation.optString("title");
        String state = conversation.optString("activity", "");
        boolean archived = conversation.optLong("archivedAt", 0) > 0 || conversationFilter.equals("archived");
        boolean unread = replies().unread(credentials, conversation);
        boolean working = state.equals("running") || state.equals("permission") || state.equals("question");
        // Work that outlives its reply still belongs in the state column: it is
        // the one sign the desktop is busy while the row would otherwise read
        // as idle. A live reply keeps the column, as it does on the desktop.
        String indicator = working || RemoteWorkStatus.backgroundCount(conversation) > 0 ? activity(conversation) : "";
        if (unread) indicator += (indicator.isEmpty() ? "" : " · ") + tr("新消息", "New reply");
        if (conversation.optBoolean("pinned")) indicator += (indicator.isEmpty() ? "" : " · ") + tr("已置顶", "Pinned");
        if (archived) indicator = tr("已归档", "Archived");
        Palette statusPalette = Palette.of(this);
        int statusColor = archived ? statusPalette.muted
            : state.equals("running") ? statusPalette.success
            : state.equals("permission") || state.equals("question") ? statusPalette.warning
            : state.equals("failed") || state.equals("error") ? statusPalette.error
            : RemoteWorkStatus.backgroundCount(conversation) > 0 || unread ? statusPalette.accent : statusPalette.muted;
        String meta = conversationMeta(conversation);
        String time = conversationTime(conversation);
        ConversationRow card = new ConversationRow(this, chatStyle, !conversation.isNull("workspaceId") && !conversation.optString("workspaceId").isEmpty(),
            conversationEngine(conversation), title, meta, indicator, statusColor, time,
            "conversation:" + conversation.optString("id"), "conversationStatus:" + conversation.optString("id"),
            () -> {
                String id = conversation.optString("id");
                if (selectingConversations) {
                    if (!selectedConversations.add(id)) selectedConversations.remove(id);
                    renderConversations();
                } else if (archived) restoreArchivedConversation(conversation);
                else { conversationId = id; conversationTitle = title; detailReturn = "list"; detailScreen(); connectEvents(); }
            }, () -> { if (archived) restoreArchivedConversation(conversation); else conversationMenu(conversation); });
        card.setContentDescription(title + (meta.isEmpty() ? "" : " · " + meta) + " · " + activity(conversation)
            + (unread ? " · " + tr("新消息", "New reply") : ""));
        card.selection(selectingConversations, selectedConversations.contains(conversation.optString("id")));
        if (!archived) prefetchRows.add(card);
        return card;
    }

    private String conversationMeta(JSONObject conversation) {
        java.util.ArrayList<String> parts = new java.util.ArrayList<>();
        String engine = RemoteEngines.label(conversationEngine(conversation));
        if (!engine.isEmpty()) parts.add(engine);
        String model = conversation.optString("modelName", "").trim();
        if (model.isEmpty() || model.equals("null")) model = conversation.optString("model", "").trim();
        if (!model.isEmpty() && !model.equals("null")) parts.add(model);
        return String.join(" · ", parts);
    }

    private String conversationEngine(JSONObject conversation) {
        String engine = conversation.optString("engine", "");
        if (engine.isEmpty() || engine.equals("null")) engine = conversation.optString("currentEngine", "");
        return engine.equals("null") ? "" : engine;
    }

    private String conversationTime(JSONObject conversation) {
        long at = conversation.optLong("archivedAt", 0);
        if (at <= 0) at = conversation.optLong("updatedAt", 0);
        if (at <= 0) return "";
        long delta = Math.max(0, System.currentTimeMillis() - at);
        long minutes = delta / 60_000L;
        if (minutes < 1) return tr("刚刚", "now");
        if (minutes < 60) return tr(minutes + " 分", minutes + "m");
        long hours = minutes / 60;
        if (hours < 24) return tr(hours + " 小时", hours + "h");
        long days = hours / 24;
        if (days < 7) return tr(days + " 天", days + "d");
        return new java.text.SimpleDateFormat("M/d", java.util.Locale.getDefault()).format(new java.util.Date(at));
    }

    private java.util.List<ConversationSidebar.Item> detailSidebarItems() {
        LinkedHashMap<String, JSONObject> merged = new LinkedHashMap<>();
        JSONObject cached = listCache == null ? null : listCache.get(credentials);
        JSONArray rows = cached == null ? null : cached.optJSONArray("conversations");
        if (rows != null) for (int index = 0; index < rows.length(); index++) {
            JSONObject conversation = rows.optJSONObject(index);
            String id = conversation == null ? "" : conversation.optString("id");
            if (!id.isEmpty() && conversation.optLong("archivedAt", 0) <= 0) {
                merged.put(id, conversation);
            }
        }
        for (JSONObject conversation : conversations.values()) {
            String id = conversation.optString("id");
            if (!id.isEmpty() && conversation.optLong("archivedAt", 0) <= 0 && !merged.containsKey(id)) {
                merged.put(id, conversation);
            }
        }
        ArrayList<ConversationSidebar.Item> items = new ArrayList<>();
        boolean currentSeen = false;
        for (JSONObject conversation : merged.values()) {
            if (items.size() == 40) break;
            String id = conversation.optString("id");
            if (id.isEmpty()) continue;
            boolean selected = id.equals(conversationId);
            currentSeen |= selected;
            items.add(sidebarItem(conversation, selected));
        }
        if (!currentSeen && conversationId != null && !conversationId.isEmpty()) {
            try {
                JSONObject current = new JSONObject().put("id", conversationId)
                    .put("title", conversationTitle)
                    .put("engine", displayedConversation != null
                        && conversationId.equals(displayedConversation.optString("id"))
                        ? conversationEngine(displayedConversation) : "");
                items.add(0, sidebarItem(current, true));
            } catch (Exception ignored) {
                // A missing synthetic row is safer than hiding the rest of the sidebar.
            }
        }
        return items;
    }

    private ConversationSidebar.Item sidebarItem(JSONObject conversation, boolean selected) {
        String state = conversation.optString("activity");
        boolean running = state.equals("running");
        boolean waiting = state.equals("permission") || state.equals("question");
        int background = RemoteWorkStatus.backgroundCount(conversation);
        boolean active = running || waiting || background > 0;
        Palette palette = Palette.of(this);
        int color = running ? palette.success
            : waiting ? palette.warning
            : background > 0 ? (RemoteWorkStatus.backgroundUnknown(conversation) ? palette.warning : palette.accent)
            : 0;
        String status = conversationMeta(conversation);
        if (active) status += (status.isEmpty() ? "" : " · ") + activity(conversation);
        String time = conversationTime(conversation);
        String detail = status.isEmpty() ? time : time.isEmpty() ? status : status + " · " + time;
        if (detail.isEmpty()) detail = tr("空闲", "Idle");
        String title = conversation.optString("title");
        if (title.isEmpty()) title = tr("未命名会话", "Untitled conversation");
        boolean unread = conversation.optLong("lastReplyAt", 0) > conversation.optLong("replyReadAt", 0);
        return new ConversationSidebar.Item(conversation.optString("id"), title,
            conversationEngine(conversation), detail, color, selected, unread);
    }

    private void openSidebarConversation(ConversationSidebar.Item item) {
        if (item == null || item.id.isEmpty() || item.id.equals(conversationId)) return;
        persistDraft();
        sidebarScrollRestore = detailSidebar == null ? -1 : detailSidebar.scrollY();
        conversationId = item.id;
        conversationTitle = item.title;
        detailScreen();
        connectEvents();
    }

    private void refreshDetailSidebar() {
        if (detailSidebar == null || !screen.equals("detail") || !foreground || sidebarRefreshBusy
                || !credentials.has("token") || !EmbeddedNetwork.online() || listCache == null) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - sidebarRefreshAt < 5_000) return;
        sidebarRefreshAt = now;
        sidebarRefreshBusy = true;
        int ticket = generation;
        long revision = conversationListRevision;
        JSONObject snapshot;
        JSONObject before;
        try {
            snapshot = new JSONObject(credentials.toString());
            before = listCache.get(snapshot);
        } catch (Exception error) {
            sidebarRefreshBusy = false;
            return;
        }
        String token = snapshot.optString("token");
        RemoteApi request = homeClientFactory.apply(snapshot.optString("address"));
        worker.submit(() -> {
            try {
                JSONObject page = request.json("/v1/conversations?offset=0", token, null);
                deliver(ticket, () -> {
                    if (revision != conversationListRevision || !screen.equals("detail")) return;
                    JSONArray rows = page.optJSONArray("conversations");
                    if (rows == null) return;
                    JSONArray workspaces = page.optJSONArray("workspaces");
                    if (workspaces == null) workspaces = before == null ? null : before.optJSONArray("workspaces");
                    if (workspaces == null) workspaces = new JSONArray();
                    boolean independent = page.has("includeUnassigned")
                        ? page.optBoolean("includeUnassigned") : before != null && before.optBoolean("includeUnassigned");
                    listCache.put(snapshot, rows, page.optInt("nextOffset", -1), workspaces, independent);
                    conversationListRevision++;
                    JSONObject after = listCache.get(snapshot);
                    boolean changed = before == null ? after != null : after != null && !before.toString().equals(after.toString());
                    if (!changed) return;
                    if (screen.equals("detail") && detailSidebar != null) {
                        detailSidebar.update(detailSidebarItems());
                    }
                });
            } catch (Exception ignored) {
                // The cached sidebar remains usable while the next open retries.
            } finally {
                sidebarRefreshBusy = false;
                request.cancel();
            }
        });
    }

    private void restoreArchivedConversation(JSONObject conversation) {
        if (!canManageConversations || commandBusy || credentials.has("pendingCreate")) {
            setStatusNotice(tr("恢复归档需要控制权限，并等待当前操作完成。", "Restoring an archived conversation requires control permission and no pending action."));
            return;
        }
        String id = conversation.optString("id");
        new CamelliaDialog.Builder(this).setTitle(tr("恢复会话？", "Restore conversation?"))
            .setMessage(tr("会话会回到正常的会话列表。", "The conversation will return to the normal list."))
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("恢复", "Restore"), (dialog, which) -> {
                try {
                    JSONObject payload = command("restore").put("conversationId", id)
                        .put("expectedSeq", conversation.optLong("seq"));
                    JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload);
                    store.save(saved); credentials = saved;
                    archivedConversations.remove(id);
                    renderConversations();
                    retryCreate();
                } catch (Exception error) {
                    reportError("无法保存恢复请求", "Could not save restore action", error);
                }
            }).show();
    }

    private void conversationMenu(JSONObject conversation) {
        if (!canManageConversations || commandBusy || credentials.has("pendingCreate")) {
            setStatusNotice(canManageConversations ? tr("请等待当前操作完成。", "Wait for the current operation to finish.") : tr("会话管理需要控制权限，并更新重启电脑端。", "Conversation actions require control permission and an updated, restarted desktop."));
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
            () -> archiveConversation(conversation), () -> confirmConversationDelete(java.util.Set.of(id)), canFork ? () -> forkConversation(conversation) : null);
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
    private void forkConversation(JSONObject conversation) {
        if (!canFork || commandBusy || credentials.has("pendingCreate")) return;
        try {
            JSONObject payload = command("fork").put("instanceId", listInstance).put("expectedSeq", conversation.optLong("seq")).put("moveSessionId", conversation.optString("id"));
            JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload);
            store.save(saved); credentials = saved; retryCreate();
        } catch (Exception error) { reportError("无法保存分叉操作", "Could not save fork action", error); }
    }

    private void confirmConversationDelete(java.util.Set<String> targets) {
        // Deleting one chat from the long-press menu does not need a trailing
        // count; the number only helps confirm a bulk delete.
        boolean single = targets.size() == 1;
        String message = single
            ? tr("将永久删除此会话在电脑端的聊天记录，无法撤销；不会删除工作区文件。", "Permanently deletes this chat on your computer, not workspace files. This cannot be undone.")
            : tr("将永久删除电脑端所选的 " + targets.size() + " 个会话，无法撤销；不会删除工作区文件。", "Permanently deletes the " + targets.size() + " selected chats on your computer, not workspace files. This cannot be undone.");
        new CamelliaDialog.Builder(this).setTitle(single ? tr("删除会话？", "Delete chat?") : tr("删除会话？", "Delete chats?"))
            .setMessage(message)
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("删除", "Delete"), (dialog, which) -> manageConversations("delete", targets, "", false)).show();
    }

    private void manageConversations(String action, java.util.Set<String> ids, String title, boolean pinned) {
        if (!canManageConversations || commandBusy || credentials.has("pendingCreate") || ids.isEmpty()) return;
        if (ids.size() > 100) { setStatusNotice(tr("每次最多选择 100 个会话。", "Select at most 100 chats at a time.")); return; }
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
        if (!canArchive) {
            setStatusNotice(tr("这台电脑未开放归档，请更新电脑端并授予控制权限。", "This computer does not allow archiving. Update the desktop and grant control permission."));
            return;
        }
        if (commandBusy || credentials.has("pendingCreate")) return;
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
        listLoadFailed = false;
        if (!listLoaded) renderConversations();
        RemoteApi client = begin(); int ticket = generation;
        ((RefreshScrollView) scroll).setRefreshing(true);
        String token = credentials.optString("token"); int offset = append ? nextOffset : 0;
        boolean searching = searchInput != null && !searchInput.getText().toString().trim().isEmpty();
        String query = searchInput == null ? "" : searchInput.getText().toString().trim().toLowerCase(Locale.ROOT);
        boolean modern = canListQuery && capabilityAddress.equals(credentials.optString("address"));
        int pageSize = Math.min(1000, Math.max(100, conversations.size()));
        setStatusNotice(conversations.isEmpty() ? tr("正在同步…", "Syncing…")
            : tr("显示上次缓存，正在同步…", "Showing cached conversations; syncing…"));
        job = worker.submit(() -> {
            try {
                JSONObject page = client.json(conversationListPath(offset, pageSize, query, modern), token, null);
                JSONObject info = listInfo(client, token, page);
                long pageCursor = page.optLong("cursor", -1);
                if (searching && !modern) {
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
                    remoteListQuery = modern ? page.optString("query") : "";
                    listCursor = append ? -1 : pageCursor;
                    applyConversationPage(page, append);
                    cacheConversations();
                    ((RefreshScrollView) scroll).setRefreshing(false);
                    computerStates.put(credentials.optString("address"), tr("已连接", "Connected"));
                    watchList(client, ticket);
                });
            } catch (Exception error) { deliver(ticket, () -> {
                ((RefreshScrollView) scroll).setRefreshing(false); listLoadFailed = true; showFailure(error, true);
                if (screen.equals("list")) renderConversations();
            }); }
        });
    }

    private void loadArchived(boolean append) {
        if (archivedLoading || !credentials.has("token") || !networkActive()) {
            archivedLoaded = true;
            renderConversations();
            return;
        }
        archivedLoading = true;
        setStatusNotice(tr("正在读取已归档会话…", "Loading archived conversations…"));
        RemoteApi client = api == null ? begin() : api;
        int ticket = generation;
        String token = credentials.optString("token");
        int offset = append ? Math.max(0, archivedNextOffset) : 0;
        worker.submit(() -> {
            try {
                JSONObject page = client.json("/v1/archived?offset=" + offset, token, null);
                JSONArray rows = page.optJSONArray("conversations");
                if (ticket != generation) return;
                deliver(ticket, () -> {
                    archivedLoading = false;
                    archivedLoaded = true;
                    if (!append) archivedConversations.clear();
                    for (int index = 0; rows != null && index < rows.length(); index++) {
                        JSONObject conversation = rows.optJSONObject(index);
                        if (conversation != null && !conversation.optString("id").isEmpty())
                            archivedConversations.put(conversation.optString("id"), conversation);
                    }
                    archivedNextOffset = page.optInt("nextOffset", -1);
                    setStatusNotice("");
                    renderConversations();
                });
            } catch (Exception error) {
                deliver(ticket, () -> {
                    archivedLoading = false;
                    archivedLoaded = true;
                    showFailure(error, true);
                    renderConversations();
                });
            }
        });
    }

    private JSONObject listInfo(RemoteApi client, String token, JSONObject page) throws IOException {
        JSONObject info = page.has("protocol") ? page : client.json("/v1/status", token, null);
        if (info.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
        // Older hosts expose discussions separately from the combined navigation snapshot.
        if (info.optString("permission").equals("control") && String.valueOf(info.optJSONArray("capabilities")).contains("\"discussions\"") && !info.has("discussionGroups")) {
            try {
                JSONObject groups = client.json("/v1/discussions", token, null);
                info.put("discussionGroups", groups.optJSONArray("groups")).put("discussionsNextOffset", groups.opt("nextOffset"));
            } catch (org.json.JSONException error) { throw new IOException(error); }
        }
        return info;
    }

    private String conversationListPath(int offset, int limit, String query, boolean modern) throws IOException {
        return "/v1/conversations?offset=" + offset + (modern ? "&limit=" + limit + "&query=" + java.net.URLEncoder.encode(query, "UTF-8") : "");
    }

    private void updateCapabilities(JSONObject info) {
        if (screen.equals("list")) { listLoaded = true; listLoadFailed = false; }
        JSONArray engines = info.optJSONArray("engines");
        java.util.List<String> advertised = engines == null ? null : new ArrayList<>();
        if (engines != null) for (int index = 0; index < engines.length(); index++) advertised.add(engines.optString(index));
        availableEngines = RemoteEngines.available(advertised);
        String capabilities = String.valueOf(info.optJSONArray("capabilities"));
        canCommandReceipts = capabilities.contains("\"command-receipts\"");
        canCodexReset = info.optString("permission").equals("control") && capabilities.contains("\"codex-reset-credits\"");
        canStopStart = capabilities.contains("\"stop-start\"");
        canStopBackgroundWork = capabilities.contains("\"stop-background-work\"");
        canIncremental = capabilities.contains("\"incremental-snapshots\"");
        canListQuery = capabilities.contains("\"list-query\""); capabilityAddress = credentials.optString("address");
        capabilityToken = credentials.optString("token");
        canDiscussions = info.optString("permission").equals("control") && capabilities.contains("\"discussions\"");
        discussionGroups = canDiscussions ? info.optJSONArray("discussionGroups") : null;
        if (discussionGroups == null) discussionGroups = new JSONArray();
        moreDiscussions = canDiscussions && info.optInt("discussionsNextOffset", -1) >= 0;
        canCreate = info.optString("permission").equals("control") && capabilities.contains("\"create\"");
        canFork = canCreate && capabilities.contains("\"fork\"");
        canCreateWorkspace = info.optString("permission").equals("control") && capabilities.contains("\"create-workspace\"");
        canImage = capabilities.contains("\"image\"");
        canMultiImage = capabilities.contains("\"multi-image\"");
        canAttachments = capabilities.contains("\"expanded-attachments\"");
        canFileAttachments = canAttachments || capabilities.contains("\"attachments\"");
        canArchive = info.optString("permission").equals("control") && capabilities.contains("\"archive\"");
        canManageConversations = info.optString("permission").equals("control") && capabilities.contains("\"conversation-actions\"");
        listInstance = info.optString("instanceId"); allowIndependent = info.optBoolean("includeUnassigned");
        availableWorkspaces = info.optJSONArray("workspaces"); if (availableWorkspaces == null) availableWorkspaces = new JSONArray();
    }

    private void createWorkspace() {
        if (!canCreateWorkspace) {
            setStatusNotice(tr("请更新电脑端，并授权控制所有工作区后再新建。", "Update the desktop and authorize control of all workspaces to create one.")); return;
        }
        if (commandBusy) return;
        if (credentials.has("pendingCreate")) { retryCreate(); return; }
        LinearLayout panel = computerDialogPanel(tr("新建工作区", "New workspace"),
            tr("填写电脑上已存在文件夹的完整路径，不是手机路径。", "Enter the full path of an existing folder on the computer, not this phone."));
        EditText name = input(panel, tr("工作区名称", "Workspace name"), "", android.text.InputType.TYPE_CLASS_TEXT);
        name.setTag("remoteWorkspaceName"); name.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(200)});
        EditText folder = input(panel, tr("电脑文件夹绝对路径", "Absolute computer folder path"), "", android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        folder.setTag("remoteWorkspacePath"); folder.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(1024)});
        android.app.Dialog dialog = createComputerDialog(panel, tr("创建", "Create"), tr("取消", "Cancel"));
        showComputerDialog(dialog);
        android.app.AlertDialog alert = (android.app.AlertDialog) dialog;
        Button submit = alert.getButton(android.app.AlertDialog.BUTTON_POSITIVE); submit.setTag("remoteWorkspaceCreate");
        alert.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).setTag("remoteWorkspaceCancel");
        submit.setOnClickListener(view -> {
            if (name.getText().toString().trim().isEmpty()) { ((SettingsField) name.getParent()).showError(tr("请输入名称", "Enter a name")); return; }
            if (folder.getText().toString().trim().isEmpty()) { ((SettingsField) folder.getParent()).showError(tr("请输入电脑文件夹路径", "Enter a computer folder path")); return; }
            try {
                JSONObject payload = command("create-workspace").put("instanceId", listInstance).put("name", name.getText().toString().trim()).put("path", folder.getText().toString().trim());
                JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload); store.save(saved); credentials = saved;
                dialog.dismiss(); retryCreate();
            } catch (Exception error) { reportError("无法保存新建请求", "Could not save creation request", error); }
        });
    }

    private void createConversation(String workspace) {
        if (!canCreate || workspace == null && !allowIndependent) {
            setStatusNotice(tr("请更新电脑端，并授权控制及对应会话范围。", "Update the desktop and authorize control and this workspace scope.")); return;
        }
        if (credentials.has("pendingCreate")) { retryCreate(); return; }
        String target = tr("新建独立会话", "New standalone chat");
        if (workspace != null) {
            String name = workspace;
            for (int index = 0; index < availableWorkspaces.length(); index++) {
                JSONObject item = availableWorkspaces.optJSONObject(index);
                if (item != null && workspace.equals(item.optString("id"))) name = item.optString("name", workspace);
            }
            target = tr("新建会话：", "New conversation: ") + name;
        }
        LinearLayout panel = computerDialogPanel(target, tr("选择执行引擎，沿用电脑端的连接设置。", "Choose an engine using your desktop connection settings."));
        android.app.Dialog dialog = createComputerDialog(panel);
        SettingsStyle style = new SettingsStyle(this);
        LinearLayout group = style.group(panel, tr("执行引擎", "Engine"));
        for (String engine : availableEngines) style.action(group, RemoteEngines.label(engine), "", "createEngine:" + engine, false, () -> {
            try {
                JSONObject payload = command("create").put("instanceId", listInstance).put("workspaceId", workspace == null ? JSONObject.NULL : workspace).put("engine", engine);
                JSONObject saved = new JSONObject(credentials.toString()).put("pendingCreate", payload); store.save(saved); credentials = saved;
                dialog.dismiss(); retryCreate();
            } catch (Exception error) { reportError("无法保存新建请求", "Could not save creation request", error); }
        });
        showComputerDialog(dialog);
    }

    private void retryCreate() {
        if (credentials.optBoolean("pendingCreateUncertain")) {
            new CamelliaDialog.Builder(this).setMessage(tr("操作可能已经执行，请先核对电脑。解除待确认仅清除手机记录。", "The action may have executed. Check the desktop first; resolving only clears the phone's pending record."))
                .setPositiveButton(tr("继续查询", "Check again"), (d, w) -> { listCommandDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS; retryCreate(false); })
                .setNeutralButton(tr("已核对，解除待确认", "Checked; resolve"), (d, w) -> {
                    try { credentials.remove("pendingCreate"); credentials.remove("pendingCreateSent"); credentials.remove("pendingCreateUncertain"); store.save(credentials); commandBusy = false; loadList(false); }
                    catch (Exception error) { reportError("无法保存核对结果。", "Could not save the resolution.", error); }
                }).setNegativeButton(tr("暂不处理", "Later"), null).show(); return;
        }
        retryCreate(true);
    }

    private void retryCreate(boolean manual) {
        if (!foreground || !screen.equals("list") || !credentials.has("pendingCreate") || commandBusy) return;
        RemoteApi client = api == null ? begin() : api; int ticket = generation; commandBusy = true;
        if (manual || listCommandDeadline == 0) listCommandDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
        JSONObject payload = credentials.optJSONObject("pendingCreate"); String token = credentials.optString("token");
        boolean query = canCommandReceipts && credentials.optBoolean("pendingCreateSent");
        try { credentials.put("pendingCreateSent", true); store.save(credentials); }
        catch (Exception error) { commandBusy = false; reportError("无法保存操作。", "Could not save the action.", error); return; }
        JSONObject owner;
        try { owner = new JSONObject(credentials.toString()); }
        catch (Exception error) { commandBusy = false; reportError("无法读取操作。", "Could not read the action.", error); return; }
        boolean workspaceCreation = payload != null && payload.optString("action").equals("create-workspace");
        boolean moving = payload != null && payload.optString("action").equals("move");
        boolean archiving = payload != null && payload.optString("action").equals("archive");
        boolean managing = payload != null && java.util.Set.of("rename", "pin", "delete").contains(payload.optString("action"));
        setStatusNotice(archiving ? tr("正在归档会话…", "Archiving conversation…") : moving ? tr("正在移动会话…", "Moving conversation…") : workspaceCreation ? tr("正在新建工作区…", "Creating workspace…") : tr("正在新建会话…", "Creating conversation…"));
        if (managing) setStatusNotice(tr("正在更新会话…", "Updating conversations…"));
        commandWorker.submit(() -> {
            try {
                JSONObject request = new JSONObject(payload.toString());
                String targetId = request.optString("moveSessionId"); request.remove("moveSessionId");
                boolean targeted = moving || request.optString("action").equals("fork");
                JSONObject response;
                try { response = client.json(query ? "/v1/commands/" + request.optString("requestId") : targeted ? "/v1/conversations/" + targetId + "/commands" : "/v1/commands", token, query ? null : request); }
                catch (RemoteApi.Failure missing) {
                    if (!query || missing.status != 404) throw missing;
                    response = client.json(targeted ? "/v1/conversations/" + targetId + "/commands" : "/v1/commands", token, request);
                }
                JSONObject result = response;
                handler.post(() -> {
                    if (!sameComputer(owner) || !foreground || ticket != generation || !screen.equals("list")) {
                        settleListReceipt(owner, payload, result); return;
                    }
                    commandBusy = false;
                    if (result.optString("state").equals("pending")) {
                        renderConversations();
                        setStatusNotice(tr("电脑正在处理操作，正在自动查询结果…", "The computer is processing the action; checking automatically…"));
                        if (android.os.SystemClock.elapsedRealtime() < listCommandDeadline) handler.postDelayed(() -> retryCreate(false), COMMAND_POLL_INTERVAL_MS);
                        else {
                            try { credentials.put("pendingCreateUncertain", true); store.save(credentials); } catch (Exception ignored) { }
                            setStatusError(tr("等待确认超时，请核对或查询同一请求。", "Confirmation timed out. Inspect or check the same request."));
                        }
                        return;
                    }
                    if (result.optString("state").equals("unknown")) {
                        try { credentials.put("pendingCreateUncertain", true); store.save(credentials); } catch (Exception ignored) { }
                        renderConversations(); setStatusError(tr("电脑无法确认结果，请核对后处理待确认记录。", "The desktop cannot confirm the outcome. Inspect it before resolving the pending record.")); return;
                    }
                    try {
                        JSONObject saved = new JSONObject(credentials.toString()); saved.remove("pendingCreate");
                        saved.remove("pendingCreateSent"); saved.remove("pendingCreateUncertain"); listCommandDeadline = 0;
                        if (result.optBoolean("ok") && payload.optString("action").equals("delete")) {
                            JSONArray deleted = payload.optJSONArray("targets");
                            for (int index = 0; deleted != null && index < deleted.length(); index++) {
                                String id = deleted.getJSONObject(index).getString("id");
                                for (String key : java.util.List.of("drafts", "draftEdits", "draftAttachments")) {
                                    JSONObject drafts = saved.optJSONObject(key); if (drafts != null) drafts.remove(id);
                                }
                            }
                        }
                        store.save(saved); credentials = saved;
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
                            setStatusNotice(tr("会话已归档", "Conversation archived"));
                        } else if (result.optBoolean("ok") && workspaceCreation && result.optJSONObject("workspace") != null) {
                            loadList(false);
                        } else if (result.optBoolean("ok") && conversation != null) {
                            conversationId = conversation.getString("id"); conversationTitle = conversation.optString("title");
                            detailReturn = "list"; detailScreen(); connectEvents();
                        } else { renderConversations(); setStatusNotice(tr("操作未确认成功，请先在电脑核对。", "Operation not confirmed. Check the desktop before retrying.") + " " + result.optString("error")); }
                    } catch (Exception error) { reportError("无法保存结果，请重试同一请求。", "Could not save result. Retry the same request.", error); }
                });
            } catch (Exception error) { deliver(ticket, () -> {
                commandBusy = false;
                if (!query && error instanceof RemoteApi.Failure && java.util.Set.of(400, 403, 409, 413).contains(((RemoteApi.Failure) error).status)) {
                    try { credentials.remove("pendingCreate"); credentials.remove("pendingCreateSent"); credentials.remove("pendingCreateUncertain"); store.save(credentials); } catch (Exception ignored) { }
                } else {
                    try { credentials.put("pendingCreateUncertain", true); store.save(credentials); } catch (Exception ignored) { }
                    if (android.os.SystemClock.elapsedRealtime() < listCommandDeadline) handler.postDelayed(() -> retryCreate(false),
                        error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : 2000);
                }
                renderConversations(); showFailure(error, true);
            }); }
        });
    }

    private void settleListReceipt(JSONObject owner, JSONObject payload, JSONObject result) {
        try {
            JSONObject saved = commandProfile(owner); if (saved == null) return;
            JSONObject pending = saved.optJSONObject("pendingCreate");
            if (pending == null || !payload.optString("requestId").equals(pending.optString("requestId"))) return;
            if (result.optString("state").equals("pending") || result.optString("state").equals("unknown")) saved.put("pendingCreateUncertain", true);
            else {
                saved.remove("pendingCreate"); saved.remove("pendingCreateSent"); saved.remove("pendingCreateUncertain");
                if (result.optBoolean("ok") && payload.optString("action").equals("delete")) {
                    JSONArray deleted = payload.optJSONArray("targets");
                    for (int i = 0; deleted != null && i < deleted.length(); i++) for (String key : java.util.List.of("drafts", "draftEdits", "draftAttachments")) {
                        JSONObject drafts = saved.optJSONObject(key); if (drafts != null) drafts.remove(deleted.getJSONObject(i).getString("id"));
                    }
                }
            }
            if (store.saveProfile(saved) && sameComputer(owner)) credentials = saved;
        } catch (Exception error) { if (sameComputer(owner) && foreground) reportError("无法保存操作结果。", "Could not save the action result.", error); }
    }

    private void pickImage() {
        if (loadingImages) return;
        boolean pending = (pendingCommand() != null);
        boolean available = connected && controlAllowed && !commandBusy;
        boolean sendable = available && !pending && !loadingImages;
        // The tiles only work when the desktop advertises the image capability
        // and this chat still has room; the sheet still opens so the capability
        // rows stay reachable.
        int limit = ChatAttachments.remoteCount(canAttachments, canFileAttachments, canMultiImage);
        boolean images = sendable && (canImage || canFileAttachments) && selectedImages.size() + selectedDocuments.size() < limit;
        imageConversation = conversationId; imageComputer = credentials.optString("address");
        AttachSheet sheet = new AttachSheet(this);
        LinearLayout panel = sheet.panel();
        android.app.Dialog dialog = createComputerDialog(panel);
        sheet.header(panel, "plus", tr("添加内容", "Add"), tr("关闭", "Close"), () -> dialog.dismiss());
        sheet.sectionLabel(panel, tr("从手机添加", "From this phone"));
        sheet.tiles(panel, java.util.Arrays.asList(
            new AttachSheet.Tile("camera", tr("拍照", "Camera"), "imageCamera", images, () -> { dialog.dismiss(); openCamera(); }),
            new AttachSheet.Tile("image", tr("照片", "Photos"), "imageGallery", images, () -> { dialog.dismiss(); openGallery(); }),
            new AttachSheet.Tile("file", tr("文件", "Files"), "remoteDocumentPicker", sendable && (canAttachments || canFileAttachments) && selectedImages.size() + selectedDocuments.size() < limit, () -> { dialog.dismiss(); openDocuments(); })));
        sheet.note(panel, (canAttachments ? ChatAttachments.limits(chinese, true)
            : canFileAttachments ? tr("当前电脑最多 9 个附件 · 合计 8 MiB；更新电脑端可提高限额。", "This desktop supports 9 attachments · 8 MiB total; update it for higher limits.")
            : tr("更新并重启电脑端后，可发送最多 20 个附件。", "Update and restart the desktop for up to 20 attachments."))
            + " " + tr("支持 PDF、Word、Excel、PPT 和文本。", "PDF, Word, Excel, PowerPoint and text."));
        LinearLayout group = sheet.group(panel, tr("附件选项", "Attachment options"));
        sheet.row(group, "folder", tr("查看产物", "Files"),
            tr("查看并下载会话产物", "Review and download files"),
            "", "attachArtifacts", sendable, () -> {
                dialog.dismiss();
                artifactDownloads.show(credentials.optString("address"), credentials.optString("token"), conversationId);
            });
        if (!images && sendable) {
            String reason = selectedImages.size() + selectedDocuments.size() >= limit
                ? (canAttachments ? tr("最多添加 20 个附件。", "Add up to 20 attachments.")
                    : canFileAttachments ? tr("当前电脑最多 9 个附件，请更新电脑端提高限额。", "This desktop supports up to 9 attachments; update it for higher limits.")
                    : canMultiImage ? tr("旧版电脑端最多 9 张图片，请更新电脑端。", "This desktop supports up to 9 images; update it.")
                    : tr("当前电脑端不具备图片附件能力。", "This desktop does not support image attachments."))
                : !canImage && !canFileAttachments
                    ? tr("当前电脑端不具备图片附件能力。", "This desktop does not support image attachments.")
                    : tr("连接电脑后可添加图片。", "Connect to your computer to add images.");
            sheet.note(panel, reason);
        }
        showComputerDialog(dialog);
    }

    private void openGallery() {
        int remaining = ChatAttachments.remoteCount(canAttachments, canFileAttachments, canMultiImage) - selectedImages.size() - selectedDocuments.size();
        try { PhotoPicker.open(this, PICK_IMAGE_REQUEST, remaining); }
        catch (Exception error) { reportError("无法打开图片选择器", "Cannot open the image picker", error); }
    }

    private void openDocuments() {
        android.content.Intent picker = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
        picker.setType("*/*"); picker.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        picker.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(picker, PICK_DOCUMENT_REQUEST); }
        catch (Exception error) { reportError("无法打开文件选择器", "Cannot open the file picker", error); }
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
        if (request == SCAN_QR_REQUEST) {
            if (result != RESULT_OK || data == null) return;
            String address = data.getStringExtra(QrScanActivity.EXTRA_ADDRESS), code = data.getStringExtra(QrScanActivity.EXTRA_CODE);
            if (address == null || code == null) { setStatusNotice(tr("二维码内容不完整，请在电脑端重新生成。", "The QR code is incomplete. Generate a new one on the computer.")); return; }
            try { applyScannedPairing(address, code); }
            catch (IllegalArgumentException error) { setStatusNotice(tr("二维码内容无效，请在电脑端重新生成。", "Invalid QR code. Generate a new one on the computer.")); }
            return;
        }
        if (request != PICK_IMAGE_REQUEST && request != TAKE_PHOTO_REQUEST && request != PICK_DOCUMENT_REQUEST) return;
        ArrayList<android.net.Uri> uris = new ArrayList<>();
        if (result == RESULT_OK) {
            if (request == TAKE_PHOTO_REQUEST && cameraImageUri != null) uris.add(cameraImageUri);
            else if (data != null && data.getClipData() != null) {
                for (int index = 0; index < data.getClipData().getItemCount(); index++) uris.add(data.getClipData().getItemAt(index).getUri());
            } else if (data != null && data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) { if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); return; }
        if (loadingImages || selectedImages.size() + selectedDocuments.size() + uris.size() > ChatAttachments.remoteCount(canAttachments, canFileAttachments, canMultiImage)) {
            setStatusNotice(canAttachments ? tr("最多添加 20 个附件。", "Add up to 20 attachments.") : tr("更多附件需要更新并重启电脑端。", "More attachments require an updated and restarted desktop."));
            if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); return;
        }
        String target = imageConversation, computer = imageComputer;
        boolean expanded = canAttachments, files = canFileAttachments, multiImage = canMultiImage;
        ArrayList<String> existingImages = new ArrayList<>(selectedImages);
        ArrayList<JSONObject> existingDocuments = new ArrayList<>(selectedDocuments);
        loadingImages = true; updateControls();
        worker.submit(() -> {
            ArrayList<String> encodedImages = new ArrayList<>();
            ArrayList<JSONObject> documents = new ArrayList<>();
            AttachmentMaintenance.Lease imported = AttachmentMaintenance.protect(this);
            String problem = null;
            try (AttachmentMaintenance.Import scope = imported.captureImports()) {
                for (android.net.Uri uri : uris) {
                    if (request == PICK_DOCUMENT_REQUEST && !String.valueOf(getContentResolver().getType(uri)).startsWith("image/")) documents.add(ChatDocument.read(this, uri, false));
                    else encodedImages.add(ChatImage.encode(this, uri, ChatImage.DESKTOP_MAX_SIDE, ChatImage.DESKTOP_MAX_BYTES));
                }
                existingImages.addAll(encodedImages); existingDocuments.addAll(documents);
                ChatAttachments.validateRemote(this, existingImages, existingDocuments, expanded, files, multiImage);
                runOnUiThread(() -> { try {
                    if (isDestroyed() || !screen.equals("detail") || !java.util.Objects.equals(target, conversationId) || !computer.equals(credentials.optString("address"))) { ChatAttachments.discard(this, encodedImages, documents); return; }
                    selectedImages.addAll(encodedImages); selectedDocuments.addAll(documents); renderImage(); persistDraft(); updateControls();
                } finally { imported.close(); } });
            } catch (Exception error) { ChatAttachments.discard(this, encodedImages, documents); imported.close(); problem = ErrorDetails.withSummary(tr("无法添加附件。", "Cannot add attachment."), error); }
            finally { String failure = problem; runOnUiThread(() -> {
                loadingImages = false; if (request == TAKE_PHOTO_REQUEST) clearCameraImage();
                if (!isDestroyed() && screen.equals("detail")) {
                    updateControls(); if (failure != null && java.util.Objects.equals(target, conversationId) && java.util.Objects.equals(computer, credentials.optString("address"))) setStatusError(failure);
                }
            }); }
        });
    }

    private void clearCameraImage() {
        if (cameraImageFile != null) cameraImageFile.delete();
        cameraImageFile = null; cameraImageUri = null;
    }

    private void renderImage() {
        if (!java.util.Objects.equals(imageConversation, conversationId) || !java.util.Objects.equals(imageComputer, credentials.optString("address"))) { selectedImages.clear(); selectedDocuments.clear(); }
        composerAttachments.replace(selectedImages, selectedDocuments);
        if (imageTray == null) return;
        imageStrip.setVisibility(selectedImages.isEmpty() && selectedDocuments.isEmpty() ? View.GONE : View.VISIBLE);
        ChatImageTray.fill(this, imageTray, selectedImages, surface, chinese,
            index -> { selectedImages.remove(index); renderImage(); persistDraft(); updateControls(); });
        ChatDocumentTray.append(this, imageTray, selectedDocuments, chinese,
            index -> { selectedDocuments.remove(index); renderImage(); persistDraft(); updateControls(); });
    }

    private void watchList(RemoteApi client, int ticket) {
        listConnected();
        if (foreground && credentials.has("pendingCreate") && !commandBusy) {
            listCommandDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
            retryCreate(false);
        }
        if (listEventsUnavailable) {
            setStatusNotice(tr("已连接，定时刷新列表。更新并重启电脑端可启用实时同步。", "Connected; refreshing periodically. Update and restart the desktop for live sync."));
            handler.postDelayed(() -> {
                if (networkActive() && ticket == generation && screen.equals("list")) loadList(false);
            }, 15_000);
        } else {
            streamList(client, ticket, 0);
        }
    }

    private void streamList(RemoteApi client, int ticket, int attempt) {
        if (!networkActive() || ticket != generation || !screen.equals("list")) return;
        String token = credentials.optString("token");
        int limit = Math.max(100, conversations.size());
        long syncedCursor = listCursor;
        String syncedInstance = listInstance;
        job = eventWorker.submit(() -> {
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
                        deliver(ticket, () -> listConnected());
                        return;
                    }
                    received[0] = true;
                    deliver(ticket, () -> scheduleListRefresh(client, ticket, snapshot));
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
                    connected = false;
                    showFailure(error, true); return;
                }
                connectionFailure(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                long delay = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : Math.min(30_000, 1000L << nextAttempt);
                handler.postDelayed(() -> streamList(client, ticket, nextAttempt), delay);
            });
        });
    }

    private void scheduleListRefresh(RemoteApi client, int ticket, JSONObject snapshot) {
        if (ticket != generation || !screen.equals("list")) return;
        JSONObject page = snapshot.optJSONObject("conversationList");
        notifyConversationPage(page);
        JSONArray rows = page == null ? null : page.optJSONArray("conversations");
        boolean searching = searchInput != null && !searchInput.getText().toString().trim().isEmpty();
        if (!listRefreshBusy && rows != null && !searching
                && (page.optInt("nextOffset", -1) < 0 || rows.length() >= conversations.size())) {
            listRefreshSnapshot = null;
            updateCapabilities(page);
            listCursor = page.optLong("cursor", -1);
            remoteListQuery = "";
            applyConversationPage(page, false);
            cacheConversations();
            listConnected();
            return;
        }
        listRefreshSnapshot = snapshot;
        if (!listRefreshBusy) {
            listRefreshBusy = true;
            handler.postDelayed(() -> refreshListFromEvents(client, ticket), 250);
        }
    }

    private void refreshListFromEvents(RemoteApi client, int ticket) {
        if (ticket != generation || !networkActive() || !screen.equals("list")) return;
        JSONObject trigger = listRefreshSnapshot; listRefreshSnapshot = null;
        if (trigger == null) { listRefreshBusy = false; return; }
        String token = credentials.optString("token"); int limit = Math.max(100, conversations.size());
        String query = searchInput == null ? "" : searchInput.getText().toString().trim().toLowerCase(Locale.ROOT);
        boolean modern = canListQuery && capabilityAddress.equals(credentials.optString("address"));
        listRefreshJob = worker.submit(() -> {
            try {
                JSONArray entries = new JSONArray(); int offset = 0; JSONObject page, info = null;
                do {
                    if (Thread.currentThread().isInterrupted() || ticket != generation) return;
                    page = client.json(conversationListPath(offset, Math.min(1000, limit), query, modern), token, null);
                    if (info == null) info = listInfo(client, token, page);
                    JSONArray rows = page.optJSONArray("conversations");
                    for (int index = 0; rows != null && index < rows.length(); index++) entries.put(rows.optJSONObject(index));
                    offset = page.optInt("nextOffset", -1);
                } while (offset >= 0 && entries.length() < limit);
                page.put("conversations", entries); JSONObject updated = page, updatedInfo = info;
                deliver(ticket, () -> {
                    updateCapabilities(updatedInfo); listCursor = updated.optLong("cursor", trigger.optLong("cursor", -1));
                    remoteListQuery = modern ? updated.optString("query") : "";
                    applyConversationPage(updated, false); cacheConversations();
                    computerStates.put(credentials.optString("address"), tr("已连接", "Connected")); listConnected();
                    listRefreshBusy = false;
                    if (listRefreshSnapshot != null) scheduleListRefresh(client, ticket, listRefreshSnapshot);
                });
            } catch (Exception error) { deliver(ticket, () -> {
                listRefreshBusy = false; showFailure(error, true);
                if (!(error instanceof RemoteApi.Failure) || ((RemoteApi.Failure) error).status == 429 || ((RemoteApi.Failure) error).status >= 500) {
                    if (listRefreshSnapshot == null) listRefreshSnapshot = trigger;
                    listRefreshBusy = true;
                    handler.postDelayed(() -> refreshListFromEvents(client, ticket), error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : 3000);
                }
            }); }
        });
    }

    private String activity(JSONObject conversation) {
        String activity = conversation.optString("activity", "");
        if (activity.equals("running")) return tr("正在运行", "Running");
        if (activity.equals("permission") || activity.equals("question")) return tr("等待电脑处理", "Waiting for desktop input");
        return RemoteWorkStatus.backgroundUnknown(conversation) ? tr("后台状态未知", "Background status unknown")
            : RemoteWorkStatus.backgroundCount(conversation) > 0 ? tr("后台任务", "Background tasks") : tr("空闲", "Idle");
    }

    private void detailScreen() {
        remoteSubtasks = new JSONArray(); expandedSubtasks.clear();
        initialMessageScroll = true;
        renderedMessages.clear();
        processState.clear();
        screen = "detail"; networkScreen = false;
        stopNetwork(); clearHistory(); instance = ""; cursor = -1; nextBefore = null; lastLive = null; olderLoading = false; editingSeq = -1;
        remoteSettings = null;
        remotePreparation = null;
        remoteCompaction = null;
        remoteGoal = null; remoteTasks = new JSONArray();
        remoteQueue = new JSONArray(); canQueue = false; queueVersion = -1; queueSignature = ""; queueSteeringGoalId = "";
        displayedConversation = null;
        outgoingMessage = pendingCommand();
        if (outgoingMessage != null && !conversationId.equals(outgoingMessage.optString("conversationId"))) outgoingMessage = null;
        if (outgoingMessage != null) {
            try { outgoingMessage = new JSONObject(outgoingMessage.toString())
                .put("delivery", outgoingMessage.optBoolean("uncertain") ? "unconfirmed" : "preparing"); }
            catch (Exception ignored) { outgoingMessage = null; }
        }
        buildDetailContent(false);
    }

    private void buildDetailContent(boolean preserveLiveState) {
        shell(conversationTitle, tr("电脑执行 · 手机查看", "Runs on your computer · Read on your phone"));
        ((ChatScrollView) scroll).setFollowBottomOnLayout(true);
        root.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        older = button(tr("加载更早消息", "Load earlier messages"), this::loadOlder, false); older.setEnabled(false);
        older.setVisibility(View.GONE);
        older.setBackgroundColor(Color.TRANSPARENT); older.setTextSize(Palette.TEXT_SMALL); content.addView(older);
        remoteEmptyState = new ChatEmptyState(this, chatStyle, "brand", tr("从这里开始", "Start here"),
            tr("描述任务，继续电脑上的工作。", "Describe a task to continue on this computer."));
        remoteEmptyState.setVisibility(View.GONE); content.addView(remoteEmptyState);
        messages = column(); content.addView(messages);
        workInline = column(); workInline.setVisibility(View.GONE); content.addView(workInline);
        approvals = column(); workInline.addView(approvals); approvalSignature = "";
        // Goal and scheduled-task state sits directly above the composer, where
        // it is visible while typing but never covers the transcript.
        automationBar = column(); automationBar.setTag("remoteAutomation");
        automationBar.setVisibility(View.GONE); workInline.addView(automationBar);
        LinearLayout composerBar = bottomBar("composerBar");
        boolean stackBackgroundControls = getResources().getConfiguration().screenWidthDp < 360 || getResources().getConfiguration().fontScale > 1.15f;
        backgroundWorkBar = new LinearLayout(this); backgroundWorkBar.setOrientation(stackBackgroundControls ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
        backgroundWorkBar.setGravity(Gravity.CENTER_VERTICAL); backgroundWorkBar.setPadding(dp(12), dp(4), dp(12), dp(4));
        backgroundWorkBar.setBackground(rounded(surface)); backgroundWorkBar.setTag("remoteBackgroundWork");
        backgroundWorkBar.setVisibility(View.GONE);
        backgroundWorkLabel = text("", Palette.TEXT_NOTE, muted);
        backgroundWorkLabel.setPadding(0, 0, dp(8), 0);
        backgroundWorkLabel.setMaxLines(2); backgroundWorkLabel.setEllipsize(android.text.TextUtils.TruncateAt.END);
        backgroundWorkBar.addView(backgroundWorkLabel, new LinearLayout.LayoutParams(stackBackgroundControls ? -1 : 0, -2, stackBackgroundControls ? 0 : 1));
        backgroundWorkStop = text(tr("停止后台任务", "Stop background tasks"), Palette.TEXT_NOTE, ink);
        backgroundWorkStop.setTag("remoteBackgroundStop"); backgroundWorkStop.setGravity(Gravity.CENTER);
        backgroundWorkStop.setMinHeight(dp(48)); backgroundWorkStop.setPadding(dp(12), 0, dp(12), 0);
        GradientDrawable stopFace = chatStyle.capsule(Color.argb(16, Color.red(Palette.of(this).error),
            Color.green(Palette.of(this).error), Color.blue(Palette.of(this).error)));
        backgroundWorkStop.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
            stopFace, capsule(Color.WHITE)));
        backgroundWorkStop.setTextColor(Palette.of(this).error);
        backgroundWorkStop.setFocusable(true);
        backgroundWorkStop.setContentDescription(tr("停止后台任务", "Stop background tasks"));
        backgroundWorkStop.setOnClickListener(view -> stopBackgroundWork());
        LinearLayout.LayoutParams stopBackgroundParams = new LinearLayout.LayoutParams(-2, -2); stopBackgroundParams.gravity = Gravity.END;
        backgroundWorkBar.addView(backgroundWorkStop, stopBackgroundParams);
        LinearLayout.LayoutParams backgroundParams = new LinearLayout.LayoutParams(-1, -2); backgroundParams.setMargins(0, 0, 0, dp(6));
        workInline.addView(backgroundWorkBar, backgroundParams);
        workSummaryBar = text("", Palette.TEXT_SMALL, muted);
        workSummaryBar.setTag("remoteWorkSummary");
        workSummaryBar.setGravity(Gravity.CENTER_VERTICAL);
        workSummaryBar.setSingleLine(true);
        workSummaryBar.setEllipsize(android.text.TextUtils.TruncateAt.END);
        workSummaryBar.setMinHeight(dp(48));
        workSummaryBar.setPadding(dp(12), 0, dp(10), 0);
        workSummaryBar.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
            capsule(Palette.of(this).controlFill), capsule(Color.WHITE)));
        workSummaryBar.setFocusable(true);
        workSummaryBar.setVisibility(View.GONE);
        workSummaryBar.setOnClickListener(view -> showWorkSheet());
        LinearLayout.LayoutParams summaryParams = new LinearLayout.LayoutParams(-2, -2);
        summaryParams.gravity = Gravity.START;
        summaryParams.setMargins(0, 0, 0, dp(4));
        LinearLayout dock = (LinearLayout) composerBar.getParent();
        dock.addView(workSummaryBar, dock.indexOfChild(composerBar), summaryParams);
        queueBar = column(); queueBar.setTag("remoteMessageQueue");
        queueBar.setVisibility(View.GONE);
        LinearLayout.LayoutParams queueParams = new LinearLayout.LayoutParams(-1, -2);
        dock.addView(queueBar, dock.indexOfChild(composerBar), queueParams);
        chatComposer = new ChatComposer(composerBar, chatStyle, chinese, tr("发消息，继续任务…", "Message your computer…"), 16000,
            () -> showRemoteSettings(false), this::sendMessage, this::stopRun, this::cancelEdit);
        composer = chatComposer.input; composer.setTag("remoteComposer");
        modelButton = chatComposer.model; modelButton.setTag("remoteModelPicker");
        sendButton = chatComposer.send; stopButton = chatComposer.stop;
        sendButton.setTag("remoteSend"); stopButton.setTag("remoteStop");
        attachButton = chatStyle.composerToolButton("plus", tr("添加附件", "Add attachments"), accent, this::pickImage); attachButton.setTag("remoteAttach");
        imageStrip = new android.widget.HorizontalScrollView(this); imageStrip.setHorizontalScrollBarEnabled(false);
        imageTray = new LinearLayout(this); imageTray.setOrientation(LinearLayout.HORIZONTAL);
        imageStrip.addView(imageTray); composerBar.addView(imageStrip, 0, new LinearLayout.LayoutParams(-1, -2)); renderImage();
        chatComposer.addTool(attachButton);
        boolean expandedPermission = MobileLayout.useExpandedComposerControls(getResources().getConfiguration());
        permissionButton = new PermissionTool(this, chatStyle, chinese, expandedPermission,
            () -> showRemoteSettings(true));
        permissionButton.setTag("remotePermissionPicker");
        chatComposer.addTool(permissionButton, expandedPermission ? -2 : 48);
        composer.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                updateControls();
            }
            @Override public void afterTextChanged(android.text.Editable text) {}
        });
        String draft = savedDraft();
        JSONObject attachmentDrafts = credentials.optJSONObject("draftAttachments");
        JSONObject attachmentDraft = attachmentDrafts == null ? null : attachmentDrafts.optJSONObject(conversationId);
        if (attachmentDraft != null && outgoingMessage == null) {
            try { ChatAttachments.restore(attachmentDraft, selectedImages, selectedDocuments); }
            catch (Exception error) { reportError("无法恢复附件草稿", "Cannot restore attachment draft", error); }
            imageConversation = conversationId; imageComputer = credentials.optString("address"); renderImage();
        }
        if (!draft.isEmpty() || savedDraftEdit() > 0) {
            composer.setText(draft); composer.setSelection(composer.length());
            long edit = savedDraftEdit();
            if (edit > 0) editingSeq = edit;
        }
        renderMessages(preserveLiveState ? lastLive : null);
        if (preserveLiveState) renderAutomationViews();
        if (!preserveLiveState) showPrefetchedConversation();
        updateControls();
        // The background list stream supplies the fresh sidebar. Starting a
        // separate pull here would immediately be invalidated by connectEvents.
    }

    private void rebuildDetailForConfiguration() {
        persistDraft();
        boolean stayAtBottom = scroll != null && scroll.getChildCount() > 0
            && scroll.getChildAt(0).getHeight() - scroll.getHeight() - scroll.getScrollY() < dp(120);
        int previousScroll = scroll == null ? 0 : scroll.getScrollY();
        initialMessageScroll = false;
        buildDetailContent(true);
        positionMessages(stayAtBottom ? Integer.MAX_VALUE : previousScroll);
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
            JSONObject attachmentDrafts = saved.optJSONObject("draftAttachments");
            if (attachmentDrafts == null) attachmentDrafts = new JSONObject();
            if (selectedImages.isEmpty() && selectedDocuments.isEmpty()) attachmentDrafts.remove(conversationId);
            else if (java.util.Objects.equals(imageConversation, conversationId)) attachmentDrafts.put(conversationId,
                new JSONObject().put("attachments", ChatAttachments.remote(selectedImages, selectedDocuments)));
            saved.put("draftAttachments", attachmentDrafts);
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
            if (row != null) retainHistory(row.optLong("seq"), row);
        }
        connected = false; controlAllowed = false; lastLive = null; remoteSettings = null;
        trimHistory(false); renderMessages(null);
        updateWorkStatus();
    }

    private void connectEvents() {
        if (!networkActive()) return;
        RemoteApi client = begin(); int ticket = generation;
        startConversationSync();
        updateWorkStatus();
        String token = credentials.optString("token");
        if (capabilityAddress.equals(credentials.optString("address")) && capabilityToken.equals(token)) {
            // Capabilities only select the wire format. Fresh permission and
            // command state still come from the initial conversation snapshot.
            client.incremental(canIncremental);
            stream(client, ticket, 0);
            return;
        }
        // Optional capability discovery must not gate the first transcript.
        // Clear another computer's flags; the legacy stream is always valid.
        updateCapabilities(new JSONObject()); capabilityAddress = ""; capabilityToken = "";
        statusWorker.submit(() -> {
            if (ticket != generation) return;
            try {
                JSONObject info = client.json("/v1/status", token, null);
                deliver(ticket, () -> { updateCapabilities(info); client.incremental(canIncremental); updateControls(); });
            } catch (Exception ignored) { /* The stream reports connection and authorization failures. */ }
        });
        stream(client, ticket, 0);
    }

    private void startConversationSync() {
        if (!networkActive() || !EmbeddedNetwork.online() || !credentials.has("token")
                || !(screen.equals("home") || screen.equals("detail"))) return;
        int ticket = generation;
        JSONObject target;
        try { target = new JSONObject(credentials.toString()); }
        catch (Exception error) { return; }
        conversationSync.start(target.optString("address"), target.optString("token"), page -> deliver(ticket, () -> {
            if (listCache == null || !(screen.equals("home") || screen.equals("detail"))) return;
            JSONArray rows = page.optJSONArray("conversations");
            if (rows == null) return;
            if (page.optInt("protocol") == 1) updateCapabilities(page);
            notifyConversationPage(page);
            conversationListRevision++;
            JSONObject cached = listCache.get(target);
            JSONArray workspaces = page.optJSONArray("workspaces");
            if (workspaces == null) workspaces = cached == null ? new JSONArray() : cached.optJSONArray("workspaces");
            boolean independent = page.has("includeUnassigned") ? page.optBoolean("includeUnassigned")
                : cached != null && cached.optBoolean("includeUnassigned");
            listCache.put(target, rows, page.optInt("nextOffset", -1), workspaces, independent);
            JSONObject updated = listCache.get(target);
            if (cached != null && updated != null && cached.toString().equals(updated.toString())) return;
            if (screen.equals("home")) {
                refreshHomeContent();
            } else if (detailSidebar != null) detailSidebar.update(detailSidebarItems());
        }));
    }

    private void notifyConversationPage(JSONObject page) {
        JSONArray rows = page == null ? null : page.optJSONArray("conversations");
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i); if (row == null) continue;
            // The detail stream supplies terminal state and approvals for the open chat.
            if (screen.equals("detail") && row.optString("id").equals(conversationId)) continue;
            chatNotifications.conversation(this, credentials, page.optString("instanceId", screen.equals("list") ? listInstance : instance), row, null, null, false);
        }
    }

    private void stream(RemoteApi client, int ticket, int attempt) {
        if (!networkActive() || ticket != generation) return;
        replyReadSync.retry();
        String id = conversationId, token = credentials.optString("token");
        RemoteStreamHealth health = new RemoteStreamHealth(android.os.SystemClock.elapsedRealtime());
        streamHealth = health;
        inspectStream();
        job = eventWorker.submit(() -> {
            boolean[] received = { false };
            Exception failure = null;
            try {
                client.events(id, token, snapshot -> {
                    JSONObject conversation = snapshot.optJSONObject("conversation");
                    if (conversation == null || !id.equals(conversation.optString("id"))
                            || !received[0] && snapshot.optJSONArray("messages") == null) throw new IOException("Invalid snapshot");
                    received[0] = true;
                    queueSnapshot(ticket, snapshot);
                }, () -> health.heartbeat(android.os.SystemClock.elapsedRealtime()));
            } catch (Exception error) { failure = error; }
            final Exception error = failure;
            int nextAttempt = received[0] ? 0 : Math.min(attempt + 1, 5);
            deliver(ticket, () -> {
                if (streamHealth != health) return;
                streamHealth = null; handler.removeCallbacks(inspectStream);
                if (!received[0] && error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 400 && client.incremental()) {
                    // The desktop may have been downgraded since the cached
                    // capability was read. Retry the legacy stream once.
                    client.incremental(false); canIncremental = false; capabilityAddress = ""; capabilityToken = "";
                    stream(client, ticket, 0);
                    return;
                }
                if (error instanceof RemoteApi.Failure && (((RemoteApi.Failure) error).status == 401 || ((RemoteApi.Failure) error).status == 403 || ((RemoteApi.Failure) error).status == 404)) {
                    connected = false; updateControls();
                    showFailure(error, true); return;
                }
                connectionFailure(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                long delay = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : Math.min(30_000, 1000L << nextAttempt);
                handler.postDelayed(() -> stream(client, ticket, nextAttempt), delay);
            });
        });
    }

    private void inspectStream() {
        handler.removeCallbacks(inspectStream);
        if (!networkActive() || !screen.equals("detail") || streamHealth == null) return;
        long remaining = streamHealth.remaining(android.os.SystemClock.elapsedRealtime());
        if (remaining > 0) { handler.postDelayed(inspectStream, remaining); return; }
        boolean synced = streamHealth.synced();
        // Start a new generation so late frames from the stalled stream are
        // ignored and cancellation cannot block the replacement connection.
        connectEvents();
        connectionFailure(synced
            ? tr("实时连接已失去响应，正在重新同步会话。", "The live connection stopped responding. Reconnecting to sync the conversation.")
            : tr("会话同步超时，正在重新连接。请确认电脑保持在线。", "Conversation sync timed out. Reconnecting; check that the computer stays online."));
    }

    private void queueSnapshot(int ticket, JSONObject snapshot) {
        synchronized (this) {
            if (ticket != generation) return;
            // Coalescing must keep the full history page that precedes a delta.
            if (!snapshot.has("messages") && pendingSnapshot != null && pendingSnapshot.has("messages")
                    && snapshot.optString("instanceId").equals(pendingSnapshot.optString("instanceId"))
                    && snapshot.optString("historyVersion").equals(pendingSnapshot.optString("historyVersion"))) {
                try { snapshot.put("messages", pendingSnapshot.getJSONArray("messages")); snapshot.put("nextBefore", pendingSnapshot.opt("nextBefore")); }
                catch (org.json.JSONException error) { throw new IllegalStateException(error); }
            }
            pendingSnapshot = snapshot;
            if (snapshotPosted) return;
            snapshotPosted = true;
        }
        handler.postDelayed(() -> {
            JSONObject latest;
            synchronized (this) {
                // An old worker can post after stopNetwork removes callbacks.
                // It must not consume the replacement generation's first frame.
                if (ticket != generation) return;
                latest = pendingSnapshot; pendingSnapshot = null; snapshotPosted = false;
            }
            if (networkActive() && ticket == generation && latest != null) {
                applySnapshot(latest);
                if (connected && streamHealth != null) streamHealth.snapshot(android.os.SystemClock.elapsedRealtime());
            }
        }, 120);
    }

    private void applySnapshot(JSONObject snapshot) {
        JSONObject conversation = snapshot.optJSONObject("conversation");
        if (conversation == null || !conversation.optString("id").equals(conversationId)) return;
        boolean reconnect = !connected;
        String server = snapshot.optString("instanceId"); long nextCursor = snapshot.optLong("cursor", -1);
        if (server.equals(instance) && nextCursor < cursor) return;
        connected = true; controlAllowed = snapshot.optString("permission").equals("control"); conversationSeq = conversation.optLong("seq");
        prefetch.put(credentials, snapshot);
        if (!server.equals(instance)) { queueVersion = -1; clearSubtasks(); }
        boolean following = !historyDetached && (initialMessageScroll || pendingScrollView == scroll && pendingScrollPosition == Integer.MAX_VALUE
            || scroll.getChildCount() == 0 || scroll.getChildAt(0).getHeight() - scroll.getHeight() - scroll.getScrollY() < dp(120));
        instance = server; cursor = nextCursor;
        if (snapshot.optJSONArray("subagents") != null) remoteSubtasks = snapshot.optJSONArray("subagents");
        if (subtaskPage != null) subtaskPage.update(remoteSubtasks);
        if (subtaskPage != null) following = false;
        conversationTitle = conversation.optString("title", conversationTitle);
        TextView pageTitle = root.findViewWithTag("pageTitle");
        if (pageTitle != null) pageTitle.setText(conversationTitle);
        JSONObject settings = snapshot.optJSONObject("settings");
        if (settingsPopup != null && (settings == null || remoteSettings == null || !settings.optString("version").equals(remoteSettings.optString("version")) || !settings.optBoolean("modelEditable", settings.optBoolean("editable")))) {
            settingsPopup.dismiss(); settingsPopup = null;
        }
        remoteSettings = settings;
        JSONArray rows = snapshot.optJSONArray("messages");
        if (rows != null && !server.equals(historyInstance)) { clearHistory(); historyInstance = server; }
        if (rows != null) historyVersion = snapshot.optString("historyVersion");
        // Live metadata and controls continue updating while the reader browses
        // an older window. A latest-page snapshot must not evict that window.
        if (rows != null && !historyDetached) {
        long first = rows.length() == 0 ? 0 : rows.optJSONObject(0).optLong("seq");
        // An edited turn returns with a higher seq and takes its superseded rows
        // with it, so cached rows below a snapshot that begins the conversation
        // were replaced on the computer and leave this transcript too. A desktop
        // that does not report paging is treated as still holding earlier pages.
        boolean olderAvailable = !snapshot.has("nextBefore") || !snapshot.isNull("nextBefore");
        for (long seq : RemoteTranscript.superseded(history.keySet(), first, olderAvailable, false)) {
            JSONObject removed = history.remove(seq);
            if (removed != null) historyBytes -= historyRowBytes(removed);
        }
        if (historyBytes < 0) historyBytes = 0;
        forgetHistoryFrom(first);
        for (int index = 0; index < rows.length(); index++) { JSONObject row = rows.optJSONObject(index); if (row != null) retainHistory(row.optLong("seq"), row); }
        if (history.isEmpty() || history.firstKey() >= first) nextBefore = snapshot.isNull("nextBefore") ? null : snapshot.optLong("nextBefore");
        trimHistory(false);
        }
        lastLive = snapshot.optJSONObject("live");
        remotePreparation = snapshot.optJSONObject("preparation");
        remoteCompaction = ContextCompactionView.fromSnapshot(snapshot, remoteCompaction, conversationSeq);
        displayedConversation = conversation;
        chatNotifications.conversation(this, credentials, instance, conversation, lastLive, rows,
            foreground && screen.equals("detail") && hasWindowFocus());
        canQueue = snapshot.has("queue");
        JSONObject queueSteering = snapshot.optJSONObject("queueSteering");
        queueSteeringGoalId = queueSteering == null ? "" : queueSteering.optString("goalId");
        if (!canQueue) remoteQueue = new JSONArray();
        applyQueue(snapshot);
        renderMessages(lastLive);
        renderAutomation(snapshot);
        if (foreground && snapshot.optJSONArray("messages") != null && snapshot.optJSONArray("messages").length() > 0) replies().markRead(credentials, conversation);
        syncReplyRead(conversation);
        renderApprovals(); updateControls();
        updateOlderControl();
        if (following && (!olderLoading || olderAutomatic)) positionMessages(Integer.MAX_VALUE);
        if (reconnect && foreground) {
            commandCheckDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
            if (pendingCommand() != null) retryCommand(false);
            JSONObject stop = RemotePendingCommands.get(credentials, conversationId, true);
            if (stop != null) retryPendingCommand(stop, false, true);
        }
        scheduleAutomaticHistory();
    }

    private void syncReplyRead(JSONObject conversation) {
        long reply = conversation.optLong("lastReplyAt", 0);
        if (!foreground || api == null || !conversation.has("replyReadAt") || reply <= 0) return;
        String target = conversation.optString("id");
        RemoteReadSync.Request request = replyReadSync.observe(replyReadScope(target), reply, conversation.optLong("replyReadAt", 0));
        sendReplyRead(request, api, credentials.optString("token"), target, generation);
    }

    private String replyReadScope(String target) {
        return new JSONArray().put(credentials.optString("address")).put(credentials.optString("token")).put(instance).put(target).toString();
    }

    private void sendReplyRead(RemoteReadSync.Request request, RemoteApi client, String token, String target, int ticket) {
        if (request == null) return;
        statusWorker.submit(() -> {
            if (ticket != generation) return;
            try {
                JSONObject result = client.json("/v1/conversations/" + target + "/read", token, new JSONObject().put("lastReplyAt", request.at));
                long confirmed = result.getLong("replyReadAt");
                if (!result.optBoolean("ok") || confirmed < 0) throw new java.io.IOException("Invalid reply-read acknowledgement");
                deliver(ticket, () -> {
                    if (api != client || !target.equals(conversationId) || !request.scope.equals(replyReadScope(target)) || !replyReadSync.acknowledge(request, confirmed)) return;
                    if (!replyReadError.isEmpty() && status != null && replyReadError.contentEquals(status.getText())) {
                        if (workStatus != null) workStatus.clear(); else status.setText("");
                        updateWorkStatus();
                    }
                    replyReadError = "";
                    if (foreground) sendReplyRead(replyReadSync.next(), client, token, target, ticket);
                });
            } catch (Exception error) {
                deliver(ticket, () -> {
                    if (api != client || !target.equals(conversationId) || !request.scope.equals(replyReadScope(target)) || !replyReadSync.failed(request)) return;
                    replyReadError = ErrorDetails.withSummary(tr("已读状态未同步，刷新或重新连接后会重试。", "Read status was not synced. Refresh or reconnect to retry.") + " " + RemoteApi.failureMessage(error, chinese), error);
                    setStatusNotice(replyReadError);
                });
            }
        });
    }

    private void renderMessages(JSONObject live) {
        if (historyDetached) live = null;
        int position = scroll.getScrollY();
        java.util.HashSet<String> retained = new java.util.HashSet<>();
        JSONArray pendingProcess = new JSONArray();
        JSONArray pendingVisualizations = new JSONArray();
        long turn = 0;
        pendingMessageViews.clear();
        java.util.Set<Long> earlierSubtaskTurns = new java.util.TreeSet<>();
        for (int i = 0; !historyDetached && i < remoteSubtasks.length(); i++) {
            JSONObject task = remoteSubtasks.optJSONObject(i); if (task == null || history.containsKey(task.optLong("userSeq"))) continue;
            if (java.util.Set.of("starting", "running", "waiting").contains(task.optString("status")) || task.optInt("pendingApprovals") > 0 || task.optBoolean("canReply")) earlierSubtaskTurns.add(task.optLong("userSeq"));
        }
        for (long userSeq : earlierSubtaskTurns) addSubtasks(userSeq, retained);
        boolean showCompaction = !historyDetached && remoteCompaction != null && !history.containsKey(remoteCompaction.optLong("seq", -1));
        long compactionBoundary = remoteCompaction == null ? Long.MAX_VALUE : remoteCompaction.optLong("afterSeq", conversationSeq);
        for (JSONObject row : history.values()) {
            if (showCompaction && row.optLong("seq") > compactionBoundary) {
                retained.add("compaction:live"); addCompaction("compaction:live", remoteCompaction); showCompaction = false;
            }
            String role = row.optString("role");
            if (role.equals("user")) {
                pendingProcess = new JSONArray(); pendingVisualizations = new JSONArray(); turn = row.optLong("seq");
            }
            if (role.equals("tool")) {
                JSONArray process = row.optJSONArray("process");
                if (process != null) for (int index = 0; index < process.length(); index++) pendingProcess.put(process.opt(index));
                JSONArray visualizations = row.optJSONArray("visualizations");
                if (visualizations != null) for (int index = 0; index < visualizations.length(); index++) pendingVisualizations.put(visualizations.opt(index));
                continue;
            }
            String label = role.equals("user") ? tr("你", "You") : role.equals("assistant") ? "Camellia" : tr("提示", "Notice");
            String key = "message:" + row.optLong("seq"); retained.add(key);
            JSONObject compaction = ContextCompactionView.fromMessage(row);
            if (compaction != null) { addCompaction(key, compaction); continue; }
            JSONArray process = row.optJSONArray("process");
            if (role.equals("assistant") && (process == null || process.length() == 0)) process = pendingProcess;
            JSONArray visualizations = row.optJSONArray("visualizations");
            if (role.equals("assistant") && (visualizations == null || visualizations.length() == 0)) visualizations = pendingVisualizations;
            addMessage(key, label, row.optString("text"), role.equals("user"), row.optBoolean("textTruncated"), process, false,
                "turn:" + turn, row.optLong("at"), row.optLong("seq"), row.optJSONObject("turnDetails"),
                row.optJSONArray("attachedFiles"), visualizations);
            if (role.equals("user")) addSubtasks(turn, retained);
            if (role.equals("assistant")) { pendingProcess = new JSONArray(); pendingVisualizations = new JSONArray(); }
        }
        if (showCompaction) { retained.add("compaction:live"); addCompaction("compaction:live", remoteCompaction); }
        if (live != null) {
            retained.add("live");
            JSONArray process = live.optJSONArray("process");
            if (process == null || process.length() == 0) process = pendingProcess;
            addMessage("live", tr("正在回复", "Reply in progress"), live.optString("text"), false, live.optBoolean("textTruncated"), process, true, "turn:" + live.optLong("userSeq", turn), live.optLong("startedAt"), 0);
            if (live.optInt("pendingApprovals") > 0 && !controlAllowed) pendingMessageViews.add(text(tr("有待处理授权，请回到电脑处理。", "Approval is pending. Respond on the computer."), Palette.TEXT_NOTE, accent));
        } else if (pendingProcess.length() > 0) {
            retained.add("pendingProcess");
            addMessage("pendingProcess", "", "", false, false, pendingProcess, false, "turn:" + turn, 0, 0,
                null, null, pendingVisualizations);
        }
        if (!historyDetached) renderOutgoing(retained);
        java.util.Iterator<java.util.Map.Entry<String, ReplyMessage>> replies = replyMessages.entrySet().iterator();
        while (replies.hasNext()) {
            java.util.Map.Entry<String, ReplyMessage> entry = replies.next();
            if (retained.contains(entry.getKey())) continue;
            entry.getValue().body.dispose(); replies.remove();
        }
        renderedText.keySet().retainAll(retained);
        renderedMessages.keySet().retainAll(retained);
        MessageViews.reconcile(messages, pendingMessageViews);
        pendingMessageViews.clear();
        boolean empty = displayedConversation != null && messages.getChildCount() == 0;
        if (remoteEmptyState != null) remoteEmptyState.setVisibility(empty ? View.VISIBLE : View.GONE);
        content.setGravity(empty ? Gravity.CENTER_VERTICAL : Gravity.TOP);
        if (initialMessageScroll && messages.getChildCount() > 0) {
            initialMessageScroll = false;
            positionMessages(Integer.MAX_VALUE);
        } else {
            ScrollView target = scroll;
            long revision = messageScrollRevision;
            boolean restoring = pendingScrollView != target;
            viewHandler.post(() -> {
                if (restoring && revision == messageScrollRevision && scroll == target && pendingScrollView != target) target.scrollTo(0, position);
            });
        }
    }

    private void positionMessages(int position) {
        positionMessages(position, null);
    }

    private void positionMessages(int position, View anchor) {
        clearMessageScroll();
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
                    if (anchor != null) destination = anchor.getParent() == messages
                        ? messages.getTop() + anchor.getTop() + position : target.getChildAt(0).getHeight();
                    target.scrollTo(0, destination);
                }
                return true;
            }
        };
        target.getViewTreeObserver().addOnPreDrawListener(pendingMessageScroll);
        target.invalidate();
    }
    private void addSubtasks(long userSeq, java.util.Set<String> retained) {
        JSONArray children = new JSONArray(); boolean active = false; int attention = 0;
        for (int i = 0; i < remoteSubtasks.length(); i++) {
            JSONObject task = remoteSubtasks.optJSONObject(i); if (task == null || task.optLong("userSeq") != userSeq) continue;
            children.put(task); String state = task.optString("status"); active |= java.util.Set.of("starting", "running", "waiting").contains(state);
            if (state.equals("waiting") || task.optInt("pendingApprovals") > 0) attention++;
        }
        if (children.length() == 0) return;
        boolean expanded = expandedSubtasks.getOrDefault(userSeq, active); String key = "subtasks:" + userSeq;
        boolean earlierTurn = !history.containsKey(userSeq);
        retained.add(key); String signature = children.toString() + expanded + earlierTurn;
        View existing = renderedMessages.get(key);
        if (existing != null && signature.equals(existing.getTag())) { pendingMessageViews.add(existing); return; }
        LinearLayout card = column(); card.setPadding(dp(12), dp(6), dp(12), dp(6)); card.setBackground(chatStyle.rounded(surface));
        if (earlierTurn) card.addView(text(tr("更早轮次的子任务", "Subtasks from an earlier turn"), Palette.TEXT_NOTE, muted));
        Button summary = button(tr("子任务", "Subtasks") + " · " + children.length() + (attention > 0 ? tr(" · 待处理 ", " · Needs attention ") + attention : ""), () -> { expandedSubtasks.put(userSeq, !expanded); renderMessages(lastLive); }, false);
        card.addView(summary);
        if (expanded) {
            for (int i = 0; i < Math.min(children.length(), 3); i++) {
                JSONObject task = children.optJSONObject(i); Button row = button(task.optString("title") + " · " + SubtaskPage.state(task.optString("status"), chinese), () -> openSubtask(userSeq, SubtaskPage.identity(task)), false); card.addView(row);
                TextView progress = text(task.optString("progress"), Palette.TEXT_NOTE, muted); progress.setMaxLines(2); card.addView(progress);
            }
            card.addView(button(tr("查看全部子任务", "View all subtasks"), () -> openSubtask(userSeq, null), false));
        }
        card.setTag(signature); renderedMessages.put(key, card); pendingMessageViews.add(card);
    }
    private void openSubtask(long userSeq, String taskId) {
        if (subtaskPage != null) subtaskPage.dismiss();
        subtaskPage = new SubtaskPage(this, chinese, userSeq, taskId, (task, operation, extra) -> {
            if (!connected || !controlAllowed || commandBusy || pendingCommand() != null) throw new IllegalStateException(tr("请等待连接或操作完成", "Wait for connection or the current operation"));
            JSONObject payload = command("subagent-command").put("taskId", task.getString("id")).put("engine", task.getString("engine")).put("operation", operation).put("expectedTurnId", task.optString("turnId"));
            for (java.util.Iterator<String> keys = extra.keys(); keys.hasNext();) { String key = keys.next(); payload.put(key, extra.get(key)); }
            submitCommand(payload);
        });
        subtaskPage.setOnDismissListener(dialog -> { if (subtaskPage == dialog) subtaskPage = null; });
        subtaskPage.update(remoteSubtasks);
        subtaskPage.setControlAvailable(connected && controlAllowed && !commandBusy && pendingCommand() == null);
        subtaskPage.show();
    }

    private void clearSubtasks() {
        remoteSubtasks = new JSONArray(); expandedSubtasks.clear();
        if (subtaskPage != null) { SubtaskPage page = subtaskPage; subtaskPage = null; page.dismiss(); }
    }

    private void clearUnavailableDetail() {
        connected = false; controlAllowed = false; clearSubtasks(); clearHistory();
        lastLive = null; remotePreparation = null; remoteSettings = null;
        remoteQueue = new JSONArray(); canQueue = false; queueVersion = -1; queueSteeringGoalId = "";
        if (messages != null) messages.removeAllViews();
        renderApprovals(); renderAutomation(new JSONObject()); updateControls();
    }

    private void clearMessageScroll() {
        messageScrollRevision++;
        if (pendingScrollView != null && pendingMessageScroll != null && pendingScrollView.getViewTreeObserver().isAlive()) {
            pendingScrollView.getViewTreeObserver().removeOnPreDrawListener(pendingMessageScroll);
        }
        pendingScrollView = null; pendingMessageScroll = null; pendingScrollPosition = 0;
    }

    private void beginEdit(long seq, String text) {
        if (!screen.equals("detail") || !connected || !controlAllowed || lastLive != null || commandBusy || (pendingCommand() != null) || awaitingSentMessage()) return;
        JSONObject latest = null;
        for (JSONObject row : history.values()) if (row.optString("role").equals("user")) latest = row;
        if (latest == null || latest.optLong("seq") != seq) return;
        editingText = text;
        composer.setText(text); composer.setSelection(composer.length());
        editingSeq = seq;
        composer.requestFocus();
        ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(composer, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        if (workStatus != null) workStatus.clear();
        updateControls();
    }

    private void cancelEdit() {
        if (composer == null || commandBusy || (pendingCommand() != null) || lastLive != null) return;
        locationConsent.cancel();
        editingSeq = -1; editingText = ""; composer.setText("");
        persistDraft(); if (workStatus != null) workStatus.clear(); updateControls();
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
        if (state.equals("unconfirmed") && pendingCommand() == null) { outgoingMessage = null; return; }
        if (synced && !state.equals("failed") && confirmOutgoingFromTranscript(payload)) return;
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
        TextView deliveryText = text(label, Palette.TEXT_SMALL, muted);
        if (state.equals("unconfirmed")) {
            retryMessage = deliveryText;
            retryMessage.setTag("outgoingRetry");
            retryMessage.setMinHeight(dp(48));
            retryMessage.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            retryMessage.setContentDescription(label + tr("（可查询或解除待确认；重试同一请求不会重复执行）", " (check or resolve it; retrying the same request will not execute it twice)"));
            retryMessage.setOnClickListener(view -> retryCommand());
            retryMessage.setEnabled(pendingCommand() != null);
        }
        delivery.addView(deliveryText); pendingMessageViews.add(delivery);
    }

    private boolean confirmOutgoingFromTranscript(JSONObject payload) {
        try {
            JSONObject saved = new JSONObject(credentials.toString());
            JSONObject pending = RemotePendingCommands.find(saved, payload.optString("requestId"));
            if (pending != null) {
                String target = pending.optString("conversationId");
                RemotePendingCommands.remove(saved, payload.optString("requestId"));
                JSONObject drafts = saved.optJSONObject("drafts");
                if (drafts != null && drafts.optString(target).equals(pending.optString("draft", payload.optString("prompt")))) {
                    drafts.remove(target);
                    JSONObject edits = saved.optJSONObject("draftEdits");
                    if (edits != null) edits.remove(target);
                }
                JSONObject files = saved.optJSONObject("draftAttachments");
                if (files != null && AttachmentStore.references(files.optJSONObject(target)).equals(AttachmentStore.references(payload)))
                    files.remove(target);
                store.save(saved);
                credentials = saved;
            }
        } catch (Exception error) {
            reportError("无法保存已确认的发送记录。", "Could not save the confirmed send.", error);
            return false;
        }
        outgoingMessage = null;
        commandBusy = false;
        commandCheckDeadline = 0;
        if (workStatus != null) workStatus.clear();
        setStatusNotice(tr("电脑已接收消息", "Message received by the computer"));
        return true;
    }

    private void outgoingState(String state) {
        if (outgoingMessage == null) return;
        try { outgoingMessage.put("delivery", state); } catch (Exception ignored) { }
        renderMessages(lastLive);
    }

    private JSONArray outgoingAttachments(JSONObject payload) {
        if (payload == null) return null;
        JSONArray files = payload.optJSONArray("attachments");
        if (files != null && files.length() > 0) return files;
        JSONArray result = new JSONArray();
        JSONArray images = payload.optJSONArray("images");
        if (images != null) for (int index = 0; index < images.length(); index++) {
            try { result.put(new JSONObject().put("name", "mobile-image-" + (index + 1) + ".jpg")
                .put("isImage", true).put("data", images.optString(index))); }
            catch (Exception ignored) { }
        }
        else if (payload.has("image")) try {
            result.put(new JSONObject().put("name", "mobile-image-1.jpg").put("isImage", true)
                .put("data", payload.optString("image")));
        } catch (Exception ignored) { }
        return result;
    }

    private boolean awaitingSentMessage() {
        return outgoingMessage != null && outgoingMessage.optString("delivery").equals("accepted");
    }

    private final ExecutionProcessView.State processState = new ExecutionProcessView.State();

    private void addCompaction(String key, JSONObject compaction) {
        View existing = renderedMessages.get(key);
        ContextCompactionView view = existing instanceof ContextCompactionView ? (ContextCompactionView) existing
            : new ContextCompactionView(this, chatStyle, chinese);
        view.setTag("remoteCompaction:" + key); view.update(compaction);
        renderedMessages.put(key, view); pendingMessageViews.add(view);
    }

    private void addMessage(String key, String label, String value, boolean user, boolean truncated, JSONArray process, boolean live, String turn, long at, long seq) {
        addMessage(key, label, value, user, truncated, process, live, turn, at, seq, null);
    }
    private void addMessage(String key, String label, String value, boolean user, boolean truncated, JSONArray process, boolean live, String turn, long at, long seq, JSONObject details) {
        JSONArray attachments = key.startsWith("outgoing:") && outgoingMessage != null
            ? outgoingAttachments(outgoingMessage.optJSONObject("payload")) : null;
        addMessage(key, label, value, user, truncated, process, live, turn, at, seq, details, attachments, null);
    }
    private void addMessage(String key, String label, String value, boolean user, boolean truncated, JSONArray process, boolean live, String turn, long at, long seq, JSONObject details, JSONArray attachments) {
        addMessage(key, label, value, user, truncated, process, live, turn, at, seq, details, attachments, null);
    }
    private void addMessage(String key, String label, String value, boolean user, boolean truncated, JSONArray process, boolean live, String turn, long at, long seq, JSONObject details, JSONArray attachments, JSONArray visualizations) {
        if (!user) { addReply(key, value, truncated, process, live, turn, at, seq, label.equals("Camellia"), details, visualizations); return; }
        long latestUserSeq = -1;
        for (JSONObject row : history.values()) if (row.optString("role").equals("user")) latestUserSeq = row.optLong("seq");
        boolean editable = !live && !truncated && seq > 0 && seq == latestUserSeq;
        String signature = label + "\u0000" + user + truncated + live + editable + "\u0000" + at + "\u0000"
            + (attachments == null ? "" : attachments.toString());
        View existing = renderedMessages.get(key);
        if (existing != null && signature.equals(existing.getTag()) && value.equals(renderedText.get(key))) { pendingMessageViews.add(existing); return; }
        LinearLayout block = chatStyle.messageBlock(user);
        View attached = RemoteAttachmentTray.create(this, chatStyle, attachments, seq,
            credentials.optString("address"), credentials.optString("token"), conversationId, chinese);
        if (attached != null) block.addView(attached);
        if (truncated) block.addView(text(tr("内容过长，仅显示末尾片段。", "Long message: showing the final portion."), Palette.TEXT_SMALL, accent));
        TextView body = text(value.isEmpty() ? tr("等待输出…", "Waiting for output…") : value, Palette.TEXT_INPUT, ink);
        body.setTextIsSelectable(true); chatStyle.messageTypography(body); block.addView(body);
        LinearLayout wrapper = value.isEmpty() ? block : chatStyle.messageWithFooter(block, user, () -> value, at, chinese);
        if (editable) {
            View.OnClickListener edit = view -> beginEdit(seq, value);
            block.setOnClickListener(edit);
            if (body != null) body.setOnClickListener(edit);
            String hint = tr("点击编辑上一条消息", "Tap to edit previous message");
            block.setContentDescription(hint);
            if (body != null) body.setContentDescription(hint);
        }
        wrapper.setTag(signature); renderedText.put(key, value); renderedMessages.put(key, wrapper); pendingMessageViews.add(wrapper);
    }

    private static final class ReplyMessage {
        LinearLayout block, wrapper, artifacts, visualizations;
        StreamingMarkdownView body;
        ExecutionProcessView process;
        TextView waiting, truncated;
        String turn, artifactText = "";
        String visualizationSignature = "";
        long at, run, imageSeq = -1;
    }
    private MarkdownView replyMarkdown(boolean live, boolean assistant, long seq) {
        MarkdownView.ImageLoader loader = !live && assistant && seq > 0
            ? inlineImageFactory.apply(seq) : null;
        return new MarkdownView(this, ink, muted, surface, accent, loader);
    }
    private void addReply(String key, String value, boolean truncated, JSONArray process, boolean live, String turn, long at, long seq, boolean assistant, JSONObject details, JSONArray visualizations) {
        long run = live && lastLive != null ? lastLive.optLong("runId") : 0;
        ReplyMessage binding = replyMessages.get(key);
        if (binding != null && live && binding.run != run) { binding.body.dispose(); replyMessages.remove(key); binding = null; }
        if (binding == null && !live && assistant && key.startsWith("message:")) {
            ReplyMessage candidate = replyMessages.get("live");
            if (candidate != null && candidate.turn.equals(turn) && value.startsWith(candidate.body.source())) {
                binding = candidate; replyMessages.remove("live"); renderedMessages.remove("live");
            }
        }
        if (binding == null) {
            binding = new ReplyMessage(); binding.turn = turn; binding.run = run;
            binding.block = chatStyle.messageBlock(false);
            binding.process = new ExecutionProcessView(this, chatStyle, processState, conversationId + ":" + turn); binding.block.addView(binding.process);
            binding.truncated = text(tr("内容过长，仅显示末尾片段。", "Long message: showing the final portion."), 12, accent); binding.block.addView(binding.truncated);
            binding.waiting = text(tr("等待输出…", "Waiting for output…"), 15, ink); binding.block.addView(binding.waiting);
            ScrollView target = scroll;
            binding.imageSeq = live || !assistant ? -1 : seq;
            binding.body = new StreamingMarkdownView(this, replyMarkdown(live, assistant, seq), new MarkdownScrollAnchor(target, () -> scroll == target && screen.equals("detail") && pendingScrollView != target));
            binding.block.addView(binding.body); binding.artifacts = column(); binding.block.addView(binding.artifacts);
            binding.visualizations = column(); binding.block.addView(binding.visualizations);
            ReplyMessage owner = binding;
            binding.wrapper = chatStyle.messageWithFooter(binding.block, false, owner.body::source, at, chinese);
            binding.at = at;
            if (live) binding.body.update(value, false); else binding.body.history(value);
        }
        long imageSeq = live || !assistant ? -1 : seq;
        if (imageSeq > 0 && binding.imageSeq != imageSeq && InlineRemoteImages.hasSupportedMedia(value)) {
            binding.body.imageLoader(inlineImageFactory.apply(imageSeq));
            binding.imageSeq = imageSeq;
        }
        int processFiles = ArtifactReferences.paths(value).size();
        binding.run = run; binding.process.update(process, live, new TurnDetails(details), processFiles);
        TurnUsage.bind(binding.wrapper, live ? null : details, chinese);
        binding.truncated.setVisibility(truncated ? View.VISIBLE : View.GONE);
        binding.waiting.setVisibility(live && value.isEmpty() && (process == null || process.length() == 0) ? View.VISIBLE : View.GONE);
        binding.body.setVisibility(value.isEmpty() ? View.GONE : View.VISIBLE); binding.body.update(value, !live);
        binding.wrapper.findViewWithTag("messageFooter").setVisibility(value.isEmpty() && !new TurnDetails(details).hasUsage() ? View.GONE : View.VISIBLE);
        if (binding.at != at) { binding.at = at; chatStyle.updateMessageTimestamp(binding.wrapper, at, chinese); }
        if (!live && !value.equals(binding.artifactText)) {
            binding.artifactText = value; binding.artifacts.removeAllViews();
            java.util.List<String> files = ArtifactReferences.paths(value);
            if (!files.isEmpty()) {
                ArtifactMessageView download = new ArtifactMessageView(this, files, chinese,
                    reference -> artifactDownloads.showFile(credentials.optString("address"), credentials.optString("token"), conversationId, seq, reference));
                download.setTag("messageArtifacts:" + key);
                LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-1, -2); layout.topMargin = dp(18); binding.artifacts.addView(download, layout);
            }
        }
        if (!live) binding.artifactText = value;
        String visualizationKey = visualizations == null ? "" : visualizations.toString();
        if (!live && !visualizationKey.equals(binding.visualizationSignature)) {
            binding.visualizations.removeAllViews();
            if (visualizations != null && visualizations.length() > 0) {
                RemoteVisualizationsView cards = new RemoteVisualizationsView(this, chatStyle, visualizations, chinese,
                    this::openVisualization);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
                params.topMargin = dp(8);
                binding.visualizations.addView(cards, params);
            }
            binding.visualizationSignature = visualizationKey;
        }
        binding.visualizations.setVisibility(!live && visualizations != null && visualizations.length() > 0
            ? View.VISIBLE : View.GONE);
        replyMessages.put(key, binding); renderedMessages.put(key, binding.wrapper); pendingMessageViews.add(binding.wrapper);
    }

    private void openVisualization(JSONObject card) {
        if (card == null || !networkActive() || conversationId == null || !credentials.has("token")) return;
        String cardId = card.optString("cardId");
        if (!cardId.matches("[0-9a-f-]{36}")) return;
        String title = card.optString("title", tr("交互卡片", "Interactive card"));
        String token = credentials.optString("token"), address = credentials.optString("address");
        String ownerConversation = conversationId;
        int ticket = generation;
        boolean dark = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        if (visualizationDialog != null) { visualizationDialog.dismiss(); visualizationDialog = null; }
        VisualizationDialog dialog = new VisualizationDialog(this, title, chinese);
        RemoteApi client = new RemoteApi(this, address);
        dialog.setOnDismissListener(ignored -> {
            if (visualizationDialog == dialog) visualizationDialog = null;
            client.cancel();
        });
        dialog.show();
        visualizationDialog = dialog;
        String path = "/v1/conversations/" + ownerConversation + "/visualizations/" + cardId
            + "?theme=" + (dark ? "dark" : "light");
        networkWorker.submit(() -> {
            try {
                JSONObject response = client.json(path, token, null, 24 * 1024 * 1024);
                JSONObject loaded = response.optJSONObject("card");
                String html = loaded == null ? "" : loaded.optString("html");
                if (html.isEmpty()) throw new java.io.IOException("Visualization document is empty");
                viewHandler.post(() -> {
                    if (ticket != generation || !ownerConversation.equals(conversationId) || !networkActive()) {
                        dialog.dismiss();
                    } else if (visualizationDialog == dialog) {
                        dialog.load(html);
                    }
                });
            } catch (Exception error) {
                viewHandler.post(() -> {
                    if (visualizationDialog != dialog) return;
                    dialog.dismiss();
                    if (ticket == generation && ownerConversation.equals(conversationId))
                        reportError("无法加载交互卡片，请检查电脑连接。", "Could not load the interactive card. Check the computer connection.", error);
                });
            } finally {
                client.cancel();
            }
        });
    }

    private void disposeMessageViews() {
        for (ReplyMessage binding : replyMessages.values()) binding.body.dispose();
        replyMessages.clear(); renderedMessages.clear(); renderedText.clear(); pendingMessageViews.clear();
    }

    private void releasePageViews() {
        if (codexResetDialog != null) { codexResetDialog.dismiss(); codexResetDialog = null; }
        // PageTransitions captures the outgoing hierarchy before detaching it.
        viewHandler.removeCallbacksAndMessages(null); clearMessageScroll();
        prefetchRows.clear(); disposeMessageViews();
        if (workStatus != null) { workStatus.close(); workStatus = null; }
        if (conversationPopup != null) { conversationPopup.dismiss(); conversationPopup = null; }
        if (settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        if (computerPicker != null) { computerPicker.dismiss(); computerPicker = null; }
        if (computerDialog != null) { computerDialog.dismiss(); computerDialog = null; }
        if (queueDialog != null) { queueDialog.dismiss(); queueDialog = null; }
        if (workDialog != null) { workDialog.dismiss(); workDialog = null; }
        workAutomationSection = null;
        queueSheetPanel = null;
        if (remoteApprovalDialog != null) { remoteApprovalDialog.dismiss(); remoteApprovalDialog = null; }
        if (visualizationDialog != null) { visualizationDialog.dismiss(); visualizationDialog = null; }
        remoteApprovalKey = ""; locationConsent.cancel();
        messages = null; older = null; remoteEmptyState = null;
        composer = null; chatComposer = null; sendButton = null; stopButton = null;
        retryMessage = null; approvals = null; automationBar = null; queueBar = null; workInline = null;
        backgroundWorkBar = null; backgroundWorkLabel = null; backgroundWorkStop = null; workSummaryBar = null;
        imageTray = null; imageStrip = null; attachButton = null; modelButton = null; permissionButton = null;
        addressInput = null; portInput = null; nameInput = null; codeInput = null; pairButton = null; scanButton = null;
        handler.removeCallbacks(searchRemote); searchInput = null; searchBar = null;
        detailSidebar = null; splitDetail = false; workbenchNavigation = null;
        homeConversations = null; homeHeading = null; homeEmptyHint = null;
        root = null; content = null; scroll = null; status = null; headerConnection = null;
    }

    private void updateOlderControl() {
        boolean available = nextBefore != null;
        older.setEnabled(available && !olderLoading);
        older.setVisibility(available ? View.VISIBLE : View.GONE);
        ((RefreshScrollView) scroll).setRefreshAction(available ? this::loadOlder : null, ready -> {
            if (ready) setStatusNotice(tr("松开加载更早消息", "Release to load earlier messages"));
        });
    }

    private void loadOlder() {
        loadOlder(false);
    }

    private int visibleHistoryMessages() {
        int count = 0;
        for (JSONObject row : history.values()) if (RemoteHistoryPage.visible(row)) count++;
        return count;
    }

    private void scheduleAutomaticHistory() {
        if (foreground && screen.equals("detail") && connected && !olderLoading && !historyDetached
                && historyLoad.shouldLoad(visibleHistoryMessages(), history.size(), historyBytes, nextBefore != null)) {
            // Let the latest reply draw before fetching anything else.
            if (!automaticHistoryScheduled) {
                automaticHistoryScheduled = true; handler.postDelayed(automaticHistoryLoad, 180);
            }
        } else {
            handler.removeCallbacks(automaticHistoryLoad); automaticHistoryScheduled = false;
        }
    }

    private void loadOlder(boolean automatic) {
        if (olderLoading) return;
        if (!foreground || !screen.equals("detail") || nextBefore == null || api == null) {
            if (scroll instanceof RefreshScrollView) ((RefreshScrollView) scroll).setRefreshing(false);
            return;
        }
        if (automatic && (!connected || historyDetached || !historyLoad.shouldLoad(
                visibleHistoryMessages(), history.size(), historyBytes, true))) return;
        handler.removeCallbacks(automaticHistoryLoad); automaticHistoryScheduled = false;
        if (!automatic) historyLoad.stop();
        RemoteApi client = api; int ticket = generation; long before = nextBefore;
        RemoteHistoryLoad load = historyLoad;
        RemoteHistoryPage page = automatic ? new RemoteHistoryPage(history.keySet(), before,
            RemoteHistoryPage.MAX_RECORDS - history.size(), RemoteHistoryPage.MAX_BYTES - historyBytes,
            load.remainingMessages(visibleHistoryMessages())) : new RemoteHistoryPage(history.keySet(), before);
        String version = historyVersion;
        String server = instance;
        String id = conversationId, token = credentials.optString("token"); older.setEnabled(false);
        olderLoading = true; olderAutomatic = automatic;
        if (!automatic) {
            ((RefreshScrollView) scroll).setRefreshing(true);
            setStatusNotice(tr("正在加载更早消息…", "Loading earlier messages…"));
        }
        worker.submit(() -> {
            try {
                long started = android.os.SystemClock.elapsedRealtime();
                String[] responseVersion = {version};
                do {
                    if (ticket != generation) return;
                    long pageBefore = page.nextBefore;
                    JSONObject snapshot = client.json("/v1/conversations/" + id + "?before=" + pageBefore, token, null);
                    JSONObject conversation = snapshot.optJSONObject("conversation");
                    if (!server.equals(snapshot.optString("instanceId", server)) || conversation == null || !id.equals(conversation.optString("id"))) {
                        throw new IOException("Conversation changed while loading earlier messages");
                    }
                    responseVersion[0] = snapshot.optString("historyVersion");
                    if (automatic && !version.equals(responseVersion[0])) break;
                    page.append(snapshot, pageBefore);
                } while (!automatic && page.needsNext());
                long duration = android.os.SystemClock.elapsedRealtime() - started;
                deliver(ticket, () -> {
                    olderLoading = false; olderAutomatic = false;
                    ((RefreshScrollView) scroll).setRefreshing(false);
                    if (automatic) {
                        load.received(duration);
                        if (load != historyLoad || !version.equals(historyVersion) || !version.equals(responseVersion[0]) || !server.equals(instance)
                                || historyDetached || !java.util.Objects.equals(nextBefore, before)) {
                            updateOlderControl(); scheduleAutomaticHistory(); return;
                        }
                    }
                    if (!server.equals(instance)) {
                        updateOlderControl();
                        setStatusNotice(tr("会话已更新，请重新加载更早消息。", "Conversation updated. Load earlier messages again.")); return;
                    }
                    boolean followBottom = automatic && (pendingScrollView == scroll && pendingScrollPosition == Integer.MAX_VALUE
                        || !scroll.canScrollVertically(1));
                    View anchor = null;
                    for (int index = 0; index < messages.getChildCount(); index++) {
                        View candidate = messages.getChildAt(index);
                        if (messages.getTop() + candidate.getBottom() > scroll.getScrollY()) { anchor = candidate; break; }
                    }
                    View retainedAnchor = anchor;
                    int anchorOffset = anchor == null ? 0 : messages.getTop() + anchor.getTop() - scroll.getScrollY();
                    java.util.Set<Long> added = new java.util.HashSet<>();
                    for (JSONObject row : page.rows.values()) {
                        long seq = row.optLong("seq");
                        if (!history.containsKey(seq)) { retainHistory(seq, row); added.add(seq); }
                    }
                    nextBefore = page.nextBefore;
                    // Automatic warmup must never displace the latest reply.
                    // Live rows may have arrived while the page was in flight.
                    trimHistory(!automatic);
                    if (automatic && (page.rows.isEmpty() || page.limited() && visibleHistoryMessages() < RemoteHistoryLoad.PROBE_MESSAGES)) load.stop();
                    renderMessages(lastLive); updateOlderControl();
                    if (followBottom) positionMessages(Integer.MAX_VALUE);
                    else if (retainedAnchor != null) positionMessages(-anchorOffset, retainedAnchor);
                    if (automatic) { scheduleAutomaticHistory(); return; }
                    int addedMessages = 0, addedProcess = 0;
                    for (long seq : added) {
                        JSONObject row = history.get(seq);
                        if (row == null) continue;
                        if (RemoteHistoryPage.visible(row)) addedMessages++; else addedProcess++;
                    }
                    String notice = addedMessages > 0 ? tr("已新增 " + addedMessages + " 条更早消息，上滑查看。", "Added " + addedMessages + " earlier message" + (addedMessages == 1 ? "" : "s") + ". Scroll up to view.")
                        : addedProcess > 0 ? tr("已加载 " + addedProcess + " 条过程记录，暂无新的聊天消息。", "Loaded " + addedProcess + " process record" + (addedProcess == 1 ? "" : "s") + "; no new chat messages.")
                        : tr("没有新增更早消息。", "No new earlier messages.");
                    if (nextBefore == null) notice += " " + tr("已到达会话最早消息", "Reached the beginning of the conversation");
                    setStatusNotice(notice);
                });
            } catch (Exception error) { deliver(ticket, () -> {
                olderLoading = false; olderAutomatic = false; ((RefreshScrollView) scroll).setRefreshing(false);
                updateOlderControl();
                if (automatic) {
                    load.stop();
                    if (error instanceof RemoteApi.Failure && java.util.Set.of(401, 403, 404).contains(((RemoteApi.Failure) error).status)) showFailure(error, true);
                } else showFailure(error, true);
            }); }
        });
    }

    private boolean trimHistory(boolean keepOlder) {
        RemoteHistoryPage.Window window = RemoteHistoryPage.trim(history, historyBytes, keepOlder);
        historyBytes = window.bytes;
        if (window.trimmed) {
            if (keepOlder) historyDetached = true;
            else nextBefore = history.firstKey();
        }
        return window.trimmed;
    }

    private void clearHistory() {
        disposeMessageViews(); history.clear(); historyBytes = 0; historyInstance = "";
        nextBefore = null; historyDetached = false; goalVisibility.reset();
        historyLoad = new RemoteHistoryLoad(); historyVersion = "";
    }

    private void retainHistory(long seq, JSONObject row) {
        JSONObject previous = history.put(seq, row);
        if (previous != null) historyBytes -= historyRowBytes(previous);
        historyBytes += historyRowBytes(row);
    }

    private void forgetHistoryFrom(long first) {
        for (java.util.Iterator<java.util.Map.Entry<Long, JSONObject>> iterator = history.tailMap(first).entrySet().iterator(); iterator.hasNext(); ) {
            historyBytes -= historyRowBytes(iterator.next().getValue());
            iterator.remove();
        }
        if (historyBytes < 0) historyBytes = 0;
    }

    private static long historyRowBytes(JSONObject row) {
        return RemoteHistoryPage.weight(row);
    }

    private void showFailure(Exception error, boolean authenticated) {
        if (!connected) { connectionBlocked = true; updateConnectionHeader(); }
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
                setStatusError(tr("凭据已失效、配对已过期或被拒绝，请重新配对。", "Access was revoked, expired or rejected. Pair again.")
                    + "\n" + RemoteApi.failureMessage(error, chinese)); return;
            }
            if (code == 404) {
                prefetch.cancel();
                prefetch.remove(credentials, screen.equals("detail") ? conversationId : null);
                if (screen.equals("detail") && conversationId != null) {
                    boolean released = releasePendingCommandForUnavailableConversation();
                    clearUnavailableDetail();
                    setStatusError(tr("会话不可用，可能已归档或不再授权。", "Conversation unavailable, archived or no longer authorized.")
                        + (pendingCommand() != null ? tr(" 操作可能已经执行，请核对后解除待确认。", " The action may have executed. Inspect it before resolving the pending record.") : "")
                        + "\n" + RemoteApi.failureMessage(error, chinese));
                } else setStatusError(tr("电脑端不支持此接口，请更新并重启电脑端。", "This endpoint is unavailable. Update and restart the desktop.")
                    + "\n" + RemoteApi.failureMessage(error, chinese));
                return;
            }
            if (code == 403) {
                prefetch.cancel();
                prefetch.remove(credentials, null);
                if (screen.equals("detail")) {
                    clearUnavailableDetail();
                }
            }
            if (code == 429 || code == 403 || code == 409) { setStatusError(RemoteApi.failureMessage(error, chinese)); return; }
        }
        setStatusError(RemoteApi.failureMessage(error, chinese) + tr(" 当前内容可能是缓存。", " Displayed content may be cached."));
    }

    // Unavailability cannot prove that the operation never executed. Preserve
    // its request ID until the user checks the desktop and resolves the record.
    private boolean releasePendingCommandForUnavailableConversation() {
        JSONObject pending = pendingCommand();
        if (pending == null || !conversationId.equals(pending.optString("conversationId"))) return false;
        JSONObject payload = pending.optJSONObject("payload");
        try { if (payload != null) markUncertain(credentials, payload); }
        catch (Exception error) { reportError("无法保存待确认状态。", "Could not save pending state.", error); }
        updateControls();
        return false;
    }

    private void bindStatusDetails() {
        ErrorDetails.bindStatus(this, status, chinese);
    }

    private void setStatusNotice(String value) {
        if (workStatus != null) workStatus.notice(value);
        else if (status != null) status.setText(value);
    }

    private void setStatusError(String value) {
        if (workStatus != null) workStatus.error(value, false);
        else if (status != null) status.setText(value);
    }

    private void connectionFailure(String value) {
        connected = false; reconnecting = true; connectionBlocked = false;
        updateControls();
        if (workStatus != null) workStatus.error(value, true);
        else setStatusError(value);
    }

    private void updateConnectionHeader() {
        if (headerConnection == null) return;
        headerConnection.setText(connected ? tr("已连接", "Connected") : connectionBlocked || !EmbeddedNetwork.online() ? tr("离线", "Offline")
            : reconnecting ? tr("正在重连", "Reconnecting") : tr("正在连接", "Connecting"));
        headerConnection.setVisibility(View.VISIBLE);
    }

    private void listConnected() {
        connected = true; reconnecting = false; updateConnectionHeader(); setStatusNotice("");
    }

    private void updateWorkStatus() {
        updateConnectionHeader();
        if (workStatus == null) return;
        if (connected) workStatus.reconnected();
        String value = "";
        JSONObject pending = RemotePendingCommands.get(credentials, conversationId, true);
        if (pending == null) pending = pendingCommand();
        if (!connected) value = tr("等待同步会话…", "Waiting for conversation sync…");
        else if (pending != null) {
            JSONObject payload = pending.optJSONObject("payload");
            value = payload != null && payload.optString("action").startsWith("stop") ? tr("正在停止…", "Stopping…")
                : tr("操作待确认…", "Awaiting action confirmation…");
        } else if (commandBusy) value = tr("正在提交操作…", "Submitting action…");
        else value = RemoteWorkStatus.conversation(displayedConversation, lastLive, remoteCompaction, chinese);
        if (value.isEmpty()) value = loadingImages ? tr("正在读取附件…", "Loading attachments…")
            : editingSeq > 0 ? tr("正在编辑上一条消息", "Editing previous message")
            : !controlAllowed ? tr("只读会话", "Read-only conversation")
            : remoteQueue.length() > 0 ? tr("等待处理队列…", "Waiting for queued messages…") : tr("就绪", "Ready");
        workStatus.work(value);
    }

    private void reportError(String zh, String en, Exception error) {
        setStatusError(ErrorDetails.withSummary(tr(zh, en), error));
    }

    private void updateControls() {
        updateWorkStatus();
        updateBackgroundWorkControls();
        if (subtaskPage != null) subtaskPage.setControlAvailable(connected && controlAllowed && !commandBusy && pendingCommand() == null);
        if (sendButton == null || conversationId == null) return;
        boolean pending = (pendingCommand() != null);
        boolean available = connected && controlAllowed && !commandBusy;
        boolean configurable = available && !pending && remoteSettings != null && remoteSettings.optBoolean("modelEditable", remoteSettings.optBoolean("editable"));
        if (!configurable && settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        if (modelButton != null) {
            String model = remoteSettings == null ? tr("模型", "Model") : remoteSettings.optString("model", tr("模型", "Model"));
            String thinking = remoteSettings == null ? "" : remoteSettings.optString("thinking");
            chatComposer.model(model, LocalChatThinking.display(thinking, chinese), configurable);
        }
        chatComposer.editing(editingSeq > 0, !commandBusy && !pending && lastLive == null);
        if (permissionButton != null) {
            String level = remoteSettings == null ? "ask" : remoteSettings.optString("permissionMode");
            boolean permissionsEditable = configurable && remoteSettings.optBoolean("editable");
            permissionButton.level(level, permissionsEditable);
        }
        String composed = composer == null ? "" : composer.getText().toString().trim();
        // A bare "/find" is a valid request: it lists the files produced most
        // recently. Any other bare slash command is still not worth sending.
        boolean bareSlash = composed.matches("(?i)^/[a-z]+$") && !composed.equalsIgnoreCase("/find");
        boolean hasMessage = ((!composed.isEmpty() && !bareSlash) || !selectedImages.isEmpty() || !selectedDocuments.isEmpty());
        boolean busy = remoteBusy();
        boolean queueing = canQueue && editingSeq <= 0 && (busy || remoteQueue.length() > 0);
        boolean findWhileBusy = busy && composed.matches("(?is)^/find(?:\\s.*)?$");
        sendButton.setEnabled(available && (!busy || queueing) && !pending && !loadingImages && !awaitingSentMessage()
            && hasMessage && !findWhileBusy && !(editingSeq > 0 && remoteQueue.length() > 0));
        String sendLabel = queueing ? tr("加入队列", "Queue message") : tr("发送", "Send");
        sendButton.setContentDescription(sendLabel); sendButton.setTooltipText(sendLabel);
        if (attachButton != null) {
            attachButton.setEnabled(available && !pending && !loadingImages);
            attachButton.setAlpha(available && !pending && !loadingImages ? 1f : .45f);
        }
        boolean stopping = RemotePendingCommands.get(credentials, conversationId, true) != null;
        boolean stoppable = lastLive != null || canStopStart && remotePreparation != null;
        stopButton.setEnabled(connected && controlAllowed && stoppable && !stopping);
        boolean showQueueSend = queueing && hasMessage;
        sendButton.setVisibility(!stoppable || showQueueSend ? View.VISIBLE : View.GONE);
        stopButton.setVisibility(stoppable && !showQueueSend ? View.VISIBLE : View.GONE);
        composer.setEnabled(!commandBusy && !pending);
        if (retryMessage != null) retryMessage.setEnabled(pending);
        if (workStatus != null) workStatus.retry(stopping ? this::retryStopCommand
            : pending ? this::retryCommand : null);
        if (approvals != null) for (int index = 0; index < approvals.getChildCount(); index++) {
            View child = approvals.getChildAt(index);
            if (child instanceof Button) child.setEnabled(available && !pending);
        }
        renderQueue();
        refreshWorkSummaryBar();
        renderWorkAutomation();
    }

    private boolean remoteBusy() {
        return lastLive != null || displayedConversation != null && !displayedConversation.isNull("activity")
            && !displayedConversation.optString("activity").isEmpty();
    }

    private void updateBackgroundWorkControls() {
        if (backgroundWorkBar == null || !screen.equals("detail")) return;
        int count = RemoteWorkStatus.backgroundCount(displayedConversation);
        boolean show = canStopBackgroundWork && count > 0;
        backgroundWorkBar.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;
        backgroundWorkLabel.setText(String.format(RemoteWorkStatus.backgroundUnknown(displayedConversation)
            ? tr("后台状态未知 · %d", "Background status unknown · %d") : tr("后台任务 · %d", "Background tasks · %d"), count));
        boolean stopping = RemotePendingCommands.get(credentials, conversationId, true) != null;
        backgroundWorkStop.setText(stopping ? tr("正在停止…", "Stopping…") : tr("停止后台任务", "Stop background tasks"));
        boolean available = connected && controlAllowed && !commandBusy && pendingCommand() == null && !stopping
            && RemoteWorkStatus.stoppableBackgroundTasks(displayedConversation).length() > 0;
        backgroundWorkStop.setEnabled(available); backgroundWorkStop.setAlpha(available ? 1f : .45f);
        refreshWorkSummaryBar();
    }

    private void refreshWorkSummaryBar() {
        if (workSummaryBar == null || !screen.equals("detail")) return;
        JSONArray approvalRows = lastLive == null ? null : lastLive.optJSONArray("approvals");
        int approvalsCount = approvalRows == null ? 0 : approvalRows.length();
        int backgroundCount = RemoteWorkStatus.backgroundCount(displayedConversation);
        int queueCount = remoteQueue.length();
        boolean automation = automationBar != null && automationBar.getVisibility() == View.VISIBLE && automationBar.getChildCount() > 0;
        JSONObject pending = pendingCommand();
        boolean failed = pending != null && (pending.optBoolean("uncertain") || pending.optBoolean("timedOut"));
        if (outgoingMessage != null) {
            String delivery = outgoingMessage.optString("delivery");
            failed |= delivery.equals("failed") || delivery.equals("unconfirmed");
        }
        Palette palette = Palette.of(this);
        String text = "";
        int color = palette.muted;
        boolean actionable = approvalsCount > 0 || failed || automation || backgroundCount > 0 || queueCount > 0;
        if (!actionable) {
            workSummaryBar.setVisibility(View.GONE);
            return;
        }
        String priority = workPriority(approvalsCount, failed, automation, backgroundCount, queueCount);
        if (priority.equals("approvals")) {
            text = tr("待处理 " + approvalsCount, "Needs attention " + approvalsCount);
            color = palette.warning;
        } else if (priority.equals("failed")) {
            text = tr("发送未确认", "Send unconfirmed");
            color = palette.error;
        } else if (priority.equals("automation")) {
            text = tr("目标/任务", "Goal/tasks");
            color = palette.accent;
        } else if (priority.equals("background")) {
            text = tr("后台 " + backgroundCount, "Background " + backgroundCount);
            color = palette.accent;
        } else if (priority.equals("queue")) {
            text = tr("排队 " + queueCount, "Queued " + queueCount);
            color = palette.accent;
        }
        workSummaryBar.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
        if (text.isEmpty()) return;
        boolean detailsAvailable = approvalsCount > 0 || queueCount > 0 || automation || backgroundCount > 0 || failed;
        workSummaryBar.setText(text + (detailsAvailable ? "  ›" : ""));
        workSummaryBar.setClickable(detailsAvailable);
        workSummaryBar.setOnClickListener(detailsAvailable ? view -> showWorkSheet() : null);
        workSummaryBar.setTextColor(color);
    }

    static String workPriority(int approvals, boolean failed, boolean automation, int background, int queue) {
        if (approvals > 0) return "approvals";
        if (failed) return "failed";
        if (automation) return "automation";
        if (background > 0) return "background";
        if (queue > 0) return "queue";
        return "none";
    }

    private void revealWorkView(View target) {
        if (target == null || scroll == null || content == null) return;
        if (workInline != null) workInline.setVisibility(View.VISIBLE);
        android.graphics.Rect bounds = new android.graphics.Rect();
        target.getDrawingRect(bounds);
        content.offsetDescendantRectToMyCoords(target, bounds);
        scroll.smoothScrollTo(0, Math.max(0, bounds.top - dp(12)));
    }

    private void showWorkSheet() {
        if (!screen.equals("detail")) return;
        if (workDialog != null && workDialog.isShowing()) return;
        SettingsStyle style = new SettingsStyle(this);
        android.app.Dialog dialog = new android.app.Dialog(this);
        workDialog = dialog;
        LinearLayout panel = column();
        style.sheetPanel(panel);
        panel.setTag("workSheet");
        TextView heading = text(tr("工作状态", "Work status"), Palette.TEXT_TITLE, ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        panel.addView(heading);
        JSONArray approvalRows = lastLive == null ? null : lastLive.optJSONArray("approvals");
        int backgroundCount = RemoteWorkStatus.backgroundCount(displayedConversation);
        boolean added = false;
        if (approvalRows != null && approvalRows.length() > 0) {
            added = true;
            panel.addView(sheetSection(tr("等待你处理", "Needs attention")));
            for (int index = 0; index < approvalRows.length(); index++) {
                JSONObject request = approvalRows.optJSONObject(index);
                if (request == null) continue;
                TextView title = text(request.optString("toolName"), Palette.TEXT_ROW_STRONG, ink);
                title.setPadding(0, dp(8), 0, dp(2)); panel.addView(title);
                TextView details = text(request.optString("details"), Palette.TEXT_SMALL, muted);
                details.setMaxLines(4); details.setEllipsize(android.text.TextUtils.TruncateAt.END);
                panel.addView(details);
                boolean questions = request.optJSONArray("questions") != null && request.optJSONArray("questions").length() > 0;
                if (questions) {
                    TextView answer = style.label(tr("需要在会话中回答问题", "Answer this in the conversation"), Palette.TEXT_NOTE, accent);
                    answer.setPadding(0, dp(8), 0, dp(4));
                    answer.setFocusable(true);
                    answer.setOnClickListener(view -> { dialog.dismiss(); revealWorkView(approvals); });
                    panel.addView(answer);
                } else {
                    LinearLayout actions = new LinearLayout(this);
                    actions.setPadding(0, dp(6), 0, 0);
                    Button deny = button(tr("拒绝", "Deny"), () -> submitSheetApproval(request, false, dialog), false);
                    Button allow = button(tr("允许一次", "Allow once"), () -> submitSheetApproval(request, true, dialog), true);
                    actions.addView(deny, new LinearLayout.LayoutParams(0, -2, 1));
                    LinearLayout.LayoutParams allowParams = new LinearLayout.LayoutParams(0, -2, 1);
                    allowParams.setMarginStart(dp(8));
                    actions.addView(allow, allowParams);
                    panel.addView(actions);
                }
            }
        }
        JSONObject pending = pendingCommand();
        boolean failed = pending != null && (pending.optBoolean("uncertain") || pending.optBoolean("timedOut"));
        if (failed) {
            added = true;
            panel.addView(sheetSection(tr("发送未确认", "Send unconfirmed")));
            TextView note = text(tr("连接中断或操作超时。先查询同一请求，避免重复发送。", "The connection failed or the action timed out. Check the same request before retrying."),
                Palette.TEXT_SMALL, Palette.of(this).error);
            note.setPadding(0, dp(6), 0, dp(8)); panel.addView(note);
            Button retry = button(tr("重新查询", "Check again"), () -> { dialog.dismiss(); retryCommand(); }, false);
            panel.addView(retry);
        }
        workAutomationSection = column();
        workAutomationSignature = "";
        panel.addView(workAutomationSection);
        renderWorkAutomation();
        if (remoteGoal != null || remoteTasks.length() > 0) {
            added = true;
        }
        if (RemoteWorkStatus.backgroundCount(displayedConversation) > 0) {
            added = true;
            panel.addView(sheetSection(tr("后台任务", "Background tasks")));
            TextView count = text(tr(backgroundCount + " 个后台任务正在运行", backgroundCount + " background tasks are running"), Palette.TEXT_SMALL, muted);
            count.setPadding(0, dp(6), 0, dp(8)); panel.addView(count);
            Button stop = button(tr("停止后台任务", "Stop background tasks"), () -> {
                dialog.dismiss();
                stopBackgroundWork();
            }, false);
            panel.addView(stop);
        }
        if (remoteQueue.length() > 0) {
            added = true;
            panel.addView(sheetSection(tr("排队消息", "Queued messages")));
            for (int index = 0; index < Math.min(3, remoteQueue.length()); index++) {
                JSONObject entry = remoteQueue.optJSONObject(index);
                if (entry == null) continue;
                String value = entry.optString("text");
                TextView row = text((index + 1) + ". " + (value.isEmpty() ? tr("附件消息", "Attachment message") : value),
                    Palette.TEXT_SMALL, muted);
                row.setSingleLine(true); row.setEllipsize(android.text.TextUtils.TruncateAt.END);
                row.setPadding(0, dp(5), 0, dp(5)); panel.addView(row);
            }
            TextView open = style.label(tr("管理发送队列", "Manage queued messages"), Palette.TEXT_NOTE, accent);
            open.setPadding(0, dp(6), 0, dp(4)); open.setFocusable(true);
            open.setOnClickListener(view -> { dialog.dismiss(); showQueueSheet(); });
            panel.addView(open);
        }
        if (!added) {
            TextView note = text(tr("当前没有需要处理的工作。", "Nothing needs attention right now."), Palette.TEXT_SMALL, muted);
            note.setPadding(0, dp(10), 0, dp(12)); panel.addView(note);
        }
        Button close = button(tr("关闭", "Close"), dialog::dismiss, false);
        close.setTag("workSheetClose");
        LinearLayout.LayoutParams closeParams = new LinearLayout.LayoutParams(-1, -2);
        closeParams.topMargin = dp(12); panel.addView(close, closeParams);
        ScrollView sheetScroll = new ScrollView(this);
        sheetScroll.setVerticalScrollBarEnabled(false);
        sheetScroll.addView(panel);
        dialog.setContentView(sheetScroll);
        dialog.setOnDismissListener(dismissed -> {
            if (workDialog == dialog) { workDialog = null; workAutomationSection = null; }
        });
        style.sheetWindow(dialog.getWindow(), sheetScroll);
        dialog.show();
    }

    private void renderWorkAutomation() {
        if (workAutomationSection == null) return;
        boolean enabled = connected && controlAllowed && !commandBusy && pendingCommand() == null;
        String signature = String.valueOf(remoteGoal) + ":" + remoteTasks + ":" + enabled + ":" + chinese;
        if (signature.equals(workAutomationSignature)) return;
        workAutomationSignature = signature;
        workAutomationSection.removeAllViews();
        boolean show = remoteGoal != null || remoteTasks.length() > 0;
        workAutomationSection.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;
        workAutomationSection.addView(sheetSection(tr("目标与任务", "Goal and tasks")));
        if (remoteGoal != null) {
            View card = automationCard(remoteGoal);
            expandAutomationText(card, "remoteGoalObjective");
            enableAutomationControl(card, "remoteGoalToggle", enabled);
            workAutomationSection.addView(card);
        }
        for (int index = 0; index < remoteTasks.length(); index++) {
            JSONObject task = remoteTasks.optJSONObject(index);
            if (task == null) continue;
            View card = automationTask(task);
            expandAutomationText(card, "remoteTaskInstruction");
            enableAutomationControl(card, "remoteTaskToggle", enabled);
            workAutomationSection.addView(card);
        }
    }

    private void expandAutomationText(View card, String tag) {
        TextView detail = card.findViewWithTag(tag);
        LinearLayout row = (LinearLayout) detail.getParent();
        int index = row.indexOfChild(detail);
        row.removeView(detail);
        row.addView(new View(this), index, new LinearLayout.LayoutParams(0, 1, 1));
        detail.setSingleLine(false); detail.setEllipsize(null);
        detail.setTextIsSelectable(true);
        detail.setPadding(dp(12), 0, dp(12), dp(12));
        ((LinearLayout) card).addView(detail, 1, new LinearLayout.LayoutParams(-1, -2));
    }

    private void enableAutomationControl(View card, String tag, boolean enabled) {
        View toggle = card.findViewWithTag(tag);
        if (toggle != null) { toggle.setEnabled(enabled); toggle.setAlpha(enabled ? 1f : .45f); }
    }

    private TextView sheetSection(String label) {
        TextView section = text(label, Palette.TEXT_SMALL, muted);
        section.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        section.setPadding(0, dp(16), 0, dp(3));
        return section;
    }

    private void submitSheetApproval(JSONObject request, boolean allow, android.app.Dialog sheet) {
        if (!connected || !controlAllowed || commandBusy || lastLive == null || pendingCommand() != null) return;
        long runId = lastLive.optLong("runId");
        String server = instance;
        String target = conversationId;
        String title = allow ? tr("允许此操作？", "Allow this operation?") : tr("拒绝此操作？", "Deny this operation?");
        new CamelliaDialog.Builder(this).setTitle(title)
            .setMessage(request.optString("toolName") + "\n" + request.optString("details"))
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(allow ? tr("允许一次", "Allow once") : tr("拒绝", "Deny"), (dialog, which) -> {
                if (!target.equals(conversationId) || !server.equals(instance) || lastLive == null
                    || lastLive.optLong("runId") != runId || !connected || commandBusy || pendingCommand() != null) return;
                try {
                    submitCommand(command("approve").put("instanceId", server).put("runId", runId)
                        .put("approvalId", request.getString("requestId"))
                        .put("fingerprint", request.getString("fingerprint")).put("allow", allow));
                    sheet.dismiss();
                } catch (Exception error) {
                    reportError("无法保存审批操作。", "Could not save approval.", error);
                }
            }).show();
    }

    private void stopBackgroundWork() {
        if (!canStopBackgroundWork || !connected || !controlAllowed || commandBusy || pendingCommand() != null
                || RemotePendingCommands.get(credentials, conversationId, true) != null) return;
        JSONArray tasks = RemoteWorkStatus.stoppableBackgroundTasks(displayedConversation);
        if (tasks.length() == 0) return;
        try { submitCommand(command("stop-background-work").put("tasks", tasks)); }
        catch (Exception error) { reportError("无法停止后台任务，请重试。", "Could not stop background tasks. Retry.", error); }
    }

    private void applyQueue(JSONObject value) {
        JSONArray queue = value.optJSONArray("queue");
        long version = value.optLong("queueVersion", 0);
        if (queue != null && version >= queueVersion) { remoteQueue = queue; queueVersion = version; }
    }

    private void renderQueue() {
        if (queueBar == null) return;
        boolean enabled = connected && controlAllowed && !commandBusy && !(pendingCommand() != null);
        String signature = remoteQueue.toString() + ":" + enabled + ":" + (lastLive == null ? 0 : lastLive.optLong("runId")) + ":" + queueSteeringGoalId;
        if (signature.equals(queueSignature)) return;
        queueSignature = signature;
        queueBar.removeAllViews(); queueBar.setVisibility(remoteQueue.length() == 0 ? View.GONE : View.VISIBLE);
        if (remoteQueue.length() == 0) {
            dismissQueueSheet();
            refreshWorkSummaryBar();
            return;
        }
        JSONObject first = remoteQueue.optJSONObject(0);
        boolean failed = queueHasState("failed");
        boolean paused = !failed && queueHasState("paused");
        boolean starting = first != null && first.optString("state").equals("starting");
        Palette palette = Palette.of(this);
        int titleColor = failed ? palette.error : paused ? palette.warning : starting ? accent : ink;
        String count = tr(remoteQueue.length() + " 条", remoteQueue.length() + " queued");
        String title = starting ? tr("正在发送 · " + count, "Sending · " + remoteQueue.length())
            : failed ? tr("队列发送失败 · " + count, "Queue failed · " + remoteQueue.length())
            : paused ? tr("队列已暂停 · " + count, "Queue paused · " + remoteQueue.length())
            : tr("待发送 · " + count, "Queued · " + remoteQueue.length());
        String preview = first == null ? "" : queuePreview(first);

        LinearLayout tray = new LinearLayout(this);
        tray.setGravity(Gravity.CENTER_VERTICAL);
        tray.setMinimumHeight(dp(60));
        tray.setPadding(dp(12), dp(8), dp(10), dp(8));
        tray.setTag("remoteQueueTray");
        tray.setFocusable(true);
        tray.setContentDescription(title + "。" + tr("下一条：", "Next: ") + preview + tr("。点按管理", ". Tap to manage."));
        GradientDrawable trayFace = rounded(surface);
        trayFace.setStroke(dp(1), Palette.of(this).cardBorder);
        tray.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), trayFace, rounded(Color.WHITE)));
        tray.setElevation(dp(1));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            tray.setOutlineAmbientShadowColor(0x10000000); tray.setOutlineSpotShadowColor(0x1c000000);
        }
        tray.setOnClickListener(view -> showQueueSheet());

        ImageView icon = new ImageView(this);
        icon.setImageDrawable(new LineIcon("select", accent));
        icon.setPadding(dp(9), dp(9), dp(9), dp(9));
        icon.setBackground(accentActionBackground());
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(34), dp(34));
        iconParams.setMarginEnd(dp(11));
        tray.addView(icon, iconParams);

        LinearLayout copy = column();
        TextView heading = text(title, Palette.TEXT_BODY, titleColor);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setSingleLine(true); heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        copy.addView(heading);
        TextView next = text(preview, Palette.TEXT_SMALL, muted);
        next.setTag("remoteQueueTrayPreview");
        next.setSingleLine(true); next.setEllipsize(android.text.TextUtils.TruncateAt.END);
        next.setPadding(0, dp(1), 0, 0);
        copy.addView(next);
        tray.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));

        TextView manage = text(tr("管理", "Manage"), Palette.TEXT_SMALL, accent);
        manage.setTag("remoteQueueManage");
        manage.setGravity(Gravity.CENTER); manage.setMinHeight(dp(48));
        manage.setPadding(dp(12), 0, dp(12), 0); manage.setBackground(accentActionBackground());
        manage.setFocusable(true); manage.setOnClickListener(view -> showQueueSheet());
        tray.addView(manage);

        LinearLayout.LayoutParams trayParams = new LinearLayout.LayoutParams(-1, -2);
        trayParams.setMargins(dp(8), dp(4), dp(8), dp(8));
        queueBar.addView(tray, trayParams);
        refreshQueueSheet();
        refreshWorkSummaryBar();
    }

    private boolean queueHasState(String wanted) {
        for (int index = 0; index < remoteQueue.length(); index++) {
            JSONObject entry = remoteQueue.optJSONObject(index);
            if (entry != null && wanted.equals(entry.optString("state"))) return true;
        }
        return false;
    }

    private String queuePreview(JSONObject entry) {
        String text = entry.optString("text").replace('\n', ' ').trim();
        if (text.isEmpty()) text = tr("附件消息", "Attachment message");
        JSONArray files = entry.optJSONArray("attachments");
        if (files != null && files.length() > 0) text += tr(" · 附件 " + files.length(), " · " + files.length() + " attachments");
        return queueSourceLabel(entry) + " · " + text;
    }

    private String queueSourceLabel(JSONObject entry) {
        return entry.optString("source").equals("desktop") ? tr("电脑", "Computer") : tr("手机", "Mobile");
    }

    private String queueStateLabel(JSONObject entry) {
        String state = entry.optString("state");
        if (state.equals("starting")) return tr("正在发送", "Sending");
        if (state.equals("failed")) return tr("发送失败", "Failed");
        if (state.equals("paused")) return tr("已暂停", "Paused");
        return lastLive == null && queueSteeringGoalId.isEmpty()
            ? tr("下一条发送", "Next to send") : tr("等待当前任务结束", "Waiting for the current task");
    }

    private void showQueueSheet() {
        if (!screen.equals("detail") || remoteQueue.length() == 0) return;
        if (queueDialog != null && queueDialog.isShowing()) { refreshQueueSheet(); return; }
        queueDialog = new android.app.Dialog(this);
        queueSheetPanel = column();
        queueDialog.setContentView(queueSheetPanel);
        populateQueueSheet();
        queueDialog.setOnDismissListener(dialog -> { queueDialog = null; queueSheetPanel = null; });
        queueDialog.show();
        new SettingsStyle(this).sheetWindow(queueDialog.getWindow(), queueSheetPanel);
    }

    private void refreshQueueSheet() {
        if (queueDialog == null || !queueDialog.isShowing() || queueSheetPanel == null) return;
        populateQueueSheet();
        new SettingsStyle(this).sheetWindow(queueDialog.getWindow(), queueSheetPanel);
    }

    private void populateQueueSheet() {
        if (queueSheetPanel == null) return;
        SettingsStyle style = new SettingsStyle(this);
        queueSheetPanel.removeAllViews();
        style.sheetPanel(queueSheetPanel);
        queueSheetPanel.setTag("queueSheet");

        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text(tr("发送队列", "Send queue"), Palette.TEXT_TITLE, ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton close = chatStyle.composerToolButton("close", tr("关闭", "Close"), muted, this::dismissQueueSheet);
        close.setTag("queueSheetClose");
        header.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        queueSheetPanel.addView(header);

        boolean failed = queueHasState("failed");
        boolean paused = failed || queueHasState("paused");
        boolean enabled = connected && controlAllowed && !commandBusy && pendingCommand() == null;
        TextView summary = text(paused
                ? tr("队列已暂停。检查内容后再继续。", "The queue is paused. Review it before continuing.")
                : lastLive != null || !queueSteeringGoalId.isEmpty()
                    ? tr("当前任务结束后按顺序发送；“插入任务”会立即发给正在执行的任务。", "Messages send in order after this task. Insert delivers one to the current task now.")
                    : tr("当前没有可插入的任务，队列会在连接就绪后继续。", "No task can accept an insert now. The queue continues when the connection is ready."),
            Palette.TEXT_SMALL, paused ? Palette.of(this).warning : muted);
        summary.setPadding(0, dp(4), 0, dp(8));
        queueSheetPanel.addView(summary);

        if (paused) {
            String error = queueErrorMessage();
            if (!error.isEmpty()) {
                TextView reason = text(error, Palette.TEXT_SMALL, Palette.of(this).error);
                reason.setPadding(dp(12), dp(9), dp(12), dp(9));
                reason.setBackground(rounded(Palette.of(this).controlFill));
                reason.setTag("remoteQueueError");
                queueSheetPanel.addView(reason);
            }
            TextView resume = queueSheetButton(tr("继续队列", "Resume queue"), true, false, enabled,
                () -> { dismissQueueSheet(); queueCommand("queue-resume", null); });
            resume.setTag("remoteQueueResume");
            LinearLayout.LayoutParams resumeParams = new LinearLayout.LayoutParams(-1, dp(44));
            resumeParams.setMargins(0, dp(8), 0, 0);
            queueSheetPanel.addView(resume, resumeParams);
        }

        android.widget.ScrollView list = new android.widget.ScrollView(this) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                int limit = dp(getResources().getConfiguration().fontScale > 1.15f ? 260 : 320);
                if (View.MeasureSpec.getMode(heightSpec) != View.MeasureSpec.UNSPECIFIED) {
                    limit = Math.min(limit, View.MeasureSpec.getSize(heightSpec));
                }
                super.onMeasure(widthSpec, View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST));
            }
        };
        list.setVerticalScrollBarEnabled(false);
        list.setTag("remoteQueueList");
        LinearLayout rows = column();
        for (int index = 0; index < remoteQueue.length(); index++) {
            JSONObject entry = remoteQueue.optJSONObject(index);
            if (entry != null) rows.addView(queueSheetItem(entry, index, enabled));
        }
        list.addView(rows);
        LinearLayout.LayoutParams listParams = new LinearLayout.LayoutParams(-1, -2);
        listParams.setMargins(0, dp(paused ? 10 : 2), 0, 0);
        queueSheetPanel.addView(list, listParams);
    }

    private String queueErrorMessage() {
        for (int index = 0; index < remoteQueue.length(); index++) {
            String error = remoteQueue.optJSONObject(index) == null ? "" : remoteQueue.optJSONObject(index).optString("error");
            if (!error.isEmpty()) return error;
        }
        return "";
    }

    private LinearLayout queueSheetItem(JSONObject entry, int index, boolean enabled) {
        String id = entry.optString("id"), state = entry.optString("state");
        boolean starting = state.equals("starting");
        boolean canSteer = enabled && !starting && !queueHasState("paused") && !queueHasState("failed")
            && (lastLive != null || !queueSteeringGoalId.isEmpty());
        LinearLayout item = column();
        item.setTag("remoteQueue:" + id);
        item.setPadding(dp(16), dp(13), dp(14), dp(8));
        GradientDrawable face = rounded(Palette.of(this).surface);
        face.setStroke(dp(1), Palette.of(this).cardBorder);
        item.setBackground(face);
        LinearLayout.LayoutParams itemParams = new LinearLayout.LayoutParams(-1, -2);
        itemParams.setMargins(0, index == 0 ? 0 : dp(10), 0, 0);
        item.setLayoutParams(itemParams);

        LinearLayout head = new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL);
        TextView position = text(String.valueOf(index + 1), Palette.TEXT_SMALL, accent);
        position.setGravity(Gravity.CENTER);
        position.setBackground(accentActionBackground());
        LinearLayout.LayoutParams positionParams = new LinearLayout.LayoutParams(dp(28), dp(28));
        positionParams.setMarginEnd(dp(9));
        head.addView(position, positionParams);
        TextView status = text(queueSourceLabel(entry) + " · " + queueStateLabel(entry), Palette.TEXT_SMALL,
            state.equals("failed") ? Palette.of(this).error : state.equals("paused") ? Palette.of(this).warning
                : state.equals("starting") ? accent : muted);
        status.setTag("remoteQueueState:" + id);
        status.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        head.addView(status, new LinearLayout.LayoutParams(0, -2, 1));
        JSONArray files = entry.optJSONArray("attachments");
        if (files != null && files.length() > 0) {
            TextView count = text(files.length() + tr(" 个附件", " files"), Palette.TEXT_TINY, muted);
            count.setGravity(Gravity.CENTER); count.setPadding(dp(8), dp(3), dp(8), dp(3));
            count.setBackground(chatStyle.capsule(Palette.of(this).controlFill));
            head.addView(count);
        }
        item.addView(head);

        String promptText = entry.optString("text").trim();
        if (promptText.isEmpty()) promptText = tr("附件消息", "Attachment message");
        TextView prompt = text(promptText, Palette.TEXT_BODY, ink);
        prompt.setTag("remoteQueuePrompt:" + id);
        prompt.setMaxLines(5); prompt.setEllipsize(android.text.TextUtils.TruncateAt.END);
        prompt.setPadding(0, dp(7), 0, 0); prompt.setLineSpacing(dp(3), 1);
        item.addView(prompt);

        if (files != null && files.length() > 0) {
            TextView names = text(queueAttachmentNames(files), Palette.TEXT_SMALL, muted);
            names.setTag("remoteQueueAttachments:" + id);
            names.setPadding(0, dp(5), 0, 0);
            names.setSingleLine(true); names.setEllipsize(android.text.TextUtils.TruncateAt.END);
            item.addView(names);
        }
        String error = entry.optString("error");
        if (!error.isEmpty()) {
            TextView detail = text(error, Palette.TEXT_SMALL, Palette.of(this).error);
            detail.setPadding(0, dp(6), 0, 0); detail.setMaxLines(2);
            detail.setEllipsize(android.text.TextUtils.TruncateAt.END);
            item.addView(detail);
        }

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.END);
        actions.setClipChildren(false); actions.setClipToPadding(false);
        actions.setPadding(0, dp(2), 0, 0);
        TextView edit = queueSheetAction(tr("编辑", "Edit"), 0, enabled && !starting,
            () -> { dismissQueueSheet(); showQueueEditor(id, entry.optString("text"), entry.optString("text")); });
        edit.setTag("remoteQueueEdit:" + id);
        LinearLayout.LayoutParams editParams = new LinearLayout.LayoutParams(-2, dp(48));
        actions.addView(edit, editParams);

        String steerLabel = queueSteeringGoalId.isEmpty() ? tr("插入任务", "Insert") : tr("发给目标", "To goal");
        TextView steer = queueSheetAction(steerLabel, 1, canSteer,
            () -> { dismissQueueSheet(); queueCommand("queue-steer", id); });
        steer.setTag("remoteQueueSteer:" + id);
        steer.setContentDescription(tr("插入当前任务", "Send into the current task"));
        LinearLayout.LayoutParams steerParams = new LinearLayout.LayoutParams(-2, dp(48));
        steerParams.setMarginStart(dp(4));
        actions.addView(steer, steerParams);

        TextView remove = queueSheetAction(tr("移出", "Remove"), 2, enabled && !starting,
            () -> { dismissQueueSheet(); queueCommand("queue-remove", id); });
        remove.setTag("remoteQueueRemove:" + id);
        LinearLayout.LayoutParams removeParams = new LinearLayout.LayoutParams(-2, dp(48));
        removeParams.setMarginStart(dp(4));
        actions.addView(remove, removeParams);
        item.addView(actions);
        return item;
    }

    private String queueAttachmentNames(JSONArray files) {
        StringBuilder names = new StringBuilder();
        for (int index = 0; index < Math.min(2, files.length()); index++) {
            JSONObject file = files.optJSONObject(index);
            if (file == null) continue;
            if (names.length() > 0) names.append(" · ");
            names.append(file.optString("name", tr("附件", "File")));
        }
        if (files.length() > 2) names.append(" +").append(files.length() - 2);
        return names.toString();
    }

    private TextView queueSheetButton(String label, boolean accentAction, boolean destructive, boolean enabled, Runnable action) {
        Palette palette = Palette.of(this);
        TextView button = text(label, Palette.TEXT_SMALL, destructive ? palette.error : accentAction ? accent : ink);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        if (!enabled) button.setTextColor(muted);
        int fill = destructive && enabled
            ? Color.argb(16, Color.red(palette.error), Color.green(palette.error), Color.blue(palette.error))
            : accentAction && enabled ? Color.argb(22, Color.red(accent), Color.green(accent), Color.blue(accent))
            : palette.controlFill;
        GradientDrawable face = rounded(fill);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, rounded(Color.WHITE)));
        button.setMinWidth(0); button.setMinHeight(dp(48)); button.setPadding(dp(3), 0, dp(3), 0);
        button.setSingleLine(true); button.setEllipsize(android.text.TextUtils.TruncateAt.END);
        button.setGravity(Gravity.CENTER); button.setFocusable(true);
        button.setEnabled(enabled); button.setAlpha(enabled ? 1f : .5f);
        button.setOnClickListener(view -> { if (enabled) action.run(); });
        return button;
    }

    private TextView queueSheetAction(String label, int kind, boolean enabled, Runnable action) {
        Palette palette = Palette.of(this);
        int color = kind == 2 ? palette.error : kind == 1 ? accent : ink;
        TextView button = text(label, Palette.TEXT_SMALL, enabled ? color : muted);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        GradientDrawable face = rounded(kind == 1 && enabled
            ? Color.argb(22, Color.red(accent), Color.green(accent), Color.blue(accent))
            : Color.TRANSPARENT);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face,
            rounded(Color.WHITE)));
        button.setMinWidth(0); button.setMinHeight(dp(48)); button.setPadding(dp(12), 0, dp(12), 0);
        button.setSingleLine(true); button.setEllipsize(android.text.TextUtils.TruncateAt.END);
        button.setGravity(Gravity.CENTER); button.setFocusable(true);
        button.setEnabled(enabled); button.setAlpha(enabled ? 1f : .5f);
        button.setOnClickListener(view -> { if (enabled) action.run(); });
        return button;
    }

    private void dismissQueueSheet() {
        if (queueDialog != null) queueDialog.dismiss();
        queueDialog = null; queueSheetPanel = null;
    }

    private void queueCommand(String action, String id) {
        if (!connected || !controlAllowed || commandBusy || (pendingCommand() != null)) return;
        try {
            JSONObject payload = command(action);
            if (id != null) payload.put("queueId", id);
            if (action.equals("queue-steer")) {
                if (!queueSteeringGoalId.isEmpty()) payload.put("goalId", queueSteeringGoalId);
                else if (lastLive != null) payload.put("runId", lastLive.optLong("runId"));
                else return;
            }
            submitCommand(payload);
        } catch (Exception error) { reportError("无法保存队列操作，请重试。", "Could not save the queue operation. Retry.", error); }
    }

    private void showQueueEditor(String id, String expectedText, String draft) {
        if (!connected || !controlAllowed || commandBusy || pendingCommand() != null) return;
        String target = conversationId, server = instance;
        EditText editor = new EditText(this); editor.setTag("remoteQueueEditor");
        editor.setText(draft); editor.setTextSize(Palette.TEXT_INPUT); editor.setTextColor(ink);
        editor.setGravity(Gravity.TOP); editor.setMinLines(3); editor.setMaxLines(10);
        editor.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        editor.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(16000)});
        SettingsField field = new SettingsField(editor);
        CamelliaDialog dialog = new CamelliaDialog.Builder(this).setTitle(tr("重新编辑", "Edit"))
            .setMessage(tr("保存后保留消息原来的设备归属、排队位置和附件。", "Saving keeps this message's source, queue position and attachments."))
            .setView(field).setPositiveButton(tr("保存", "Save"), null)
            .setNegativeButton(tr("取消", "Cancel"), null).show();
        dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            if (editor.getText().toString().trim().isEmpty()) { editor.setError(tr("请输入消息", "Enter a message")); return; }
            if (!connected || !controlAllowed || commandBusy || pendingCommand() != null || !target.equals(conversationId) || !server.equals(instance)) {
                editor.setError(tr("请等待连接恢复或当前操作完成", "Wait for the connection or current operation")); return;
            }
            try {
                JSONObject payload = command("queue-edit").put("queueId", id).put("expectedText", expectedText).put("prompt", editor.getText().toString());
                submitCommand(payload); dialog.dismiss();
            } catch (Exception error) { editor.setError(tr("无法保存，请重试", "Could not save. Retry.")); }
        });
        editor.requestFocus(); editor.setSelection(editor.length());
    }

    private JSONObject command(String action) throws Exception {
        return new JSONObject().put("action", action).put("requestId", java.util.UUID.randomUUID().toString()).put("instanceId", instance);
    }

    private void sendMessage() {
        if (composer == null || !connected || !controlAllowed || remoteBusy() && (!canQueue || editingSeq > 0) || commandBusy || (pendingCommand() != null) || awaitingSentMessage()) return;
        String prompt = composer.getText().toString(), target = conversationId, address = credentials.optString("address"), server = instance;
        ArrayList<String> images = new ArrayList<>(selectedImages);
        ArrayList<JSONObject> documents = new ArrayList<>(selectedDocuments);
        EditText input = composer;
        locationConsent.request(prompt, computerName(credentials) + tr("（电脑及其模型服务商；会保存到会话历史）", " (computer and its model provider; saved in conversation history)"), context -> {
            if (input == composer && prompt.equals(input.getText().toString()) && target.equals(conversationId)
                    && address.equals(credentials.optString("address")) && server.equals(instance)
                    && images.equals(selectedImages) && documents.equals(selectedDocuments)) sendMessage(context);
        });
    }

    private void sendMessage(String locationContext) {
        if (!connected || !controlAllowed || remoteBusy() && (!canQueue || editingSeq > 0) || commandBusy || (pendingCommand() != null) || awaitingSentMessage()) return;
        String prompt = composer.getText().toString();
        if (loadingImages || (prompt.trim().isEmpty() && selectedImages.isEmpty() && selectedDocuments.isEmpty())) return;
        try {
            ChatAttachments.validateRemote(this, selectedImages, selectedDocuments, canAttachments, canFileAttachments, canMultiImage);
            boolean editing = editingSeq > 0;
            JSONObject payload = command(editing ? "resend" : "send").put("prompt", (prompt.trim().isEmpty() ? tr("请查看这些附件。", "Please review these attachments.") : prompt) + locationContext).put("expectedSeq", conversationSeq);
            if (editing) payload.put("editSeq", editingSeq);
            else if (canQueue) payload.put("queue", true);
            if ((canAttachments || canFileAttachments) && (!selectedImages.isEmpty() || !selectedDocuments.isEmpty())) payload.put("attachments", ChatAttachments.remote(selectedImages, selectedDocuments));
            else if (selectedImages.size() == 1) payload.put("image", selectedImages.get(0));
            else if (!selectedImages.isEmpty()) payload.put("images", new JSONArray(selectedImages));
            submitCommand(payload);
        }
        catch (Exception error) { reportError("无法保存操作，请重试。", "Could not save the operation. Retry.", error); }
    }

    private void stopRun() {
        if (!connected || !controlAllowed || lastLive == null && (!canStopStart || remotePreparation == null)
                || RemotePendingCommands.get(credentials, conversationId, true) != null) return;
        long runId = lastLive == null ? 0 : lastLive.optLong("runId");
        String server = instance, target = conversationId;
        String startId = remotePreparation == null ? "" : remotePreparation.optString("startId");
        new CamelliaDialog.Builder(this).setTitle(tr("停止当前任务？", "Stop the current run?"))
            .setMessage(tr("停止当前任务并暂停待发送队列，不撤销已经执行的文件操作；关联的自动任务可能暂停。", "Stops this run and pauses queued messages without undoing completed file operations. Related automatic tasks may be paused."))
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("停止", "Stop"), (dialog, which) -> {
                if (!target.equals(conversationId) || !server.equals(instance)) return;
                try { submitCommand(runId > 0 ? command("stop").put("instanceId", server).put("runId", runId)
                    : command("stop-start").put("instanceId", server).put("startId", startId)); }
                catch (Exception error) { reportError("无法保存操作。", "Could not save operation.", error); }
            }).show();
    }

    // Goal and scheduled-task state for this conversation. The snapshot already
    // carries it, so showing it here needs no protocol change; pausing and
    // resuming reuse the existing goal-control and task-control commands.
    private LinearLayout automationCard() {
        LinearLayout card = column();
        GradientDrawable face = rounded(surface);
        face.setStroke(dp(1), Palette.of(this).cardBorder);
        card.setBackground(face);
        card.setClipToOutline(true);
        SurfaceElevation.apply(card, 1);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(dp(8), dp(4), dp(8), dp(4));
        card.setLayoutParams(params);
        return card;
    }

    private void renderAutomation(JSONObject snapshot) {
        // Automation belongs to the conversation snapshot, not its optional
        // live turn. Keep the same filtered state for the bar and work sheet.
        JSONObject automation = snapshot.optJSONObject("automation");
        JSONObject goal = automation == null ? null : automation.optJSONObject("goal");
        JSONArray tasks = automation == null ? null : automation.optJSONArray("tasks");
        long latestUserSeq = 0, latestUserAt = 0;
        for (JSONObject row : history.values()) if (row.optString("role").equals("user")) {
            latestUserSeq = Math.max(latestUserSeq, row.optLong("seq"));
            latestUserAt = Math.max(latestUserAt, row.optLong("at"));
        }
        String goalKey = goal == null ? "" : goal.optString("id", "");
        if (goal != null && goalKey.isEmpty()) goalKey = goal.optString("objective", "");
        boolean hasGoal = goalVisibility.show(goalKey, goal == null ? "" : goal.optString("phase", ""),
            goal == null ? 0 : goal.optLong("completedAt"), latestUserSeq, latestUserAt);
        remoteGoal = hasGoal ? goal : null;
        remoteTasks = tasks == null ? new JSONArray() : tasks;
        renderAutomationViews();
    }

    private void renderAutomationViews() {
        if (automationBar == null) return;
        automationBar.removeAllViews();
        int taskCount = remoteTasks.length();
        automationBar.setVisibility(remoteGoal != null || taskCount > 0 ? View.VISIBLE : View.GONE);
        automationBar.setPadding(0, dp(4), 0, dp(4));
        if (remoteGoal != null) automationBar.addView(automationCard(remoteGoal));
        if (taskCount > 0) {
            TextView heading = text(String.format(tr("定时任务 · %d", "Scheduled · %d"), taskCount), Palette.TEXT_SMALL, muted);
            heading.setPadding(dp(12), dp(2), dp(12), 0); automationBar.addView(heading);
            for (int index = 0; index < taskCount; index++) {
                JSONObject task = remoteTasks.optJSONObject(index);
                if (task != null) automationBar.addView(automationTask(task));
            }
        }
        refreshWorkSummaryBar();
        renderWorkAutomation();
    }

    private View automationCard(JSONObject goal) {
        String phase = goal.optString("phase", "");
        boolean armed = goal.optBoolean("armed");
        boolean running = phase.equals("active") && armed;
        JSONObject waiting = running ? goal.optJSONObject("waiting") : null;
        String label = phase.equals("complete") ? tr("目标已完成", "Goal complete")
            : phase.equals("blocked") ? tr("目标受阻", "Goal blocked")
            : waiting != null ? tr("目标等待中", "Goal waiting")
            : running ? tr("目标进行中", "Goal running") : tr("目标已暂停", "Goal paused");
        LinearLayout card = automationCard(); card.setTag("remoteGoal");
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(12), dp(10), dp(12), dp(10));
        TextView status = text(label, Palette.TEXT_NOTE, running ? accent : muted);
        status.setTag("remoteGoalState"); status.setSingleLine(true);
        row.addView(status, new LinearLayout.LayoutParams(-2, -2));
        TextView objective = text(goal.optString("objective", ""), Palette.TEXT_BODY, ink);
        objective.setPadding(dp(10), 0, dp(10), 0); objective.setSingleLine(true);
        objective.setEllipsize(android.text.TextUtils.TruncateAt.END); objective.setTag("remoteGoalObjective");
        row.addView(objective, new LinearLayout.LayoutParams(0, -2, 1));
        int rounds = goal.optInt("roundsStarted", 0);
        if (rounds > 0) {
            TextView count = text(String.valueOf(rounds), Palette.TEXT_SMALL, muted); count.setPadding(dp(6), 0, dp(6), 0);
            row.addView(count, new LinearLayout.LayoutParams(-2, -2));
        }
        // Paused and blocked goals resume from the same saved goal. Older hosts
        // can also report a disarmed goal with phase=active.
        if (phase.equals("active") || phase.equals("paused") || phase.equals("blocked")) {
            TextView toggle = text(running ? tr("暂停", "Pause") : tr("恢复", "Resume"), Palette.TEXT_NOTE, accent);
            toggle.setTag("remoteGoalToggle"); toggle.setMinHeight(dp(48));
            toggle.setGravity(Gravity.CENTER); toggle.setPadding(dp(10), dp(6), dp(10), dp(6));
            toggle.setBackground(accentActionBackground()); toggle.setFocusable(true);
            toggle.setContentDescription((running ? tr("暂停目标：", "Pause goal: ") : tr("恢复目标：", "Resume goal: ")) + goal.optString("objective", ""));
            toggle.setOnClickListener(view -> submitAutomation("goal-control", running ? "pause" : "resume", null));
            row.addView(toggle, new LinearLayout.LayoutParams(-2, -2));
        }
        card.addView(row);
        if (waiting != null) {
            String reason = waiting.optString("reason", "");
            if (!reason.isEmpty()) {
                TextView detail = text(reason, Palette.TEXT_NOTE, muted); detail.setTag("remoteGoalWaitingReason");
                detail.setPadding(dp(12), 0, dp(12), dp(4)); detail.setMaxLines(3);
                detail.setEllipsize(android.text.TextUtils.TruncateAt.END);
                card.addView(detail, new LinearLayout.LayoutParams(-1, -2));
            }
            long until = waiting.optLong("until");
            if (until > 0) {
                java.text.DateFormat format = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT,
                    java.text.DateFormat.SHORT, chinese ? java.util.Locale.SIMPLIFIED_CHINESE : java.util.Locale.ENGLISH);
                TextView next = text(tr("下次检查：", "Next check: ") + format.format(new java.util.Date(until)), Palette.TEXT_SMALL, muted);
                next.setTag("remoteGoalNextCheck"); next.setPadding(dp(12), 0, dp(12), dp(10));
                card.addView(next, new LinearLayout.LayoutParams(-1, -2));
            }
        }
        return card;
    }

    private View automationTask(JSONObject task) {
        LinearLayout card = automationCard(); card.setTag("remoteTask");
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(12), dp(8), dp(12), dp(8));
        String status = task.optString("status", "");
        String label = status.equals("running") ? tr("检查中", "Checking") : status.equals("paused") ? tr("已暂停", "Paused")
            : status.equals("complete") ? tr("已完成", "Complete") : tr("等待", "Waiting");
        TextView state = text(label, Palette.TEXT_SMALL, muted); state.setTag("remoteTaskState"); row.addView(state, new LinearLayout.LayoutParams(-2, -2));
        TextView instruction = text(task.optString("instruction", ""), Palette.TEXT_NOTE, ink);
        instruction.setPadding(dp(10), 0, dp(10), 0); instruction.setSingleLine(true);
        instruction.setEllipsize(android.text.TextUtils.TruncateAt.END); instruction.setTag("remoteTaskInstruction");
        row.addView(instruction, new LinearLayout.LayoutParams(0, -2, 1));
        int minutes = task.optInt("intervalMinutes", 0);
        if (minutes > 0) {
            TextView interval = text(tr("每 ", "every ") + minutes + tr(" 分钟", " min"), Palette.TEXT_SMALL, muted);
            interval.setPadding(dp(6), 0, dp(6), 0); row.addView(interval, new LinearLayout.LayoutParams(-2, -2));
        }
        if (status.equals("scheduled") || status.equals("running") || status.equals("paused")) {
            boolean pause = !status.equals("paused");
            TextView toggle = text(pause ? tr("暂停", "Pause") : tr("恢复", "Resume"), Palette.TEXT_NOTE, accent);
            toggle.setTag("remoteTaskToggle"); toggle.setMinHeight(dp(48));
            toggle.setGravity(Gravity.CENTER); toggle.setPadding(dp(10), dp(6), dp(10), dp(6));
            toggle.setBackground(accentActionBackground()); toggle.setFocusable(true);
            toggle.setContentDescription((pause ? tr("暂停任务：", "Pause task: ") : tr("恢复任务：", "Resume task: ")) + task.optString("instruction", ""));
            String id = task.optString("id");
            toggle.setOnClickListener(view -> submitAutomation("task-control", pause ? "pause" : "resume", id));
            row.addView(toggle, new LinearLayout.LayoutParams(-2, -2));
        }
        card.addView(row); return card;
    }

    // Automation controls are existing commands, so the request/retry rules and
    // the per-command idempotency journal apply unchanged.
    private void submitAutomation(String action, String operation, String taskId) {
        if (!connected || !controlAllowed || commandBusy || (pendingCommand() != null)) return;
        try {
            JSONObject payload = command(action).put("instanceId", instance).put("operation", operation);
            if (taskId != null) payload.put("taskId", taskId);
            submitCommand(payload);
        } catch (Exception error) { reportError("无法保存操作。", "Could not save operation.", error); }
    }

    private void renderApprovals() {
        viewHandler.post(this::notifyApprovalRequests);
        JSONArray requests = controlAllowed && lastLive != null ? lastLive.optJSONArray("approvals") : null;
        String signature = instance + ":" + (lastLive == null ? "" : lastLive.optLong("runId")) + ":" + String.valueOf(requests);
        String scope = conversationId + ":" + instance + ":" + (lastLive == null ? "" : lastLive.optLong("runId")) + ":";
        boolean stillPending = false;
        for (int i = 0; requests != null && i < requests.length(); i++)
            if (requests.optJSONObject(i) != null && remoteApprovalKey.equals(scope + requests.optJSONObject(i).optString("fingerprint"))) stillPending = true;
        if (remoteApprovalDialog != null && !stillPending) { remoteApprovalDialog.dismiss(); remoteApprovalDialog = null; }
        if (signature.equals(approvalSignature)) return;
        approvalSignature = signature; approvals.removeAllViews();
        if (requests == null) return;
        for (int index = 0; index < requests.length(); index++) {
            JSONObject request = requests.optJSONObject(index); if (request == null) continue;
            approvals.addView(text(request.optString("toolName"), Palette.TEXT_ROW_STRONG, accent));
            TextView details = text(request.optString("details"), Palette.TEXT_NOTE, ink); details.setTypeface(Typeface.MONOSPACE); details.setTextIsSelectable(true); approvals.addView(details);
            if (!request.optBoolean("responseSupported", request.optBoolean("actionable"))) {
                approvals.addView(text(tr("此请求需要电脑处理（问答或内容过长）。", "Handle this request on the computer (questions or oversized details)."), Palette.TEXT_NOTE, muted)); continue;
            }
            long runId = lastLive.optLong("runId"); String server = instance;
            if (request.optJSONArray("questions") != null && request.optJSONArray("questions").length() > 0) {
                approvals.addView(button(tr("回答问题", "Answer questions"), () -> {
                    if (!connected || !controlAllowed || commandBusy || (pendingCommand() != null)) return;
                    if (remoteApprovalDialog != null) remoteApprovalDialog.dismiss();
                    String target = conversationId;
                    remoteApprovalKey = scope + request.optString("fingerprint");
                    remoteApprovalDialog = RemoteApprovalDialog.show(this, request, conversationTitle, (allow, input, optionId) -> {
                        if (!target.equals(conversationId) || !server.equals(instance) || lastLive == null || lastLive.optLong("runId") != runId || !connected || commandBusy || (pendingCommand() != null)) return false;
                        JSONObject payload = command("approve").put("instanceId", server).put("runId", runId).put("approvalId", request.getString("requestId"))
                            .put("fingerprint", request.getString("fingerprint")).put("allow", allow);
                        if (input != null) payload.put("input", input); if (optionId != null) payload.put("optionId", optionId);
                        submitCommand(payload); return true;
                    });
                }, true)); continue;
            }
            for (boolean allow : new boolean[]{false, true}) {
                approvals.addView(button(allow ? tr("允许一次", "Allow once") : tr("拒绝", "Deny"), () -> {
                    if (!connected || !controlAllowed || commandBusy || (pendingCommand() != null)) return;
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
        refreshWorkSummaryBar();
    }

    private void notifyApprovalRequests() {
        if (!foreground || !screen.equals("detail") || !connected || !controlAllowed || lastLive == null) return;
        String scope = new JSONArray().put(credentials.optString("address")).put(credentials.optString("deviceId"))
            .put(instance).put("conversation").put(conversationId).put(lastLive.optString("runId")).toString();
        MobileHaptics.pendingRequests(this, approvals, scope, lastLive.optJSONArray("approvals"));
    }

    private void showRemoteSettings(boolean permissions) {
        if (!connected || !controlAllowed || commandBusy || (pendingCommand() != null) || remoteSettings == null
            || !(permissions ? remoteSettings.optBoolean("editable") : remoteSettings.optBoolean("modelEditable", remoteSettings.optBoolean("editable")))) return;
        if (settingsPopup != null) {
            boolean sameTrigger = settingsPopup.isShowing(permissions ? permissionButton : modelButton);
            settingsPopup.dismiss(); settingsPopup = null;
            if (sameTrigger) return;
        }
        String version = remoteSettings.optString("version"), server = instance, target = conversationId;
        settingsPopup = new RemoteSettingsPopup(this, chinese, background, ink, muted, accent, remoteSettings, (key, value) -> {
            if (!target.equals(conversationId) || !server.equals(instance) || remoteSettings == null || !version.equals(remoteSettings.optString("version"))) return;
            try {
                if (key.equals("codexReset")) {
                    setStatusNotice(tr("正在查询电脑账号的重置卡…", "Checking this computer account's reset credits…"));
                    submitCommand(command("codex-reset-preview")); return;
                }
                JSONObject changes = key.equals("modelChoice") ? new JSONObject(value)
                    : new JSONObject().put(key, key.equals("fastMode") || key.equals("quickSwitch") ? Boolean.parseBoolean(value) : value);
                submitCommand(command("configure").put("instanceId", server).put("expectedSettings", version).put("settings", changes));
            } catch (Exception error) { reportError("无法保存设置，请重试。", "Could not save settings. Try again.", error); }
        });
        settingsPopup.setResetCreditsAvailable(canCodexReset && remoteSettings.optString("engine").equals("codex") && remoteSettings.optString("connection").equals("subscription"));
        settingsPopup.show(permissions ? permissionButton : modelButton, permissions);
    }

    private void submitCommand(JSONObject payload) throws Exception {
        boolean stop = payload.optString("action").equals("stop") || payload.optString("action").equals("stop-start") || payload.optString("action").equals("stop-background-work");
        if (!foreground || !connected || !controlAllowed || (!stop && (commandBusy || pendingCommand() != null))
                || stop && RemotePendingCommands.get(credentials, conversationId, true) != null) return;
        JSONObject saved = new JSONObject(credentials.toString());
        JSONObject pending = new JSONObject().put("conversationId", conversationId).put("payload", payload);
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) pending.put("draft", composer.getText().toString()).put("at", System.currentTimeMillis());
        RemotePendingCommands.put(saved, pending, stop);
        store.save(saved); credentials = saved;
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) {
            outgoingMessage = pending;
            editingSeq = -1; editingText = "";
            composer.setText(""); selectedImages.clear(); selectedDocuments.clear(); renderImage();
            persistDraft();
            outgoingState("sending");
            viewHandler.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        }
        updateControls();
        commandCheckDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
        if (stop) retryPendingCommand(pending, true, true); else retryCommand(false);
    }

    private JSONObject pendingCommand() { return RemotePendingCommands.get(credentials, conversationId, false); }
    private String commandKey(JSONObject profile, JSONObject payload) {
        return profile.optString("address") + "#" + profile.optString("token") + "#" + payload.optString("requestId");
    }
    static String commandTransportKey(JSONObject profile) {
        return profile.optString("address") + "#" + profile.optString("token");
    }
    private RemoteApi commandClient(JSONObject owner) {
        String key = commandTransportKey(owner);
        synchronized (commandClients) {
            RemoteApi client = commandClients.get(key);
            if (client == null) {
                client = new RemoteApi(this, owner.optString("address"));
                commandClients.put(key, client);
            }
            return client;
        }
    }
    private void closeCommandClients() {
        java.util.ArrayList<RemoteApi> clients;
        synchronized (commandClients) {
            clients = new java.util.ArrayList<>(commandClients.values());
            commandClients.clear();
        }
        for (RemoteApi client : clients) new Thread(client::cancel, "camellia-command-disconnect").start();
        commandHandler.removeCallbacksAndMessages(null);
        scheduledCommandChecks.clear();
    }

    private void retryCommand() { retryCommand(true); }

    private void retryStopCommand() {
        JSONObject stop = RemotePendingCommands.get(credentials, conversationId, true); if (stop == null) return;
        if (stop.optBoolean("uncertain")) {
            String request = stop.optJSONObject("payload").optString("requestId");
            new CamelliaDialog.Builder(this).setMessage(tr("请核对电脑上的任务是否已停止，再解除待确认。", "Check whether the desktop task stopped before resolving this record."))
                .setPositiveButton(tr("继续查询", "Check again"), (d, w) -> retryPendingCommand(stop, true, true))
                .setNeutralButton(tr("已核对，解除待确认", "Checked; resolve"), (d, w) -> resolvePendingCommand(request))
                .setNegativeButton(tr("暂不处理", "Later"), null).show();
        } else retryPendingCommand(stop, true, true);
    }

    private void retryCommand(boolean userInitiated) {
        JSONObject pending = pendingCommand();
        if (pending == null) return;
        JSONObject payload = pending.optJSONObject("payload");
        boolean submitted = payload != null && (payload.optString("action").equals("send") || payload.optString("action").equals("resend"));
        if (userInitiated && (pending.optBoolean("uncertain") || submitted)) {
            String request = payload == null ? "" : payload.optString("requestId");
            new CamelliaDialog.Builder(this).setTitle(submitted
                    ? tr("核对未确认消息", "Check unconfirmed message") : tr("核对未确认操作", "Check unconfirmed action"))
                .setMessage(submitted
                    ? tr("消息可能已经发送。查询原请求不会重复发送；如果电脑上已经出现这条消息，可直接解除手机上的待确认记录。", "The message may have been sent. Checking keeps the original request; if it is already visible on the computer, resolve the pending record on this phone.")
                    : tr("操作可能已经执行。查询不会创建新请求；解除待确认只清除手机记录，不会取消电脑操作。", "The action may have executed. Checking keeps the same request. Resolving only clears the phone's pending record; it does not cancel desktop work."))
                .setPositiveButton(tr("继续查询", "Check again"), (d, w) -> { commandCheckDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS; retryPendingCommand(pending, false, false); })
                .setNeutralButton(tr("已核对，解除待确认", "Checked; resolve"), (d, w) -> resolvePendingCommand(request))
                .setNegativeButton(tr("暂不处理", "Later"), null).show(); return;
        }
        if (payload == null) return;
        retryPendingCommand(pending, userInitiated, payload.optString("action").startsWith("stop"));
    }

    private void resolvePendingCommand(String request) {
        try {
            JSONObject saved = new JSONObject(credentials.toString()); JSONObject pending = RemotePendingCommands.find(saved, request);
            boolean stop = pending != null && pending.optJSONObject("payload") != null && pending.optJSONObject("payload").optString("action").startsWith("stop");
            RemotePendingCommands.remove(saved, request);
            store.save(saved); credentials = saved;
            if (!stop) { outgoingMessage = null; commandBusy = false; }
            if (workStatus != null) workStatus.clear();
            renderMessages(lastLive); updateControls();
        } catch (Exception error) { reportError("无法保存核对结果。", "Could not save the resolution.", error); }
    }

    private void retryPendingCommand(JSONObject pending, boolean userInitiated, boolean urgent) {
        if (!foreground || !connected || !controlAllowed || pending == null) return;
        String target = pending.optString("conversationId"); JSONObject payload = pending.optJSONObject("payload");
        if (payload == null || !target.equals(conversationId)) return;
        String key = commandKey(credentials, payload);
        if (commandRequests.contains(key)) return;
        if (!urgent) commandBusy = true;
        boolean sending = payload.optString("action").equals("send") || payload.optString("action").equals("resend");
        // Only the user-facing entry point opens a confirmation window; the
        // automatic checks reuse it. Re-arming on every poll would push the
        // deadline out forever and the wait would never report a timeout.
        if (userInitiated) {
            commandCheckDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
            if (sending) outgoingState("sending");
            if (workStatus != null) workStatus.clear();
        }
        updateControls();
        boolean query = canCommandReceipts && pending.optBoolean("dispatched");
        JSONObject owner;
        try {
            pending.put("dispatched", true); store.save(credentials); owner = new JSONObject(credentials.toString());
        } catch (Exception error) { commandBusy = false; reportError("无法保存操作，请重试。", "Could not save the action. Retry.", error); updateControls(); return; }
        commandRequests.add(key);
        RemoteApi client = commandClient(owner); String token = owner.optString("token");
        long deadline = commandCheckDeadline > 0
            ? commandCheckDeadline : android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
        (urgent ? urgentWorker : commandWorker).submit(() -> {
            try {
                JSONObject result;
                try { result = client.json(query ? "/v1/commands/" + payload.optString("requestId") : "/v1/conversations/" + target + "/commands", token, query ? null : payload); }
                catch (RemoteApi.Failure missing) {
                    if (!query || missing.status != 404) throw missing;
                    result = client.json("/v1/conversations/" + target + "/commands", token, payload);
                }
                JSONObject receipt = result;
                commandHandler.post(() -> receiveCommand(owner, payload, receipt, urgent, deadline));
            } catch (Exception error) {
                commandHandler.post(() -> {
                    commandRequests.remove(key);
                    boolean current = sameComputer(owner) && foreground && !isDestroyed()
                        && screen.equals("detail") && target.equals(conversationId);
                    if (!query && error instanceof RemoteApi.Failure && java.util.Set.of(400, 403, 409, 413).contains(((RemoteApi.Failure) error).status)) {
                        if (current) { finishCommand(payload, new JSONObject()); showFailure(error, true); }
                        else receiveCommand(owner, payload, new JSONObject(), urgent, deadline);
                        return;
                    }
                    try { markUncertain(owner, payload); }
                    catch (Exception saveError) { if (current) reportError("无法保存待确认状态。", "Could not save pending state.", saveError); }
                    if (current) {
                        if (!urgent) commandBusy = false;
                        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("unconfirmed");
                        setStatusError(ErrorDetails.withSummary(tr("发送未确认：连接失败或超时。请重试同一请求，避免重复发送。", "Send unconfirmed: connection failed or timed out. Retry the same request to avoid duplicates."), error));
                        updateControls();
                    }
                    int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
                    if ((status == 0 || status >= 500)
                            && android.os.SystemClock.elapsedRealtime() < deadline)
                        scheduleCommandCheck(owner, payload, urgent, deadline);
                });
            }
        });
    }

    private JSONObject pendingFor(JSONObject owner, String requestId) {
        if (sameComputer(owner)) return RemotePendingCommands.find(credentials, requestId);
        try {
            JSONObject profile = commandProfile(owner);
            return profile == null ? null : RemotePendingCommands.find(profile, requestId);
        } catch (Exception ignored) { return null; }
    }

    private void resumePendingCommands() {
        if (!foreground || !credentials.has("token")) return;
        try {
            long deadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
            JSONObject owner = commandOwner();
            for (JSONObject pending : RemotePendingCommands.all(credentials)) {
                JSONObject payload = pending.optJSONObject("payload");
                if (payload == null || !pending.optBoolean("dispatched")) continue;
                if (screen.equals("detail") && pending.optString("conversationId").equals(conversationId))
                    commandCheckDeadline = Math.max(commandCheckDeadline, deadline);
                scheduleCommandCheck(owner, payload, payload.optString("action").startsWith("stop"), deadline);
            }
        } catch (Exception error) {
            reportError("无法恢复后台操作，请重新打开会话处理。", "Could not resume background actions; reopen the conversation.", error);
        }
    }

    private JSONObject commandOwner() {
        try { return new JSONObject(credentials.toString()); }
        catch (Exception ignored) { return credentials; }
    }

    private void scheduleCommandCheck(JSONObject owner, JSONObject payload, boolean urgent, long deadline) {
        if (payload == null) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (deadline <= 0) deadline = now + COMMAND_CONFIRM_TIMEOUT_MS;
        if (deadline <= now) { markCommandTimedOut(owner, payload); return; }
        String key = commandKey(owner, payload);
        synchronized (scheduledCommandChecks) {
            if (!scheduledCommandChecks.add(key)) return;
        }
        long delay = Math.max(1, Math.min(COMMAND_POLL_INTERVAL_MS, deadline - now));
        long checkDeadline = deadline;
        commandHandler.postDelayed(() -> {
            synchronized (scheduledCommandChecks) { scheduledCommandChecks.remove(key); }
            JSONObject pending = pendingFor(owner, payload.optString("requestId"));
            if (pending == null) return;
            long at = android.os.SystemClock.elapsedRealtime();
            if (at >= checkDeadline) { markCommandTimedOut(owner, payload); return; }
            if (commandRequests.contains(key)) {
                scheduleCommandCheck(owner, payload, urgent, checkDeadline);
                return;
            }
            retryPendingCommandInBackground(owner, pending, urgent, checkDeadline);
        }, delay);
    }

    private void retryPendingCommandInBackground(JSONObject owner, JSONObject pending, boolean urgent, long deadline) {
        if (!networkActive() || pending == null) return;
        JSONObject payload = pending.optJSONObject("payload");
        if (payload == null) return;
        String target = pending.optString("conversationId");
        String key = commandKey(owner, payload);
        if (commandRequests.contains(key)) return;
        boolean query = canCommandReceipts && pending.optBoolean("dispatched");
        commandRequests.add(key);
        RemoteApi client = commandClient(owner);
        String token = owner.optString("token");
        long until = deadline > 0 ? deadline
            : android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
        (urgent ? urgentWorker : commandWorker).submit(() -> {
            try {
                JSONObject result;
                try { result = client.json(query ? "/v1/commands/" + payload.optString("requestId") : "/v1/conversations/" + target + "/commands", token, query ? null : payload); }
                catch (RemoteApi.Failure missing) {
                    if (!query || missing.status != 404) throw missing;
                    result = client.json("/v1/conversations/" + target + "/commands", token, payload);
                }
                JSONObject receipt = result;
                commandHandler.post(() -> receiveCommand(owner, payload, receipt, urgent, until));
            } catch (Exception error) {
                commandHandler.post(() -> {
                    commandRequests.remove(key);
                    if (!query && error instanceof RemoteApi.Failure
                            && java.util.Set.of(400, 403, 409, 413).contains(((RemoteApi.Failure) error).status)) {
                        receiveCommand(owner, payload, new JSONObject(), urgent, until);
                        if (sameComputer(owner) && foreground && screen.equals("detail")) showFailure(error, true);
                        return;
                    }
                    try { markUncertain(owner, payload); } catch (Exception ignored) { }
                    if (sameComputer(owner) && foreground && !isDestroyed() && screen.equals("detail")
                            && target.equals(conversationId)) {
                        commandBusy = false;
                        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend"))
                            outgoingState("unconfirmed");
                        setStatusError(ErrorDetails.withSummary(tr("发送未确认：连接失败或超时。请重试同一请求，避免重复发送。", "Send unconfirmed: connection failed or timed out. Retry the same request to avoid duplicates."), error));
                        updateControls();
                    }
                    int status = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
                    if (networkActive() && (status == 0 || status >= 500)
                            && android.os.SystemClock.elapsedRealtime() < until)
                        scheduleCommandCheck(owner, payload, urgent, until);
                });
            }
        });
    }

    private void markCommandTimedOut(JSONObject owner, JSONObject payload) {
        try { markUncertain(owner, payload); }
        catch (Exception error) { if (sameComputer(owner)) reportError("无法保存待确认状态。", "Could not save pending state.", error); }
        JSONObject pending = pendingFor(owner, payload.optString("requestId"));
        String target = pending == null ? "" : pending.optString("conversationId");
        if (!sameComputer(owner) || !foreground || isDestroyed() || !screen.equals("detail")
                || !target.equals(conversationId)) return;
        commandBusy = false;
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend"))
            outgoingState("unconfirmed");
        setStatusError(tr("等待电脑确认超时，操作可能已执行。请重试同一请求，不要重复发送。", "Timed out waiting for confirmation; the operation may have executed. Retry the same request, not a new copy."));
        updateControls();
    }

    private boolean sameComputer(JSONObject owner) {
        return owner.optString("address").equals(credentials.optString("address")) && owner.optString("token").equals(credentials.optString("token"));
    }

    private JSONObject commandProfile(JSONObject owner) throws Exception {
        for (JSONObject profile : store.all()) if (profile.optString("address").equals(owner.optString("address"))
                && profile.optString("token").equals(owner.optString("token"))) return sameComputer(owner) ? new JSONObject(credentials.toString()) : profile;
        return null;
    }

    private void markUncertain(JSONObject owner, JSONObject payload) throws Exception {
        JSONObject saved = commandProfile(owner); if (saved == null) return;
        JSONObject pending = RemotePendingCommands.find(saved, payload.optString("requestId")); if (pending == null) return;
        pending.put("uncertain", true);
        if (store.saveProfile(saved) && sameComputer(owner)) credentials = saved;
    }

    private void receiveCommand(JSONObject owner, JSONObject payload, JSONObject result) {
        long deadline = commandCheckDeadline > 0
            ? commandCheckDeadline : android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
        receiveCommand(owner, payload, result, payload.optString("action").startsWith("stop"), deadline);
    }

    private void receiveCommand(JSONObject owner, JSONObject payload, JSONObject result, boolean urgent, long deadline) {
        commandRequests.remove(commandKey(owner, payload));
        try { if (commandProfile(owner) == null) return; }
        catch (Exception error) { if (sameComputer(owner)) reportError("无法读取操作记录，请重试同一请求。", "Could not read the action record. Retry the same request.", error); return; }
        JSONObject currentPending = RemotePendingCommands.find(credentials, payload.optString("requestId"));
        if (sameComputer(owner) && foreground && !isDestroyed() && screen.equals("detail") && currentPending != null && conversationId.equals(currentPending.optString("conversationId"))) {
            // A receipt may arrive after this window expired or the user
            // changed it. Only restore an unset window; never re-arm it here.
            if (commandCheckDeadline == 0) commandCheckDeadline = deadline;
            finishCommand(payload, result); return;
        }
        try {
            JSONObject saved = commandProfile(owner); if (saved == null) return;
            JSONObject pending = RemotePendingCommands.find(saved, payload.optString("requestId")); if (pending == null) return;
            String state = result.optString("state");
            if (state.equals("pending")) {
                if (android.os.SystemClock.elapsedRealtime() >= deadline) pending.put("uncertain", true);
            } else if (state.equals("unknown")) {
                pending.put("uncertain", true);
            } else {
                RemotePendingCommands.remove(saved, payload.optString("requestId"));
                String target = pending.optString("conversationId");
                if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) {
                    JSONObject drafts = saved.optJSONObject("drafts");
                    if (drafts == null) { drafts = new JSONObject(); saved.put("drafts", drafts); }
                    if (result.optBoolean("ok")) {
                        if (drafts.optString(target).equals(pending.optString("draft"))) drafts.remove(target);
                        JSONObject files = saved.optJSONObject("draftAttachments");
                        if (files != null && AttachmentStore.references(files.optJSONObject(target)).equals(AttachmentStore.references(payload))) files.remove(target);
                    } else if (drafts.optString(target).isEmpty()) {
                        drafts.put(target, pending.optString("draft", payload.optString("prompt")));
                        JSONObject files = saved.optJSONObject("draftAttachments"); if (files == null) { files = new JSONObject(); saved.put("draftAttachments", files); }
                        files.put(target, payload);
                        if (payload.has("editSeq")) { JSONObject edits = saved.optJSONObject("draftEdits"); if (edits == null) { edits = new JSONObject(); saved.put("draftEdits", edits); } edits.put(target, payload.optLong("editSeq")); }
                    }
                }
            }
            if (store.saveProfile(saved) && sameComputer(owner)) {
                credentials = saved;
                if (outgoingMessage != null && outgoingMessage.optJSONObject("payload") != null
                    && payload.optString("requestId").equals(outgoingMessage.optJSONObject("payload").optString("requestId"))
                    && !result.optString("state").equals("pending") && !result.optString("state").equals("unknown")) outgoingMessage = null;
                if (!isDestroyed() && foreground) updateControls();
            }
            if (state.equals("pending") && android.os.SystemClock.elapsedRealtime() < deadline)
                scheduleCommandCheck(owner, payload, urgent, deadline);
        } catch (Exception error) { if (sameComputer(owner)) reportError("无法保存操作结果，请重试同一请求。", "Could not save result. Retry the same request.", error); }
    }

    private void finishCommand(JSONObject payload, JSONObject result) {
        JSONObject queued = RemotePendingCommands.find(credentials, payload.optString("requestId"));
        if (queued == null || queued.optJSONObject("payload") == null
                || !payload.optString("requestId").equals(queued.optJSONObject("payload").optString("requestId"))) return;
        boolean urgent = payload.optString("action").startsWith("stop");
        if (!urgent) commandBusy = false;
        if (result.optBoolean("ok") && workStatus != null) workStatus.clear();
        if (result.optString("state").equals("pending")) {
            if (android.os.SystemClock.elapsedRealtime() >= commandCheckDeadline) {
                markCommandTimedOut(credentials, payload); return;
            }
            if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("preparing");
            scheduleCommandCheck(commandOwner(), payload, urgent, commandCheckDeadline);
            updateControls();
            return;
        }
        if (result.optString("state").equals("unknown")) {
            try { markUncertain(credentials, payload); } catch (Exception error) { reportError("无法保存待确认状态。", "Could not save pending state.", error); }
            if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) outgoingState("unconfirmed");
            setStatusError(tr("电脑无法确认该请求结果，请先到电脑核对；不会自动重复发送。", "The computer cannot confirm this request. Inspect it on the computer; it will not be resent automatically."));
            updateControls(); return;
        }
        try (AttachmentMaintenance.Lease responding = AttachmentMaintenance.protect(this, payload)) {
            String target = queued.optString("conversationId");
            boolean submitted = payload.optString("action").equals("send") || payload.optString("action").equals("resend");
            JSONObject saved = new JSONObject(credentials.toString()); RemotePendingCommands.remove(saved, payload.optString("requestId"));
            // An accepted send is the only moment the stored draft is known to be
            // delivered, so it is the safe place to drop it for good.
            if (result.optBoolean("ok") && submitted && target != null) {
                JSONObject drafts = saved.optJSONObject("drafts");
                if (drafts != null && drafts.optString(target).equals(queued.optString("draft", payload.optString("prompt")))) {
                    drafts.remove(target);
                    JSONObject edits = saved.optJSONObject("draftEdits"); if (edits != null) edits.remove(target);
                }
                JSONObject files = saved.optJSONObject("draftAttachments");
                if (files != null && AttachmentStore.references(files.optJSONObject(target)).equals(AttachmentStore.references(payload))) files.remove(target);
            }
            store.save(saved); credentials = saved;
            JSONObject current = result.optJSONObject("current");
            boolean currentState = payload.optString("instanceId").equals(instance) || current != null && current.optString("instanceId").equals(instance);
            if (current != null && currentState) applySnapshot(current);
            if (result.optBoolean("ok")) {
                if (current == null && currentState) {
                    JSONObject settings = result.optJSONObject("settings");
                    if (settings != null && remoteSettings != null && payload.optString("expectedSettings").equals(remoteSettings.optString("version"))) remoteSettings = settings;
                    if (urgent && (lastLive == null || lastLive.optLong("runId") == payload.optLong("runId"))) {
                        lastLive = null; remotePreparation = null;
                        if (displayedConversation != null) displayedConversation.put("activity", JSONObject.NULL);
                    }
                }
                if (workStatus != null) workStatus.clear();
                if (currentState && conversationId.equals(target)) applyQueue(result);
                if (submitted && result.optString("state").equals("queued")) {
                    outgoingMessage = null; renderMessages(lastLive);
                } else if (submitted && outgoingMessage != null) {
                    if (result.has("userSeq")) outgoingMessage.put("userSeq", result.getLong("userSeq"));
                    outgoingState("accepted");
                }
                setStatusNotice(result.optString("state").equals("queued") ? tr("已加入电脑队列", "Queued on the computer") : tr("电脑已接收操作", "Computer accepted the operation"));
                if (currentState && conversationId.equals(target) && payload.optString("action").equals("codex-reset-preview")) {
                    JSONObject preview = result.optJSONObject("resetPreview");
                    if (preview != null && foreground) showCodexResetPreview(preview);
                }
                if (payload.optString("action").equals("codex-reset-consume")) {
                    String message = RemoteCodexResetDialog.outcome(chinese, result.optString("outcome"));
                    if (!result.isNull("warning") && !result.optString("warning").isEmpty()) message += tr(" 刷新额度失败，请稍后重新查询。", " Refresh failed. Check the quota again later.");
                    setStatusNotice(message);
                }
            } else {
                if (submitted && outgoingMessage != null) {
                    // A refused edit stays an edit: keep its target so the restored
                    // draft does not silently become a brand new message.
                    if (payload.has("editSeq") && conversationId.equals(target)) editingSeq = payload.optLong("editSeq");
                    composer.setText(outgoingMessage.optString("draft", payload.optString("prompt")));
                    ChatAttachments.restore(payload, selectedImages, selectedDocuments);
                    imageConversation = conversationId; imageComputer = credentials.optString("address"); renderImage();
                    persistDraft();
                    outgoingState("failed");
                }
                if (payload.optString("action").equals("queue-edit") && conversationId.equals(target)) {
                    setStatusError(result.optString("error"));
                    showQueueEditor(payload.optString("queueId"), payload.optString("expectedText"), payload.optString("prompt"));
                } else new CamelliaDialog.Builder(this).setTitle(tr("操作未确认成功", "Operation not confirmed successful"))
                    .setMessage(tr("请先检查最新会话状态，再决定是否重新操作。", "Inspect the latest conversation before deciding whether to submit a new operation.") + "\n" + result.optString("error"))
                    .setPositiveButton(tr("知道了", "OK"), null).show();
            }
        } catch (Exception error) { reportError("无法保存操作结果，请重试同一请求。", "Could not save result. Retry the same request.", error); }
        updateControls();
    }

    private void showCodexResetPreview(JSONObject preview) {
        if (codexResetDialog != null) codexResetDialog.dismiss();
        String target = conversationId, server = instance;
        codexResetDialog = RemoteCodexResetDialog.show(this, chinese, preview, () -> {
            if (!foreground || !connected || !controlAllowed || !target.equals(conversationId) || !server.equals(instance)) return;
            try {
                submitCommand(command("codex-reset-consume").put("accountId", preview.getString("accountId"))
                    .put("confirmationToken", preview.getString("confirmationToken")).put("confirmed", true));
                setStatusNotice(tr("正在使用重置卡…", "Using reset credit…"));
            } catch (Exception error) { reportError("无法提交重置，请重新查询后确认。", "Could not submit reset. Query and confirm again.", error); }
        });
    }

    private void forget(JSONObject computer) {
        new CamelliaDialog.Builder(this).setTitle(tr("移除这台电脑？", "Forget this computer?"))
            .setMessage(tr("将删除手机上的凭据。若要撤销权限，还需在电脑端撤销此设备。", "This deletes credentials on the phone. Also revoke this device on the computer to remove its authorization."))
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("移除", "Forget"), (dialog, which) -> {
                try { closeCommandClients(); store.remove(computer.getString("address")); listCache.remove(computer); prefetch.remove(computer, null); credentials = store.load(); computersScreen(); refreshComputers(); }
                catch (Exception error) { reportError("无法清除凭据，请重试。", "Could not remove credentials. Try again.", error); }
            }).show();
    }

    @Override public void onBackPressed() {
        if (selectingConversations && screen.equals("list")) {
            selectingConversations = false; selectedConversations.clear(); renderConversations(); return;
        }
        if (screen.equals("list") && searchBar != null && searchBar.getVisibility() == View.VISIBLE) { closeConversationSearch(); return; }
        if (networkScreen) { leaveNetwork(); return; }
        if (screen.equals("detail")) {
            persistDraft();
            if ("home".equals(detailReturn)) homeScreen();
            else { listScreen(); loadList(false); }
        }
        else if (screen.equals("pair")) {
            pendingScannedPairing = false; pairingDraft = null;
            computersScreen(); refreshComputers();
        }
        else if (screen.equals("list")) homeScreen();
        else if (!screen.equals("home")) homeScreen();
        else super.onBackPressed();
    }

    private void showNetwork() {
        if (screen.equals("pair")) rememberPairingDraft();
        if (!screen.equals("network")) networkReturn = screen;
        screen = "network";
        stopNetwork(); networkScreen = true; loginLaunched = false;
        shell(tr("手机访问", "Mobile access"), tr("网络连接 · 仅连接 Camellia，不接管其他 App 流量", "Network connection · Camellia only, no device-wide VPN"));
        SettingsStyle settingsStyle = new SettingsStyle(this);
        // The page opens on a question — is this phone on the network yet — and
        // the answer used to arrive in `status`, which sits below three groups
        // and five rows. This is that answer, at the top, where the reader lands.
        networkStatusBanner = settingsStyle.statusBanner(content);
        LinearLayout connection = settingsStyle.group(content, "");
        settingsStyle.toggle(connection, tr("内置 Tailscale", "Built-in Tailscale"),
            tr("无需另装应用，仅连接 Camellia，不接管其他应用流量。", "No extra app required. Connects only Camellia, not other apps."), "networkMode", EmbeddedNetwork.enabled(), (button, checked) -> {
            if (checked == EmbeddedNetwork.enabled()) return;
            stopNetwork();
            button.setEnabled(false); ((View) button.getParent()).setEnabled(false);
            setStatusNotice(tr("正在保存网络模式…", "Saving network mode…"));
            EmbeddedNetwork.setEnabled(checked).whenComplete((ignored, error) -> viewHandler.post(() -> {
                if (!networkScreen || content == null || content.findViewWithTag("networkMode") != button) return;
                button.setEnabled(true); ((View) button.getParent()).setEnabled(true);
                if (error == null) refreshNetwork(false);
                else {
                    button.setChecked(EmbeddedNetwork.enabled());
                    setStatusNotice(ErrorDetails.withSummary(tr("无法更新网络模式，请重试。", "Could not update network mode. Retry."), error));
                }
            }));
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
                EmbeddedNetwork.forget().whenComplete((ignored, error) -> deliver(ticket, () -> {
                    if (error == null) reportNetwork(tr("已清除，请重新登录。", "Identity removed. Sign in again."));
                    else reportNetwork(ErrorDetails.withSummary(tr("清除失败，请重试。", "Could not clear identity. Retry."), error));
                }));
            }).show());
        LinearLayout about = settingsStyle.group(content, tr("关于", "About"));
        settingsStyle.action(about, tr("开源许可", "Open-source licenses"), "", "networkLicenses", false, () -> {
            try (var bytes = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                for (String asset : new String[]{"third-party-notices.txt", "markdown-notices.txt"}) {
                    try (var input = getAssets().open(asset)) { while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count); }
                    bytes.write('\n');
                }
                TextView licenses = text(bytes.toString("UTF-8"), Palette.TEXT_SMALL, ink); licenses.setTextIsSelectable(true); licenses.setPadding(dp(16), dp(12), dp(16), dp(12));
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

    /**
     * Publishes this page's state to both places it is shown.
     *
     * <p>The bottom `status` line is shared with every other screen and is
     * filtered per screen by its own text watcher; the banner at the top of this
     * page is not. Writing to one place and forgetting the other is how the page
     * ends up saying "Connected" three rows down while the top still reads
     * whatever the last screen left behind.
     */
    private void reportNetwork(String message) {
        setStatusNotice(message);
        TextView banner = networkStatusBanner;
        if (banner == null) return;
        banner.setText(message);
        banner.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void refreshNetwork(boolean login) {
        if (!foreground || !networkScreen) return;
        if (!EmbeddedNetwork.enabled()) { reportNetwork(tr("外部模式：请自行连接 Tailscale App。", "External mode: connect the Tailscale app separately.")); return; }
        int ticket = generation;
        reportNetwork(tr("正在检查内置连接…", "Checking embedded connection…"));
        networkWorker.submit(() -> {
            try {
                var node = EmbeddedNetwork.node();
                if (login) node.login();
                JSONObject state = new JSONObject(node.status());
                deliver(ticket, () -> {
                    if (!networkScreen) return;
                    String phase = state.optString("state");
                    reportNetwork(phase.equals("Running") ? tr("已连接，可以返回配对。", "Connected. Return to pairing.") : tr("网络状态：", "Network state: ") + phase);
                    String url = EmbeddedNetwork.loginUrl(state.optString("loginUrl"));
                    if (login && url != null && !loginLaunched) {
                        loginLaunched = true;
                        try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))); }
                        catch (Exception error) { reportError("找不到浏览器，无法打开登录页面。", "No browser available to open the login page.", error); }
                    } else if (login && !phase.equals("Running")) handler.postDelayed(() -> refreshLoginStatus(ticket), 2000);
                });
            } catch (Exception error) { deliver(ticket, () -> reportNetwork(RemoteApi.failureMessage(error, chinese))); }
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
                    else reportNetwork(tr("已连接，可以返回配对。", "Connected. Return to pairing."));
                });
            } catch (Exception error) { deliver(ticket, () -> reportNetwork(ErrorDetails.withSummary(tr("登录连接中断，请重试。", "Login connection interrupted. Retry."), error))); }
        });
    }
}
