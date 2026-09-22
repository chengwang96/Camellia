package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

public class ComposerInputTest extends InstrumentationTestCase {
    public void testEnterModesAndImePaths() throws Exception {
        var context = getInstrumentation().getTargetContext();
        String previous = MobilePreferences.get(context, "enterMode");
        try {
            getInstrumentation().runOnMainSync(() -> {
                ComposerInput input = new ComposerInput(context);
                input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
                int[] sends = {0}; input.setSendAction(() -> sends[0]++);
                InputConnection connection = input.onCreateInputConnection(new EditorInfo()); assertNotNull(connection);
                for (String mode : new String[]{"system", "send", "newline", "button"}) {
                    MobilePreferences.set(context, "enterMode", mode);
                    boolean shortSends = mode.equals("send") || mode.equals("system");
                    boolean holdSends = mode.equals("newline");
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    press(connection, false);
                    assertEquals(shortSends ? 1 : 0, sends[0]);
                    assertEquals(shortSends ? "draft" : "draft\n", input.getText().toString());
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    press(connection, true);
                    assertEquals(holdSends ? 1 : 0, sends[0]);
                    assertEquals(holdSends ? "draft" : "draft\n", input.getText().toString());
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    connection.commitText("\n", 1);
                    assertEquals(shortSends ? 1 : 0, sends[0]);
                    sends[0] = 0; connection.performEditorAction(EditorInfo.IME_ACTION_SEND);
                    assertEquals(shortSends ? 1 : 0, sends[0]);
                    sends[0] = 0; connection.commitText("pasted\ntext", 1);
                    assertEquals(0, sends[0]); assertTrue(input.getText().toString().contains("pasted\ntext"));
                }
                MobilePreferences.set(context, "enterMode", "send");
                input.setText("draft"); sends[0] = 0;
                input.onKeyDown(KeyEvent.KEYCODE_ENTER, new KeyEvent(100, 100, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
                assertEquals(0, sends[0]);
                input.onKeyUp(KeyEvent.KEYCODE_ENTER, new KeyEvent(100, 120, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
                assertEquals(1, sends[0]);
                input.setEnabled(false); sends[0] = 0; press(connection, false); assertEquals(0, sends[0]);
            });
        } finally { MobilePreferences.set(context, "enterMode", previous); }
    }

    private void press(InputConnection connection, boolean hold) {
        connection.sendKeyEvent(new KeyEvent(100, 100, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
        if (hold) {
            connection.sendKeyEvent(new KeyEvent(100, 1100, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 1));
            connection.sendKeyEvent(new KeyEvent(100, 1200, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 2));
        }
        connection.sendKeyEvent(new KeyEvent(100, hold ? 1300 : 120, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
    }
}
