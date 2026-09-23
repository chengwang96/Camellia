package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import org.json.JSONObject;

public class RemoteComposerInputTest extends InstrumentationTestCase {
    private Object field(MainActivity activity, String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true);
        return member.get(activity);
    }

    private void field(MainActivity activity, String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true);
        member.set(activity, value);
    }

    private void refresh(MainActivity activity) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("updateControls");
        method.setAccessible(true);
        method.invoke(activity);
    }

    private void press(InputConnection connection, boolean hold) {
        long down = android.os.SystemClock.uptimeMillis();
        long up = down + (hold ? ViewConfiguration.getLongPressTimeout() + 100 : 10);
        connection.sendKeyEvent(new KeyEvent(down, down, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
        if (hold) connection.sendKeyEvent(new KeyEvent(down, up, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 1));
        connection.sendKeyEvent(new KeyEvent(down, up, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
    }

    public void testRemoteComposerUsesMobileEnterPreferenceAndSendGuards() throws Exception {
        var context = getInstrumentation().getTargetContext();
        String previous = MobilePreferences.get(context, "enterMode");
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field(activity, "conversationId", "12345678-1234-1234-1234-123456789abc");
                    JSONObject credentials = new JSONObject();
                    field(activity, "credentials", credentials);
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen");
                    detail.setAccessible(true);
                    detail.invoke(activity);
                    field(activity, "connected", true);
                    field(activity, "controlAllowed", true);
                    ComposerInput input = (ComposerInput) field(activity, "composer");
                    View send = (View) field(activity, "sendButton");
                    int[] sends = {0};
                    send.setOnClickListener(view -> sends[0]++);
                    InputConnection connection = input.onCreateInputConnection(new EditorInfo());
                    assertNotNull(connection);
                    for (String mode : new String[]{"system", "send", "newline", "button"}) {
                        MobilePreferences.set(context, "enterMode", mode);
                        for (boolean hold : new boolean[]{false, true}) {
                            input.setText("remote draft"); input.setSelection(input.length()); sends[0] = 0;
                            assertTrue(send.isEnabled());
                            press(connection, hold);
                            boolean shouldSend = hold ? mode.equals("newline") : mode.equals("send") || mode.equals("system");
                            assertEquals(shouldSend ? 1 : 0, sends[0]);
                            assertEquals(shouldSend ? "remote draft" : "remote draft\n", input.getText().toString());
                        }
                    }
                    MobilePreferences.set(context, "enterMode", "send");
                    input.setText("remote draft"); sends[0] = 0;
                    connection.commitText("\n", 1);
                    connection.performEditorAction(EditorInfo.IME_ACTION_SEND);
                    assertEquals(2, sends[0]);
                    connection.commitText("pasted\ntext", 1);
                    assertEquals(2, sends[0]);

                    View model = activity.getWindow().getDecorView().findViewWithTag("remoteModelPicker");
                    assertSame(send.getParent(), model.getParent());
                    field(activity, "editingSeq", 7L); refresh(activity);
                    View banner = activity.getWindow().getDecorView().findViewWithTag("composerEditBanner");
                    assertEquals(View.VISIBLE, banner.getVisibility());
                    field(activity, "commandBusy", true); refresh(activity);
                    View cancel = activity.getWindow().getDecorView().findViewWithTag("composerCancelEdit");
                    assertFalse(cancel.isEnabled());
                    field(activity, "commandBusy", false); refresh(activity); cancel.performClick();
                    assertEquals(-1L, field(activity, "editingSeq"));
                    assertEquals("", input.getText().toString());
                    assertEquals(View.GONE, banner.getVisibility());

                    for (String guard : new String[]{"empty", "disconnected", "readonly", "running", "busy", "pending"}) {
                        input.setText(guard.equals("empty") ? "" : "remote draft");
                        field(activity, "connected", !guard.equals("disconnected"));
                        field(activity, "controlAllowed", !guard.equals("readonly"));
                        field(activity, "lastLive", guard.equals("running") ? new JSONObject() : null);
                        field(activity, "commandBusy", guard.equals("busy"));
                        if (guard.equals("pending")) credentials.put("pendingCommand", new JSONObject());
                        refresh(activity); sends[0] = 0;
                        assertFalse(guard, send.isEnabled());
                        String draft = input.getText().toString();
                        press(connection, false);
                        connection.commitText("\n", 1);
                        connection.performEditorAction(EditorInfo.IME_ACTION_SEND);
                        assertEquals(guard, 0, sends[0]);
                        assertEquals(guard, draft, input.getText().toString());
                    }
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            MobilePreferences.set(context, "enterMode", previous);
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
        }
    }
}
