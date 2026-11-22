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
    private static final int SCAN_TAILSCALE_QR_REQUEST = 46;
    private static final long COMMAND_CONFIRM_TIMEOUT_MS = 30_000;
    private static final long COMMAND_POLL_INTERVAL_MS = 1_500;
    private static final long FOREGROUND_STREAM_GRACE_MS = 5_000;
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
    private RemoteListCache homeCache;
    private RemoteConversationCache conversationCache;
    private final ArrayList<JSONObject> homeComputers = new ArrayList<>();
    private final RemoteWorkbenchSync homeSync = new RemoteWorkbenchSync(address -> this.homeClientFactory.apply(address));
    private final java.util.function.Function<String, RemoteApi> remoteClientFactory = address -> new RemoteApi(this, address);
    private final RemoteConversationSync conversationSync = new RemoteConversationSync(address -> remoteClientFactory.apply(address));
    private long conversationListRevision;
    private final RemotePrefetch prefetch = new RemotePrefetch(address -> new RemoteApi(this, address));
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
    private boolean canCommandReceipts, canStopStart, canStopBackgroundWork, canIncremental, canLiveDelta;
    private LinearLayout backgroundWorkBar;
    private TextView backgroundWorkLabel, backgroundWorkStop;
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
    private boolean streamRetryPending;
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
    private boolean homeRunningExpanded;
    private boolean homeRecentExpanded;
    private long homeRefreshAt;
    private WorkbenchList homeConversations;
    private TextView homeHeading, homeEmptyHint;
    private ConversationSidebar detailSidebar;
    private ConversationListPane tabletConversationList;
    private RemoteApi tabletListClient;
    private RemoteApi tabletArchiveClient;
    private volatile int tabletListRequest;
    private int sidebarScrollRestore = -1;
    private String sidebarStateAddress = "";
    private final java.util.Map<String, Bundle> tabletSidebarStates = new java.util.LinkedHashMap<>();
    private boolean splitDetail;
    private boolean tabletConversationFocus;
    private WorkbenchNavigation workbenchNavigation;
    private boolean tabletShell;
    private TabletComputerPane tabletComputerPane;
    private String tabletComputerAddress = "";
    private boolean tabletComputerExpanded;
    private final java.util.Map<String, JSONObject> computerInformation = new java.util.LinkedHashMap<>();
    private WorkbenchList tabletHomeRecent;
    private ScrollView tabletHomeActiveScroll, tabletHomeRecentScroll;
    private int tabletHomeActiveY, tabletHomeRecentY;
    private volatile boolean sidebarRefreshBusy;
    private long sidebarRefreshAt;
    private JSONArray discussionGroups = new JSONArray();
    private boolean moreDiscussions;
    private boolean canDiscussions;
    private ScrollView scroll;
    private final ConversationListScroll conversationListScroll = new ConversationListScroll();
    private boolean initialMessageScroll;
    private ScrollView pendingScrollView;
    private android.view.ViewTreeObserver.OnPreDrawListener pendingMessageScroll;
    private final Handler viewHandler = new Handler(Looper.getMainLooper());
    private int pendingScrollPosition;
    private long messageScrollRevision;
    private EditText addressInput, portInput, nameInput, codeInput;
    private Button pairButton, scanButton, lanScanButton;
    private TextView lanNetworkHint;
    private boolean pendingScannedPairing, pairingBusy, lanConnectBusy, lanPairScanning;
    private long lanScanStartedAt;
    private int lanDiscoveryError = Integer.MIN_VALUE;
    private final Runnable lanScanRefresh = this::refreshLanScanStatus;
    private Bundle pairingDraft;
    private LinearLayout lanPairList;
    private final ArrayList<LanDiscovery.Service> lanServices = new ArrayList<>();
    private LanDiscovery lanDiscovery;
    private android.net.ConnectivityManager.NetworkCallback lanNetworkCallback;
    private String activeRouteSignature = "";
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
    private JSONObject archivedConversation;
    private boolean archivedRestorable;
    private LinearLayout archivedBar;
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
    private final java.util.Set<String> expandedTaskDetails = new java.util.HashSet<>();
    private android.app.Dialog workDialog;
    private LinearLayout workApprovalSection;
    private String workApprovalSignature = "";
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
    private boolean retainingDialogsForConfiguration;
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
    private RemoteApi homeMenuClient;
    private android.widget.Toast homeMenuNotice;
    private JSONObject homeActionConversation;
    private String homeActionScope = "";
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
    private long listLastFrameAt;
    private boolean listRetryPending;
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
    private final Runnable searchRemote = () -> { if (conversationListAvailable()) loadList(false); };
    private final LinkedHashMap<String, String> computerStates = new LinkedHashMap<>();
    private final LinkedHashMap<String, String> computerRoutes = new LinkedHashMap<>();
    private final java.util.Set<String> autoLanChecks = new java.util.HashSet<>();
    private String tailscaleMergeAddress = "";
    private final java.util.Set<RemoteApi> statusClients = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.function.Function<String, RemoteApi> statusClientFactory = address -> new RemoteApi(this, address);
    private final java.util.function.Function<String, RemoteApi> homeClientFactory = address -> new RemoteApi(this, address);
    private boolean loginLaunched;
    private final ExecutorService networkWorker = Executors.newSingleThreadExecutor();
    // The settings index's Mobile access row, kept so its state label can be
    // refreshed when the reader comes back from that page rather than only when
    // the index is rebuilt.
    private LinearLayout settingsRowMobileAccess;
    // The pairing page's Tailscale row, refreshed when that page is shown and
    // when the network state changes underneath it.
    private TextView pairNetworkValue, lanScanStatus;
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
        if (focused) {
            // Window attachment/theme resolution can reapply the platform's
            // navigation scrim after shell() has configured the destination.
            if (workbenchNavigation != null && android.os.Build.VERSION.SDK_INT >= 29)
                getWindow().setNavigationBarContrastEnforced(false);
            notifyApprovalRequests();
        }
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
        String destination = intent.getStringExtra("tabletDestination");
        intent.removeExtra("tabletDestination");
        if (destination != null) {
            persistDraft();
            switch (destination) {
                case "home": navigateHome(); break;
                case "sessions": navigateSessions(); break;
                case "computers": navigateComputers(); break;
                case "network": networkReturn = "settings"; screen = "network"; showNetwork(); break;
                default: openSettingsPage();
            }
            return;
        }
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
        if (saved != null) {
            tabletComputerAddress = saved.getString("tabletComputerAddress", "");
            tabletComputerExpanded = saved.getBoolean("tabletComputerExpanded");
            tailscaleMergeAddress = saved.getString("tailscaleMergeAddress", "");
        }
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
        lanDiscovery = new LanDiscovery(this, new LanDiscovery.Listener() {
            @Override public void onLanServices(java.util.List<LanDiscovery.Service> services) {
                MainActivity.this.onLanServices(services);
            }

            @Override public void onLanDiscoveryStarted() {
                MainActivity.this.onLanDiscoveryStarted();
            }

            @Override public void onLanDiscoveryFailed(int errorCode) {
                MainActivity.this.onLanDiscoveryFailed(errorCode);
            }
        });
        listCache = RemoteListCache.get(this);
        homeCache = RemoteListCache.workbench(this);
        conversationCache = RemoteConversationCache.get(this);
        String recovery = null;
        try {
            credentials = store.load();
            ComputerRoutes.configure(store.all());
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
            if (saved.containsKey(TabletScaffold.CATEGORY_SCROLL)) getIntent().putExtra(TabletScaffold.CATEGORY_SCROLL, saved.getInt(TabletScaffold.CATEGORY_SCROLL));
            homeRecentExpanded = saved.getBoolean("homeRecentExpanded");
            homeRunningExpanded = saved.getBoolean("homeRunningExpanded");
            Bundle sidebarStates = saved.getBundle("tabletSidebarStates");
            if (sidebarStates != null) for (String key : sidebarStates.keySet()) tabletSidebarStates.put(key, sidebarStates.getBundle(key));
            conversationListScroll.load(saved.getBundle("conversationListScroll"));
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
        if (getIntent().hasExtra("tabletDestination")) onNewIntent(getIntent());
        else openNotificationConversation();
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
        syncLanDiscoveryForScreen();
        if (lanNetworkCallback == null) {
            lanNetworkCallback = new android.net.ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(android.net.Network network) { restartLanDiscovery(); }
                @Override public void onLost(android.net.Network network) { restartLanDiscovery(); }
            };
            try {
                ((android.net.ConnectivityManager) getSystemService(android.content.Context.CONNECTIVITY_SERVICE))
                    .registerDefaultNetworkCallback(lanNetworkCallback);
            } catch (Exception error) {
                android.util.Log.w("CamelliaLan", "Could not watch network changes", error);
                lanNetworkCallback = null;
            }
        }
        resumePendingCommands();
        if (retained) {
            if (screen.equals("detail")) { resumeDetail(); return; }
            if (screen.equals("list")) { resumeList(); return; }
        }
        if (networkScreen) { refreshNetwork(false); return; }
        if (screen.equals("computers")) { refreshComputers(); return; }
        if (screen.equals("home")) { refreshHomeConversations(); return; }
        // Coming back from Mobile access, which is where the mode is actually
        // changed. Without this the row kept whatever it said when the index
        // was built, so toggling Tailscale off and back left it claiming to be
        // connected.
        if (screen.equals("settings")) { refreshMobileAccessRow(); return; }
        if (screen.equals("pair")) {
            renderLanPairList();
            if (!pendingScannedPairing && credentials.has("claim")) waitForApproval();
            return;
        }
        if (credentials.has("token")) {
            if (screen.equals("detail") && conversationId != null) connectEvents();
            else if (screen.equals("list")) loadList(false);
        } else if (credentials.has("claim")) waitForApproval();
    }

    private void networkRouteChanged() {
        clearComputerRoutes();
        computerInformation.clear();
        if (!networkActive()) return;
        if (EmbeddedNetwork.online()) resumePendingCommands();
        if (screen.equals("home")) { homeSync.stop(); refreshHomeConversations(); return; }
        // These two report the network state on a row, and a route change flips
        // it without rebuilding the page.
        if (screen.equals("settings")) { refreshMobileAccessRow(); return; }
        if (screen.equals("pair")) { refreshPairNetworkRow(); return; }
        if (!screen.equals("computers") && !screen.equals("list") && !screen.equals("detail")) return;
        artifactDownloads.stop();
        if (!EmbeddedNetwork.online()) {
            if (screen.equals("computers")) {
                try { for (JSONObject computer : store.all()) updateComputerState(computer.optString("address"), tr("网络已断开", "Offline")); }
                catch (Exception ignored) { /* keep existing device rows available */ }
            }
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

    private void onLanServices(java.util.List<LanDiscovery.Service> services) {
        lanServices.clear();
        if (services != null) lanServices.addAll(services);
        if (!lanServices.isEmpty()) {
            lanDiscoveryError = Integer.MIN_VALUE;
            handler.removeCallbacks(lanScanRefresh);
        }
        if (!foreground) return;
        if (screen.equals("pair")) renderLanPairList();
        applyLanRoutes();
    }

    private void onLanDiscoveryStarted() {
        lanDiscoveryError = Integer.MIN_VALUE;
        if (foreground && screen.equals("pair")) renderLanPairList();
    }

    private void onLanDiscoveryFailed(int errorCode) {
        lanDiscoveryError = errorCode;
        if (foreground && screen.equals("pair")) renderLanPairList();
    }

    private boolean hasLanPreferredComputer() {
        try {
            for (JSONObject computer : store.all()) {
                if (ComputerRoutes.prefersLan(computer)) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    private void syncLanDiscoveryForScreen() {
        if (lanDiscovery == null) return;
        if ("pair".equals(screen)) {
            if (lanPairScanning) {
                if (!lanDiscovery.isRunning()) lanDiscovery.start();
            } else if (lanDiscovery.isRunning()) {
                lanDiscovery.stop(false);
            }
            return;
        }
        if (hasLanPreferredComputer()) {
            if (!lanDiscovery.isRunning()) lanDiscovery.start();
        } else if (lanDiscovery.isRunning()) {
            lanDiscovery.stop(true);
        }
        applyLanRoutes();
    }

    private void startLanPairScan() {
        if (!foreground || !screen.equals("pair") || pairingBusy) return;
        lanPairScanning = true;
        lanScanStartedAt = android.os.SystemClock.elapsedRealtime();
        lanDiscoveryError = Integer.MIN_VALUE;
        lanServices.clear();
        if (lanDiscovery != null) lanDiscovery.restart(true);
        handler.removeCallbacks(lanScanRefresh);
        handler.postDelayed(lanScanRefresh, 8_000);
        renderLanPairList();
    }

    private void stopLanPairScan() {
        lanPairScanning = false;
        lanScanStartedAt = 0;
        lanDiscoveryError = Integer.MIN_VALUE;
        handler.removeCallbacks(lanScanRefresh);
        if (lanDiscovery != null) lanDiscovery.stop(false);
        renderLanPairList();
    }

    private String lanDiscoveryFailureText(int errorCode) {
        if (errorCode < 0) return tr("系统局域网发现不可用", "System local discovery is unavailable");
        return tr("系统局域网发现失败，错误码 " + errorCode,
            "System local discovery failed with code " + errorCode);
    }

    private String lanNetworkSummary() {
        java.util.List<String> addresses = wifiIpv4Addresses();
        if (addresses.isEmpty()) {
            return tr("手机未连接 Wi-Fi，请先连接与电脑相同的 Wi-Fi",
                "This phone is not on Wi-Fi. Connect it to the same Wi-Fi as the computer");
        }
        String address = addresses.get(0);
        java.util.Set<String> expected = expectedLanPrefixes();
        if (expected.isEmpty()) {
            return tr("手机 Wi-Fi：" + address + "。请确认电脑也连接此 Wi-Fi",
                "Phone Wi-Fi: " + address + ". Make sure the computer uses the same Wi-Fi");
        }
        String prefix = lanPrefix(address);
        if (prefix != null && expected.contains(prefix)) {
            return tr("手机 Wi-Fi：" + address + "。与电脑属于同一网段",
                "Phone Wi-Fi: " + address + ". This is the computer's subnet");
        }
        java.util.List<String> networks = new java.util.ArrayList<>();
        for (String item : expected) networks.add(item + ".x");
        return tr("手机 Wi-Fi：" + address + "。电脑在 " + String.join("、", networks)
                + "，当前不在同一网段",
            "Phone Wi-Fi: " + address + ". The computer is on " + String.join(", ", networks)
                + ", so this is a different subnet");
    }

    private java.util.List<String> wifiIpv4Addresses() {
        java.util.LinkedHashSet<String> addresses = new java.util.LinkedHashSet<>();
        try {
            android.net.ConnectivityManager connectivity =
                (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (connectivity == null) return new java.util.ArrayList<>();
            for (android.net.Network network : connectivity.getAllNetworks()) {
                android.net.NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
                if (capabilities == null || !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI))
                    continue;
                android.net.LinkProperties properties = connectivity.getLinkProperties(network);
                if (properties == null) continue;
                for (android.net.LinkAddress link : properties.getLinkAddresses()) {
                    java.net.InetAddress value = link.getAddress();
                    if (value instanceof java.net.Inet4Address && !value.isLoopbackAddress()) {
                        addresses.add(value.getHostAddress());
                    }
                }
            }
        } catch (Exception ignored) { }
        return new java.util.ArrayList<>(addresses);
    }

    private java.util.Set<String> expectedLanPrefixes() {
        java.util.LinkedHashSet<String> prefixes = new java.util.LinkedHashSet<>();
        try {
            for (JSONObject computer : store.all()) {
                addLanPrefix(prefixes, computer.optString("lanAddress"));
                try {
                    Endpoint endpoint = new Endpoint(computer.optString("address"));
                    if (endpoint.isLan()) addLanPrefix(prefixes, endpoint.origin());
                } catch (IllegalArgumentException ignored) { }
            }
        } catch (Exception ignored) { }
        return prefixes;
    }

    private static void addLanPrefix(java.util.Set<String> prefixes, String url) {
        if (url == null || url.isEmpty()) return;
        try {
            String value = lanPrefix(new Endpoint(url).host());
            if (value != null) prefixes.add(value);
        } catch (IllegalArgumentException ignored) { }
    }

    private static String lanPrefix(String address) {
        String[] parts = address.split("\\.");
        if (parts.length != 4) return null;
        return parts[0] + "." + parts[1] + "." + parts[2];
    }

    private LanDiscovery.Service lanServiceFor(String computerId) {
        if (computerId == null || computerId.isEmpty()) return null;
        for (LanDiscovery.Service service : lanServices) if (computerId.equals(service.computerId)) return service;
        return null;
    }

    private void applyLanRoutes() {
        if (store == null || screen.equals("pair")) return;
        try {
            java.util.List<JSONObject> computers = store.all();
            if (computers.isEmpty()) return;
            String current = credentials.optString("address");
            ComputerRoutes.Route before = ComputerRoutes.route(current);
            boolean changed = false;
            for (JSONObject computer : computers) {
                String key = computer.optString("address");
                if (key.isEmpty() || !computer.has("token")) continue;
                LanDiscovery.Service service = lanServiceFor(computer.optString("computerId"));
                if (ComputerRoutes.updateDiscoveredRoute(computer, service)) changed |= store.saveProfile(computer);
            }
            if (changed) credentials = store.load();
            ComputerRoutes.configure(computers);
            ComputerRoutes.Route after = ComputerRoutes.route(current);
            if ((changed && screen.equals("computers")) || !java.util.Objects.equals(before.url, after.url)
                    || !java.util.Objects.equals(before.transport, after.transport)) {
                lanConnectionChanged();
            }
            if (!foreground) return;
            for (JSONObject computer : computers) {
                if (!ComputerRoutes.prefersLan(computer)) continue;
                LanDiscovery.Service service = lanServiceFor(computer.optString("computerId"));
                if (service != null && !ComputerRoutes.matchesLanFingerprint(computer, service.computerId, service.fingerprint)) {
                    verifyTrustedLan(computer, service);
                }
            }
        } catch (Exception error) {
            android.util.Log.w("CamelliaLan", "Could not apply LAN route", error);
        }
    }

    private void verifyTrustedLan(JSONObject computer, LanDiscovery.Service service) {
        String address = computer.optString("address"), tailscale = ComputerRoutes.tailscaleUrl(computer);
        if (address.isEmpty() || tailscale.isEmpty() || !autoLanChecks.add(address)) return;
        String token = computer.optString("token");
        int ticket = generation;
        statusWorker.submit(() -> {
            if (ticket != generation) return;
            JSONObject info = null;
            try {
                info = tailscaleLanStatus(tailscale, token, service);
            } catch (Exception ignored) { /* Stay on Tailscale until the LAN can be verified. */ }
            JSONObject found = info;
            handler.post(() -> {
                if (ticket != generation) return;
                autoLanChecks.remove(address);
                JSONObject current = storedComputer(address);
                LanDiscovery.Service discovered = lanServiceFor(service.computerId);
                if (!foreground || current == null || !token.equals(current.optString("token"))
                        || !ComputerRoutes.prefersLan(current) || !tailscale.equals(ComputerRoutes.tailscaleUrl(current))
                        || discovered == null) return;
                if (found == null) {
                    handler.postDelayed(this::applyLanRoutes, 15_000);
                } else if (!service.fingerprint.equals(discovered.fingerprint) || observeTransportInfo(found, address)) {
                    applyLanRoutes();
                }
            });
        });
    }

    private JSONObject routeStatus(RemoteApi client, String token) throws IOException {
        statusClients.add(client);
        try {
            JSONObject info = client.json("/v1/status", token, null);
            if (info.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
            return info;
        } finally {
            statusClients.remove(client);
            client.cancel();
        }
    }

    private JSONObject tailscaleLanStatus(String tailscale, String token, LanDiscovery.Service service) throws IOException {
        JSONObject info = routeStatus(RemoteApi.explicit(this, tailscale), token);
        JSONObject transports = info.optJSONObject("transports");
        JSONObject lan = transports == null ? null : transports.optJSONObject("lan");
        if (!service.computerId.equals(info.optString("computerId")) || lan == null
                || !service.fingerprint.equalsIgnoreCase(lan.optString("fingerprint"))) {
            throw new IOException(tr("Tailscale 返回的电脑身份或证书与扫描结果不一致。",
                "Tailscale returned a different computer identity or certificate than the scan."));
        }
        return info;
    }

    private void lanConnectionChanged() {
        if (!foreground) return;
        if (screen.equals("computers")) { refreshComputers(); return; }
        if (screen.equals("home")) { refreshHomeConversations(); return; }
        if (screen.equals("pair")) { renderLanPairList(); return; }
        if (!credentials.has("token")) return;
        if (screen.equals("list")) loadList(false);
        else if (screen.equals("detail")) { connectEvents(); refreshDetailSidebar(); }
    }

    private boolean observeTransportInfo(JSONObject info, String address) {
        if (info == null || address == null || address.isEmpty()) return false;
        try {
            JSONObject transports = info.optJSONObject("transports");
            JSONObject profile = null;
            for (JSONObject candidate : store.all()) {
                if (address.equals(candidate.optString("address"))) { profile = candidate; break; }
            }
            if (profile == null || !profile.has("token")) return false;
            boolean changed = false;
            String identity = info.optString("computerId");
            if (!identity.isEmpty() && !identity.equals(profile.optString("computerId"))) {
                profile.put("computerId", identity); changed = true;
            }
            JSONObject lan = transports == null ? null : transports.optJSONObject("lan");
            if (lan != null) {
                String url = lan.optString("url"), fingerprint = lan.optString("fingerprint");
                try {
                    if (!new Endpoint(url).isLan()) throw new IllegalArgumentException();
                    if (LanTls.validFingerprint(fingerprint)) {
                        if (!url.equals(profile.optString("lanAddress"))) { profile.put("lanAddress", url); changed = true; }
                        if (!LanTls.normalize(fingerprint).equals(profile.optString("lanFingerprint"))) {
                            profile.put("lanFingerprint", LanTls.normalize(fingerprint)); changed = true;
                        }
                    }
                } catch (IllegalArgumentException ignored) { }
            }
            JSONObject tailscale = transports == null ? null : transports.optJSONObject("tailscale");
            if (tailscale != null) {
                String url = tailscale.optString("url");
                try {
                    if (!new Endpoint(url).isLan() && !url.equals(profile.optString("tailscaleAddress"))) {
                        profile.put("tailscaleAddress", url); changed = true;
                    }
                } catch (IllegalArgumentException ignored) { }
            }
            if (changed) {
                store.saveProfile(profile);
                credentials = store.load();
                ComputerRoutes.configure(store.all());
            }
            return changed;
        } catch (Exception error) {
            android.util.Log.w("CamelliaLan", "Could not update transport descriptors", error);
            return false;
        }
    }

    private void restartLanDiscovery() {
        handler.postDelayed(() -> {
            if (!foreground || lanDiscovery == null) return;
            lanServices.clear();
            lanDiscovery.stop();
            syncLanDiscoveryForScreen();
            if (screen.equals("pair")) renderLanPairList();
        }, 600);
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        VisualizationDialog card = visualizationDialog;
        boolean retainCard = card != null && card.isShowing();
        if (retainCard) card.preserveEditorForConfiguration();
        android.view.Window focusWindow = EditorFocusState.focusedWindow(this, card, remoteApprovalDialog,
            computerDialog, codexResetDialog, queueDialog, workDialog, subtaskPage);
        EditorFocusState focus = EditorFocusState.capture(focusWindow);
        retainingDialogsForConfiguration = true;
        try {
            super.onConfigurationChanged(configuration);
            if (screen.equals("detail")) {
                rebuildDetailForConfiguration();
            } else if (screen.equals("home")) {
                renderHomeContent(); if (foreground) refreshHomeConversations();
            } else if (screen.equals("computers")) {
                computersScreen(); if (foreground) refreshComputers();
            } else if (screen.equals("settings")) {
                settingsScreen();
            } else if (screen.equals("network")) {
                int y = TabletScaffold.savedCategoryScroll(this), bodyY = scroll == null ? 0 : scroll.getScrollY();
                getIntent().putExtra(TabletScaffold.CATEGORY_SCROLL, y);
                renderNetworkContent();
                TabletScaffold.restoreScroll(scroll, bodyY);
            } else if (screen.equals("list") && scroll != null && content != null) {
                listScreen(); if (foreground && credentials.has("token")) loadList(false);
            }
            DialogWindows.requestLayout(this); focus.restore(focusWindow);
            updateNavigationWidth();
            if (retainCard && visualizationDialog == card) card.updateViewport();
        } finally { retainingDialogsForConfiguration = false; }
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
        cancelTabletListRequest();
        closeVisualization();
        if (connectionTest != null) { connectionTest.close(); connectionTest = null; }
        persistDraft();
        if (listCache != null) listCache.flush();
        if (homeCache != null) homeCache.flush();
        lanPairScanning = false;
        lanScanStartedAt = 0;
        lanDiscoveryError = Integer.MIN_VALUE;
        handler.removeCallbacks(lanScanRefresh);
        if (lanDiscovery != null) lanDiscovery.stop();
        if (lanNetworkCallback != null) {
            try {
                ((android.net.ConnectivityManager) getSystemService(android.content.Context.CONNECTIVITY_SERVICE))
                    .unregisterNetworkCallback(lanNetworkCallback);
            } catch (Exception ignored) { }
            lanNetworkCallback = null;
        }
        if (conversationCache != null) conversationCache.flush();
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
        homeSync.close();
        closeCommandClients();
        if (pages != null) { pages.finishTransition(); pages = null; }
        releasePageViews();
        if (composerAttachments != null) composerAttachments.close();
        RemoteKeepAliveService.finish(this, false);
        artifactDownloads.close();
        InlineImageGallery.close(this);
        if (listCache != null) listCache.flush();
        if (conversationCache != null) conversationCache.flush();
        prefetch.close();
        worker.shutdownNow(); eventWorker.shutdownNow(); commandWorker.shutdownNow(); urgentWorker.shutdownNow(); statusWorker.shutdownNow(); networkWorker.shutdownNow(); super.onDestroy();
    }

    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        if (screen.equals("network")) saved.putInt(TabletScaffold.CATEGORY_SCROLL, TabletScaffold.savedCategoryScroll(this));
        saved.putBoolean("homeRecentExpanded", homeRecentExpanded);
        saved.putBoolean("homeRunningExpanded", homeRunningExpanded);
        if (detailSidebar != null) tabletSidebarStates.put(sidebarStateAddress, detailSidebar.saveState());
        Bundle sidebarStates = new Bundle();
        for (var state : tabletSidebarStates.entrySet()) sidebarStates.putBundle(state.getKey(), state.getValue());
        saved.putBundle("tabletSidebarStates", sidebarStates);
        rememberConversationListContext();
        saved.putBundle("conversationListScroll", conversationListScroll.save());
        artifactDownloads.save(saved);
        saved.putString("tabletComputerAddress", tabletComputerAddress);
        saved.putBoolean("tabletComputerExpanded", tabletComputerPane != null ? tabletComputerPane.expanded() : tabletComputerExpanded);
        saved.putString("tailscaleMergeAddress", tailscaleMergeAddress);
        saved.putString("screen", screen); saved.putString("networkReturn", networkReturn);
        saved.putString("detailReturn", detailReturn);
        if (screen.equals("pair")) rememberPairingDraft();
        saved.putBundle("pairingDraft", pairingDraft);
        saved.putBoolean("pendingScannedPairing", pendingScannedPairing);
        if (conversationId != null) { saved.putString("conversationId", conversationId); saved.putString("conversationTitle", conversationTitle); }
    }

    private void stopNetwork() {
        cancelHomeConversationMenu();
        homeSync.stop();
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
        streamRetryPending = false;
        listLastFrameAt = 0;
        listRetryPending = false;
        statusWorker.getQueue().clear();
        autoLanChecks.clear();
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
        Button button = new Button(this); button.setText(label); ActionStyle.page(button, primary);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(8), 0, dp(8)); button.setLayoutParams(params);
        button.setOnClickListener(view -> action.run()); return button;
    }

    private void shell(String title, String subtitle) {
        releasePageViews();
        tabletShell = MobileLayout.useTabletRail(getResources().getConfiguration());
        if (!screen.equals("detail")) composerAttachments.replace();
        reconnecting = false; connectionBlocked = false;
        boolean settingsPage = screen.equals("settings") || screen.equals("network") || screen.equals("pair");
        boolean tabletNetworkCategory = tabletShell && screen.equals("network") && networkReturn.equals("settings");
        boolean showNavigation = screen.equals("home") || screen.equals("list") || screen.equals("computers") || screen.equals("settings");
        int bottomPadding = screen.equals("list") || screen.equals("detail") ? chatStyle.dockBottomPadding() : dp(24);
        if (showNavigation) bottomPadding = 0;
        final int pageBottomPadding = bottomPadding;
        SettingsStyle settingsStyle = new SettingsStyle(this);
        int pageBackground = settingsPage || screen.equals("computers") ? settingsStyle.background : background;
        splitDetail = screen.equals("detail") && (tabletShell || MobileLayout.useDetailSplit(getResources().getConfiguration()));
        root = column(); root.setBackground(Palette.of(this).pageBackground());
        root.setPadding(dp(ChatStyle.PAGE_SIDE_DP), dp(10), dp(ChatStyle.PAGE_SIDE_DP), bottomPadding);
        root.setBackgroundColor(pageBackground); getWindow().setStatusBarColor(pageBackground);
        getWindow().setNavigationBarColor(showNavigation ? Color.TRANSPARENT : pageBackground);
        if (android.os.Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(!showNavigation);
        int systemUi = getWindow().getDecorView().getSystemUiVisibility();
        int bottomLayout = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        getWindow().getDecorView().setSystemUiVisibility(showNavigation ? systemUi | bottomLayout : systemUi & ~bottomLayout);
        root.setClipToPadding(false);
        if (screen.equals("list") || screen.equals("detail")) { root.setFocusableInTouchMode(true); root.requestFocus(); }
        View page = root;
        if (tabletShell && screen.equals("list")) {
            ConversationListPane pane = tabletConversationList(false);
            root = pane.root; scroll = pane.scroll; content = pane.content; status = pane.status; headerConnection = pane.connection;
            searchInput = root.findViewWithTag("remoteSearchInput"); searchBar = root.findViewWithTag("remoteSearchBar");
            pane.select("conversation:", "");
            LinearLayout listSplit = new LinearLayout(this); listSplit.setTag("tabletSessionListSplit");
            root.setVisibility(View.VISIBLE);
            listSplit.addView(pane.takeView(), new LinearLayout.LayoutParams(dp(ConversationListPane.WIDTH_DP), -1));
            android.widget.FrameLayout preview = new android.widget.FrameLayout(this);
            LinearLayout empty = column(); empty.setPadding(dp(28), dp(28), dp(28), dp(28));
            new SettingsStyle(this).emptyState(empty, credentials.has("token") ? tr("选择一个会话", "Select a conversation") : tr("连接电脑后继续", "Connect a computer to continue"),
                tr("从左侧选择工作区与会话，在这里阅读和回复。", "Choose a workspace and conversation on the left to read and reply here."), "", null);
            preview.addView(empty, new android.widget.FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
            listSplit.addView(preview, new LinearLayout.LayoutParams(0, -1, 1));
            page = TabletScaffold.wrap(this, listSplit, "sessions", this::navigateHome, this::navigateSessions, this::navigateComputers, this::openSettingsPage);
            if (pages == null) pages = new PageTransitions(this);
            pages.show(page, "list", 2, true); updateConnectionHeader(); page.requestApplyInsets(); return;
        }
        LinearLayout split = null;
        if (splitDetail) {
            split = new LinearLayout(this);
            split.setOrientation(LinearLayout.HORIZONTAL);
            split.setTag("detailSplitLayout");
            split.setBackground(Palette.of(this).pageBackground());
            split.setClipChildren(false);
            split.setClipToPadding(false);
            if (tabletShell) {
                ConversationListPane pane = tabletConversationList(true);
                pane.select("conversation:", conversationId);
                split.addView(pane.takeView(), new LinearLayout.LayoutParams(dp(ConversationListPane.WIDTH_DP), -1));
                pane.root.setVisibility(tabletConversationFocus ? View.GONE : View.VISIBLE);
            } else {
            detailSidebar = new ConversationSidebar(this, chinese, detailSidebarItems(), new ConversationSidebar.Listener() {
                @Override public void open(ConversationSidebar.Item item) { openSidebarConversation(item); }
                @Override public void all() { navigateSessions(); }
                @Override public void refresh() { sidebarRefreshAt = 0; refreshDetailSidebar(); }
            });
            int restoreSidebarScroll = sidebarScrollRestore;
            sidebarScrollRestore = -1;
            sidebarStateAddress = credentials.optString("address");
            detailSidebar.restoreState(tabletSidebarStates.get(sidebarStateAddress));
            if (restoreSidebarScroll > 0) detailSidebar.restoreScroll(restoreSidebarScroll);
            int sidebarWidth = dp(MobileLayout.detailSidebarWidthDp(getResources().getConfiguration().screenWidthDp));
            split.addView(detailSidebar, new LinearLayout.LayoutParams(sidebarWidth, -1));
            detailSidebar.setVisibility(tabletConversationFocus ? View.GONE : View.VISIBLE);
            }
            View divider = new View(this);
            divider.setBackgroundColor(Palette.of(this).separator);
            divider.setTag("tabletConversationDivider");
            divider.setVisibility(tabletConversationFocus ? View.GONE : View.VISIBLE);
            split.addView(divider, new LinearLayout.LayoutParams(Math.max(1, dp(1)), -1));
            split.addView(root, new LinearLayout.LayoutParams(0, -1, 1));
            page = split;
        } else {
            sidebarScrollRestore = -1;
        }
        if (showNavigation && !tabletShell) {
            // The dock installs destination insets after its scrolling stage exists.
            root.setPadding(dp(ChatStyle.PAGE_SIDE_DP), dp(settingsPage ? 6 : 10), dp(ChatStyle.PAGE_SIDE_DP), 0);
        }
        else if (settingsPage) settingsStyle.pagePadding(root, 20);
        else if (splitDetail && !tabletShell) {
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
            view.setPadding(dp(ChatStyle.PAGE_SIDE_DP) + insets.getSystemWindowInsetLeft(), dp(10) + insets.getSystemWindowInsetTop(), dp(ChatStyle.PAGE_SIDE_DP) + insets.getSystemWindowInsetRight(), pageBottomPadding + insets.getSystemWindowInsetBottom());
            return insets;
        });
        if (tabletShell) {
            root.setOnApplyWindowInsetsListener(null);
            root.setPadding(dp(screen.equals("list") ? 12 : 24), dp(10), dp(screen.equals("list") ? 12 : 24), screen.equals("detail") ? chatStyle.dockBottomPadding() : 0);
            if (split != null) {
                split.setOnApplyWindowInsetsListener(null);
                if (detailSidebar != null) detailSidebar.setPadding(dp(8), dp(8), dp(8), dp(8));
            }
            if (tabletNetworkCategory) {
                page = TabletScaffold.settingsBody(this, page, "network", section -> {
                    if (section.equals("network")) return;
                    if (section.equals("usage")) openAccountUsage(null); else openSettingsSection(section);
                });
            }
            page = TabletScaffold.wrap(this, page, screen.equals("detail") || screen.equals("list") ? "sessions" : screen.equals("network") ? "settings" : screen,
                this::navigateHome, this::navigateSessions, this::navigateComputers, this::openSettingsPage);
        }
        if (pages == null) pages = new PageTransitions(this);
        int depth = screen.equals("home") ? 0 : screen.equals("computers") || screen.equals("settings") ? 1
            : screen.equals("detail") || (screen.equals("network") && networkReturn.equals("pair")) ? 3 : 2;
        pages.show(page, screen, depth, destinationSwitch || tabletShell); page.requestApplyInsets();
        if (settingsPage) {
            root.addView(screen.equals("settings") || tabletNetworkCategory ? settingsStyle.header(title)
                : settingsStyle.header(title, tr("返回上一级", "Back"), this::onBackPressed));
        } else if (screen.equals("computers") && !tabletShell) {
            LinearLayout header = settingsStyle.topLevelHeader(title);
            header.findViewWithTag("settingsTitle").setTag("remoteControlTitle"); root.addView(header);
        } else if (screen.equals("list") || screen.equals("detail")) {
            headerConnection = addConversationHeader(root, screen.equals("detail"));
        } else if (!tabletShell) {
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
        NavigationDockLayout navigationViewport = null;
        if (showNavigation && !tabletShell) {
            navigationViewport = new NavigationDockLayout(this, scroll);
            navigationViewport.setTag(screen.equals("list") ? "remoteListViewport" : "workbenchViewport");
            root.addView(navigationViewport, new LinearLayout.LayoutParams(-1, 0, 1));
        } else root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        content = column(); content.setPadding(0, 0, 0, dp(16)); scroll.addView(content);
        if (settingsPage) { content.setPadding(0, dp(4), 0, dp(16)); scroll.setVerticalScrollBarEnabled(false); }
        if (!showNavigation) root.addView(status);
        if (showNavigation && !tabletShell) {
            String navigationSelection = screen.equals("list") ? "sessions" : screen;
            workbenchNavigation = new WorkbenchNavigation(this, navigationSelection,
                this::navigateHome, this::navigateSessions, this::navigateComputers, this::openSettingsPage);
            navigationViewport.setNavigation(workbenchNavigation);
            NavigationDockLayout dock = navigationViewport;
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                int left = dp(ChatStyle.PAGE_SIDE_DP) + insets.getSystemWindowInsetLeft();
                int right = dp(ChatStyle.PAGE_SIDE_DP) + insets.getSystemWindowInsetRight();
                view.setPadding(left, dp(settingsPage ? 6 : 10) + insets.getSystemWindowInsetTop(), right, 0);
                dock.setInsets(left, right, insets.getSystemWindowInsetBottom());
                return insets;
            });
            dock.setInsets(root.getPaddingLeft(), root.getPaddingRight(), 0);
            root.requestApplyInsets();
        }
    }

    private TextView addConversationHeader(LinearLayout page, boolean detail) {
        TextView connection = null;
            LinearLayout header = new LinearLayout(this); chatStyle.pageHeader(header);
            if (detail) {
                header.addView(chatStyle.backButton(tr("返回上一级", "Back"), this::onBackPressed),
                    new LinearLayout.LayoutParams(dp(48), dp(48)));
            }
            boolean paired = credentials.has("token");
            LinearLayout titles = column(); titles.setPadding(detail ? dp(8) : 0, 0, 0, 0);
            TextView pageTitle = text(detail ? conversationTitle : tr("会话", "Conversations"),
                detail ? Palette.TEXT_CARD : tabletShell ? 20 : Palette.TEXT_HERO, ink);
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
                connection = text("", Palette.TEXT_SMALL, muted); connection.setTag("headerConnectionState");
                connection.setSingleLine(true); connection.setMaxWidth(dp(112)); connection.setEllipsize(android.text.TextUtils.TruncateAt.END);
                connection.setPadding(dp(6), 0, dp(6), 0); connection.setVisibility(View.GONE);
                computer.addView(connection);
            }
            titles.addView(computer);
            header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); page.addView(header, 0);
            if (detail && splitDetail) {
                ImageButton focus = lineButton("sidebar", tr("切换会话侧栏", "Toggle conversation sidebar"), () -> {
                    tabletConversationFocus = !tabletConversationFocus;
                    View sidebar = tabletConversationList == null ? detailSidebar : tabletConversationList.root;
                    sidebar.setVisibility(tabletConversationFocus ? View.GONE : View.VISIBLE);
                    View parent = (View) sidebar.getParent();
                    View divider = parent.findViewWithTag("tabletConversationDivider");
                    if (divider != null) divider.setVisibility(tabletConversationFocus ? View.GONE : View.VISIBLE);
                });
                focus.setTag("tabletToggleSidebar"); header.addView(focus, new LinearLayout.LayoutParams(dp(48), dp(48)));
            }
            ImageButton search = null, switcher = null;
            if (!detail && paired) {
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
        return connection;
    }

    private void updateNavigationWidth() {
        if (workbenchNavigation != null && workbenchNavigation.getParent() instanceof NavigationDockLayout dock)
            dock.updateGeometry();
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
        ChatDockLayout.attach(root, scroll, content, dock, chatStyle, tag); return bar;
    }

    private EditText input(String label, String value, int type) {
        return input(content, label, value, type);
    }

    private EditText input(LinearLayout parent, String label, String value, int type) {
        parent.addView(text(label, Palette.TEXT_SMALL, muted));
        EditText input = new EditorInput(this); input.setSingleLine(true); input.setTextSize(Palette.TEXT_INPUT); input.setTextColor(ink); input.setHintTextColor(muted);
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
        persistDraft();
        destinationSwitch = true;
        try { action.run(); }
        finally { destinationSwitch = false; }
    }

    private void homeScreen() {
        stopNetwork(); screen = "home"; networkScreen = false; conversationId = null;
        readHomeComputers();
        renderHomeContent();
        if (foreground) refreshHomeConversations();
    }

    private void renderHomeContent() {
        shell("", "");
        homeHeading = text(tr("继续工作", "Continue working"), Palette.TEXT_HERO, ink);
        content.addView(homeHeading);
        homeEmptyHint = text(tr("本地聊天和远程电脑，从这里继续。",
            "Continue with local chat or a remote computer."), Palette.TEXT_BODY, muted);
        homeEmptyHint.setPadding(0, 0, 0, dp(14)); homeEmptyHint.setTag("homeEmptyHint");
        content.addView(homeEmptyHint);
        if (tabletShell) { buildTabletHome(); updateHomeConversations(); return; }
        homeConversations = new WorkbenchList(this, scroll);
        content.addView(homeConversations, new LinearLayout.LayoutParams(-1, -2));
        updateHomeConversations();
        renderHomeShortcuts();
        ((RefreshScrollView) scroll).setRefreshAction(() -> {
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - homeRefreshAt >= 5_000) {
                homeRefreshAt = now; refreshHomeConversations(true);
            }
            ((RefreshScrollView) scroll).setRefreshing(false);
        }, ready -> {});
        status.setVisibility(View.GONE);
    }

    private void buildTabletHome() {
        content.removeView(homeHeading); content.removeView(homeEmptyHint);
        ((android.view.ViewGroup) scroll.getParent()).removeView(scroll);
        homeHeading.setTextSize(26); root.addView(homeHeading); root.addView(homeEmptyHint);
        LinearLayout columns = new LinearLayout(this); columns.setTag("tabletHomeColumns");
        tabletHomeActiveScroll = new RefreshScrollView(this); tabletHomeRecentScroll = new RefreshScrollView(this);
        for (ScrollView pane : new ScrollView[]{tabletHomeActiveScroll, tabletHomeRecentScroll}) {
            pane.setVerticalScrollBarEnabled(false); pane.setFillViewport(true);
            ((RefreshScrollView) pane).setRefreshIndicatorVisible(false);
            ((RefreshScrollView) pane).setRefreshAction(() -> refreshHomeConversations(true), ready -> {});
        }
        homeConversations = new WorkbenchList(this, tabletHomeActiveScroll);
        tabletHomeRecent = new WorkbenchList(this, tabletHomeRecentScroll); tabletHomeRecent.setTag("tabletHomeRecent");
        tabletHomeActiveScroll.addView(homeConversations);
        LinearLayout recent = column(); recent.addView(tabletHomeRecent); tabletHomeRecentScroll.addView(recent);
        LinearLayout.LayoutParams first = new LinearLayout.LayoutParams(0, -1, 1.08f); first.setMarginEnd(dp(22));
        columns.addView(tabletHomeActiveScroll, first); columns.addView(tabletHomeRecentScroll, new LinearLayout.LayoutParams(0, -1, 1));
        root.addView(columns, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout previousContent = content; content = recent; renderHomeShortcuts(); content = previousContent;
        tabletHomeActiveScroll.post(() -> { if (tabletHomeActiveScroll != null) tabletHomeActiveScroll.scrollTo(0, tabletHomeActiveY); });
        tabletHomeRecentScroll.post(() -> { if (tabletHomeRecentScroll != null) tabletHomeRecentScroll.scrollTo(0, tabletHomeRecentY); });
        status.setVisibility(View.GONE);
    }

    private void refreshHomeContent() {
        if (!screen.equals("home") || homeConversations == null) return;
        if (tabletHomeActiveScroll != null) ((ChatScrollView) tabletHomeActiveScroll).whenScrollIdle(() -> {
            if (tabletHomeRecentScroll != null) ((ChatScrollView) tabletHomeRecentScroll).whenScrollIdle(this::updateHomeConversations);
        });
        else ((ChatScrollView) scroll).whenScrollIdle(this::updateHomeConversations);
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
        if (tabletHomeRecent != null) {
            ArrayList<WorkbenchList.Item> recent = new ArrayList<>();
            renderHomeRecent(cached, shown, recent);
            if (recent.isEmpty()) { recent.add(new WorkbenchList.Item("recent", "0", () -> homeRecentHeader(0))); recent.add(new WorkbenchList.Item("recentEmpty", "", () -> text(tr("暂无最近会话", "No recent conversations"), Palette.TEXT_BODY, muted))); }
            tabletHomeRecent.show(recent);
        } else renderHomeRecent(cached, shown, items);
        renderHomeUnavailable(items);
        homeConversations.show(items);
    }

    private JSONArray homeCachedConversations() {
        JSONArray rows = new JSONArray();
        ArrayList<JSONObject> merged = new ArrayList<>();
        for (JSONObject computer : homeComputers) {
            if (homeSync.state(computer) == RemoteWorkbenchSync.State.UNAUTHORIZED) continue;
            JSONObject page = homeCachedPage(computer);
            JSONArray entries = page == null ? null : page.optJSONArray("conversations");
            JSONObject listed = listCache == null ? null : listCache.get(computer);
            JSONArray listedRows = listed == null ? null : listed.optJSONArray("conversations");
            java.util.Map<String, JSONObject> replyRows = new java.util.HashMap<>();
            for (int i = 0; listedRows != null && i < listedRows.length(); i++) {
                JSONObject row = listedRows.optJSONObject(i);
                if (row != null) replyRows.put(row.optString("id"), row);
            }
            for (int i = 0; entries != null && i < entries.length(); i++) {
                JSONObject row = entries.optJSONObject(i);
                if (row == null || row.optString("id").isEmpty()) continue;
                try {
                    JSONObject summary = new JSONObject(row.toString());
                    // The Sessions page may know a newer reply or read receipt than Home's summary cache.
                    JSONObject reply = replyRows.get(row.optString("id"));
                    for (String key : new String[] { "lastReplyAt", "replyReadAt" })
                        if (reply != null && reply.has(key)) summary.put(key, Math.max(summary.optLong(key), reply.optLong(key)));
                    merged.add(summary.put("homeAddress", computer.optString("address"))
                        .put("homeComputerName", computerName(computer))
                        .put("homeFresh", homeSync.state(computer) == RemoteWorkbenchSync.State.LIVE));
                } catch (Exception ignored) { }
            }
        }
        merged.sort((left, right) -> {
            int order = Long.compare(right.optLong("updatedAt"), left.optLong("updatedAt"));
            return order == 0 ? left.optString("homeAddress").compareTo(right.optString("homeAddress")) : order;
        });
        for (JSONObject row : merged) rows.put(row);
        return rows;
    }

    private String homeKey(JSONObject row) { return row.optString("homeAddress") + "#" + row.optString("id"); }

    private JSONObject homeCachedPage(JSONObject computer) {
        JSONObject page = homeCache == null ? null : homeCache.get(computer);
        return page != null || listCache == null ? page : listCache.get(computer);
    }

    private void readHomeComputers() {
        homeComputers.clear();
        try { for (JSONObject computer : store.all()) if (computer.has("token")) homeComputers.add(computer); }
        catch (Exception error) { android.util.Log.w("CamelliaHome", "Could not read paired computers", error); }
        // The selected profile can include changes not yet flushed by the pairing flow.
        if (credentials.has("token")) {
            homeComputers.removeIf(computer -> computer.optString("address").equals(credentials.optString("address")));
            homeComputers.add(credentials);
        }
    }

    private void renderHomeUnavailable(ArrayList<WorkbenchList.Item> items) {
        for (JSONObject computer : homeComputers) {
            RemoteWorkbenchSync.State state = homeSync.state(computer);
            if (homeCachedPage(computer) != null && state != RemoteWorkbenchSync.State.UNAUTHORIZED) continue;
            String address = computer.optString("address");
            String message = state == RemoteWorkbenchSync.State.UNAUTHORIZED ? tr("请检查配对和访问权限", "Check pairing and access permissions")
                : state == RemoteWorkbenchSync.State.CONNECTING ? tr("正在获取任务…", "Fetching tasks…")
                : tr("暂时无法同步任务", "Tasks unavailable right now");
            String label = computerName(computer) + " · " + message;
            items.add(new WorkbenchList.Item("homeUnavailable:" + address, label, () -> {
                TextView note = text(label, Palette.TEXT_SMALL, muted);
                note.setTag("homeUnavailable:" + address); note.setPadding(0, dp(8), 0, dp(8));
                note.setOnClickListener(view -> manageComputer(computer));
                note.setFocusable(true);
                return note;
            }));
        }
    }

    private void renderHomeRunning(JSONArray cached, java.util.Set<String> shown, ArrayList<WorkbenchList.Item> items) {
        ArrayList<JSONObject> active = new ArrayList<>();
        for (int index = 0; index < cached.length(); index++) {
            JSONObject conversation = cached.optJSONObject(index);
            if (conversation != null && homeConversationActive(conversation)) active.add(conversation);
        }
        if (active.isEmpty() && tabletShell) {
            items.add(new WorkbenchList.Item("running", "0", () -> homeRunningHeader(0)));
            items.add(new WorkbenchList.Item("activeEmpty", "", () -> text(tr("暂无进行中的任务", "No work in progress"), Palette.TEXT_BODY, muted))); return;
        }
        if (tabletShell) active.sort(java.util.Comparator.comparingInt(row -> {
            String activity = row.optString("activity"); return activity.equals("permission") || activity.equals("question") ? 0 : 1;
        }));
        if (active.isEmpty()) return;
        items.add(new WorkbenchList.Item("running", active.size() > 3 ? active.size() + ":" + homeRunningExpanded : "",
            () -> homeRunningHeader(active.size())));
        int count = tabletShell || homeRunningExpanded ? active.size() : Math.min(3, active.size());
        for (int index = 0; index < count; index++) {
            JSONObject conversation = active.get(index);
            String id = homeKey(conversation);
            shown.add(id);
            items.add(homeConversationItem(conversation, true, "homeActive:" + id, "homeActiveStatus:" + id));
        }
    }

    private View homeRunningHeader(int count) {
        LinearLayout section = new LinearLayout(this);
        section.setTag("homeRunningSection");
        section.setGravity(Gravity.CENTER_VERTICAL);
        section.setPadding(0, dp(2), 0, dp(2));
        section.setMinimumHeight(dp(52));
        TextView label = text(tabletShell ? tr("进行中", "Running") : tr("运行中", "Running"), Palette.TEXT_CARD, ink);
        label.setTag("homeRunningTitle");
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        section.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (count > 3 && !tabletShell) {
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
        return RemoteWorkbenchSync.active(conversation);
    }

    private WorkbenchList.Item homeConversationItem(JSONObject conversation, boolean active, String tag, String statusTag) {
        Palette palette = Palette.of(this);
        boolean unread = replies().unread(conversationComputer(conversation), conversation);
        String state = conversation.optString("activity");
        int statusColor = state.equals("running") ? palette.success
            : state.equals("permission") || state.equals("question") ? palette.warning
            : RemoteWorkStatus.backgroundCount(conversation) > 0 || unread ? palette.accent : palette.muted;
        String indicator = active ? activity(conversation) : "";
        if (active && !conversation.optBoolean("homeFresh")) {
            indicator = cachedHomeActivity(conversation);
            statusColor = palette.muted;
        }
        indicator = withReplyIndicator(indicator, unread);
        String engine = conversationEngine(conversation), title = conversation.optString("title");
        String meta = conversation.optString("homeComputerName") + " · " + conversationMeta(conversation), time = conversationTime(conversation);
        // Ignore stream counters, previews and other metadata that this page does not display.
        String presentation = new JSONArray().put(engine).put(title).put(meta).put(indicator).put(statusColor).put(time).toString();
        final String label = indicator;
        final int color = statusColor;
        return new WorkbenchList.Item(tag, presentation, () -> {
            ConversationRow row = new ConversationRow(this, chatStyle, false, engine,
                title, meta, label, color, time, tag, statusTag, () -> openHomeConversation(conversation),
                () -> homeConversationMenu(conversation, tag));
            row.setContentDescription(title + " · " + meta + (label.isEmpty() ? "" : " · " + label) + " · " + time);
            return row;
        });
    }

    private String cachedHomeActivity(JSONObject conversation) {
        RemoteWorkbenchSync.State sync = homeSync.state(conversationComputer(conversation));
        String state = conversation.optString("activity");
        if (sync == RemoteWorkbenchSync.State.CONNECTING) return tr("正在确认状态…", "Checking status…");
        if (sync == RemoteWorkbenchSync.State.STALE) return state.equals("running")
            ? tr("离线 · 上次运行中", "Offline · Previously running")
            : tr("离线 · 状态待确认", "Offline · Status unconfirmed");
        return state.equals("running") ? tr("上次运行中", "Previously running") : tr("状态待确认", "Status unconfirmed");
    }

    private void cancelHomeConversationMenu() {
        RemoteApi client = homeMenuClient; homeMenuClient = null;
        if (client != null) client.cancel();
        if (homeMenuNotice != null) { homeMenuNotice.cancel(); homeMenuNotice = null; }
    }

    private JSONObject pairedHomeComputer(JSONObject computer) throws Exception {
        for (JSONObject saved : store.all())
            if (RemoteWorkbenchSync.identity(saved).equals(RemoteWorkbenchSync.identity(computer)) && saved.has("token")) return saved;
        throw new IOException(tr("这台电脑的配对已变化，请刷新工作台。", "This computer's pairing changed. Refresh Home."));
    }

    private void homeConversationMenu(JSONObject summary, String tag) {
        cancelHomeConversationMenu();
        if (conversationPopup != null) { conversationPopup.dismiss(); conversationPopup = null; }
        final JSONObject computer;
        try { computer = pairedHomeComputer(conversationComputer(summary)); }
        catch (Exception error) { homeConversationMenuFailure(error); return; }
        RemoteApi client = homeClientFactory.apply(computer.optString("address")); homeMenuClient = client;
        int ticket = generation;
        handler.postDelayed(() -> {
            if (homeMenuClient != client) return;
            homeMenuNotice = android.widget.Toast.makeText(this, tr("正在获取会话操作…", "Loading conversation actions…"), android.widget.Toast.LENGTH_SHORT);
            homeMenuNotice.show();
        }, 400);
        worker.submit(() -> {
            try {
                JSONObject info = client.json("/v1/status", computer.optString("token"), null);
                String capabilities = String.valueOf(info.optJSONArray("capabilities"));
                if (info.optInt("protocol") != 1 || !info.optString("permission").equals("control")
                        || !capabilities.contains("\"conversation-actions\""))
                    throw new IOException(tr("会话管理需要控制权限，并更新重启电脑端。", "Conversation actions require control permission and an updated, restarted desktop."));
                // Home's lightweight summary intentionally omits pinned and seq. Fetch only
                // the current metadata, without downloading messages or opening the chat.
                JSONObject snapshot = client.json("/v1/conversations/" + summary.optString("id") + "?before=1", computer.optString("token"), null);
                JSONObject conversation = snapshot.getJSONObject("conversation");
                if (!summary.optString("id").equals(conversation.optString("id")) || !conversation.has("seq"))
                    throw new IOException(tr("会话已变化，请刷新。", "Conversation changed; refresh first."));
                boolean fork = capabilities.contains("\"create\"") && capabilities.contains("\"fork\"");
                handler.post(() -> {
                    if (homeMenuClient != client || ticket != generation || !foreground || !screen.equals("home")) return;
                    cancelHomeConversationMenu();
                    View anchor = root.findViewWithTag(tag);
                    if (anchor == null || !anchor.isAttachedToWindow() || !anchor.getGlobalVisibleRect(new android.graphics.Rect())) return;
                    try {
                        pairedHomeComputer(computer);
                        conversationPopup = conversationActionsMenu(anchor, conversation, fork,
                            action -> openHomeConversationActions(computer, conversation, info, action));
                    } catch (Exception error) { homeConversationMenuFailure(error); }
                });
            } catch (Exception error) {
                handler.post(() -> {
                    if (homeMenuClient != client || ticket != generation || !foreground || !screen.equals("home")) return;
                    cancelHomeConversationMenu(); homeConversationMenuFailure(error);
                });
            } finally { client.cancel(); }
        });
    }

    private void homeConversationMenuFailure(Exception error) {
        new CamelliaDialog.Builder(this).setTitle(tr("无法打开会话操作", "Conversation actions unavailable"))
            .setMessage(ErrorDetails.withSummary(tr("请检查对应电脑的连接及控制权限。", "Check this computer's connection and control permission."), error))
            .setPositiveButton(tr("知道了", "OK"), null).show();
    }

    private void openHomeConversationActions(JSONObject computer, JSONObject conversation, JSONObject info, String action) {
        if (!screen.equals("home")) return;
        try {
            JSONObject target = pairedHomeComputer(computer);
            if (commandBusy || target.has("pendingCreate"))
                throw new IOException(tr("请先在此电脑的会话页确认待处理操作。", "Resolve the pending action in this computer's Sessions page first."));
            persistDraft(); stopNetwork(); store.save(target); credentials = store.load();
            listScreen(); updateCapabilities(info); instance = info.optString("instanceId");
            homeActionConversation = conversation; homeActionScope = RemoteWorkbenchSync.identity(credentials);
            conversations.put(conversation.optString("id"), conversation);
            renderConversations();
            // Keep the selected Home row even when it falls outside the first list page.
            nextOffset = 0;
            if (foreground) loadList(true);
            performConversationAction(conversation, action);
        } catch (Exception error) { homeConversationMenuFailure(error); }
    }

    private JSONObject conversationComputer(JSONObject conversation) {
        String address = conversation.optString("homeAddress");
        for (JSONObject computer : homeComputers) if (address.equals(computer.optString("address"))) return computer;
        return new JSONObject();
    }

    private void openHomeConversation(JSONObject conversation) {
        try {
            String address = conversation.optString("homeAddress");
            JSONObject target = null;
            for (JSONObject computer : store.all()) if (address.equals(computer.optString("address")) && computer.has("token")) { target = computer; break; }
            if (target == null) throw new IOException(tr("这台服务器已移除，请刷新首页。", "This server was removed. Refresh Home."));
            persistDraft(); stopNetwork(); store.save(target); credentials = store.load();
            canCreate = false; canCreateWorkspace = false; canImage = false; availableWorkspaces = new JSONArray();
            conversationId = conversation.optString("id"); conversationTitle = conversation.optString("title");
            detailReturn = "home"; detailScreen();
            if (foreground) connectEvents();
        } catch (Exception error) { reportError("无法打开服务器上的会话。", "Could not open the server conversation.", error); }
    }

    private void renderHomeRecent(JSONArray cached, java.util.Set<String> shown, ArrayList<WorkbenchList.Item> items) {
        int available = 0;
        for (int index = 0; index < cached.length(); index++) {
            JSONObject conversation = cached.optJSONObject(index);
            if (conversation != null && !homeConversationActive(conversation)
                && !shown.contains(homeKey(conversation))) available++;
        }
        if (available == 0) return;
        final int count = Math.min(30, available);
        items.add(new WorkbenchList.Item("recent", count + ":" + homeRecentExpanded, () -> homeRecentHeader(count)));
        int added = 0;
        int limit = homeRecentExpanded ? 30 : 3;
        for (int index = 0; index < cached.length() && added < limit; index++) {
            JSONObject conversation = cached.optJSONObject(index);
            if (conversation == null) continue;
            String id = homeKey(conversation);
            if (id.isEmpty() || shown.contains(id) || homeConversationActive(conversation)) continue;
            shown.add(id); added++;
            items.add(homeConversationItem(conversation, false, "homeRecent:" + id, "homeRecentStatus:" + id));
        }
    }

    private View homeRecentHeader(int count) {
        LinearLayout section = new LinearLayout(this);
        section.setTag("homeRecentSection");
        section.setGravity(Gravity.CENTER_VERTICAL);
        section.setPadding(0, tabletShell ? dp(2) : dp(12), 0, dp(2));
        section.setMinimumHeight(tabletShell ? dp(52) : dp(62));
        TextView label = text(tr("最近", "Recent"), Palette.TEXT_CARD, ink);
        label.setTag("homeRecentTitle");
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        section.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (count <= 3) return section;
        TextView all = text(homeRecentExpanded ? tr("收起", "Collapse") : tr("展开更多", "Show more"), Palette.TEXT_SMALL, accent);
        all.setGravity(Gravity.CENTER); all.setMinHeight(dp(48)); all.setPadding(dp(12), 0, dp(2), 0); all.setTag("homeRecentAll");
        all.setOnClickListener(view -> {
            homeRecentExpanded = !homeRecentExpanded;
            homeSync.setRecentLimit(homeRecentExpanded ? 30 : 3);
            refreshHomeContent();
        });
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
                PageTransitions.openActivity(this, new android.content.Intent(this, LocalChatActivity.class));
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
        refreshHomeConversations(false);
    }

    private void refreshHomeConversations(boolean force) {
        if (!foreground || !screen.equals("home") || homeCache == null) return;
        homeSync.setRecentLimit(homeRecentExpanded ? 30 : 3);
        readHomeComputers();
        if (!EmbeddedNetwork.online()) { homeSync.stop(); refreshHomeContent(); return; }
        int ticket = generation;
        java.util.function.Consumer<RemoteWorkbenchSync.Update> listener = update -> deliver(ticket, () -> {
            if (!screen.equals("home") || !homeSync.current(update)) return;
            if (update.state == RemoteWorkbenchSync.State.UNAUTHORIZED) {
                homeCache.remove(update.computer); listCache.remove(update.computer); conversationCache.remove(update.computer, null);
            } else if (update.page != null) {
                homeCache.put(update.computer, update.page.optJSONArray("conversations"), -1, new JSONArray(), false);
            }
            refreshHomeContent();
        });
        if (force) homeSync.refresh(homeComputers, listener); else homeSync.start(homeComputers, listener);
        refreshHomeContent();
    }

    private void settingsScreen() {
        if (MobileLayout.useTabletRail(getResources().getConfiguration())) { openSettingsSection("general", true); return; }
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
        openSettingsSection(section, false);
    }

    private void openSettingsSection(String section, boolean destination) {
        android.content.Intent intent = new android.content.Intent(this, SettingsActivity.class).putExtra("section", section);
        if (destination || MobileLayout.useTabletRail(getResources().getConfiguration())) { TabletScaffold.openSettingsCategory(this, intent); return; }
        startActivity(intent);
        PageTransitions.openActivity(this);
    }

    private void openAccountUsage(JSONObject computer) {
        android.content.Intent intent = new android.content.Intent(this, RemoteUsageActivity.class)
            .putExtra("address", computer == null ? credentials.optString("address") : computer.optString("address"));
        if (MobileLayout.useTabletRail(getResources().getConfiguration())) TabletScaffold.openSettingsCategory(this, intent);
        else { startActivity(intent); PageTransitions.openActivity(this); }
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
        if (pairNetworkValue == null || !screen.equals("pair")) return;
        pairNetworkValue.setText(mobileAccessState());
    }

    private void editDeviceName() {
        SettingsStyle style = new SettingsStyle(this);
        LinearLayout panel = computerDialogPanel(tr("本机名称", "This phone name"),
            tr("配对时默认提交这个名称，电脑端可以在授权时确认。最多 80 个字符。", "This name is submitted by default when pairing; the computer confirms it when authorizing. Up to 80 characters."), "phone");
        TextView label = text(tr("设备名称", "Device name"), Palette.TEXT_SMALL, muted); panel.addView(label);
        EditText name = new EditorInput(this); name.setId(View.generateViewId()); label.setLabelFor(name.getId());
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
            EmbeddedNetwork.setNodeHostname(value);
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
        persistDraft();
        stopNetwork(); screen = "computers"; networkScreen = false; conversationId = null;
        syncLanDiscoveryForScreen();
        clearHistory(); conversations.clear();
        shell(tr("电脑与连接", "Computers & connections"), "");
        root.setClipChildren(false);
        SettingsStyle style = new SettingsStyle(this);
        if (tabletShell) {
            try {
                root.setPadding(0, 0, 0, 0);
                root.removeAllViews();
                tabletComputerPane = new TabletComputerPane(this, chinese, store.all(), tabletComputerAddress,
                    computerStates, computerRoutes, computerInformation, tabletComputerExpanded, new TabletComputerPane.Listener() {
                        public String name(JSONObject computer) { return computerName(computer); }
                        public void selected(String address) { tabletComputerAddress = address; }
                        public void open(JSONObject computer) { openComputer(computer); }
                        public void test(JSONObject computer) { testComputerConnection(computer); }
                        public void rename(JSONObject computer) { renameComputer(computer); }
                        public void connectionSettings(JSONObject computer) { showComputerConnectionSettings(computer); }
                        public void restart(JSONObject computer) { restartComputer(computer); }
                        public void forget(JSONObject computer) { MainActivity.this.forget(computer); }
                        public void add() { addComputer(); }
                    });
                root.addView(tabletComputerPane, new LinearLayout.LayoutParams(-1, -1));
                ((RefreshScrollView) scroll).setRefreshAction(this::refreshComputers, ready -> {});
            } catch (Exception error) { reportError("无法读取电脑列表，请重试。", "Could not load computers. Try again.", error); }
            return;
        }
        TextView introduction = text(tr("管理配对与连接；打开一台电脑会进入它的会话。",
            "Manage pairing and connections. Open a computer to see its conversations."), Palette.TEXT_BODY, style.secondary);
        introduction.setPadding(dp(2), dp(2), dp(2), dp(12)); content.addView(introduction);
        LinearLayout group = style.group(content, ""); group.setTag("computerList");
        status.setVisibility(View.GONE);
        try {
            var computers = store.all();
            if (computers.isEmpty()) {
                // Keep the empty state outside the card so it does not read
                // as another action beside "Add computer".
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
        boolean online = state.equals(tr("已连接", "Connected"));
        row.state(state, online, checkingComputer(state));
        row.route(online ? computerRoutes.get(address) : null);
        return row;
    }

    private boolean checkingComputer(String state) {
        return state.equals(tr("待检查", "Not checked")) || state.equals(tr("正在检查…", "Checking…"))
            || state.equals(tr("正在重启…", "Restarting…"));
    }

    private void updateComputerState(String address, String state) {
        computerStates.put(address, state);
        if (computerDialog != null && computerDialog.isShowing()) {
            TextView summary = computerDialog.getWindow().getDecorView().findViewWithTag("managedComputerSummary:" + address);
            if (summary != null) summary.setText(managedComputerDescription(address));
        }
        if (tabletComputerPane != null) tabletComputerPane.update(address);
        View row = root.findViewWithTag("computer:" + address);
        if (row instanceof ComputerRow) {
            boolean online = state.equals(tr("已连接", "Connected"));
            ComputerRow value = (ComputerRow) row;
            value.state(state, online, checkingComputer(state));
            value.route(online ? computerRoutes.get(address) : null);
        }
    }

    private void openComputer(JSONObject computer) {
        try {
            JSONObject current = storedComputer(computer.optString("address"));
            if (current == null) throw new IOException("Computer was removed");
            persistDraft();
            canCreate = false; canCreateWorkspace = false; canImage = false; availableWorkspaces = new JSONArray();
            stopNetwork(); store.save(current); credentials = store.load();
            if (credentials.has("token")) switchDestination(() -> { listScreen(); loadList(false); });
            else pairScreen();
        } catch (Exception error) { reportError("无法读取电脑凭据，请重试。", "Could not load computer credentials. Try again.", error); }
    }

    private void manageComputer(JSONObject computer) {
        SettingsStyle style = new SettingsStyle(this);
        String address = computer.optString("address");
        LinearLayout panel = computerDialogPanel(computerName(computer), managedComputerDescription(address));
        panel.findViewWithTag("computerDialogSubtitle").setTag("managedComputerSummary:" + address);
        android.app.Dialog dialog = createComputerDialog(panel);
        LinearLayout group = style.group(panel, "");
        addComputerConnectionSettings(style, group, computer, dialog);
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

    private String managedComputerDescription(String address) {
        String state = computerStates.getOrDefault(address, "");
        String route = switch (ComputerRoutes.activeTransport(address)) {
            case ComputerRoutes.LAN -> tr("当前线路：局域网直连", "Current route: LAN direct");
            case ComputerRoutes.TAILSCALE -> tr("当前线路：Tailscale", "Current route: Tailscale");
            default -> "";
        };
        return address + (state.isEmpty() ? "" : "\n" + state) + (route.isEmpty() ? "" : "\n" + route);
    }

    private void showComputerConnectionSettings(JSONObject computer) {
        JSONObject current = storedComputer(computer.optString("address"));
        if (current == null || !current.has("token")) return;
        SettingsStyle style = new SettingsStyle(this);
        LinearLayout panel = computerDialogPanel(tr("连接设置", "Connection settings"), computerName(current));
        android.app.Dialog dialog = createComputerDialog(panel);
        addComputerConnectionSettings(style, style.group(panel, ""), current, dialog);
        showComputerDialog(dialog);
    }

    private void addComputerConnectionSettings(SettingsStyle style, LinearLayout group, JSONObject computer,
                                               android.app.Dialog dialog) {
        String address = computer.optString("address");
        JSONObject saved = storedComputer(address);
        JSONObject profile = saved == null ? computer : saved;
        if (!profile.has("token")) return;
        if (ComputerRoutes.tailscaleUrl(profile).isEmpty()) {
            style.action(group, tr("添加 Tailscale 连接", "Add Tailscale"),
                tr("输入地址或扫描电脑二维码，沿用当前配对",
                    "Enter an address or scan the computer QR code to reuse this pairing"),
                "manageAddTailscale", false, () -> { dialog.dismiss(); promptAddTailscale(profile); });
            return;
        }
        style.toggle(group, tr("自动局域网直连", "Automatic LAN direct"),
            tr("开启后优先使用已验证的局域网连接，其他情况使用 Tailscale",
                "When enabled, prefer verified LAN connections. Use Tailscale otherwise."),
            "manageAutoLan", ComputerRoutes.prefersLan(profile), (button, checked) -> {
                try {
                    JSONObject current = storedComputer(address);
                    if (current == null || !store.saveProfile(current.put("lanPreferred", checked))) {
                        throw new IOException("Computer was removed");
                    }
                    credentials = store.load();
                    syncLanDiscoveryForScreen();
                } catch (Exception error) {
                    dialog.dismiss();
                    reportError("无法保存自动局域网设置。", "Could not save automatic LAN settings.", error);
                }
            });
    }

    private void promptAddTailscale(JSONObject computer) {
        if (!foreground || computer == null || !computer.has("token")) return;
        String address = computer.optString("address");
        LinearLayout panel = column();
        EditText host = input(panel, tr("Tailscale 地址", "Tailscale address"), "100.x.y.z",
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText port = input(panel, tr("端口", "Port"), "43127", InputType.TYPE_CLASS_NUMBER);
        port.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(5)});
        new CamelliaDialog.Builder(this)
            .setTitle(tr("添加 Tailscale 连接", "Add Tailscale"))
            .setMessage(tr("沿用这台电脑现有的设备凭据，不需要重新配对。也可以扫描电脑端二维码自动填写。",
                "Reuse this computer's existing device credential without pairing again, or scan its QR code."))
            .setView(panel)
            .setNeutralButton(tr("扫描二维码", "Scan QR code"), (dialog, which) -> {
                try {
                    tailscaleMergeAddress = address;
                    startActivityForResult(new android.content.Intent(this, QrScanActivity.class), SCAN_TAILSCALE_QR_REQUEST);
                } catch (Exception error) {
                    tailscaleMergeAddress = "";
                    reportError("无法打开二维码扫描", "Cannot open the QR scanner", error);
                }
            })
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("连接", "Connect"), (dialog, which) -> {
                try {
                    Endpoint endpoint = new Endpoint(host.getText().toString(), port.getText().toString());
                    if (endpoint.isLan()) throw new IllegalArgumentException("Tailscale address required");
                    connectExistingTailscale(computer, endpoint.origin());
                } catch (IllegalArgumentException error) {
                    setStatusNotice(tr("请输入电脑端显示的 Tailscale IPv4 地址和端口。",
                        "Enter the Tailscale IPv4 address and port shown on the computer."));
                }
            }).show();
        host.requestFocus();
    }

    private void connectExistingTailscale(JSONObject computer, String url) {
        if (!foreground || lanConnectBusy || computer == null || !computer.has("token")) return;
        final Endpoint endpoint;
        try {
            endpoint = new Endpoint(url);
            if (endpoint.isLan()) throw new IllegalArgumentException("Tailscale address required");
        } catch (IllegalArgumentException error) {
            setStatusNotice(tr("这台电脑还没有可用的 Tailscale 地址。", "This computer has no usable Tailscale address."));
            return;
        }
        lanConnectBusy = true;
        final String address = computer.optString("address"), token = computer.optString("token");
        final String expectedId = computer.optString("computerId");
        statusWorker.submit(() -> {
            JSONObject info;
            RemoteApi client = null;
            try {
                client = RemoteApi.explicit(this, endpoint.origin());
                statusClients.add(client);
                info = client.json("/v1/status", token, null);
            } catch (Exception error) {
                handler.post(() -> {
                    lanConnectBusy = false;
                    if (!foreground) return;
                    String detail = error instanceof RemoteApi.Failure failure && failure.status == 401
                        ? tr("当前设备凭据不能通过 Tailscale 使用。请在“添加电脑”中重新配对这台电脑。",
                            "This device credential cannot be used over Tailscale. Pair this computer again from Add computer.")
                        : RemoteApi.failureMessage(error, chinese);
                    new CamelliaDialog.Builder(this)
                        .setTitle(tr("Tailscale 连接失败", "Tailscale connection failed"))
                        .setMessage(detail).setPositiveButton(tr("知道了", "OK"), null).show();
                });
                return;
            } finally {
                if (client != null) statusClients.remove(client);
                if (client != null) client.cancel();
            }
            JSONObject found = info;
            handler.post(() -> {
                lanConnectBusy = false;
                if (!foreground) return;
                try {
                    if (found.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
                    String returnedId = found.optString("computerId");
                    if (!expectedId.isEmpty() && !returnedId.isEmpty() && !expectedId.equals(returnedId)) {
                        throw new IOException(tr("Tailscale 地址对应的电脑与当前电脑不一致。",
                            "The computer at this Tailscale address does not match the current computer."));
                    }
                    JSONObject current = storedComputer(address);
                    if (current == null || !token.equals(current.optString("token"))) {
                        throw new IOException("Computer pairing changed");
                    }
                    JSONObject next = new JSONObject(current.toString());
                    next.put("lanPreferred", ComputerRoutes.prefersLan(current)).put("tailscaleAddress", endpoint.origin());
                    if (!returnedId.isEmpty()) next.put("computerId", returnedId);
                    JSONObject transports = found.optJSONObject("transports");
                    JSONObject lan = transports == null ? null : transports.optJSONObject("lan");
                    if (lan != null && LanTls.validFingerprint(lan.optString("fingerprint"))
                            && !lan.optString("url").isEmpty()) {
                        next.put("lanAddress", lan.optString("url"))
                            .put("lanFingerprint", LanTls.normalize(lan.optString("fingerprint")));
                    }
                    ComputerRoutes.updateDiscoveredRoute(next, lanServiceFor(next.optString("computerId")));
                    if (!store.saveProfileByAddress(next)) throw new IOException("Computer was removed");
                    credentials = store.load();
                    ComputerRoutes.configure(store.all());
                    android.widget.Toast.makeText(this, tr("Tailscale 连接已保存。", "Tailscale connection saved."),
                        android.widget.Toast.LENGTH_SHORT).show();
                    if (screen.equals("computers")) refreshComputers();
                    else if (address.equals(credentials.optString("address"))) lanConnectionChanged();
                } catch (Exception error) {
                    reportError("无法保存 Tailscale 连接。", "Could not save the Tailscale connection.", error);
                }
            });
        });
    }

    private JSONObject storedComputer(String address) {
        try {
            for (JSONObject computer : store.all()) if (address.equals(computer.optString("address"))) return computer;
        } catch (Exception ignored) { }
        return null;
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
        subtitle.setTag("computerDialogSubtitle");
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
        EditText name = new EditorInput(this); name.setTag("computerNameInput"); name.setId(View.generateViewId()); label.setLabelFor(name.getId());
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
        clearComputerRoutes();
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
                        String token = computer.getString("token");
                        info = client.json("/v1/status", token, null);
                        if (info.optInt("protocol") != 1) throw new IOException("Unsupported protocol");
                        result = tr("已连接", "Connected");
                        if (ComputerRoutes.LAN.equals(ComputerRoutes.activeTransport(address))) {
                            // No Tailscale path diagnostic is meaningful for a LAN route.
                        } else if (EmbeddedNetwork.enabled()) {
                            try {
                                String host = java.net.URI.create(ComputerRoutes.route(address).url).getHost();
                                if (host != null) probeComputerPath(ticket, address, host);
                            } catch (Exception ignored) { /* path is diagnostic, not connection state */ }
                        }
                    } catch (Exception error) {
                        revoked = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 401;
                        result = RemoteApi.failureMessage(error, chinese);
                    }
                    String state = result;
                    JSONObject metadata = info;
                    boolean unauthorized = revoked;
                    deliver(ticket, () -> {
                        if (metadata == null) computerInformation.remove(address); else computerInformation.put(address, metadata);
                        if (observeTransportInfo(metadata, address)) handler.post(this::applyLanRoutes);
                        if (unauthorized) { listCache.remove(computer); homeCache.remove(computer); prefetch.remove(computer, null); conversationCache.remove(computer, null); }
                        if (ComputerRoutes.LAN.equals(ComputerRoutes.activeTransport(address)))
                            computerRoutes.put(address, tr("局域网直连", "LAN direct"));
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

    private void clearComputerRoutes() {
        computerRoutes.clear();
        if (screen.equals("computers")) for (var entry : computerStates.entrySet())
            updateComputerState(entry.getKey(), entry.getValue());
    }

    private void probeComputerPath(int ticket, String address, String host) {
        if (ticket != generation || statusWorker.isShutdown()) return;
        statusWorker.submit(() -> {
            if (ticket != generation) return;
            JSONObject result = null;
            try {
                result = EmbeddedNetwork.path(host);
            } catch (Exception ignored) { /* a failed probe must clear the old path */ }
            JSONObject probe = result;
            deliver(ticket, () -> applyComputerPath(ticket, address, probe));
        });
    }

    private void applyComputerPath(int ticket, String address, JSONObject probe) {
        if (ticket != generation || !foreground || !screen.equals("computers")) return;
        String label = ComputerRoute.label(probe, chinese);
        if (label.isEmpty()) computerRoutes.remove(address); else computerRoutes.put(address, label);
        updateComputerState(address, computerStates.getOrDefault(address, tr("正在检查…", "Checking…")));
    }

    private LinearLayout pairingCardBody(SettingsStyle style, LinearLayout parent, String icon, String title, String subtitle) {
        LinearLayout card = style.group(parent, "");
        card.setPadding(dp(18), dp(16), dp(18), dp(16));
        LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) card.getLayoutParams();
        params.bottomMargin = dp(12);
        card.setLayoutParams(params);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView iconView = new ImageView(this);
        iconView.setImageDrawable(new LineIcon(icon, style.accent));
        iconView.setBackground(style.round(style.palette().controlFill, 12));
        iconView.setPadding(dp(9), dp(9), dp(9), dp(9));
        iconView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(iconView, new LinearLayout.LayoutParams(dp(40), dp(40)));
        LinearLayout copy = column();
        copy.setPadding(dp(12), 0, 0, 0);
        TextView heading = text(title, Palette.TEXT_CARD, style.ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(0, 0, 0, dp(2));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        copy.addView(heading);
        TextView sub = text(subtitle, Palette.TEXT_SMALL, style.secondary);
        sub.setPadding(0, 0, 0, 0);
        copy.addView(sub);
        header.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        card.addView(header);
        LinearLayout body = column();
        body.setPadding(0, dp(12), 0, 0);
        card.addView(body);
        return body;
    }

    private Button compactButton(String label, boolean primary) {
        Button button = new Button(this);
        button.setText(label);
        ActionStyle.page(button, primary);
        button.setMinWidth(dp(104));
        return button;
    }

    private void pairScreen() {
        boolean enteringPair = !"pair".equals(screen);
        stopNetwork();
        closeCommandClients();
        screen = "pair";
        if (enteringPair) {
            lanPairScanning = false;
            lanScanStartedAt = 0;
            lanDiscoveryError = Integer.MIN_VALUE;
            handler.removeCallbacks(lanScanRefresh);
            lanServices.clear();
            if (lanDiscovery != null) lanDiscovery.stop(true);
        }
        syncLanDiscoveryForScreen();
        networkScreen = false;
        conversationId = null;
        shell(tr("配对电脑", "Pair computer"), "");
        root.setFocusableInTouchMode(true); root.requestFocus();
        SettingsStyle style = new SettingsStyle(this);
        TextView intro = text(tr("选择一种方式连接电脑。同一 Wi-Fi 更快，外出时使用 Tailscale。",
            "Choose how to connect. Same Wi-Fi is faster; use Tailscale when you are away."),
            Palette.TEXT_BODY, style.secondary);
        intro.setPadding(dp(4), 0, dp(4), dp(12));
        content.addView(intro);

        LinearLayout tailscale = pairingCardBody(style, content, "shield",
            tr("Tailscale 网络", "Tailscale network"),
            tr("跨网络连接，适合离开家后使用", "Works across networks when you are away"));
        LinearLayout networkRow = new LinearLayout(this);
        networkRow.setGravity(Gravity.CENTER_VERTICAL);
        networkRow.setMinimumHeight(dp(48));
        networkRow.setFocusable(true);
        networkRow.setTag("pairNetwork");
        networkRow.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
            null, style.round(Color.WHITE, 10)));
        networkRow.setOnClickListener(view -> showNetwork());
        TextView networkLabel = text(tr("连接状态", "Connection status"), Palette.TEXT_BODY, style.ink);
        networkLabel.setPadding(0, 0, dp(12), 0);
        networkRow.addView(networkLabel, new LinearLayout.LayoutParams(0, -2, 1));
        pairNetworkValue = text(mobileAccessState(), Palette.TEXT_SMALL, style.secondary);
        pairNetworkValue.setTag("pairNetworkValue");
        networkRow.addView(pairNetworkValue);
        ImageView networkArrow = new ImageView(this);
        networkArrow.setImageDrawable(new LineIcon("right", style.secondary));
        networkArrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams networkArrowParams = new LinearLayout.LayoutParams(dp(18), dp(18));
        networkArrowParams.setMarginStart(dp(8));
        networkRow.addView(networkArrow, networkArrowParams);
        tailscale.addView(networkRow);
        TextView networkNote = text(tr("手机与电脑需登录同一个 Tailscale 网络。",
            "Sign into the same Tailscale network on both devices."), Palette.TEXT_SMALL, style.secondary);
        networkNote.setPadding(0, dp(8), 0, 0);
        tailscale.addView(networkNote);

        LinearLayout lan = pairingCardBody(style, content, "wifi",
            tr("同一 Wi-Fi 直连", "Same Wi-Fi direct"),
            tr("局域网发现，速度更快；首次输入电脑端的 6 位 PIN",
                "Faster on this Wi-Fi; enter the computer's six-digit PIN once"));
        LinearLayout lanScanRow = new LinearLayout(this);
        lanScanRow.setGravity(Gravity.CENTER_VERTICAL);
        lanScanRow.setMinimumHeight(dp(48));
        lanScanStatus = text(tr("尚未扫描", "Not scanned"), Palette.TEXT_SMALL, style.secondary);
        lanScanStatus.setMaxLines(1);
        lanScanStatus.setEllipsize(android.text.TextUtils.TruncateAt.END);
        lanScanRow.addView(lanScanStatus, new LinearLayout.LayoutParams(0, -2, 1));
        lanScanButton = compactButton(tr("开始扫描", "Start scanning"), false);
        lanScanButton.setTag("pairLanScan");
        lanScanButton.setOnClickListener(view -> {
            if (lanPairScanning) stopLanPairScan(); else startLanPairScan();
        });
        LinearLayout.LayoutParams lanScanButtonParams = new LinearLayout.LayoutParams(-2, -2);
        lanScanButtonParams.setMarginStart(dp(12));
        lanScanRow.addView(lanScanButton, lanScanButtonParams);
        lan.addView(lanScanRow);
        lanNetworkHint = text(lanNetworkSummary(), Palette.TEXT_SMALL, style.secondary);
        lanNetworkHint.setPadding(0, dp(8), 0, 0);
        lan.addView(lanNetworkHint);
        lanPairList = column();
        lanPairList.setPadding(0, dp(10), 0, 0);
        lanPairList.setTag("pairLanList");
        lan.addView(lanPairList);
        renderLanPairList();

        LinearLayout qr = pairingCardBody(style, content, "camera",
            tr("扫码配对", "Scan to pair"),
            tr("扫描电脑端二维码，自动填入地址和一次性码",
                "Scan the computer's QR to fill in its address and one-time code"));
        scanButton = button(tr("扫描二维码", "Scan QR code"), this::scanPairingCode, false);
        scanButton.setTag("pairScan"); qr.addView(scanButton);

        LinearLayout fields = pairingCardBody(style, content, "edit",
            tr("手动配对", "Pair manually"),
            tr("填写 Tailscale 地址、端口和一次性码",
                "Enter the Tailscale address, port and one-time code"));
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
        TextView manualNote = text(tr("请求发出后，在电脑端确认授权即可连接。",
            "After sending the request, approve it on your computer to connect."), Palette.TEXT_SMALL, style.secondary);
        manualNote.setPadding(0, dp(10), 0, 0);
        fields.addView(manualNote);
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
                    client = new RemoteApi(this, address); statusClients.add(client);
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
        if (lanScanButton != null) lanScanButton.setEnabled(!busy);
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

    private void refreshLanScanStatus() {
        if (lanPairScanning && "pair".equals(screen)) renderLanPairList();
    }

    private void renderLanPairList() {
        if (lanPairList == null) return;
        lanPairList.removeAllViews();
        if (lanScanButton != null) {
            lanScanButton.setText(lanPairScanning ? tr("停止扫描", "Stop scanning")
                : lanServices.isEmpty() ? tr("开始扫描", "Start scanning") : tr("重新扫描", "Scan again"));
            lanScanButton.setContentDescription(lanScanButton.getText());
        }
        if (lanNetworkHint != null) lanNetworkHint.setText(lanNetworkSummary());
        if (lanScanStatus != null) {
            if (lanPairScanning) {
                if (!lanServices.isEmpty()) {
                    lanScanStatus.setText(tr("已发现 " + lanServices.size() + " 台，继续扫描中",
                        "Found " + lanServices.size() + ", still scanning"));
                } else if (lanDiscoveryError != Integer.MIN_VALUE) {
                    lanScanStatus.setText(lanDiscoveryFailureText(lanDiscoveryError));
                } else if (lanScanStartedAt > 0
                        && android.os.SystemClock.elapsedRealtime() - lanScanStartedAt >= 8_000) {
                    lanScanStatus.setText(tr("仍在扫描，暂未发现电脑",
                        "Still scanning. No computer found yet"));
                } else {
                    lanScanStatus.setText(tr("正在扫描…", "Scanning…"));
                }
            } else {
                lanScanStatus.setText(lanServices.isEmpty()
                    ? tr("尚未扫描", "Not scanned")
                    : tr("已发现 " + lanServices.size() + " 台电脑", "Found " + lanServices.size() + " computers"));
            }
        }
        if (lanServices.isEmpty()) {
            return;
        }
        try {
            for (LanDiscovery.Service service : lanServices) {
                JSONObject paired = store.findByComputerId(service.computerId);
                boolean hasPairing = paired != null && !paired.optString("token").isEmpty();
                LinearLayout row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(0, dp(10), 0, dp(10));
                LinearLayout copy = column();
                TextView title = text(service.name.isEmpty() ? service.computerId : service.name, Palette.TEXT_ROW_STRONG, ink);
                title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
                copy.addView(title);
                TextView meta = text(service.url + (hasPairing ? tr(" · 已配对", " · Paired") : ""),
                    Palette.TEXT_SMALL, muted);
                copy.addView(meta);
                row.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
                if (hasPairing) {
                    boolean willEnableLan = !ComputerRoutes.prefersLan(paired);
                    Button verify = compactButton(willEnableLan ? tr("启用自动直连", "Enable LAN direct") : tr("直连", "Connect"), false);
                    verify.setTag("lanConnect:" + service.computerId);
                    verify.setOnClickListener(view -> connectScannedLan(paired, service));
                    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
                    params.setMarginStart(dp(10));
                    row.addView(verify, params);
                } else if (!service.joinable) {
                    TextView locked = text(tr("未允许加入", "Joining off"), Palette.TEXT_SMALL, muted);
                    locked.setPadding(dp(8), 0, 0, 0);
                    row.addView(locked);
                } else {
                    Button connect = compactButton(tr("连接", "Connect"), false);
                    connect.setOnClickListener(view -> promptLanPin(service));
                    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
                    params.setMarginStart(dp(10));
                    row.addView(connect, params);
                }
                lanPairList.addView(row);
            }
        } catch (Exception error) {
            lanPairList.addView(text(ErrorDetails.withSummary(tr("无法读取电脑列表。", "Could not read computers."), error),
                Palette.TEXT_SMALL, muted));
        }
    }

    private void connectScannedLan(JSONObject paired, LanDiscovery.Service service) {
        if (!foreground || pairingBusy) return;
        String address = paired.optString("address"), token = paired.optString("token");
        String tailscale = ComputerRoutes.tailscaleUrl(paired);
        boolean trustedFingerprint = ComputerRoutes.matchesLanFingerprint(paired, service.computerId, service.fingerprint);
        setPairingBusy(true);
        setStatusNotice(tr("正在验证现有配对…", "Verifying this pairing…"));
        int ticket = generation;
        job = worker.submit(() -> {
            boolean verified = trustedFingerprint;
            try {
                if (!verified) {
                    if (tailscale.isEmpty()) throw new IOException(tr("扫描到的局域网证书与配对时保存的证书不一致。",
                        "The scanned LAN certificate differs from the saved pairing."));
                    tailscaleLanStatus(tailscale, token, service);
                    verified = true;
                }
                JSONObject info = routeStatus(RemoteApi.explicit(this, service.url, service.fingerprint), token);
                if (!service.computerId.equals(info.optString("computerId"))) throw new IOException(
                    tr("局域网返回的电脑身份与现有配对不一致。", "The LAN computer identity differs from the saved pairing."));
            } catch (Exception error) {
                boolean canRepair = !verified || error instanceof RemoteApi.Failure failure && failure.status == 401;
                deliver(ticket, () -> showLanVerificationFailure(service, error, canRepair));
                return;
            }
            deliver(ticket, () -> {
                try {
                    JSONObject current = storedComputer(address);
                    if (current == null || !token.equals(current.optString("token"))) throw new IOException("Computer pairing changed");
                    useScannedLan(current, service);
                } catch (Exception error) {
                    setPairingBusy(false);
                    reportError("无法保存局域网连接。", "Could not save the local connection.", error);
                }
            });
        });
    }

    private void showLanVerificationFailure(LanDiscovery.Service service, Exception error, boolean canRepair) {
        setPairingBusy(false);
        String detail = error instanceof RemoteApi.Failure ? RemoteApi.failureMessage(error, chinese)
            : ErrorDetails.withSummary(RemoteApi.failureMessage(error, chinese), error);
        setStatusNotice(detail);
        CamelliaDialog.Builder dialog = new CamelliaDialog.Builder(this)
            .setTitle(tr("无法通过现有配对直连", "Could not connect with this pairing"));
        if (canRepair && service.joinable) {
            dialog.setMessage(detail)
                .setPositiveButton(tr("用 PIN 重新配对", "Pair again with PIN"), (ignored, which) -> promptLanPin(service))
                .setNegativeButton(tr("取消", "Cancel"), null);
        } else {
            dialog.setMessage(canRepair ? detail + "\n" + tr("如需用 PIN 恢复，请在电脑上开启「允许新设备加入」，再重新扫描。",
                "To repair with a PIN, enable Allow new devices on the computer and scan again.") : detail)
                .setPositiveButton(tr("知道了", "OK"), null);
        }
        dialog.show();
    }

    private void useScannedLan(JSONObject computer, LanDiscovery.Service service) throws Exception {
        computer.put("computerId", service.computerId)
            .put("lanAddress", service.url)
            .put("lanFingerprint", service.fingerprint)
            .put("lanPreferred", true)
            .put("activeTransport", ComputerRoutes.LAN);
        if (computer.optString("computerName").isEmpty()) computer.put("computerName", service.name);
        store.save(computer);
        credentials = store.load();
        ComputerRoutes.configure(store.all());
        pairingDraft = null; pendingScannedPairing = false;
        setPairingBusy(false);
        listScreen(); loadList(false);
    }

    private void promptLanPin(LanDiscovery.Service service) {
        if (!foreground || pairingBusy) return;
        LinearLayout panel = column();
        panel.setPadding(dp(4), dp(4), dp(4), dp(4));
        EditText pin = input(panel, tr("6 位连接 PIN", "Six-digit connection PIN"), "",
            InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        pin.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(6)});
        pin.setGravity(Gravity.CENTER);
        CamelliaDialog dialog = new CamelliaDialog.Builder(this)
            .setTitle(service.name.isEmpty() ? tr("连接电脑", "Connect to computer") : service.name)
            .setMessage(tr("在电脑「局域网访问」中查看 6 位 PIN。", "See the six-digit PIN in Local network on the computer."))
            .setView(panel)
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("连接", "Connect"), (ignored, which) -> {
                String value = pin.getText().toString();
                if (!value.matches("\\d{6}")) {
                    setStatusNotice(tr("请输入 6 位数字 PIN。", "Enter the six-digit PIN."));
                    return;
                }
                joinLanService(service, value);
            }).create();
        dialog.show();
        pin.requestFocus();
    }

    private void joinLanService(LanDiscovery.Service service, String pin) {
        if (!foreground || pairingBusy || service == null) return;
        pairingBusy = true;
        setPairingBusy(true);
        setStatusNotice(tr("正在通过局域网连接…", "Connecting over the local network…"));
        final int ticket = generation;
        final String deviceName = nameInput == null || nameInput.getText().toString().trim().isEmpty()
            ? MobilePreferences.deviceName(this) : nameInput.getText().toString().trim();
        try {
            RemoteApi client = RemoteApi.explicit(this, service.url, service.fingerprint);
            JSONObject payload = new JSONObject().put("pin", pin).put("name", deviceName);
            job = worker.submit(() -> {
                try {
                    JSONObject result = client.json("/v1/lan/join", null, payload);
                    deliver(ticket, () -> {
                        try {
                            String token = result.getString("token");
                            if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IOException();
                            String computerId = result.optString("computerId");
                            if (!service.computerId.equals(computerId)) throw new IOException(tr(
                                "返回的电脑身份与扫描结果不一致。", "The computer identity differs from the scan."));
                            JSONObject existing = store.findByComputerId(computerId);
                            JSONObject tailscale = result.optJSONObject("tailscale");
                            String tailscaleUrl = tailscale == null ? "" : ComputerRoutes.tailscaleOrigin(tailscale.optString("url"));
                            String address = existing != null && !existing.optString("address").isEmpty()
                                ? existing.optString("address")
                                : !tailscaleUrl.isEmpty() ? tailscaleUrl : service.url;
                            JSONObject next = existing == null ? new JSONObject() : new JSONObject(existing.toString());
                            next.put("address", address).put("name", deviceName)
                                .put("token", token).put("deviceId", result.getString("deviceId"))
                                .put("permission", result.optString("permission", "control"));
                            if (!tailscaleUrl.isEmpty()) next.put("tailscaleAddress", tailscaleUrl);
                            useScannedLan(next, service);
                        } catch (Exception error) {
                            setPairingBusy(false);
                            reportError("无法保存局域网连接。", "Could not save the local connection.", error);
                        }
                    });
                } catch (Exception error) {
                    deliver(ticket, () -> {
                        setPairingBusy(false);
                        String detail = error instanceof RemoteApi.Failure failure && failure.status == 401
                            ? tr("PIN 不正确或尝试次数过多。", "Incorrect PIN or too many attempts.")
                            : RemoteApi.failureMessage(error, chinese);
                        setStatusNotice(detail);
                    });
                }
            });
        } catch (Exception error) {
            setPairingBusy(false);
            reportError("无法发起局域网连接。", "Could not start the local connection.", error);
        }
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
            EmbeddedNetwork.setNodeHostname(name);
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
                        JSONObject status = null;
                        try { status = client.json("/v1/status", token, null); }
                        catch (Exception ignored) { /* Pairing is already authorized; enrich the route when possible. */ }
                        String entered = credentials.getString("address");
                        String computerId = status == null ? result.optString("computerId") : status.optString("computerId");
                        JSONObject transports = status == null ? result.optJSONObject("transports") : status.optJSONObject("transports");
                        JSONObject lan = transports == null ? null : transports.optJSONObject("lan");
                        JSONObject tailscale = transports == null ? null : transports.optJSONObject("tailscale");
                        String tailscaleUrl = tailscale == null ? "" : tailscale.optString("url");
                        if (tailscaleUrl.isEmpty()) {
                            try { if (!new Endpoint(entered).isLan()) tailscaleUrl = entered; }
                            catch (IllegalArgumentException ignored) { }
                        }
                        JSONObject existing = store.findByComputerId(computerId);
                        JSONObject next = existing == null ? new JSONObject() : new JSONObject(existing.toString());
                        if (existing != null) next.put("lanPreferred", ComputerRoutes.prefersLan(existing));
                        String address = existing != null && !existing.optString("address").isEmpty()
                            ? existing.optString("address") : !tailscaleUrl.isEmpty() ? tailscaleUrl : entered;
                        next.put("address", address).put("name", credentials.getString("name"))
                            .put("token", token).put("deviceId", result.getString("deviceId"))
                            .put("permission", result.optString("permission", "control"));
                        if (!computerId.isEmpty()) next.put("computerId", computerId);
                        if (!tailscaleUrl.isEmpty()) next.put("tailscaleAddress", tailscaleUrl);
                        if (lan != null && !lan.optString("url").isEmpty() && LanTls.validFingerprint(lan.optString("fingerprint"))) {
                            next.put("lanAddress", lan.optString("url"))
                                .put("lanFingerprint", LanTls.normalize(lan.optString("fingerprint")));
                        }
                        next.put("activeTransport", !tailscaleUrl.isEmpty() ? ComputerRoutes.TAILSCALE : ComputerRoutes.LAN);
                        if (credentials.has("computerName") && next.optString("computerName").isEmpty())
                            next.put("computerName", credentials.getString("computerName"));
                        store.save(next); credentials = store.load(); ComputerRoutes.configure(store.all());
                        pairingDraft = null; listScreen(); loadList(false);
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

    private String conversationListScope() {
        return credentials.optString("address") + "/" + java.util.UUID.nameUUIDFromBytes(credentials.optString("token").getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private boolean conversationListAvailable() {
        return screen.equals("list") || screen.equals("detail") && tabletShell && tabletConversationList != null;
    }

    private LinearLayout conversationListRoot() { return tabletConversationList == null ? root : tabletConversationList.root; }
    private LinearLayout conversationListContent() { return tabletConversationList == null ? content : tabletConversationList.content; }

    private ConversationListPane tabletConversationList(boolean initialize) {
        if (tabletConversationList == null || !tabletConversationList.scope.equals(conversationListScope())) {
            discardTabletConversationList();
            tabletConversationList = ConversationListPane.create(this, chatStyle, conversationListScope(), 12);
            tabletConversationList.connection = addConversationHeader(tabletConversationList.root, false);
            ErrorDetails.bindStatus(this, tabletConversationList.status, chinese);
        }
        ConversationListPane pane = tabletConversationList;
        if (initialize && !pane.initialized) initializeConversationList(pane.root, pane.scroll, pane.content, pane.status);
        return pane;
    }

    private void discardTabletConversationList() {
        if (tabletConversationList == null) return;
        rememberConversationListContext(); conversationListScroll.detach();
        tabletConversationList = null; cancelTabletListRequest();
    }

    private void cancelTabletListRequest() {
        tabletListRequest++;
        RemoteApi previous = tabletListClient; tabletListClient = null;
        if (previous != null) new Thread(previous::cancel, "camellia-list-disconnect").start();
        RemoteApi archive = tabletArchiveClient; tabletArchiveClient = null;
        if (archive != null) { archivedLoading = false; new Thread(archive::cancel, "camellia-archive-disconnect").start(); }
    }

    private void openListConversation(String id, String title) {
        if (screen.equals("detail") && id.equals(conversationId)) return;
        persistDraft();
        if (searchInput != null && searchInput.hasFocus()) {
            ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(searchInput.getWindowToken(), 0);
            searchInput.clearFocus();
        }
        conversationId = id; conversationTitle = title; detailReturn = "list"; detailScreen(); connectEvents();
    }

    private void loadTabletConversationList(boolean append, int attempt) {
        if (!networkActive() || !credentials.has("token") || tabletConversationList == null || append && nextOffset < 0) return;
        ConversationListPane pane = tabletConversationList;
        int requestId = ++tabletListRequest;
        RemoteApi previous = tabletListClient;
        if (previous != null) new Thread(previous::cancel, "camellia-list-replace").start();
        RemoteApi client = homeClientFactory.apply(credentials.optString("address")); tabletListClient = client;
        String token = credentials.optString("token");
        String query = searchInput == null ? "" : searchInput.getText().toString().trim().toLowerCase(Locale.ROOT);
        boolean modern = canListQuery && capabilityAddress.equals(credentials.optString("address"));
        int offset = append ? nextOffset : 0, limit = Math.max(100, conversations.size());
        ((RefreshScrollView) pane.scroll).setRefreshing(true);
        worker.submit(() -> {
            try {
                JSONObject page = client.json(conversationListPath(offset, Math.min(1000, limit), query, modern), token, null);
                JSONObject info = listInfo(client, token, page);
                JSONArray rows = page.optJSONArray("conversations"); if (rows == null) rows = new JSONArray();
                int following = page.optInt("nextOffset", -1);
                while (following >= 0 && requestId == tabletListRequest && (!modern && !query.isEmpty() || !append && rows.length() < limit)) {
                    JSONObject next = client.json(conversationListPath(following, Math.min(1000, limit), query, modern), token, null);
                    JSONArray entries = next.optJSONArray("conversations");
                    for (int index = 0; entries != null && index < entries.length(); index++) rows.put(entries.optJSONObject(index));
                    int after = next.optInt("nextOffset", -1); if (after == following) break; following = after;
                }
                page.put("conversations", rows).put("nextOffset", following < 0 ? JSONObject.NULL : following);
                handler.post(() -> {
                    if (!networkActive() || tabletConversationList != pane || requestId != tabletListRequest) return;
                    updateCapabilities(info); remoteListQuery = modern ? page.optString("query") : "";
                    applyConversationPage(page, append); cacheConversations();
                });
            } catch (Exception error) {
                handler.post(() -> {
                    if (tabletConversationList != pane || requestId != tabletListRequest || !networkActive()) return;
                    if (!append && retryableListFailure(error)) {
                        setStatusNotice(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                        int nextAttempt = Math.min(attempt + 1, 5);
                        handler.postDelayed(() -> {
                            if (tabletConversationList == pane && requestId == tabletListRequest) loadList(false, nextAttempt);
                        }, listRetryDelay(error, attempt));
                    } else setStatusNotice(RemoteApi.failureMessage(error, chinese));
                });
            } finally {
                client.cancel();
                handler.post(() -> { if (tabletConversationList == pane && requestId == tabletListRequest) { tabletListClient = null; ((RefreshScrollView) pane.scroll).setRefreshing(false); } });
            }
        });
    }

    private void listScreen() {
        screen = "list";
        networkScreen = false;
        boolean reuse = MobileLayout.useTabletRail(getResources().getConfiguration()) && tabletConversationList != null
            && tabletConversationList.scope.equals(conversationListScope());
        stopNetwork(); conversationId = null; clearHistory();
        if (reuse) { shell("", ""); return; }
        if (!MobileLayout.useTabletRail(getResources().getConfiguration())) discardTabletConversationList();
        conversations.clear(); nextOffset = -1;
        archivedConversations.clear(); archivedLoaded = false; archivedLoading = false; archivedNextOffset = -1;
        canCreate = false; canCreateWorkspace = false; canArchive = false; canManageConversations = false;
        canDiscussions = false;
        selectingConversations = false; selectedConversations.clear();
        availableWorkspaces = new JSONArray(); allowIndependent = false;
        listEventsUnavailable = false;
        listLoaded = false; listLoadFailed = false;
        shell("", "");
        if (tabletConversationList == null || !tabletConversationList.initialized)
            initializeConversationList(root, scroll, content, status);
    }

    private void initializeConversationList(LinearLayout root, ScrollView scroll, LinearLayout content, TextView status) {
        String pairing = java.util.UUID.nameUUIDFromBytes(credentials.optString("token")
            .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
        conversationListScroll.attach(credentials.optString("address") + "/" + pairing, scroll, content);
        Bundle listContext = conversationListScroll.context();
        conversationFilter = listContext.getString("filter", "all");
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
        searchInput = new EditorInput(this); searchInput.setSingleLine(true); searchInput.setTextSize(Palette.TEXT_ROW); searchInput.setTextColor(ink); searchInput.setHintTextColor(muted);
        searchInput.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(200)});
        searchInput.setTag("remoteSearchInput"); searchInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        searchInput.setHint(tr("搜索会话", "Search conversations")); searchInput.setContentDescription(tr("搜索会话", "Search conversations")); searchInput.setBackgroundColor(Color.TRANSPARENT);
        searchInput.setPadding(dp(2), dp(12), dp(8), dp(12)); searchInput.setMinHeight(dp(48));
        searchInput.setText(listContext.getString("query", ""));
        searchBar.setVisibility(listContext.getBoolean("searchVisible") ? View.VISIBLE : View.GONE);
        searchBar.addView(searchInput, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton close = chatStyle.composerToolButton("close", tr("关闭搜索", "Close search"), muted,
            this::closeConversationSearch);
        close.setTag("remoteSearchClose"); searchBar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        searchInput.setOnEditorActionListener((view, action, event) -> {
            if (action != android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) return false;
            ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(view.getWindowToken(), 0);
            conversationListRoot().requestFocus(); return true;
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
        if (tabletConversationList != null) tabletConversationList.initialized = true;
    }

    private void showConversationSearch() {
        if (!conversationListAvailable() || searchBar == null || searchInput == null) return;
        searchBar.setVisibility(View.VISIBLE);
        EditText input = searchInput; input.requestFocus();
        input.post(() -> {
            if (conversationListAvailable() && searchInput == input && input.hasFocus())
                ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(input, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        });
    }

    private void closeConversationSearch() {
        if (searchBar == null || searchInput == null) return;
        ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(searchInput.getWindowToken(), 0);
        searchInput.setText(""); searchInput.clearFocus(); searchBar.setVisibility(View.GONE); conversationListRoot().requestFocus();
    }

    private void applyConversationPage(JSONObject page, boolean append) {
        if (!append) conversations.clear();
        JSONArray entries = page.optJSONArray("conversations");
        if (entries != null) for (int index = 0; index < entries.length(); index++) {
            JSONObject conversation = entries.optJSONObject(index);
            if (conversation != null && !conversation.optString("id").isEmpty()) conversations.put(conversation.optString("id"), conversation);
        }
        nextOffset = page.optInt("nextOffset", -1);
        if (homeActionConversation != null && homeActionScope.equals(RemoteWorkbenchSync.identity(credentials))) {
            String id = homeActionConversation.optString("id");
            if (conversations.containsKey(id)) homeActionConversation = conversations.get(id);
            else if (nextOffset >= 0) conversations.put(id, homeActionConversation);
            else homeActionConversation = null;
        }
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
        LinearLayout content = conversationListContent();
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
        boolean compactList = tabletConversationList != null || tabletShell;
        boolean active = conversationFilter.equals(value);
        TextView chip = new TextView(this);
        chip.setText(label);
        chip.setTextSize(Palette.TEXT_SMALL);
        chip.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        chip.setTextColor(active ? accent : muted);
        chip.setGravity(Gravity.CENTER);
        chip.setMinHeight(dp(48));
        chip.setMinimumWidth(dp(48));
        chip.setPadding(dp(compactList ? 4 : 12), dp(8), dp(compactList ? 4 : 12), dp(8));
        if (compactList) { chip.setTextSize(11); chip.setMaxLines(2); }
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
        LinearLayout.LayoutParams params = compactList ? new LinearLayout.LayoutParams(0, -2, 1) : new LinearLayout.LayoutParams(-2, -2);
        params.setMarginEnd(dp(compactList ? 2 : 4));
        row.addView(chip, params);
    }

    private void renderConversations() {
        LinearLayout content = conversationListContent();
        if (conversationPopup != null) conversationPopup.dismiss();
        conversationListScroll.beforeRender();
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
            layoutConversationList(true); return;
        }
        if (!query.isEmpty() && groups.values().stream().allMatch(java.util.List::isEmpty) && !matchingDiscussion) {
            content.addView(new ChatEmptyState(this, chatStyle, "search", tr("没有找到会话", "No conversations found"),
                tr("试试更短的关键词，或清除搜索查看全部会话。", "Try a shorter keyword, or clear the search to see all conversations."),
                tr("清除搜索", "Clear search"), () -> searchInput.setText("")));
            layoutConversationList(true); return;
        }
        if (filtered && visibleConversations == 0 && !matchingDiscussion && dataLoaded) {
            content.addView(new ChatEmptyState(this, chatStyle, "sessions", archivedFilter ? tr("没有已归档会话", "No archived conversations") : tr("没有符合筛选的会话", "No matching conversations"),
                archivedFilter ? tr("归档后仍可在这里找到会话。", "Archived conversations remain available here.") : tr("清除筛选，查看全部会话。", "Clear the filter to see all conversations."),
                tr("查看全部", "Show all"), () -> { conversationFilter = "all"; renderConversations(); }));
            layoutConversationList(true); return;
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
            content.addView(welcome); layoutConversationList(true); return;
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
            if (!entries.isEmpty() && !workspace.isEmpty()) {
                String supplied = entries.get(0).optString("workspaceName", "");
                if (!supplied.isEmpty() && !supplied.equals("null")) name = supplied;
            }
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
        layoutConversationList(false);
    }

    private void layoutConversationList(boolean centered) {
        LinearLayout content = conversationListContent();
        content.setGravity(Gravity.TOP);
        if (centered) {
            // Keep filters and pending actions at the top; only the placeholder
            // fills and centers in the remaining space. WRAP_CONTENT preserves
            // its full height so actions stay scrollable on short screens.
            View empty = content.findViewWithTag("chatEmptyState");
            empty.setLayoutParams(new LinearLayout.LayoutParams(-1, -2, 1));
        }
        if (tabletConversationList != null) tabletConversationList.select("conversation:", screen.equals("detail") ? conversationId : "");
        conversationListScroll.afterRender(centered);
        if (!centered) requestPrefetchViewport();
    }

    private void rememberConversationListContext() {
        Bundle context = conversationListScroll.context();
        if (context == null) return;
        context.putString("filter", conversationFilter);
        context.putString("query", searchInput == null ? "" : searchInput.getText().toString());
        context.putBoolean("searchVisible", searchBar != null && searchBar.getVisibility() == View.VISIBLE);
    }

    private boolean renderDiscussionSection(String query) {
        LinearLayout content = conversationListContent();
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
        indicator = withReplyIndicator(indicator, unread);
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
                else openListConversation(id, title);
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
            conversationEngine(conversation), detail, color, selected, unread,
            conversation.optString("workspaceName", tr("独立会话", "Independent conversations")), conversation.optString("activity"));
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
        if (tabletConversationList != null) return; // The existing list summary stream refreshes this pane.
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
        if (screen.equals("detail") && tabletConversationList != null) { persistDraft(); listScreen(); }
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
        View anchor = conversationListRoot().findViewWithTag("conversation:" + conversation.optString("id"));
        if (anchor == null) return;
        conversationPopup = conversationActionsMenu(anchor, conversation, canFork,
            action -> performConversationAction(conversation, action));
    }

    private ConversationMenu conversationActionsMenu(View anchor, JSONObject conversation, boolean fork,
            java.util.function.Consumer<String> action) {
        return new ConversationMenu(anchor, chatStyle, chinese, conversation.optBoolean("pinned"),
            () -> action.accept("rename"), () -> action.accept("select"), () -> action.accept("pin"),
            () -> action.accept("archive"), () -> action.accept("delete"), fork ? () -> action.accept("fork") : null);
    }

    private void performConversationAction(JSONObject conversation, String action) {
        String id = conversation.optString("id");
        switch (action) {
            case "rename" -> renameConversation(conversation);
            case "select" -> { selectingConversations = true; selectedConversations.add(id); renderConversations(); }
            case "pin" -> manageConversations("pin", java.util.Set.of(id), "", !conversation.optBoolean("pinned"));
            case "archive" -> archiveConversation(conversation);
            case "delete" -> confirmConversationDelete(java.util.Set.of(id));
            case "fork" -> forkConversation(conversation);
        }
    }

    private void renameConversation(JSONObject conversation) {
        EditText name = new EditorInput(this); name.setSingleLine(true); name.setText(conversation.optString("title")); name.setTag("remoteRename");
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
        if (screen.equals("detail") && tabletConversationList != null) { persistDraft(); listScreen(); }
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
        if (screen.equals("detail") && tabletConversationList != null) { persistDraft(); listScreen(); }
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
        if (screen.equals("detail") && tabletConversationList != null) { persistDraft(); listScreen(); }
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

    private String withReplyIndicator(String indicator, boolean unread) {
        return unread ? indicator + (indicator.isEmpty() ? "" : " · ") + tr("新消息", "New reply") : indicator;
    }

    private void resumeList() {
        long now = android.os.SystemClock.elapsedRealtime();
        boolean stale = !connected || listRetryPending || listLastFrameAt == 0
            || now - listLastFrameAt > FOREGROUND_STREAM_GRACE_MS;
        if (stale) { reconnecting = true; loadList(false); }
    }

    private void loadList(boolean append) { loadList(append, 0); }

    private void loadList(boolean append, int attempt) {
        if (screen.equals("detail") && tabletConversationList != null) { loadTabletConversationList(append, attempt); return; }
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
                    if (observeTransportInfo(page, credentials.optString("address"))) handler.post(this::applyLanRoutes);
                    remoteListQuery = modern ? page.optString("query") : "";
                    listCursor = append ? -1 : pageCursor;
                    applyConversationPage(page, append);
                    cacheConversations();
                    ((RefreshScrollView) scroll).setRefreshing(false);
                    computerStates.put(credentials.optString("address"), tr("已连接", "Connected"));
                    watchList(client, ticket);
                });
            } catch (Exception error) { deliver(ticket, () -> {
                ((RefreshScrollView) scroll).setRefreshing(false); listLoadFailed = true;
                if (!append && retryableListFailure(error)) {
                    int nextAttempt = Math.min(attempt + 1, 5);
                    listRetryPending = true;
                    connectionFailure(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                    handler.postDelayed(() -> { if (ticket == generation) loadList(false, nextAttempt); }, listRetryDelay(error, attempt));
                } else showFailure(error, true);
                if (screen.equals("list")) renderConversations();
            }); }
        });
    }

    private static boolean retryableListFailure(Exception error) {
        if (!(error instanceof java.io.IOException)) return false;
        if (error instanceof RemoteApi.Failure) {
            int status = ((RemoteApi.Failure) error).status;
            return status == 408 || status == 429 || status >= 500;
        }
        return switch (ConnectionFailure.classify(error, EmbeddedNetwork.online())) {
            case LOGIN_REQUIRED, DEVICE_APPROVAL_REQUIRED, NETWORK_STOPPED, PROTOCOL_ERROR, INVALID_CREDENTIAL -> false;
            default -> true;
        };
    }

    private static long listRetryDelay(Exception error, int attempt) {
        if (error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429) return 60_000;
        return Math.min(30_000, 1000L << Math.min(attempt, 5));
    }

    private void loadArchived(boolean append) {
        if (archivedLoading || !credentials.has("token") || !networkActive()) {
            archivedLoaded = true;
            renderConversations();
            return;
        }
        archivedLoading = true;
        setStatusNotice(tr("正在读取已归档会话…", "Loading archived conversations…"));
        ConversationListPane owner = screen.equals("detail") ? tabletConversationList : null;
        RemoteApi client = owner == null ? api == null ? begin() : api : homeClientFactory.apply(credentials.optString("address"));
        if (owner != null) tabletArchiveClient = client;
        int ticket = generation;
        String token = credentials.optString("token");
        int offset = append ? Math.max(0, archivedNextOffset) : 0;
        worker.submit(() -> {
            try {
                JSONObject page = client.json("/v1/archived?offset=" + offset, token, null);
                JSONArray rows = page.optJSONArray("conversations");
                if (owner == null && ticket != generation) return;
                deliverListResponse(ticket, owner, client, () -> {
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
                deliverListResponse(ticket, owner, client, () -> {
                    archivedLoading = false;
                    archivedLoaded = true;
                    showFailure(error, true);
                    renderConversations();
                });
            } finally { if (owner != null) client.cancel(); }
        });
    }

    private void deliverListResponse(int ticket, ConversationListPane owner, RemoteApi client, Runnable action) {
        if (owner == null) deliver(ticket, action);
        else handler.post(() -> {
            if (networkActive() && tabletConversationList == owner && tabletArchiveClient == client) {
                tabletArchiveClient = null; action.run();
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
        if (conversationListAvailable()) { listLoaded = true; listLoadFailed = false; }
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
        canLiveDelta = capabilities.contains("\"live-deltas\"");
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
        if (screen.equals("detail") && tabletConversationList != null) { persistDraft(); listScreen(); }
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
        if (screen.equals("detail") && tabletConversationList != null) { persistDraft(); listScreen(); }
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
                                conversationCache.remove(credentials, id);
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
        if (request == SCAN_TAILSCALE_QR_REQUEST) {
            String target = tailscaleMergeAddress;
            tailscaleMergeAddress = "";
            if (result != RESULT_OK || data == null) return;
            String scanned = data.getStringExtra(QrScanActivity.EXTRA_ADDRESS);
            if (scanned == null || target.isEmpty()) return;
            try {
                Endpoint endpoint = new Endpoint(scanned);
                if (endpoint.isLan()) {
                    setStatusNotice(tr("二维码是局域网地址，不是 Tailscale 地址。",
                        "The QR code contains a LAN address, not a Tailscale address."));
                    return;
                }
                JSONObject profile = storedComputer(target);
                if (profile == null) {
                    setStatusNotice(tr("这台电脑已从手机中移除。", "This computer was removed from the phone."));
                    return;
                }
                connectExistingTailscale(profile, endpoint.origin());
            } catch (IllegalArgumentException error) {
                setStatusNotice(tr("二维码中的 Tailscale 地址无效。", "The QR code's Tailscale address is invalid."));
            }
            return;
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

    private void attachPastedText(CharSequence text) {
        if (archivedConversation != null) {
            setStatusError(tr("已归档会话不可发送附件。", "Archived conversations cannot send attachments."));
            return;
        }
        if (!canFileAttachments) {
            setStatusError(tr("发送文档需要更新并重启电脑端。", "Update and restart the desktop to send documents."));
            return;
        }
        if (loadingImages) {
            setStatusError(tr("正在添加附件，请稍后再粘贴。", "Attachments are still being added; paste again shortly."));
            return;
        }
        if (selectedImages.size() + selectedDocuments.size() >= ChatAttachments.MAX_COUNT) {
            setStatusError(tr("每条消息最多 20 个附件。", "Up to 20 attachments per message."));
            return;
        }
        String target = conversationId, computer = credentials.optString("address");
        new Thread(() -> {
            AttachmentMaintenance.Lease imported = AttachmentMaintenance.protect(this);
            try {
                JSONObject document;
                try (AttachmentMaintenance.Import scope = imported.captureImports()) {
                    document = LongPaste.attach(this, text);
                }
                JSONObject attached = document;
                runOnUiThread(() -> {
                    try {
                        if (!java.util.Objects.equals(target, conversationId)
                                || !java.util.Objects.equals(computer, credentials.optString("address"))) {
                            ChatAttachments.discard(this, java.util.List.of(),
                                java.util.List.of(attached));
                            imageConversation = conversationId;
                            imageComputer = credentials.optString("address");
                            return;
                        }
                        selectedDocuments.add(attached);
                        imageConversation = conversationId;
                        imageComputer = credentials.optString("address");
                        renderImage(); persistDraft(); updateControls();
                        setStatusNotice(LongPaste.notice(text.length(), chinese));
                    } finally { imported.close(); }
                });
            } catch (Exception error) {
                imported.close();
                runOnUiThread(() -> setStatusError(ErrorDetails.withSummary(
                    tr("无法保存粘贴的文本。", "Could not save the pasted text."), error)));
            }
        }, "camellia-paste-text").start();
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
                        deliver(ticket, () -> { markListFrame(); listConnected(); });
                        return;
                    }
                    received[0] = true;
                    deliver(ticket, () -> { markListFrame(); scheduleListRefresh(client, ticket, snapshot); });
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
                listRetryPending = true;
                connectionFailure(RemoteApi.failureMessage(error, chinese) + tr(" 正在重连，当前显示上次同步内容。", " Reconnecting; displayed content may be stale."));
                long delay = error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 429 ? 60_000 : Math.min(30_000, 1000L << nextAttempt);
                handler.postDelayed(() -> streamList(client, ticket, nextAttempt), delay);
            });
        });
    }

    private void markListFrame() {
        listLastFrameAt = android.os.SystemClock.elapsedRealtime();
        listRetryPending = false;
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
        archivedConversation = null;
        archivedRestorable = false;
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
        ((ChatScrollView) scroll).setOnReading(this::clearMessageScroll);
        root.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        older = button(tr("加载更早消息", "Load earlier messages"), this::loadOlder, false); older.setEnabled(false);
        older.setVisibility(View.GONE);
        older.setBackgroundColor(Color.TRANSPARENT); older.setTextSize(Palette.TEXT_SMALL); content.addView(older);
        remoteEmptyState = new ChatEmptyState(this, chatStyle, "brand", tr("从这里开始", "Start here"),
            tr("描述任务，继续电脑上的工作。", "Describe a task to continue on this computer."));
        remoteEmptyState.setVisibility(View.GONE); content.addView(remoteEmptyState);
        archivedBar = column(); archivedBar.setTag("remoteArchivedBar");
        archivedBar.setVisibility(View.GONE); content.addView(archivedBar);
        messages = column(); content.addView(messages);
        workInline = column(); workInline.setVisibility(View.GONE); content.addView(workInline);
        approvals = column(); workInline.addView(approvals); approvalSignature = "";
        // Keep work cards available to the shared work sheet. Its entry is the
        // existing composer footer, without a separate summary row.
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
        LinearLayout dock = (LinearLayout) composerBar.getParent();
        queueBar = column(); queueBar.setTag("remoteMessageQueue");
        queueBar.setVisibility(View.GONE);
        LinearLayout.LayoutParams queueParams = new LinearLayout.LayoutParams(-1, -2);
        dock.addView(queueBar, dock.indexOfChild(composerBar), queueParams);
        chatComposer = new ChatComposer(composerBar, chatStyle, chinese, tr("发消息，继续任务…", "Message your computer…"), 16000,
            () -> showRemoteSettings(false), this::sendMessage, this::stopRun, this::cancelEdit);
        composer = chatComposer.input; composer.setTag("remoteComposer");
        chatComposer.longPasteHandler(this::attachPastedText);
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
        if (!preserveLiveState) showAvailableConversation();
        updateControls();
        // The background list stream supplies the fresh sidebar. Starting a
        // separate pull here would immediately be invalidated by connectEvents.
    }

    private void rebuildDetailForConfiguration() {
        persistDraft();
        boolean stayAtBottom = scroll instanceof ChatScrollView && ((ChatScrollView) scroll).isFollowingOutput();
        int previousScroll = scroll == null ? 0 : scroll.getScrollY();
        initialMessageScroll = false;
        buildDetailContent(true);
        if (!stayAtBottom) ((ChatScrollView) scroll).readHistory();
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

    private boolean showAvailableConversation() {
        return showPrefetchedConversation() || showPersistedConversation();
    }

    private boolean showPrefetchedConversation() {
        JSONObject cached = prefetch.get(credentials, conversationId);
        if (cached == null) return false;
        JSONArray rows = cached.optJSONArray("messages");
        if (rows == null) return false;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row != null) retainHistory(row.optLong("seq"), row);
        }
        connected = false; controlAllowed = false; lastLive = null; remoteSettings = null;
        trimHistory(false); renderMessages(null);
        updateWorkStatus();
        return true;
    }

    private boolean showPersistedConversation() {
        JSONObject cached = conversationCache.get(credentials, conversationId);
        if (cached == null) return false;
        JSONArray rows = cached.optJSONArray("messages");
        if (rows == null) return false;
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row != null) retainHistory(row.optLong("seq"), row);
        }
        instance = cached.optString("instanceId"); historyInstance = instance;
        cursor = cached.optLong("cursor", -1); historyVersion = cached.optString("historyVersion");
        nextBefore = cached.isNull("nextBefore") ? null : cached.optLong("nextBefore");
        if (conversationTitle.isEmpty()) {
            JSONObject conversation = cached.optJSONObject("conversation");
            conversationTitle = conversation == null ? "" : conversation.optString("title");
            TextView pageTitle = root.findViewWithTag("pageTitle");
            if (pageTitle != null) pageTitle.setText(conversationTitle);
        }
        connected = false; controlAllowed = false; lastLive = null; remoteSettings = null;
        trimHistory(false); renderMessages(null); updateOlderControl(); updateWorkStatus();
        return true;
    }

    private void resumeDetail() {
        if (history.isEmpty() && !historyDetached) showAvailableConversation();
        long now = android.os.SystemClock.elapsedRealtime();
        boolean stale = streamRetryPending || streamHealth == null
            || !streamHealth.fresh(now, FOREGROUND_STREAM_GRACE_MS);
        if (stale) { reconnecting = true; connectEvents(true); }
        else {
            inspectStream();
            startConversationSync();
        }
        if (displayedConversation != null) {
            replies().markRead(credentials, displayedConversation);
            replyReadSync.retry();
            syncReplyRead(displayedConversation);
        }
        updateControls();
        refreshDetailSidebar();
        if (stale) setStatusNotice(history.isEmpty() ? tr("正在恢复连接…", "Restoring the connection…")
            : tr("显示上次内容，正在恢复连接…", "Showing the latest available content; restoring the connection…"));
    }

    private void connectEvents() { connectEvents(false); }

    private void connectEvents(boolean foregroundRecovery) {
        if (!networkActive()) return;
        RemoteApi client = begin(); int ticket = generation;
        long initialTimeout = foregroundRecovery ? RemoteStreamHealth.RECOVERY_INITIAL_TIMEOUT_MS : RemoteStreamHealth.INITIAL_TIMEOUT_MS;
        boolean incremental = canIncremental || !historyVersion.isEmpty();
        startConversationSync();
        updateWorkStatus();
        String token = credentials.optString("token");
        if (capabilityAddress.equals(credentials.optString("address")) && capabilityToken.equals(token)) {
            // Capabilities only select the wire format. Fresh permission and
            // command state still come from the initial conversation snapshot.
            client.incremental(incremental); client.liveDelta(canLiveDelta);
            stream(client, ticket, 0, initialTimeout);
            return;
        }
        // Optional capability discovery must not gate the first transcript.
        // Clear another computer's flags; the legacy stream is always valid.
        updateCapabilities(new JSONObject()); capabilityAddress = ""; capabilityToken = "";
        statusWorker.submit(() -> {
            if (ticket != generation) return;
            try {
                JSONObject info = client.json("/v1/status", token, null);
                deliver(ticket, () -> { updateCapabilities(info); client.incremental(canIncremental || !historyVersion.isEmpty()); client.liveDelta(canLiveDelta); updateControls(); });
            } catch (Exception ignored) { /* The stream reports connection and authorization failures. */ }
        });
        client.incremental(incremental); client.liveDelta(canLiveDelta);
        stream(client, ticket, 0, initialTimeout);
    }

    private void startConversationSync() {
        if (!networkActive() || !EmbeddedNetwork.online() || !credentials.has("token")
                || !screen.equals("detail")) return;
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
            } else if (tabletConversationList != null) {
                if (remoteListQuery.isEmpty()) {
                    if (page.optInt("nextOffset", -1) < 0 || rows.length() >= conversations.size()) applyConversationPage(page, false);
                    else {
                        for (int index = 0; index < rows.length(); index++) {
                            JSONObject row = rows.optJSONObject(index);
                            if (row != null) conversations.put(row.optString("id"), row);
                        }
                        renderConversations();
                    }
                }
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
        stream(client, ticket, attempt, RemoteStreamHealth.INITIAL_TIMEOUT_MS);
    }

    private void stream(RemoteApi client, int ticket, int attempt, long initialTimeout) {
        if (!networkActive() || ticket != generation) return;
        replyReadSync.retry();
        String id = conversationId, token = credentials.optString("token");
        String syncedHistoryVersion = historyVersion;
        client.historyVersion(syncedHistoryVersion);
        RemoteStreamHealth health = new RemoteStreamHealth(android.os.SystemClock.elapsedRealtime(), initialTimeout);
        streamHealth = health;
        inspectStream();
        job = eventWorker.submit(() -> {
            boolean[] received = { false };
            Exception failure = null;
            try {
                client.events(id, token, snapshot -> {
                    JSONObject conversation = snapshot.optJSONObject("conversation");
                    if (conversation == null || !id.equals(conversation.optString("id"))) throw new IOException("Invalid snapshot");
                    if (!received[0] && snapshot.optJSONArray("messages") == null
                            && (syncedHistoryVersion.isEmpty() || !syncedHistoryVersion.equals(snapshot.optString("historyVersion")))) {
                        throw new IOException("Invalid incremental snapshot");
                    }
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
                    client.incremental(false); client.liveDelta(false); canIncremental = false; canLiveDelta = false; capabilityAddress = ""; capabilityToken = "";
                    stream(client, ticket, 0);
                    return;
                }
                if (error instanceof RemoteApi.Failure && (((RemoteApi.Failure) error).status == 401 || ((RemoteApi.Failure) error).status == 403 || ((RemoteApi.Failure) error).status == 404)) {
                    connected = false; updateControls();
                    showFailure(error, true); return;
                }
                streamRetryPending = true;
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
        streamRetryPending = false;
        connected = true; controlAllowed = snapshot.optString("permission").equals("control"); conversationSeq = conversation.optLong("seq");
        archivedConversation = snapshot.optJSONObject("archived");
        archivedRestorable = snapshot.optBoolean("canRestore");
        prefetch.put(credentials, snapshot);
        if (!server.equals(instance)) { queueVersion = -1; clearSubtasks(); }
        boolean following = !historyDetached && (initialMessageScroll || pendingScrollView == scroll && pendingScrollPosition == Integer.MAX_VALUE
            || scroll instanceof ChatScrollView && ((ChatScrollView) scroll).isFollowingOutput());
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
        renderArchivedDetail();
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
        conversationCache.put(credentials, snapshot);
    }

    private void syncReplyRead(JSONObject conversation) {
        long reply = conversation.optLong("lastReplyAt", 0);
        if (archivedConversation != null || !foreground || api == null || !conversation.has("replyReadAt") || reply <= 0) return;
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
        subtaskPage.setControlAvailable(connected && controlAllowed && archivedConversation == null && !commandBusy && pendingCommand() == null);
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
        archivedConversation = null;
        archivedRestorable = false;
        if (messages != null) messages.removeAllViews();
        renderApprovals(); renderArchivedDetail(); renderAutomation(new JSONObject()); updateControls();
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
        closeVisualization();
        VisualizationDialog dialog = new VisualizationDialog(this, title, chinese);
        RemoteApi client = remoteClientFactory.apply(address);
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
                handler.post(() -> {
                    if (ticket != generation || !ownerConversation.equals(conversationId) || !networkActive()) {
                        dialog.dismiss();
                    } else if (visualizationDialog == dialog) {
                        dialog.load(html);
                    }
                });
            } catch (Exception error) {
                handler.post(() -> {
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

    private void closeVisualization() {
        VisualizationDialog dialog = visualizationDialog;
        visualizationDialog = null;
        if (dialog != null) dialog.dismiss();
    }

    private void disposeMessageViews() {
        for (ReplyMessage binding : replyMessages.values()) binding.body.dispose();
        replyMessages.clear(); renderedMessages.clear(); renderedText.clear(); pendingMessageViews.clear();
    }

    private void releasePageViews() {
        cancelHomeConversationMenu();
        if (!screen.equals("list") || !homeActionScope.equals(RemoteWorkbenchSync.identity(credentials))) {
            homeActionConversation = null; homeActionScope = "";
        }
        if (detailSidebar != null) tabletSidebarStates.put(sidebarStateAddress, detailSidebar.saveState());
        if (tabletComputerPane != null) tabletComputerExpanded = tabletComputerPane.expanded();
        tabletComputerPane = null;
        if (tabletHomeActiveScroll != null) tabletHomeActiveY = tabletHomeActiveScroll.getScrollY();
        if (tabletHomeRecentScroll != null) tabletHomeRecentY = tabletHomeRecentScroll.getScrollY();
        tabletHomeRecent = null; tabletHomeActiveScroll = null; tabletHomeRecentScroll = null;
        rememberConversationListContext();
        boolean retainList = tabletConversationList != null && tabletConversationList.scope.equals(conversationListScope())
            && (screen.equals("list") || screen.equals("detail"));
        if (retainList) tabletConversationList.takeView(); // Do not retain the old transcript through its parent split.
        else { conversationListScroll.detach(); discardTabletConversationList(); }
        if (!retainingDialogsForConfiguration && codexResetDialog != null) { codexResetDialog.dismiss(); codexResetDialog = null; }
        // PageTransitions captures the outgoing hierarchy before detaching it.
        viewHandler.removeCallbacksAndMessages(null); clearMessageScroll();
        prefetchRows.clear(); disposeMessageViews();
        if (workStatus != null) { workStatus.close(); workStatus = null; }
        if (conversationPopup != null) { conversationPopup.dismiss(); conversationPopup = null; }
        if (settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        if (computerPicker != null) { computerPicker.dismiss(); computerPicker = null; }
        if (!retainingDialogsForConfiguration) {
            if (computerDialog != null) { computerDialog.dismiss(); computerDialog = null; }
            if (queueDialog != null) { queueDialog.dismiss(); queueDialog = null; }
            if (workDialog != null) { workDialog.dismiss(); workDialog = null; }
            workApprovalSection = null;
            workAutomationSection = null;
            queueSheetPanel = null;
            if (remoteApprovalDialog != null) { remoteApprovalDialog.dismiss(); remoteApprovalDialog = null; }
            closeVisualization(); remoteApprovalKey = "";
            DialogWindows.dismiss(this);
        }
        locationConsent.cancel();
        messages = null; older = null; remoteEmptyState = null;
        archivedBar = null;
        composer = null; chatComposer = null; sendButton = null; stopButton = null;
        retryMessage = null; approvals = null; automationBar = null; queueBar = null; workInline = null;
        backgroundWorkBar = null; backgroundWorkLabel = null; backgroundWorkStop = null;
        imageTray = null; imageStrip = null; attachButton = null; modelButton = null; permissionButton = null;
        addressInput = null; portInput = null; nameInput = null; codeInput = null; pairButton = null; scanButton = null;
        handler.removeCallbacks(searchRemote);
        searchInput = retainList ? tabletConversationList.root.findViewWithTag("remoteSearchInput") : null;
        searchBar = retainList ? tabletConversationList.root.findViewWithTag("remoteSearchBar") : null;
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
                    boolean followBottom = automatic && ((ChatScrollView) scroll).isFollowingOutput();
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
                    conversationCache.remove(credentials, null);
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
                conversationCache.remove(credentials, screen.equals("detail") ? conversationId : null);
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
                conversationCache.remove(credentials, null);
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
        if (tabletConversationList != null && tabletConversationList.connection != null && tabletConversationList.connection != headerConnection) {
            tabletConversationList.connection.setText(headerConnection.getText()); tabletConversationList.connection.setVisibility(View.VISIBLE);
        }
    }

    private void listConnected() {
        connected = true; reconnecting = false; listRetryPending = false; updateConnectionHeader(); setStatusNotice("");
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
            : archivedConversation != null ? tr("已在电脑归档 · 只读", "Archived on your computer · Read-only")
            : editingSeq > 0 ? tr("正在编辑上一条消息", "Editing previous message")
            : !controlAllowed ? tr("只读会话", "Read-only conversation")
            : remoteQueue.length() > 0 ? tr("等待处理队列…", "Waiting for queued messages…") : tr("就绪", "Ready");
        JSONArray approvalRows = lastLive == null ? null : lastLive.optJSONArray("approvals");
        int approvalsCount = approvalRows == null ? 0 : approvalRows.length();
        int backgroundCount = RemoteWorkStatus.backgroundCount(displayedConversation);
        boolean automation = remoteGoal != null || remoteTasks.length() > 0;
        JSONObject pendingAction = pendingCommand();
        boolean failed = pendingAction != null && (pendingAction.optBoolean("uncertain") || pendingAction.optBoolean("timedOut"));
        if (outgoingMessage != null) {
            String delivery = outgoingMessage.optString("delivery");
            failed |= delivery.equals("failed") || delivery.equals("unconfirmed");
        }
        String priority = archivedConversation == null ? workPriority(approvalsCount, failed, automation, backgroundCount) : "none";
        if (connected && !commandBusy) {
            if (priority.equals("approvals") && pending == null) {
                value = RemoteWorkStatus.approval(approvalRows, chinese) + tr(" · " + approvalsCount + " 项", " · " + approvalsCount);
            } else if (priority.equals("failed")) {
                value = tr("发送未确认", "Send unconfirmed");
            } else if (priority.equals("automation") || priority.equals("background")) {
                String detail = RemoteWorkStatus.automation(remoteGoal, remoteTasks, chinese);
                // A live reply owns the main status; append background counts
                // only when the main status is not already describing them.
                if (backgroundCount > 0 && !value.equals(RemoteWorkStatus.background(displayedConversation, chinese)))
                    detail += (detail.isEmpty() ? "" : " · ") + tr("后台任务 " + backgroundCount, "Background tasks " + backgroundCount);
                if (!detail.isEmpty()) value = value.equals(tr("就绪", "Ready")) ? detail : value + " · " + detail;
            }
        }
        workStatus.work(value, priority.equals("none") ? null : this::showWorkSheet);
    }

    private void reportError(String zh, String en, Exception error) {
        setStatusError(ErrorDetails.withSummary(tr(zh, en), error));
    }

    private void updateControls() {
        updateWorkStatus();
        updateBackgroundWorkControls();
        renderWorkApprovals();
        if (subtaskPage != null) subtaskPage.setControlAvailable(connected && controlAllowed && archivedConversation == null && !commandBusy && pendingCommand() == null);
        if (sendButton == null || conversationId == null) return;
        boolean pending = (pendingCommand() != null);
        boolean available = connected && controlAllowed && archivedConversation == null && !commandBusy;
        boolean configurable = available && !pending && remoteSettings != null && remoteSettings.optBoolean("modelEditable", remoteSettings.optBoolean("editable"));
        if (!configurable && settingsPopup != null) { settingsPopup.dismiss(); settingsPopup = null; }
        if (modelButton != null) {
            String model = remoteSettings == null ? "" : remoteSettings.optString("modelName", "").trim();
            if (model.isEmpty() && remoteSettings != null) model = remoteSettings.optString("model", "").trim();
            if (model.isEmpty()) model = tr("模型", "Model");
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
        boolean stoppable = archivedConversation == null && (lastLive != null || canStopStart && remotePreparation != null);
        stopButton.setEnabled(connected && controlAllowed && stoppable && !stopping);
        boolean showQueueSend = queueing && hasMessage;
        sendButton.setVisibility(!stoppable || showQueueSend ? View.VISIBLE : View.GONE);
        stopButton.setVisibility(stoppable && !showQueueSend ? View.VISIBLE : View.GONE);
        composer.setEnabled(!commandBusy && !pending && archivedConversation == null);
        if (retryMessage != null) retryMessage.setEnabled(pending);
        if (workStatus != null) workStatus.retry(stopping ? this::retryStopCommand
            : pending ? this::retryCommand : null);
        if (approvals != null) for (int index = 0; index < approvals.getChildCount(); index++) {
            View child = approvals.getChildAt(index);
            if (child instanceof Button) child.setEnabled(available && !pending);
        }
        renderQueue();
        updateWorkStatus();
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
        boolean available = connected && controlAllowed && archivedConversation == null && !commandBusy && pendingCommand() == null && !stopping
            && RemoteWorkStatus.stoppableBackgroundTasks(displayedConversation).length() > 0;
        backgroundWorkStop.setEnabled(available); backgroundWorkStop.setAlpha(available ? 1f : .45f);
        updateWorkStatus();
    }

    static String workPriority(int approvals, boolean failed, boolean automation, int background) {
        if (approvals > 0) return "approvals";
        if (failed) return "failed";
        if (automation) return "automation";
        if (background > 0) return "background";
        return "none";
    }

    private void showWorkSheet() {
        if (!screen.equals("detail")) return;
        if (workDialog != null && workDialog.isShowing()) return;
        SettingsStyle style = new SettingsStyle(this);
        android.app.Dialog dialog = new android.app.Dialog(this) {
            @Override public boolean onTouchEvent(android.view.MotionEvent event) {
                // The sheet's 12dp side margin is smaller than Android's
                // default outside-touch slop. Recognize the visible gap too.
                View decor = getWindow().getDecorView();
                if (event.getActionMasked() == android.view.MotionEvent.ACTION_DOWN
                        && (event.getX() < 0 || event.getY() < 0 || event.getX() > decor.getWidth() || event.getY() > decor.getHeight())) {
                    cancel(); return true;
                }
                return super.onTouchEvent(event);
            }
        };
        workDialog = dialog;
        dialog.setCanceledOnTouchOutside(true);
        LinearLayout panel = column();
        style.sheetPanel(panel);
        panel.setTag("workSheet");
        TextView heading = text(tr("工作状态", "Work status"), Palette.TEXT_TITLE, ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        panel.addView(heading);
        JSONArray approvalRows = lastLive == null ? null : lastLive.optJSONArray("approvals");
        boolean added = false;
        workApprovalSection = column();
        workApprovalSignature = "";
        panel.addView(workApprovalSection);
        renderWorkApprovals();
        added = approvalRows != null && approvalRows.length() > 0;
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
        String background = RemoteWorkStatus.background(displayedConversation, chinese);
        if (!background.isEmpty()) {
            added = true;
            panel.addView(sheetSection(background));
            String descriptions = RemoteWorkStatus.backgroundDescriptions(displayedConversation);
            if (!descriptions.isEmpty()) {
                TextView detail = text(descriptions, Palette.TEXT_SMALL, muted);
                detail.setTag("workBackgroundDescriptions");
                detail.setPadding(0, dp(6), 0, dp(8));
                detail.setTextIsSelectable(true);
                panel.addView(detail);
            }
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
        ScrollView sheetScroll = ScrollViews.plain(this);
        sheetScroll.setVerticalScrollBarEnabled(false);
        sheetScroll.addView(panel);
        dialog.setContentView(sheetScroll);
        dialog.setOnDismissListener(dismissed -> {
            if (workDialog == dialog) { workDialog = null; workApprovalSection = null; workAutomationSection = null; expandedTaskDetails.clear(); }
        });
        style.sheetWindow(dialog.getWindow(), sheetScroll);
        dialog.show();
    }

    private void addApprovalSummary(LinearLayout parent, JSONObject request, boolean compact) {
        String description = RemoteApprovalDialog.description(request);
        if (!description.isEmpty()) {
            TextView details = text(description, Palette.TEXT_NOTE, muted);
            if (compact) { details.setMaxLines(4); details.setEllipsize(android.text.TextUtils.TruncateAt.END); }
            details.setTypeface(Typeface.MONOSPACE); details.setTextIsSelectable(true); parent.addView(details);
        }
        JSONArray questions = request.optJSONArray("questions");
        for (int index = 0; questions != null && index < questions.length(); index++) {
            JSONObject question = questions.optJSONObject(index); if (question == null) continue;
            TextView preview = text(question.optString("question", question.optString("header")), Palette.TEXT_NOTE, ink);
            preview.setPadding(0, dp(8), 0, dp(6)); preview.setTextIsSelectable(true); parent.addView(preview);
        }
    }

    private void renderWorkApprovals() {
        if (workApprovalSection == null) return;
        JSONArray requests = controlAllowed && lastLive != null ? lastLive.optJSONArray("approvals") : null;
        boolean enabled = connected && controlAllowed && !commandBusy && pendingCommand() == null;
        long runId = lastLive == null ? 0 : lastLive.optLong("runId");
        String server = instance, target = conversationId;
        String signature = target + ":" + server + ":" + runId + ":" + requests + ":" + enabled + ":" + chinese;
        if (signature.equals(workApprovalSignature)) return;
        workApprovalSignature = signature; workApprovalSection.removeAllViews();
        if (requests == null || requests.length() == 0) return;
        workApprovalSection.addView(sheetSection(tr("等待你处理", "Needs attention")));
        android.app.Dialog sheet = workDialog;
        for (int index = 0; index < requests.length(); index++) {
            JSONObject request = requests.optJSONObject(index); if (request == null) continue;
            TextView title = text(request.optString("toolName"), Palette.TEXT_ROW_STRONG, ink);
            title.setPadding(0, dp(8), 0, dp(2)); workApprovalSection.addView(title);
            addApprovalSummary(workApprovalSection, request, true);
            if (!RemoteApprovalDialog.supported(request)) {
                workApprovalSection.addView(text(tr("此请求暂不支持手机回答，请在电脑处理。", "This request cannot be answered on this phone. Respond on the computer."), Palette.TEXT_NOTE, muted));
            } else if (RemoteApprovalDialog.hasQuestions(request)) {
                Button answer = button(tr("回答问题", "Answer questions"), () -> {
                    if (!currentRemoteApproval(request, target, server, runId)) return;
                    sheet.dismiss(); showRemoteQuestions(request, target, server, runId);
                }, true);
                answer.setTag("workApprovalAnswer:" + request.optString("requestId")); answer.setEnabled(enabled);
                workApprovalSection.addView(answer);
            } else {
                LinearLayout actions = new LinearLayout(this); actions.setPadding(0, dp(6), 0, 0);
                Button deny = button(tr("拒绝", "Deny"), () -> submitSheetApproval(request, false, target, server, runId, sheet), false);
                Button allow = button(tr("允许一次", "Allow once"), () -> submitSheetApproval(request, true, target, server, runId, sheet), true);
                deny.setEnabled(enabled); allow.setEnabled(enabled);
                actions.addView(deny, new LinearLayout.LayoutParams(0, -2, 1));
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); params.setMarginStart(dp(8));
                actions.addView(allow, params); workApprovalSection.addView(actions);
            }
        }
    }

    /**
     * Keeps an archived conversation readable without pretending its controls
     * still work. The snapshot carries the archive marker and a read permission,
     * so this banner is the only place that explains why the input is empty.
     */
    private void renderArchivedDetail() {
        if (archivedBar == null) return;
        archivedBar.removeAllViews();
        boolean archived = archivedConversation != null;
        archivedBar.setVisibility(archived ? View.VISIBLE : View.GONE);
        if (chatComposer != null) chatComposer.bar().setVisibility(archived ? View.GONE : View.VISIBLE);
        if (!archived) return;
        LinearLayout card = column(); card.setTag("remoteArchivedCard");
        card.setPadding(dp(14), dp(12), dp(14), dp(10));
        card.setBackground(chatStyle.rounded(surface));
        TextView title = text(tr("已在电脑归档", "Archived on your computer"), Palette.TEXT_ROW_STRONG, ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        card.addView(title);
        TextView detail = text(tr("聊天记录仍保留，这里是只读状态。", "The transcript is still here and read-only."), Palette.TEXT_NOTE, muted);
        detail.setTag("remoteArchivedDetail");
        card.addView(detail);
        if (archivedRestorable && !commandBusy) {
            TextView restore = text(tr("恢复会话", "Restore conversation"), Palette.TEXT_NOTE, accent);
            restore.setTag("remoteArchivedRestore");
            restore.setMinHeight(dp(48));
            restore.setGravity(Gravity.CENTER_VERTICAL);
            restore.setPadding(dp(4), 0, dp(4), 0);
            restore.setFocusable(true);
            restore.setContentDescription(tr("恢复这个归档会话", "Restore this archived conversation"));
            restore.setOnClickListener(view -> confirmRestoreArchivedDetail());
            card.addView(restore);
        }
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, dp(10));
        archivedBar.addView(card, params);
    }

    private void clearArchivedAfterRestore() {
        archivedConversation = null;
        archivedRestorable = false;
        renderArchivedDetail();
        if (lastLive == null) updateControls();
    }

    private void confirmRestoreArchivedDetail() {
        if (archivedConversation == null || !archivedRestorable || commandBusy) return;
        new CamelliaDialog.Builder(this).setTitle(tr("恢复会话？", "Restore conversation?"))
            .setMessage(tr("会话会回到正常的会话列表，并重新允许发送消息。", "The conversation returns to the normal list and becomes writable again."))
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("恢复", "Restore"), (dialog, which) -> {
                try {
                    JSONObject payload = command("restore").put("instanceId", instance)
                        .put("conversationId", conversationId)
                        .put("expectedSeq", conversationSeq);
                    submitRestore(payload);
                } catch (Exception error) {
                    reportError("无法保存恢复请求", "Could not save restore action", error);
                }
            }).show();
    }

    // Restore is journaled at the collection level because it names the
    // conversation in its payload. Sending it down the detail command URL would
    // be rejected by the remote protocol's target check.
    private void submitRestore(JSONObject payload) throws Exception {
        if (!foreground || !connected || !archivedRestorable || commandBusy || pendingCommand() != null) return;
        JSONObject saved = new JSONObject(credentials.toString());
        JSONObject pending = new JSONObject().put("conversationId", conversationId).put("payload", payload);
        RemotePendingCommands.put(saved, pending, false);
        store.save(saved); credentials = saved;
        setStatusNotice(tr("正在恢复会话…", "Restoring conversation…"));
        updateControls();
        commandCheckDeadline = android.os.SystemClock.elapsedRealtime() + COMMAND_CONFIRM_TIMEOUT_MS;
        retryCommand(false);
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
            addTaskDetails((LinearLayout) card, task, enabled);
            workAutomationSection.addView(card);
        }
    }

    private void addTaskDetails(LinearLayout card, JSONObject task, boolean enabled) {
        collapseTaskDetail(card, card.findViewWithTag("remoteTaskInstruction"), task.optString("id") + ":instruction");
        addTaskDetail(card, taskScheduleText(task, false), "remoteTaskSchedule");
        String notice = task.optString(chinese ? "noticeZh" : "notice");
        if (!notice.isEmpty()) addTaskDetail(card, notice, "remoteTaskNotice");
        if (task.has("maxRuns")) {
            addTaskDetail(card, task.optInt("runs") + "/" + task.optInt("maxRuns") + tr(" 次检查", " checks")
                + " · " + task.optInt("repairs") + "/" + task.optInt("maxRepairs") + tr(" 次恢复", " recoveries"), "remoteTaskCounts");
        }
        java.text.DateFormat format = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT,
            java.text.DateFormat.SHORT, chinese ? java.util.Locale.SIMPLIFIED_CHINESE : java.util.Locale.ENGLISH);
        if (task.optLong("nextRunAt") > 0) addTaskDetail(card, tr("下次检查：", "Next check: ")
            + format.format(new java.util.Date(task.optLong("nextRunAt"))), "remoteTaskNextCheck");
        if (task.optLong("expiresAt") > 0) addTaskDetail(card, tr("截止时间：", "Deadline: ")
            + format.format(new java.util.Date(task.optLong("expiresAt"))), "remoteTaskDeadline");
        if (!task.optString("lastResult").isEmpty()) {
            addTaskDetail(card, task.optString("lastResult"), "remoteTaskResult");
            collapseTaskDetail(card, card.findViewWithTag("remoteTaskResult"), task.optString("id") + ":result");
        }
        JSONArray history = task.optJSONArray("history");
        if (history != null && history.length() > 0) {
            LinearLayout records = column(); records.setVisibility(View.GONE); records.setTag("remoteTaskHistory");
            for (int index = history.length() - 1; index >= 0; index--) {
                JSONObject entry = history.optJSONObject(index); if (entry == null) continue;
                addTaskDetail(records, format.format(new java.util.Date(entry.optLong("at"))) + "\n" + entry.optString("message"), null);
            }
            TextView expand = text(tr("最近记录", "Recent checks"), Palette.TEXT_NOTE, accent);
            expand.setTag("remoteTaskHistoryToggle"); expand.setMinHeight(dp(48)); expand.setGravity(Gravity.CENTER_VERTICAL);
            expand.setPadding(dp(12), dp(4), dp(12), dp(4)); expand.setFocusable(true);
            expand.setOnClickListener(view -> { boolean show = records.getVisibility() != View.VISIBLE;
                records.setVisibility(show ? View.VISIBLE : View.GONE);
                expand.setText(show ? tr("收起记录", "Hide recent checks") : tr("最近记录", "Recent checks")); });
            card.addView(expand); card.addView(records);
        }
        if (!task.optBoolean("stopping") && java.util.Arrays.asList("scheduled", "running", "paused").contains(task.optString("status"))) {
            TextView cancel = text(tr("取消任务", "Cancel task"), Palette.TEXT_NOTE, accent);
            cancel.setTag("remoteTaskCancel"); cancel.setMinHeight(dp(48)); cancel.setGravity(Gravity.CENTER_VERTICAL);
            cancel.setPadding(dp(12), dp(4), dp(12), dp(4)); cancel.setFocusable(true);
            cancel.setEnabled(enabled); cancel.setAlpha(enabled ? 1f : .45f);
            String target = conversationId, server = instance, id = task.optString("id");
            cancel.setOnClickListener(view -> new CamelliaDialog.Builder(this).setTitle(tr("取消任务？", "Cancel task?"))
                .setMessage(tr("停止定时检查，保留记录。正在运行的实验不会停止。", "Stops scheduled checks and keeps their history. The experiment keeps running."))
                .setNegativeButton(tr("返回", "Back"), null).setPositiveButton(tr("取消任务", "Cancel task"), (dialog, which) -> {
                    if (target.equals(conversationId) && server.equals(instance)) submitAutomation("task-control", "cancel", id);
                }).show());
            card.addView(cancel);
        }
    }

    private void collapseTaskDetail(LinearLayout card, TextView detail, String key) {
        if (detail.getText().length() <= 300) return;
        boolean expanded = expandedTaskDetails.contains(key);
        detail.setMaxLines(expanded ? Integer.MAX_VALUE : 4);
        detail.setEllipsize(expanded ? null : android.text.TextUtils.TruncateAt.END);
        TextView toggle = text(expanded ? tr("收起", "Collapse") : tr("展开全文", "Show full text"), Palette.TEXT_NOTE, accent);
        toggle.setTag(detail.getTag() + "Expand"); toggle.setMinHeight(dp(48)); toggle.setGravity(Gravity.CENTER_VERTICAL);
        toggle.setPadding(dp(12), 0, dp(12), dp(8)); toggle.setFocusable(true);
        toggle.setOnClickListener(view -> {
            boolean show = !expandedTaskDetails.contains(key);
            if (show) expandedTaskDetails.add(key); else expandedTaskDetails.remove(key);
            detail.setMaxLines(show ? Integer.MAX_VALUE : 4); detail.setEllipsize(show ? null : android.text.TextUtils.TruncateAt.END);
            toggle.setText(show ? tr("收起", "Collapse") : tr("展开全文", "Show full text"));
        });
        card.addView(toggle, card.indexOfChild(detail) + 1);
    }

    private void addTaskDetail(LinearLayout card, String value, String tag) {
        TextView detail = text(value, Palette.TEXT_SMALL, muted); detail.setTag(tag); detail.setTextIsSelectable(true);
        detail.setPadding(dp(12), 0, dp(12), dp(10)); card.addView(detail, new LinearLayout.LayoutParams(-1, -2));
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

    private boolean currentRemoteApproval(JSONObject request, String target, String server, long runId) {
        if (!screen.equals("detail") || !connected || !controlAllowed || commandBusy || pendingCommand() != null
                || target == null || !target.equals(conversationId) || !server.equals(instance) || lastLive == null || lastLive.optLong("runId") != runId) return false;
        JSONArray requests = lastLive.optJSONArray("approvals");
        for (int index = 0; requests != null && index < requests.length(); index++) {
            JSONObject current = requests.optJSONObject(index);
            if (current != null && current.optString("requestId").equals(request.optString("requestId"))
                    && current.optString("fingerprint").equals(request.optString("fingerprint")) && RemoteApprovalDialog.supported(current)) return true;
        }
        return false;
    }

    private boolean sendRemoteApproval(JSONObject request, String target, String server, long runId, boolean allow, JSONObject input, String optionId) throws Exception {
        if (!foreground || !currentRemoteApproval(request, target, server, runId)) return false;
        JSONObject payload = command("approve").put("instanceId", server).put("runId", runId)
            .put("approvalId", request.getString("requestId")).put("fingerprint", request.getString("fingerprint")).put("allow", allow);
        if (input != null) payload.put("input", input);
        if (optionId != null) payload.put("optionId", optionId);
        submitCommand(payload); return true;
    }

    private void showRemoteQuestions(JSONObject request, String target, String server, long runId) {
        if (!currentRemoteApproval(request, target, server, runId)) return;
        if (remoteApprovalDialog != null) remoteApprovalDialog.dismiss();
        remoteApprovalKey = target + ":" + server + ":" + runId + ":" + request.optString("fingerprint");
        remoteApprovalDialog = RemoteApprovalDialog.show(this, request, conversationTitle,
            (allow, input, optionId) -> sendRemoteApproval(request, target, server, runId, allow, input, optionId));
    }

    private void submitSheetApproval(JSONObject request, boolean allow, String target, String server, long runId, android.app.Dialog sheet) {
        if (!currentRemoteApproval(request, target, server, runId) || RemoteApprovalDialog.hasQuestions(request)) return;
        String title = allow ? tr("允许此操作？", "Allow this operation?") : tr("拒绝此操作？", "Deny this operation?");
        new CamelliaDialog.Builder(this).setTitle(title)
            .setMessage(request.optString("toolName") + "\n" + request.optString("details"))
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(allow ? tr("允许一次", "Allow once") : tr("拒绝", "Deny"), (dialog, which) -> {
                try {
                    if (sendRemoteApproval(request, target, server, runId, allow, null, null) && sheet != null) sheet.dismiss();
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
        if (archivedConversation != null) {
            dismissQueueSheet();
            queueSignature = "";
            queueBar.removeAllViews();
            queueBar.setVisibility(View.GONE);
            return;
        }
        boolean enabled = connected && controlAllowed && !commandBusy && !(pendingCommand() != null);
        String signature = remoteQueue.toString() + ":" + enabled + ":" + (lastLive == null ? 0 : lastLive.optLong("runId")) + ":" + queueSteeringGoalId;
        if (signature.equals(queueSignature)) return;
        queueSignature = signature;
        queueBar.removeAllViews(); queueBar.setVisibility(remoteQueue.length() == 0 ? View.GONE : View.VISIBLE);
        if (remoteQueue.length() == 0) {
            dismissQueueSheet();
            updateWorkStatus();
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
        updateWorkStatus();
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

        android.widget.ScrollView list = ScrollViews.capped(this, () -> dp(getResources().getConfiguration().fontScale > 1.15f ? 260 : 320));
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
        EditText editor = new EditorInput(this); editor.setTag("remoteQueueEditor");
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
        if (archivedConversation != null) {
            automationBar.setVisibility(View.GONE);
            if (queueBar != null) queueBar.setVisibility(View.GONE);
            updateWorkStatus();
            return;
        }
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
        updateWorkStatus();
        renderWorkAutomation();
    }

    private View automationCard(JSONObject goal) {
        String phase = goal.optString("phase", "");
        boolean armed = goal.optBoolean("armed");
        boolean running = phase.equals("active") && armed;
        JSONObject waiting = running ? goal.optJSONObject("waiting") : null;
        String label = RemoteWorkStatus.goal(goal, chinese);
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
        String label = task.optBoolean("stopping") ? tr("停止中", "Stopping") : status.equals("running") ? tr("检查中", "Checking") : status.equals("paused") ? tr("已暂停", "Paused")
            : status.equals("complete") ? tr("已完成", "Complete") : status.equals("cancelled") ? tr("已取消", "Cancelled") : tr("等待", "Waiting");
        TextView state = text(label, Palette.TEXT_SMALL, muted); state.setTag("remoteTaskState"); row.addView(state, new LinearLayout.LayoutParams(-2, -2));
        TextView instruction = text(task.optString("instruction", ""), Palette.TEXT_NOTE, ink);
        instruction.setPadding(dp(10), 0, dp(10), 0); instruction.setSingleLine(true);
        instruction.setEllipsize(android.text.TextUtils.TruncateAt.END); instruction.setTag("remoteTaskInstruction");
        row.addView(instruction, new LinearLayout.LayoutParams(0, -2, 1));
        int minutes = task.optInt("intervalMinutes", 0);
        if (minutes > 0 || task.optJSONObject("schedule") != null) {
            TextView interval = text(taskScheduleText(task, true), Palette.TEXT_SMALL, muted);
            interval.setPadding(dp(6), 0, dp(6), 0); row.addView(interval, new LinearLayout.LayoutParams(-2, -2));
        }
        if (!task.optBoolean("stopping") && (status.equals("scheduled") || status.equals("running") || status.equals("paused"))) {
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

    private String taskScheduleText(JSONObject task, boolean compact) {
        JSONObject schedule = task.optJSONObject("schedule");
        String type = schedule == null ? "interval" : schedule.optString("type", "interval");
        if (type.equals("once")) return tr("执行一次", "One time");
        if (type.equals("daily")) return tr("每天 ", "Daily ") + schedule.optString("time")
            + (compact ? "" : " (" + schedule.optString("timeZone") + ")");
        return tr("每 ", "Every ") + task.optInt("intervalMinutes") + tr(" 分钟", " min");
    }

    // Automation controls are existing commands, so the request/retry rules and
    // the per-command idempotency journal apply unchanged.
    private void submitAutomation(String action, String operation, String taskId) {
        if (!connected || !controlAllowed || archivedConversation != null || commandBusy || (pendingCommand() != null)) return;
        try {
            JSONObject payload = command(action).put("instanceId", instance).put("operation", operation);
            if (taskId != null) payload.put("taskId", taskId);
            submitCommand(payload);
        } catch (Exception error) { reportError("无法保存操作。", "Could not save operation.", error); }
    }

    private void renderApprovals() {
        viewHandler.post(this::notifyApprovalRequests);
        renderWorkApprovals();
        JSONArray requests = controlAllowed && archivedConversation == null && lastLive != null ? lastLive.optJSONArray("approvals") : null;
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
            addApprovalSummary(approvals, request, false);
            if (!RemoteApprovalDialog.supported(request)) {
                approvals.addView(text(tr("此请求暂不支持手机回答，请在电脑处理。", "This request cannot be answered on this phone. Respond on the computer."), Palette.TEXT_NOTE, muted)); continue;
            }
            long runId = lastLive.optLong("runId"); String server = instance, target = conversationId;
            if (RemoteApprovalDialog.hasQuestions(request)) {
                approvals.addView(button(tr("回答问题", "Answer questions"), () -> showRemoteQuestions(request, target, server, runId), true)); continue;
            }
            for (boolean allow : new boolean[]{false, true}) {
                approvals.addView(button(allow ? tr("允许一次", "Allow once") : tr("拒绝", "Deny"),
                    () -> submitSheetApproval(request, allow, target, server, runId, null), allow));
            }
        }
        updateWorkStatus();
    }

    private void notifyApprovalRequests() {
        if (!foreground || !screen.equals("detail") || !connected || !controlAllowed || archivedConversation != null || lastLive == null) return;
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
        boolean restoring = payload.optString("action").equals("restore");
        if (!foreground || !connected || (!controlAllowed && !(restoring && archivedConversation != null && archivedRestorable)) || (!restoring && archivedConversation != null)
                || (!stop && (commandBusy || pendingCommand() != null))
                || stop && RemotePendingCommands.get(credentials, conversationId, true) != null) return;
        JSONObject saved = new JSONObject(credentials.toString());
        JSONObject pending = new JSONObject().put("conversationId", conversationId).put("payload", payload);
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) pending.put("draft", composer.getText().toString()).put("at", System.currentTimeMillis());
        RemotePendingCommands.put(saved, pending, stop);
        store.save(saved); credentials = saved;
        if (payload.optString("action").equals("send") || payload.optString("action").equals("resend")) {
            ((ChatScrollView) scroll).followOutput();
            outgoingMessage = pending;
            editingSeq = -1; editingText = "";
            composer.setText(""); selectedImages.clear(); selectedDocuments.clear(); renderImage();
            persistDraft();
            outgoingState("sending");
            ScrollView sentScroll = scroll;
            viewHandler.post(() -> {
                if (scroll == sentScroll && ((ChatScrollView) sentScroll).isFollowingOutput()) sentScroll.fullScroll(View.FOCUS_DOWN);
            });
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
        if (!foreground || !connected || pending == null) return;
        String target = pending.optString("conversationId"); JSONObject payload = pending.optJSONObject("payload");
        if (payload == null || !target.equals(conversationId)) return;
        boolean restoring = payload.optString("action").equals("restore");
        if (!controlAllowed && !(restoring && archivedConversation != null && archivedRestorable)) return;
        // Restore is the one command that must keep working while archived;
        // every other pending write waits for the conversation to be restored.
        if (archivedConversation != null && !restoring) return;
        String key = commandKey(credentials, payload);
        if (commandRequests.contains(key)) return;
        if (!urgent) commandBusy = true;
        boolean sending = payload.optString("action").equals("send") || payload.optString("action").equals("resend");
        boolean collectionCommand = restoring;
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
                String submitPath = collectionCommand ? "/v1/commands" : "/v1/conversations/" + target + "/commands";
                try { result = client.json(query ? "/v1/commands/" + payload.optString("requestId") : submitPath, token, query ? null : payload); }
                catch (RemoteApi.Failure missing) {
                    if (!query || missing.status != 404) throw missing;
                    result = client.json(submitPath, token, payload);
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
                if (payload.optString("action").equals("restore") && conversationId.equals(target))
                    clearArchivedAfterRestore();
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
                try { removeComputer(computer); }
                catch (Exception error) { reportError("无法清除凭据，请重试。", "Could not remove credentials. Try again.", error); }
            }).show();
    }

    private void removeComputer(JSONObject computer) throws Exception {
        // Close the old stream before deleting credentials so a late snapshot
        // cannot repopulate the cache after this removal.
        stopNetwork();
        closeCommandClients();
        boolean cacheCleared = conversationCache == null || conversationCache.removeDurably(computer, null);
        store.remove(computer.getString("address"));
        listCache.remove(computer); homeCache.remove(computer); prefetch.remove(computer, null);
        credentials = store.load(); computersScreen(); refreshComputers();
        if (!cacheCleared) setStatusError(tr("手机上的凭据已删除，但会话缓存未能写入删除记录；请重启应用后再次移除。",
            "Credentials were removed, but the chat cache could not record the deletion; restart the app and remove this computer again."));
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
            lanPairScanning = false;
            lanScanStartedAt = 0;
            lanDiscoveryError = Integer.MIN_VALUE;
            handler.removeCallbacks(lanScanRefresh);
            if (lanDiscovery != null) lanDiscovery.stop(true);
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
        renderNetworkContent();
    }

    private void renderNetworkContent() {
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
        settingsStyle.info(identity, tr("独立网络身份", "Separate network identity"), tr("手机以本机名称加入网络；未设置时使用默认名称，仍受网络访问策略控制。", "This phone joins using its device name, or a default name when none is set, and follows your tailnet access rules."));
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
                ScrollView page = ScrollViews.plain(this); page.addView(licenses);
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
