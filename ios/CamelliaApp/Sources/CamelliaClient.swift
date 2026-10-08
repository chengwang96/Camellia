import SwiftUI
import UIKit
import Combine

#if !CAMELLIA_REMEDIATION_CHECK
@main
#endif
struct CamelliaClient: App {
    @UIApplicationDelegateAdaptor private var delegate: ClientDelegate

    var body: some Scene {
        WindowGroup {
            #if targetEnvironment(simulator)
            if LaunchScreen.requested == "remoteListFixture" {
                RemoteListFixtureView()
            } else if LaunchScreen.requested == "localListFixture" {
                LocalListFixtureView()
            } else {
                RootView()
            }
            #else
            RootView()
            #endif
        }
    }
}

/// Notifications rather than `scenePhase`: the `onChange` form of that is
/// deprecated from iOS 17 and its replacement is not available while the
/// deployment target is 15.
final class ClientDelegate: NSObject, UIApplicationDelegate {
    private let privacyCoverTag = 0xCA11E11A
    private var sceneObservers: [NSObjectProtocol] = []
    private var appBackgrounded = false
    /// The window iOS grants after backgrounding, held open so an in-flight
    /// transfer can finish and the tunnel is not torn down the instant the app
    /// leaves the screen. iOS has no foreground service, so this — roughly half
    /// a minute — is the most "keep the connection" the platform allows, which
    /// is the same trade the design notes make for `短暂离开保持连接`.
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        observeScenes()
        #if targetEnvironment(simulator)
        if ["remoteListFixture", "localListFixture"].contains(LaunchScreen.requested) { return true }
        #endif
        AppModelHolder.shared.model.boot()
        return true
    }

    /// SwiftUI's WindowGroup owns scenes. Scene notifications also arrive on
    /// iPad when the corresponding UIApplicationDelegate callback does not.
    private func observeScenes() {
        let center = NotificationCenter.default
        sceneObservers.append(center.addObserver(forName: UIScene.willDeactivateNotification,
                                                 object: nil, queue: .main) { [weak self] note in
            guard let scene = note.object as? UIWindowScene else { return }
            self?.cover(scene)
        })
        sceneObservers.append(center.addObserver(forName: UIScene.didActivateNotification,
                                                 object: nil, queue: .main) { [weak self] note in
            guard let scene = note.object as? UIWindowScene else { return }
            self?.uncover(scene)
        })
        sceneObservers.append(center.addObserver(forName: UIScene.didEnterBackgroundNotification,
                                                 object: nil, queue: .main) { [weak self] note in
            if let scene = note.object as? UIWindowScene { self?.cover(scene) }
            let anotherSceneIsVisible = UIApplication.shared.connectedScenes.contains {
                $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive
            }
            if !anotherSceneIsVisible { self?.enterBackground(UIApplication.shared) }
        })
        sceneObservers.append(center.addObserver(forName: UIScene.willEnterForegroundNotification,
                                                 object: nil, queue: .main) { [weak self] _ in
            self?.enterForeground(UIApplication.shared)
        })
    }

    func applicationWillResignActive(_ application: UIApplication) {
        for scene in application.connectedScenes.compactMap({ $0 as? UIWindowScene }) { cover(scene) }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        for scene in application.connectedScenes.compactMap({ $0 as? UIWindowScene }) { uncover(scene) }
    }

    private func cover(_ scene: UIWindowScene) {
        for window in scene.windows where window.windowLevel == .normal {
            window.endEditing(true)
            guard window.viewWithTag(privacyCoverTag) == nil else { continue }
            // Stay inside the app window: a system permission sheet must remain
            // usable above us when it temporarily deactivates the scene.
            let cover = UIView(frame: window.bounds)
            cover.tag = privacyCoverTag
            cover.backgroundColor = .systemBackground
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            window.addSubview(cover)
        }
    }

    private func uncover(_ scene: UIWindowScene) {
        for window in scene.windows { window.viewWithTag(privacyCoverTag)?.removeFromSuperview() }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        for scene in application.connectedScenes.compactMap({ $0 as? UIWindowScene }) { cover(scene) }
        enterBackground(application)
    }

    private func enterBackground(_ application: UIApplication) {
        guard !appBackgrounded else { return }
        appBackgrounded = true
        LocalChatHolder.shared.model.pauseForLeavingApp()
        AppModelHolder.shared.model.background()
        endBackgroundTask(application)
        guard AppModelHolder.shared.model.preferences.keepAlive else { return }
        backgroundTask = application.beginBackgroundTask(withName: "camellia.background") { [weak self] in
            guard let self else { return }
            // The grant expired before the work did: tell the network so it can
            // close the tunnel, then hand the identifier back or the watchdog
            // will kill the app.
            AppModelHolder.shared.model.endBackground()
            self.endBackgroundTask(application)
        }
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        enterForeground(application)
    }

    private func enterForeground(_ application: UIApplication) {
        guard appBackgrounded else { return }
        appBackgrounded = false
        endBackgroundTask(application)
        AppModelHolder.shared.model.foreground()
        LocalChatHolder.shared.model.resumePendingSaves()
    }

    private func endBackgroundTask(_ application: UIApplication) {
        guard backgroundTask != .invalid else { return }
        application.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}

