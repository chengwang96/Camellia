package app.camellia.mobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;

/** Chat alerts are separate from foreground-service and download notifications. */
final class ChatNotifications {
    private static final String PREFIX = "chat-";
    private static ChatNotificationEvents events;
    private static String saved;
    private static int savedRevision;
    private static final java.util.Set<String> posted = new java.util.LinkedHashSet<>();

    static boolean enabled(Context context) { return MobilePreferences.get(context, "chatNotifications").equals("enabled"); }
    static boolean categoryEnabled(Context context, String type) { return !MobilePreferences.get(context, "notify:" + type).equals("disabled"); }
    static boolean allowed(Context context) { return context.getSystemService(NotificationManager.class).areNotificationsEnabled(); }

    private ChatNotificationEvents events(Context context) {
        if (events == null) {
            saved = context.getSharedPreferences("chat-notices", Context.MODE_PRIVATE).getString("events", "{}");
            events = new ChatNotificationEvents(saved);
        }
        return events;
    }

    private void save(Context context) {
        if (savedRevision == events.revision) return;
        savedRevision = events.revision;
        String next = events.serialize();
        if (!next.equals(saved)) {
            saved = next;
            context.getSharedPreferences("chat-notices", Context.MODE_PRIVATE).edit().putString("events", next).apply();
        }
    }

    void conversation(Activity activity, JSONObject credentials, String instance, JSONObject conversation,
            JSONObject live, JSONArray rows, boolean viewing) {
        String id = conversation.optString("id"); if (id.isEmpty()) return;
        String scope = scope(credentials, instance, "conversation", id);
        List<String> fresh = events(activity).conversation(scope, conversation, live, rows);
        save(activity);
        Intent open = new Intent(activity, MainActivity.class).putExtra("noticeAddress", credentials.optString("address"))
            .putExtra("noticeConversation", id);
        for (String type : fresh) show(activity, type, scope, conversation.optString("title"), viewing, open);
    }

    void discussion(Activity activity, JSONObject credentials, String instance, JSONObject group, boolean viewing) {
        String id = group.optString("id"); if (id.isEmpty()) return;
        String scope = scope(credentials, instance, "discussion", id);
        List<String> fresh = events(activity).discussion(scope, group); save(activity);
        Intent open = new Intent(activity, RemoteDiscussionsActivity.class).putExtra("address", credentials.optString("address")).putExtra("groupId", id);
        for (String type : fresh) show(activity, type, scope, group.optString("title"), viewing, open);
    }

    void local(Activity activity, String conversation, long startedAt, String title, String state, boolean viewing) {
        String type = state.equals("complete") ? "reply" : state.equals("error") ? "error" : "";
        if (type.isEmpty()) return;
        String scope = "local:" + conversation;
        boolean fresh = events(activity).claim(scope, type, Long.toString(startedAt)); save(activity);
        if (fresh) show(activity, type, scope, title, viewing, new Intent(activity, LocalChatActivity.class).putExtra("conversationId", conversation));
    }

    private static String scope(JSONObject credentials, String instance, String kind, String id) {
        return new JSONArray().put(credentials.optString("address")).put(credentials.optString("deviceId")).put(instance).put(kind).put(id).toString();
    }

    private static String tr(Context context, String zh, String en) {
        return MobilePreferences.wrap(context).getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? zh : en;
    }

    private void show(Activity activity, String type, String scope, String title, boolean viewing, Intent open) {
        if (!enabled(activity) || !categoryEnabled(activity, type) || !allowed(activity)
                || viewing && !MobilePreferences.get(activity, "notifyForeground").equals("enabled")) return;
        String label = type.equals("approval") ? tr(activity, "等待审批或回答问题", "Approval or answer needed")
            : type.equals("error") ? tr(activity, "执行失败", "Execution failed") : tr(activity, "回复完成", "Reply completed");
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        String channel = PREFIX + type;
        NotificationChannel category = new NotificationChannel(channel, label, NotificationManager.IMPORTANCE_DEFAULT);
        category.enableVibration(true); manager.createNotificationChannel(category);
        String tag = PREFIX + type + ":" + scope;
        open.setData(new Uri.Builder().scheme("camellia").authority("chat-notice").appendPath(type).appendPath(scope).build());
        // MainActivity can safely reuse its existing connection. Local chat and
        // discussions open fresh destination Activities with the requested ID.
        if (open.getComponent().getClassName().equals(MainActivity.class.getName()))
            open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(activity, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            manager.notify(tag, 0, new Notification.Builder(activity, channel).setSmallIcon(R.drawable.ic_connection)
                .setContentTitle(label).setContentText(title.trim().isEmpty() ? "Camellia" : title.substring(0, Math.min(160, title.length())))
                .setContentIntent(content).setAutoCancel(true).setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PRIVATE).build());
            posted.add(tag);
            while (posted.size() > 512) posted.remove(posted.iterator().next());
        } catch (SecurityException ignored) { /* Permission can be revoked between the check and notify. */ }
    }

    static void clear(Context context) { for (String type : new String[]{"reply", "approval", "error"}) clear(context, type); }
    static void clear(Context context, String type) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        var tags = posted.iterator();
        while (tags.hasNext()) {
            String tag = tags.next();
            if (tag.startsWith(PREFIX + type + ":")) { manager.cancel(tag, 0); tags.remove(); }
        }
        for (var active : manager.getActiveNotifications())
            if (active.getTag() != null && active.getTag().startsWith(PREFIX + type + ":")) manager.cancel(active.getTag(), active.getId());
    }
}
