package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

public class PendingCommandTest extends InstrumentationTestCase {
    private Object field(Object target, String name) throws Exception {
        var member = target.getClass().getDeclaredField(name);
        member.setAccessible(true);
        return member.get(target);
    }

    public void testPendingReceiptPreservesRequestAndCommandsDoNotWaitForStreams() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        EmbeddedNetwork.setEnabled(false);
        CredentialStore encrypted = new CredentialStore(context);
        encrypted.clear();
        String id = "12345678-1234-1234-1234-123456789abc";
        JSONObject payload = new JSONObject().put("action", "send").put("requestId", java.util.UUID.randomUUID().toString())
            .put("instanceId", "fixture").put("expectedSeq", 3).put("prompt", "Keep this message");
        new ComputerStore(encrypted).save(new JSONObject().put("address", "http://100.80.1.2:43127").put("token", "a".repeat(43))
            .put("pendingCommand", new JSONObject().put("conversationId", id).put("payload", payload)));
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        CountDownLatch release = new CountDownLatch(1);
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var conversation = MainActivity.class.getDeclaredField("conversationId"); conversation.setAccessible(true); conversation.set(activity, id);
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    ((EditText) field(activity, "composer")).setText("Keep this message");
                    var finish = MainActivity.class.getDeclaredMethod("finishCommand", JSONObject.class, JSONObject.class); finish.setAccessible(true);
                    finish.invoke(activity, payload, new JSONObject().put("ok", false).put("state", "pending"));
                    assertEquals(payload.toString(), encrypted.load().getJSONObject("pendingCommand").getJSONObject("payload").toString());
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    apply.invoke(activity, new JSONObject().put("instanceId", "fixture").put("cursor", 1).put("permission", "control")
                        .put("conversation", new JSONObject().put("id", id).put("seq", 3)).put("messages", new JSONArray()).put("nextBefore", JSONObject.NULL));
                    assertFalse(((EditText) field(activity, "composer")).isEnabled());
                    String status = ((TextView) field(activity, "status")).getText().toString();
                    assertTrue(status, status.contains("待确认") || status.contains("awaiting confirmation"));
                    finish.invoke(activity, payload, new JSONObject().put("ok", true).put("state", "accepted"));
                    assertFalse(encrypted.load().has("pendingCommand"));
                    assertEquals("", ((EditText) field(activity, "composer")).getText().toString());
                } catch (Exception error) { throw new AssertionError(error); }
            });
            ExecutorService worker = (ExecutorService) field(activity, "worker");
            CountDownLatch occupied = new CountDownLatch(2), dispatched = new CountDownLatch(1);
            for (int index = 0; index < 2; index++) worker.submit(() -> {
                occupied.countDown();
                try { release.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            assertTrue(occupied.await(5, TimeUnit.SECONDS));
            ((ExecutorService) field(activity, "commandWorker")).submit(dispatched::countDown);
            assertTrue("Commands must not queue behind blocked streams", dispatched.await(2, TimeUnit.SECONDS));
        } finally {
            release.countDown();
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
            encrypted.clear();
        }
    }
}