/// One model for the whole app.
///
/// Created eagerly because the node has to be told where to keep its state
/// before anything can start it, and a `@StateObject` inside `RootView` would
/// not exist yet when the delegate wants to boot.
final class AppModelHolder {
    static let shared = AppModelHolder()
    @MainActor let model = AppModel()
    private init() {}
}

struct RootView: View {
    @StateObject private var holder = ViewModelHolder()
    @StateObject private var localHolder = LocalChatViewModelHolder()
    @State private var screen: Screen = .home
    @State private var showComputers = false
    @State private var showComputerPicker = false
    @State private var showConversationSearch = false
    @State private var showSettings = false
    @State private var showLogin = false
    @State private var showPairing = false
    @State private var pairingComputer: PairedComputer?
    @State private var resumePendingPairing = false
    @State private var pairingFromPicker = false
    @State private var appliedLaunchScreen = false

    /// Which of the two halves is on screen.
    ///
    /// A plain switch rather than `NavigationLink`s, because the remote list
    /// already pushes its own detail: nesting that inside a second navigation
    /// level would put two back buttons in the same bar. Android's start page
    /// makes the same split.
    private enum Screen: Equatable {
        case home, localChat, remoteControl
    }

    init(appModel: AppModel = AppModelHolder.shared.model,
         localModel: LocalChatModel = LocalChatHolder.shared.model) {
        _holder = StateObject(wrappedValue: ViewModelHolder(model: appModel))
        _localHolder = StateObject(wrappedValue: LocalChatViewModelHolder(model: localModel))
    }

