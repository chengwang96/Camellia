package app.camellia.mobile;

import android.app.AlertDialog;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

/** A preview never uses a credit. Only the explicit positive action can do so. */
final class RemoteCodexResetDialog {
    private static String tr(boolean chinese, String zh, String en) { return chinese ? zh : en; }

    static AlertDialog show(Context context, boolean chinese, JSONObject preview, Runnable consume) {
        JSONObject account = preview.optJSONObject("account"), credits = preview.optJSONObject("credits");
        StringBuilder text = new StringBuilder(account == null ? "" : account.optString("email"));
        if (credits == null) text.append(tr(chinese, "\n重置卡信息暂不可用，请稍后重试。", "\nReset credit information is unavailable. Try again later."));
        else text.append("\n").append(tr(chinese, "可用重置卡：", "Reset credits available: ")).append(credits.optInt("availableCount"));
        long expiry = 0;
        JSONArray details = credits == null ? null : credits.optJSONArray("credits");
        for (int index = 0; details != null && index < details.length(); index++) {
            JSONObject credit = details.optJSONObject(index);
            if (credit == null || !credit.optString("status").equals("available") || !credit.optString("resetType").equals("codexRateLimits")) continue;
            long at = credit.optLong("expiresAt");
            if (at * 1000 > System.currentTimeMillis() && (expiry == 0 || at < expiry)) expiry = at;
        }
        if (expiry > 0) text.append(tr(chinese, "\n最早到期：", "\nEarliest expiry: ")).append(
            java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT,
                chinese ? java.util.Locale.SIMPLIFIED_CHINESE : java.util.Locale.ENGLISH).format(new java.util.Date(expiry * 1000)));
        boolean retry = preview.optBoolean("retry"), canConsume = !preview.optString("confirmationToken").isEmpty();
        text.append(retry
            ? tr(chinese, "\n\n上次结果未确认。重试将核对同一请求，不会新建重置请求。", "\n\nThe previous result is unknown. Retry checks the same reset request.")
            : canConsume ? tr(chinese, "\n\n确认后将消耗该电脑账号的一张官方重置卡。", "\n\nConfirm to use one official reset credit on this computer's account.")
            : credits != null && credits.optInt("availableCount") == 0 ? tr(chinese, "\n\n该账号没有可用重置卡。", "\n\nNo reset credits are available for this account.") : "");
        CamelliaDialog.Builder builder = new CamelliaDialog.Builder(context)
            .setTitle(tr(chinese, "重置 Codex 额度", "Reset Codex usage")).setMessage(text.toString())
            .setNegativeButton(tr(chinese, "取消", "Cancel"), null);
        if (canConsume) builder.setPositiveButton(retry ? tr(chinese, "重试同一请求", "Retry this reset request")
            : tr(chinese, "确认使用一张", "Confirm and use one credit"), (dialog, which) -> consume.run());
        return builder.show();
    }

    static String outcome(boolean chinese, String outcome) {
        switch (outcome) {
            case "reset": return tr(chinese, "Codex 额度已重置，可以继续发送消息。", "Codex usage reset. You can send your message again.");
            case "alreadyRedeemed": return tr(chinese, "该重置请求已完成。", "This reset request was already completed.");
            case "nothingToReset": return tr(chinese, "当前没有可重置的额度。", "There is no eligible usage to reset.");
            case "noCredit": return tr(chinese, "该账号没有可用重置卡。", "No reset credits are available for this account.");
            default: return tr(chinese, "重置结果未确认，请重新打开重置卡核对同一请求。", "Reset result unknown. Open reset credits again to check the same request.");
        }
    }
}
