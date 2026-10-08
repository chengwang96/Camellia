import Foundation

/// The settings this phone keeps for itself.
///
/// Ported from `MobilePreferences.java`. None of these are sent to the desktop:
/// they decide how the phone behaves and how it addresses itself, so two phones
/// paired to the same computer can disagree about all of them.
public enum AppLanguage: String, CaseIterable, Sendable {
    case system
    case simplifiedChinese = "zh-CN"
    case english = "en"

    /// The tag handed to `Locale`, which wants BCP-47 rather than the stored value.
    public var tag: String? {
        switch self {
        case .system: return nil
        case .simplifiedChinese: return "zh-Hans"
        case .english: return "en"
        }
    }

    /// How the choice reads in a picker, in the language it names.
    public var label: String {
        switch self {
        case .system: return "跟随系统"
        case .simplifiedChinese: return "简体中文"
        case .english: return "English"
        }
    }
}

public enum AppTheme: String, CaseIterable, Sendable {
    case system
    case light
    case dark

    public var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

/// What the keyboard's return key does in a composer.
public enum EnterMode: String, CaseIterable, Sendable {
    /// Return sends. Android offers hold-for-newline; iOS keyboards do not
    /// share that gesture, so the iOS settings screen explains the difference.
    case send
    /// Return inserts a newline. Android offers hold-for-send.
    case newline
    /// Return always inserts a newline; only the button sends.
    case button

    public var label: String {
        switch self {
        case .send: return "回车发送"
        case .newline: return "回车换行"
        case .button: return "只用按钮发送"
        }
    }
}

/// Where preferences are kept.
///
/// A protocol so the same rules run against `UserDefaults` in the app and
/// against a dictionary in tests and previews.
public protocol PreferenceStore: AnyObject {
    func string(_ key: String) -> String?
    func set(_ value: String?, for key: String)
}

public final class DictionaryPreferenceStore: PreferenceStore {
    private var values: [String: String]

    public init(_ values: [String: String] = [:]) { self.values = values }

    public func string(_ key: String) -> String? { values[key] }

    public func set(_ value: String?, for key: String) { values[key] = value }
}

public final class UserDefaultsPreferenceStore: PreferenceStore {
    private let defaults: UserDefaults

    /// A suite of its own, matching the Android preference file's name, so the
    /// settings do not sit in the same namespace as anything else the app keeps.
    public init(suiteName: String = "mobile-preferences") {
        defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    public func string(_ key: String) -> String? { defaults.string(forKey: key) }

    public func set(_ value: String?, for key: String) { defaults.set(value, forKey: key) }
}

/// Reads and writes the phone's own preferences.
///
/// Every read falls back rather than returning nil, which is what Android does
/// (`get` returns `"system"` and `enterMode` coerces anything unknown to
/// `send`): a preference written by a newer build, or corrupted, must not be
/// able to take the app down.
public final class MobilePreferences {
    private let store: PreferenceStore
    /// The model name used when the user has not chosen one, which is the
    /// device's own name on a real phone. Injected because reading it needs
    /// UIKit, and these rules are checked without it.
    public let modelName: String

    public init(store: PreferenceStore, modelName: String = "iPhone") {
        self.store = store
        self.modelName = modelName
    }

    public var language: AppLanguage {
        get { AppLanguage(rawValue: store.string("language") ?? "") ?? .system }
        set { store.set(newValue.rawValue, for: "language") }
    }

    public var theme: AppTheme {
        get { AppTheme(rawValue: store.string("theme") ?? "") ?? .system }
        set { store.set(newValue.rawValue, for: "theme") }
    }

    public var enterMode: EnterMode {
        get { EnterMode(rawValue: store.string("enterMode") ?? "") ?? .send }
        set { store.set(newValue.rawValue, for: "enterMode") }
    }

    /// Whether to hold the tunnel open for a few minutes after leaving the app.
    public var keepAlive: Bool {
        get { store.string("remoteKeepAlive") == "enabled" }
        set { store.set(newValue ? "enabled" : "disabled", for: "remoteKeepAlive") }
    }

    /// The name this phone offers the desktop when pairing.
    ///
    /// Falls back to the device's model name, then to a literal, so the desktop
    /// always has something to show next to a request.
    public var deviceName: String {
        get {
            let stored = store.string("deviceName").map(ComposerText.androidTrim) ?? ""
            if !stored.isEmpty { return stored }
            let model = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
            return model.isEmpty ? "iPhone" : model
        }
        set { store.set(newValue, for: "deviceName") }
    }

    /// Whether a conversation-list workspace group is folded away.
    ///
    /// Keyed by computer address *and* workspace id, which is exactly how
    /// Android keys its own `collapsed:` entries: one desktop's list layout is
    /// not carried onto another, and a workspace the desktop has since removed
    /// is simply never asked about again rather than lingering as a stale key.
    /// Absent means expanded, matching Android's `getBoolean(..., false)`.
    public func isWorkspaceCollapsed(address: String, workspace: String) -> Bool {
        store.string("collapsed:\(address)/\(workspace)") == "1"
    }

    public func setWorkspace(_ workspace: String, collapsed: Bool, address: String) {
        store.set(collapsed ? "1" : "0", for: "collapsed:\(address)/\(workspace)")
    }

    /// The two settings that change how the whole UI is built.
    ///
    /// Android rebuilds its context when this changes; on iOS it is the value a
    /// root view watches to decide whether to tear down and rebuild its tree.
    public var signature: String { "\(language.rawValue):\(theme.rawValue)" }
}