    var body: some View {
        NavigationView {
            content
                .environmentObject(holder.model)
                .environmentObject(localHolder.model)
                .navigationBarHidden(screen == .home)
                .navigationTitle(LocalizedStringKey(screen == .localChat ? "" : title))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        if screen == .localChat {
                            HStack(spacing: 12) {
                                leading
                                RemotePageHeading(title: holder.model.usesChinese ? "本机聊天" : "Local chat",
                                                  computer: holder.model.usesChinese
                                                      ? (isPad ? "本机 · 平板直连 API" : "本机 · 手机直连 API")
                                                      : (isPad ? "On this iPad · Direct API" : "On this phone · Direct API"),
                                                  systemImage: isPad ? "ipad" : "iphone", note: "")
                            }
                        } else {
                            leading
                        }
                    }
                    // Android's list header is the wordmark with the computer's
                    // name and its connection state underneath, not the
                    // computer's name alone: the screen is the app's, and which
                    // computer it is talking to is a detail of it. The detail
                    // screen keeps its own title and subtitle in the same slot.
                    //
                    // The branch lives inside the item rather than around it,
                    // because a bare `if` at this level reads as either a view
                    // builder or a toolbar content builder and SwiftUI cannot
                    // choose between the two overloads.
                    ToolbarItem(placement: .principal) {
                        if screen == .remoteControl, holder.model.current?.isPaired == true {
                            remoteHeading
                        } else if screen == .localChat {
                            EmptyView()
                        } else {
                            Text(LocalizedStringKey(title)).font(.headline).lineLimit(1)
                        }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        HStack(spacing: 4) {
                            if screen == .remoteControl {
                                if holder.model.openId == nil {
                                    Button { showConversationSearch.toggle() } label: {
                                        Image(systemName: "magnifyingglass")
                                            .frame(width: 44, height: 44)
                                    }
                                    .accessibilityLabel(holder.model.usesChinese ? "搜索会话" : "Search conversations")
                                }
                                Button { showComputerPicker.toggle() } label: {
                                    SwitchComputerIcon()
                                }
                                .accessibilityLabel(holder.model.usesChinese ? "切换电脑" : "Switch computer")
                            } else if screen == .home {
                                // Android's list header carries the switch
                                // button and nothing else — its settings entry
                                // is a row of the *home* page, which is where
                                // this gear lives too. Two gears on the same
                                // page would be the wrong number of them.
                                Button { showSettings = true } label: {
                                    Image(systemName: "gearshape")
                                }
                                .accessibilityLabel("设置")
                            }
                        }
                    }
                }
        }
        .navigationViewStyle(.stack)
        .overlay {
            GeometryReader { geometry in
                if showComputerPicker, screen == .remoteControl {
                    ZStack(alignment: .topTrailing) {
                        PopupDismissArea { showComputerPicker = false }
                        ComputerPickerPopupView(
                            maxHeight: max(96, min(520, geometry.size.height - 88)),
                            onAction: handleComputerPickerAction)
                            .environmentObject(holder.model)
                            .frame(width: min(312, geometry.size.width - 24))
                            .padding(.top, 56)
                            .padding(.trailing, 12)
                    }
                }
            }
            .allowsHitTesting(showComputerPicker && screen == .remoteControl)
        }
        .overlay {
            if let message = holder.model.statusDetails {
                GeometryReader { geometry in
                    ZStack(alignment: .bottom) {
                        Color.black.opacity(0.28).ignoresSafeArea()
                            .onTapGesture { holder.model.statusDetails = nil }
                        StatusDetailsPanel(message: message,
                                           maximumHeight: min(660, geometry.size.height * 0.83),
                                           onCopy: {
                                               UIPasteboard.general.string = message
                                               holder.model.statusDetails = nil
                                           },
                                           onClose: { holder.model.statusDetails = nil })
                            .frame(maxWidth: 560)
                            .frame(maxHeight: min(660, geometry.size.height * 0.83), alignment: .bottom)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showComputers) {
            ComputersView(onOpenComputer: { screen = .remoteControl })
                .environmentObject(holder.model)
        }
        .fullScreenCover(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(holder.model)
                .environmentObject(localHolder.model)
        }
        .fullScreenCover(isPresented: $showPairing, onDismiss: {
            if pairingFromPicker {
                screen = .home
                showComputers = true
            }
            pairingFromPicker = false
            pairingComputer = nil
        }) {
            PairingView(initialComputer: pairingComputer,
                        resumePending: resumePendingPairing,
                        onApproved: {
                pairingFromPicker = false
                showPairing = false
                screen = .remoteControl
            }).environmentObject(holder.model)
        }
        .fullScreenCover(isPresented: $showLogin) {
            NavigationView { MobileAccessView().environmentObject(holder.model) }
                .navigationViewStyle(.stack)
        }
        // Android keeps the start page visible while the node is waiting for a
        // sign-in and puts the route to Mobile access directly under the remote
        // card. Do the same here; presenting a sheet automatically on every
        // launch hid both product choices and made local chat look unavailable.
        .onAppear {
            guard !appliedLaunchScreen else { return }
            appliedLaunchScreen = true
            applyLaunchScreen()
            holder.model.remoteScreenChanged(active: screen == .remoteControl)
        }
        .onChange(of: screen) { next in
            showComputerPicker = false
            showConversationSearch = false
            holder.model.remoteScreenChanged(active: next == .remoteControl)
        }
        .onChange(of: holder.model.current?.address) { _ in showConversationSearch = false }
        .onChange(of: holder.model.current?.isPaired) { paired in
            // Android returns to the computer picker when the selected pairing
            // is lost. Do not strand the remote screen behind an extra welcome
            // step after a revoke or removal.
            if screen == .remoteControl && paired != true && !pairingFromPicker {
                screen = .home
                showComputers = true
            }
        }
        .alert(item: notice) { item in
            if item.kind == .rejectedSend {
                return Alert(title: Text("操作未确认成功"),
                             message: Text("请先检查最新会话状态，再决定是否重新操作。")
                                + Text(verbatim: "\n" + item.text),
                             dismissButton: .default(Text("知道了")))
            }
            if item.kind == .transportUnconfirmed {
                return Alert(title: Text(""),
                             message: Text("未收到电脑确认。操作可能已执行，请勿重复新建发送；点击未确认提示，重试同一请求。")
                                + Text(verbatim: "\n" + item.text),
                             dismissButton: .default(Text("知道了")))
            }
            return Alert(title: Text(item.serious ? "出错了" : "提示"),
                         message: Text(LocalizedStringKey(item.text)),
                         dismissButton: .default(Text("好")))
        }
        // Apply preferences outside the presenters too. A fullScreenCover
        // created after an inner locale modifier otherwise keeps the previous
        // language even while the home screen redraws in the new one.
        .environment(\.locale, holder.model.interfaceLocale)
        .preferredColorScheme(holder.model.preferredColorScheme)
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// The one button on the left, which means something different per screen.
    @ViewBuilder
    private var leading: some View {
        switch screen {
        case .home:
            EmptyView()
        case .localChat:
            RoundBackButton {
                localHolder.model.pauseForLeavingApp()
                screen = .home
            }
        case .remoteControl:
            // The remote list is a screen of its own, not the root: without this
            // there was no way back to the start page at all. Android's list
            // header carries the same back button, and moving between computers
            // moved to the trailing side where Android also keeps it.
            RoundBackButton {
                if showConversationSearch { showConversationSearch = false }
                else { screen = .home }
            }
        }
    }

    /// The list screen's heading: the wordmark over the computer's name and its
    /// connection state, which is how Android's list header is built. Which
    /// computer this is talking to is the one thing the screen cannot be read
    /// without, and a line under the title costs less than a row of chrome.
    ///
    /// The detail screen draws the same shape with the conversation's title as
    /// the heading (`RemotePageHeading`), because Android builds both out of one
    /// `shell()` branch.
    private var remoteHeading: some View {
        RemotePageHeading(title: "Camellia",
                          computer: holder.model.current?.displayName ?? "",
                          note: RemoteConnectionNote.text(for: holder.model.streamState,
                                                          chinese: holder.model.usesChinese))
    }

    /// Opens the screen named by `CAMELLIA_APP_SCREEN`, if any.
    ///
    /// A scripted simulator run cannot tap, and a screen that only ever draws
    /// behind a button is a screen nobody has looked at. `home`, `local`,
    /// `conversations`, `computers`, `pairing`, `settings`, `providers`,
    /// `general`, `archived`, `mobileAccess`, `deviceName` and `login` are the
    /// values; with none set the app opens at home and shows the sign-in sheet
    /// only when the node asks for it.
    private func applyLaunchScreen() {
        #if targetEnvironment(simulator)
        if LaunchScreen.requested == "remoteListFixture" {
            screen = .remoteControl
            return
        } else if LaunchScreen.requested == "localListFixture" {
            screen = .localChat
            return
        }
        #endif
        switch LaunchScreen.requested {
        case "computers": showComputers = true
        case "settings", "providers", "general", "archived", "mobileAccess", "deviceName":
            showSettings = true
        case "pairing": showPairing = true
        case "login": showLogin = true
        case "conversations":
            if holder.model.current?.isPaired == true { screen = .remoteControl }
            else { showComputers = true }
        case "local": screen = .localChat
        default:
            screen = .home
            showLogin = false
        }
    }

    @ViewBuilder
    private var content: some View {
        #if targetEnvironment(simulator)
        if LaunchScreen.requested == "remoteFeedbackFixture" {
            RemoteFeedbackFixtureView()
        } else {
            normalContent
        }
        #else
        normalContent
        #endif
    }

    @ViewBuilder
    private var normalContent: some View {
        switch screen {
        case .home:
            HomeView(onLocalChat: { screen = .localChat },
                     onRemoteControl: {
                         if holder.model.current?.isPaired == true { screen = .remoteControl }
                         else { showComputers = true }
                     },
                     onSettings: { showSettings = true },
                     onMobileAccess: { showLogin = true })
        case .localChat:
            LocalChatListView()
        case .remoteControl:
            if holder.model.current?.isPaired == true {
                ConversationListView(showSearch: $showConversationSearch,
                                     onComputerPickerAction: handleComputerPickerAction)
            } else {
                WelcomeView(onPair: { showComputers = true })
            }
        }
    }

    private func handleComputerPickerAction(_ action: ComputerPickerAction) {
        showComputerPicker = false
        switch action {
        case .open(let computer):
            guard computer.address != holder.model.current?.address else { return }
            pairingFromPicker = !computer.isPaired
            guard holder.model.select(computer.address) else {
                pairingFromPicker = false
                return
            }
            if computer.isPaired {
                screen = .remoteControl
            } else {
                pairingComputer = computer
                resumePendingPairing = computer.isAwaitingApproval
                showPairing = true
            }
        case .add:
            pairingFromPicker = true
            pairingComputer = nil
            resumePendingPairing = false
            screen = .home
            showPairing = true
        case .manage:
            showComputers = true
        }
    }

    private var title: String {
        switch screen {
        case .home: return "Camellia"
        case .localChat: return "本机聊天"
        // When a computer is paired the heading above replaces this, and it says
        // "Camellia" too; this is what shows before there is one to name.
        case .remoteControl: return "Camellia"
        }
    }

    private var notice: Binding<AppModel.Notice?> {
        Binding(get: { holder.model.notice }, set: { holder.model.notice = $0 })
    }
}

/// The local-chat half of the app, held the same way and for the same reason:
/// its store has to be open before the first screen asks for a conversation,
/// and the run it owns must outlive the screen that started it.
final class LocalChatHolder {
    static let shared = LocalChatHolder()
    @MainActor let model = LocalChatModel()
    private init() {}
}

/// Bridges the app-wide model into the SwiftUI environment.
private final class ViewModelHolder: ObservableObject {
    @MainActor let model: AppModel
    private var forwarding: AnyCancellable?

    @MainActor init(model: AppModel = AppModelHolder.shared.model) {
        self.model = model
        forwarding = model.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }
}

/// Bridges the local-chat model into the SwiftUI environment.
private final class LocalChatViewModelHolder: ObservableObject {
    @MainActor let model: LocalChatModel

    @MainActor init(model: LocalChatModel = LocalChatHolder.shared.model) { self.model = model }
}

/// Reads the launch-time screen override.
///
/// Exists so a scripted simulator run can reach a screen that would otherwise
/// need a tap, for the same reason the diagnostics build has
/// `CAMELLIA_APP_TAB`. Nothing sets it in normal use.
enum LaunchScreen {
    static var requested: String {
        ProcessInfo.processInfo.environment["CAMELLIA_APP_SCREEN"] ?? ""
    }

    /// A conversation to open on launch, by id.
    ///
    /// The detail screen is the one screen with no launch value of its own,
    /// because reaching it means tapping a row and a scripted run cannot tap.
    /// It is also the screen the composer lives on, so without this the row of
    /// controls under the input is the one thing that can only be reviewed by
    /// reading it. The id has to be one the list cache already holds, since
    /// there is no desktop here to fetch it from.
    static var conversation: String? {
        let value = ProcessInfo.processInfo.environment["CAMELLIA_APP_CONVERSATION"] ?? ""
        return value.isEmpty ? nil : value
    }
}

/// What shows when the app is not talking to a computer.
///
/// Two different situations, and the screen says which. Normally there is
/// nothing paired and the answer is to pair. But a phone can also hold pairings
/// without any of them being the current computer — adding a second one moves
/// the pointer off the first — and offering "添加电脑" to someone who has a
/// computer already is how a screen becomes a dead end: the pairing they want
/// is one tap away, behind a button that talks about adding another.
struct WelcomeView: View {
    let onPair: () -> Void
    @EnvironmentObject private var model: AppModel

    private var hasPairedComputers: Bool { model.computers.contains { $0.isPaired } }

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "desktopcomputer.and.arrow.down")
                .font(.system(size: 44))
                .foregroundColor(Palette.accent)
            Text(LocalizedStringKey(hasPairedComputers ? "还没有选好电脑" : "还没有连接电脑"))
                .font(.headline)
            Text(LocalizedStringKey(hasPairedComputers
                 ? (UIDevice.current.userInterfaceIdiom == .pad
                     ? "这台平板已经配对上电脑，但当前没有选中哪一台。打开电脑列表选一台，就能查看和继续它的会话。"
                     : "这台手机已经配对上电脑，但当前没有选中哪一台。打开电脑列表选一台，就能查看和继续它的会话。")
                 : (UIDevice.current.userInterfaceIdiom == .pad
                     ? "在电脑端的 Camellia 里生成配对码，然后用平板扫码或手动填写，即可在平板上查看和继续会话。"
                     : "在电脑端的 Camellia 里生成配对码，然后用手机扫码或手动填写，即可在手机上查看和继续会话。")))
                .font(.subheadline)
                .foregroundColor(Palette.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            CapsuleButton(title: hasPairedComputers ? "选择电脑" : "添加电脑",
                          systemImage: hasPairedComputers ? "desktopcomputer" : "plus",
                          action: onPair)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.grouped.ignoresSafeArea())
    }
}
