package app.camellia.mobile;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

final class ConnectionFailure {
    enum Code {
        OFFLINE, LOGIN_REQUIRED, DEVICE_APPROVAL_REQUIRED, NETWORK_STOPPED, NETWORK_STARTING,
        CONNECT_TIMEOUT, RESPONSE_TIMEOUT, READ_TIMEOUT, TIMEOUT, CONNECTION_REFUSED, NETWORK_UNREACHABLE,
        CANCELLED, PROTOCOL_ERROR, INVALID_CREDENTIAL, NETWORK_START_FAILED, CONNECTION_FAILED, STREAM_CLOSED
    }

    static Code classify(Throwable error, boolean online) {
        if (!online) return Code.OFFLINE;
        int depth = 0;
        for (Throwable cause = error; cause != null && depth++ < 16; cause = cause.getCause()) {
            String message = cause.getMessage();
            if (message != null && message.startsWith("CAMELLIA_")) {
                try { return Code.valueOf(message.substring("CAMELLIA_".length())); }
                catch (IllegalArgumentException ignored) { }
            }
            if (cause instanceof SocketTimeoutException) return Code.TIMEOUT;
            if (cause instanceof NoRouteToHostException || cause instanceof UnknownHostException) return Code.NETWORK_UNREACHABLE;
            if (cause instanceof ConnectException) return Code.CONNECTION_FAILED;
            if ("Unsupported protocol".equals(message) || "Invalid JSON".equals(message) || "Invalid snapshot".equals(message)
                    || "Unexpected content type".equals(message) || "Unexpected event stream".equals(message)
                    || "Unexpected stream type".equals(message)) return Code.PROTOCOL_ERROR;
            if ("Invalid credential".equals(message) || "Invalid device credential".equals(message)) return Code.INVALID_CREDENTIAL;
            if ("Cancelled".equals(message) || "embedded network closed".equals(message)
                    || "embedded request closed or already started".equals(message)) return Code.CANCELLED;
        }
        if (error == null) return Code.STREAM_CLOSED;
        return Code.CONNECTION_FAILED;
    }

    static String message(Throwable error, boolean online, boolean chinese) {
        Code code = classify(error, online);
        String text = switch (code) {
            case OFFLINE -> chinese ? "手机当前没有可用网络，请连接 Wi-Fi 或开启移动数据。" : "No phone network. Connect Wi-Fi or enable mobile data.";
            case LOGIN_REQUIRED -> chinese ? "内置网络未登录或登录已失效，请到内置网络设置重新登录；无需先删除电脑配对。" : "Embedded network sign-in is required or expired. Sign in in network settings; keep your computer pairing.";
            case DEVICE_APPROVAL_REQUIRED -> chinese ? "网络设备等待管理员批准，请在 Tailscale 管理后台批准手机节点。" : "The phone node needs approval in the Tailscale admin console.";
            case NETWORK_STOPPED -> chinese ? "内置网络已停止，请在网络设置重新启用。" : "Embedded network is stopped. Enable it in network settings.";
            case NETWORK_STARTING -> chinese ? "内置网络尚未就绪，请稍后刷新；持续失败请检查网络登录状态。" : "Embedded network is not ready. Refresh shortly; check sign-in if this persists.";
            case CONNECT_TIMEOUT -> chinese ? "连接电脑超时，隧道尚未建立。请检查电脑在线状态及两端 Tailscale 网络。" : "Connection to the computer timed out before the tunnel connected. Check the computer and both Tailscale nodes.";
            case RESPONSE_TIMEOUT -> chinese ? "已建立连接，但电脑未及时返回响应头。请检查电脑端运行状态后重试。" : "Connected, but the computer did not return response headers in time. Check the desktop app and retry.";
            case READ_TIMEOUT -> chinese ? "接收数据超时，连接可能已中断。请检查网络后重试。" : "Timed out receiving data. Check the network and retry.";
            case TIMEOUT -> chinese ? "网络请求超时，请检查手机网络和电脑在线状态后重试。" : "Network request timed out. Check the phone network and computer, then retry.";
            case CONNECTION_REFUSED -> chinese ? "目标拒绝连接，请确认电脑端已开启手机访问，地址和端口正确。" : "Connection refused. Enable mobile access on the computer and verify the address and port.";
            case NETWORK_UNREACHABLE -> chinese ? "无法到达目标网络，请检查两端 Tailscale 连接和网络访问规则。" : "Target network is unreachable. Check both Tailscale connections and access rules.";
            case CANCELLED -> chinese ? "连接已取消或因网络切换关闭，请等待重连或刷新。" : "Connection cancelled or closed during a network change. Wait for reconnection or refresh.";
            case PROTOCOL_ERROR -> chinese ? "电脑响应格式或协议不兼容，请更新并重启电脑端。" : "Incompatible desktop response or protocol. Update and restart the desktop app.";
            case INVALID_CREDENTIAL -> chinese ? "本地配对凭据格式无效，请重新配对电脑。" : "Invalid local pairing credential. Pair with the computer again.";
            case NETWORK_START_FAILED -> chinese ? "手机内置网络启动失败，请重新打开 App；持续失败请检查网络设置。" : "The phone's embedded network failed to start. Reopen the app; check network settings if this persists.";
            case STREAM_CLOSED -> chinese ? "实时连接已关闭，正在恢复同步。" : "Live connection closed. Restoring sync.";
            default -> chinese ? "连接未完成，暂不能确定原因。请检查电脑端手机访问和两端网络；不要先删除配对。" : "Connection failed for an undetermined reason. Check desktop mobile access and both networks; keep your pairing.";
        };
        return text + " [" + code.name() + "]";
    }

    static IOException failure(Code code, Throwable cause) { return new IOException("CAMELLIA_" + code.name(), cause); }
    private ConnectionFailure() {}
}
