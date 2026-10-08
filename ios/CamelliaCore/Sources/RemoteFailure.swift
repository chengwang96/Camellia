import Foundation

/// How a remote call failed, as reported to the person holding the phone.
///
/// Ported from `RemoteApi.failureMessage` and `ConnectionFailure`. The two
/// files answer different questions and the split is kept:
///
/// * the desktop answered with an HTTP status, so the status explains it
/// * the tunnel or the local node failed before an answer arrived, so the
///   `CAMELLIA_*` code the Go bridge raises explains it
public enum RemoteFailure {
    /// The message shown for an HTTP status the desktop returned.
    public static func httpMessage(status: Int, detail: String, chinese: Bool) -> String {
        let message: String
        switch status {
        case 401:
            message = chinese ? "电脑配对凭据无效或已撤销，请重新配对。" : "Computer pairing is invalid or revoked. Pair again."
        case 403:
            message = chinese ? "电脑拒绝访问，请检查设备权限和工作区授权。" : "Desktop denied access. Check device and workspace permissions."
        case 404:
            message = chinese ? "会话或接口不可用，请确认授权并更新电脑端。" : "Conversation or endpoint unavailable. Check authorization and update the desktop."
        case 409:
            message = chinese ? "会话状态已变化，请刷新核对后再操作。" : "Conversation state changed. Refresh and check before operating."
        case 429:
            message = chinese ? "请求过于频繁，请一分钟后重试。" : "Too many requests. Retry in one minute."
        case 502, 503, 504:
            message = chinese ? "已到达远程网关，但电脑服务暂不可用，请检查电脑端。" : "Remote gateway reached, but desktop service is unavailable. Check the desktop app."
        default:
            message = chinese ? "电脑返回请求错误，请刷新；持续失败请检查电脑端。" : "Desktop returned a request error. Refresh; check the desktop if it persists."
        }
        let cleaned = Redaction.clean(detail)
        return message + " [HTTP \(status)]" + (cleaned.isEmpty ? "" : "\n" + (chinese ? "电脑返回详情：" : "Desktop detail: ") + cleaned)
    }
}

/// The failure codes the embedded network bridge raises.
///
/// Ported from `ConnectionFailure.Code`; raw values match the Android enum names
/// because the Go bridge writes them into `CAMELLIA_<CODE>` messages.
public enum ConnectionFailureCode: String, CaseIterable, Sendable {
    case offline = "OFFLINE"
    case loginRequired = "LOGIN_REQUIRED"
    case deviceApprovalRequired = "DEVICE_APPROVAL_REQUIRED"
    case networkStopped = "NETWORK_STOPPED"
    case networkStarting = "NETWORK_STARTING"
    case connectTimeout = "CONNECT_TIMEOUT"
    case responseTimeout = "RESPONSE_TIMEOUT"
    case readTimeout = "READ_TIMEOUT"
    case timeout = "TIMEOUT"
    case connectionRefused = "CONNECTION_REFUSED"
    case networkUnreachable = "NETWORK_UNREACHABLE"
    case cancelled = "CANCELLED"
    case protocolError = "PROTOCOL_ERROR"
    case invalidCredential = "INVALID_CREDENTIAL"
    case networkStartFailed = "NETWORK_START_FAILED"
    case connectionFailed = "CONNECTION_FAILED"
    case streamClosed = "STREAM_CLOSED"
}

extension ConnectionFailureCode {
    /// Reads the code out of a `CAMELLIA_<CODE>` message, as the bridge emits it.
    public static func parse(_ message: String) -> ConnectionFailureCode? {
        let prefix = "CAMELLIA_"
        guard message.hasPrefix(prefix) else { return nil }
        return ConnectionFailureCode(rawValue: String(message.dropFirst(prefix.count)))
    }

    /// Builds the message the bridge would raise for this code.
    public static func message(for code: ConnectionFailureCode) -> String {
        "CAMELLIA_" + code.rawValue
    }

    /// Classifies a bridge failure. `online` is the state of the local node.
    public static func classify(message: String?, online: Bool) -> ConnectionFailureCode {
        guard online else { return .offline }
        guard let message else { return .streamClosed }
        if let code = parse(message) { return code }
        switch message {
        case "Unsupported protocol", "Invalid JSON", "Invalid snapshot",
             "Unexpected content type", "Unexpected event stream", "Unexpected stream type":
            return .protocolError
        case "Invalid credential", "Invalid device credential":
            return .invalidCredential
        case "Cancelled", "embedded network closed", "embedded request closed or already started":
            return .cancelled
        default:
            return .connectionFailed
        }
    }

    /// The explanation shown to the user, with the code appended.
    public func text(chinese: Bool) -> String { Self.text(for: self, chinese: chinese) }

    public static func text(for code: ConnectionFailureCode, chinese: Bool) -> String {
        let message: String
        switch code {
        case .offline:
            message = chinese ? "手机当前没有可用网络，请连接 Wi-Fi 或开启移动数据。" : "No phone network. Connect Wi-Fi or enable mobile data."
        case .loginRequired:
            message = chinese ? "内置网络未登录或登录已失效，请到内置网络设置重新登录；无需先删除电脑配对。" : "Embedded network sign-in is required or expired. Sign in in network settings; keep your computer pairing."
        case .deviceApprovalRequired:
            message = chinese ? "网络设备等待管理员批准，请在 Tailscale 管理后台批准手机节点。" : "The phone node needs approval in the Tailscale admin console."
        case .networkStopped:
            message = chinese ? "内置网络已停止，请在网络设置重新启用。" : "Embedded network is stopped. Enable it in network settings."
        case .networkStarting:
            message = chinese ? "内置网络尚未就绪，请稍后刷新；持续失败请检查网络登录状态。" : "Embedded network is not ready. Refresh shortly; check sign-in if this persists."
        case .connectTimeout:
            message = chinese ? "连接电脑超时，隧道尚未建立。请检查电脑在线状态及两端 Tailscale 网络。" : "Connection to the computer timed out before the tunnel connected. Check the computer and both Tailscale nodes."
        case .responseTimeout:
            message = chinese ? "已建立连接，但电脑未及时返回响应头。请检查电脑端运行状态后重试。" : "Connected, but the computer did not return response headers in time. Check the desktop app and retry."
        case .readTimeout:
            message = chinese ? "接收数据超时，连接可能已中断。请检查网络后重试。" : "Timed out receiving data. Check the network and retry."
        case .timeout:
            message = chinese ? "网络请求超时，请检查手机网络和电脑在线状态后重试。" : "Network request timed out. Check the phone network and computer, then retry."
        case .connectionRefused:
            message = chinese ? "目标拒绝连接，请确认电脑端已开启手机访问，地址和端口正确。" : "Connection refused. Enable mobile access on the computer and verify the address and port."
        case .networkUnreachable:
            message = chinese ? "无法到达目标网络，请检查两端 Tailscale 连接和网络访问规则。" : "Target network is unreachable. Check both Tailscale connections and access rules."
        case .cancelled:
            message = chinese ? "连接已取消或因网络切换关闭，请等待重连或刷新。" : "Connection cancelled or closed during a network change. Wait for reconnection or refresh."
        case .protocolError:
            message = chinese ? "电脑响应格式或协议不兼容，请更新并重启电脑端。" : "Incompatible desktop response or protocol. Update and restart the desktop app."
        case .invalidCredential:
            message = chinese ? "本地配对凭据格式无效，请重新配对电脑。" : "Invalid local pairing credential. Pair with the computer again."
        case .networkStartFailed:
            message = chinese ? "手机内置网络启动失败，请重新打开 App；持续失败请检查网络设置。" : "The phone's embedded network failed to start. Reopen the app; check network settings if this persists."
        case .streamClosed:
            message = chinese ? "实时连接已关闭，正在恢复同步。" : "Live connection closed. Restoring sync."
        case .connectionFailed:
            message = chinese ? "连接未完成，暂不能确定原因。请检查电脑端手机访问和两端网络；不要先删除配对。" : "Connection failed for an undetermined reason. Check desktop mobile access and both networks; keep your pairing."
        }
        return message + " [" + code.rawValue + "]"
    }
}

/// The pairing credential shapes the gateway accepts.
public enum Credential {
    /// A device token is forty-three characters of base64url.
    public static let deviceTokenLength = 43

    public static func isDeviceToken(_ value: String) -> Bool {
        value.count == deviceTokenLength
            && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}

/// A failure the desktop answered with, rather than one that happened on the
/// way there.
///
/// The distinction decides whether pairing survives. A 401 means the desktop
/// revoked this device and the local token has to go; a tunnel failure says
/// nothing about the pairing and must not delete it. Anything that can raise
/// either kind — the pairing flow above all — asks for this protocol first.
public protocol RemoteHttpError: Error {
    var status: Int { get }
    var detail: String { get }
}
