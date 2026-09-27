package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.view.KeyEvent;
import android.view.ViewConfiguration;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

public class ComposerInputTest extends InstrumentationTestCase {
    public void testEnterModesAndImePaths() throws Exception {
        var context = getInstrumentation().getTargetContext();
        String previous = MobilePreferences.get(context, "enterMode");
        try {
            getInstrumentation().runOnMainSync(() -> {
                ComposerInput input = new ComposerInput(context);
                input.useMultiLineInput();
                int[] sends = {0}; input.setSendAction(() -> sends[0]++);
                // The keyboard must see a plain text field, otherwise it replaces its send key
                // (and its hold-for-newline gesture) with a plain enter key.
                assertEquals(0, input.getInputType() & android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
                for (String mode : new String[]{"system", "send", "newline", "button"}) {
                    MobilePreferences.set(context, "enterMode", mode);
                    EditorInfo info = new EditorInfo();
                    InputConnection connection = input.onCreateInputConnection(info); assertNotNull(connection);
                    boolean shortSends = mode.equals("send") || mode.equals("system");
                    boolean holdSends = mode.equals("newline");
                    // Short press sends only when the keyboard shows a send key, so a keyboard that
                    // supports holding the send key can insert a newline instead.
                    assertEquals(shortSends ? EditorInfo.IME_ACTION_SEND : EditorInfo.IME_ACTION_NONE,
                        info.imeOptions & EditorInfo.IME_MASK_ACTION);
                    assertEquals(shortSends, (info.imeOptions & EditorInfo.IME_FLAG_NO_ENTER_ACTION) == 0);
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    press(connection, false);
                    assertEquals(shortSends ? 1 : 0, sends[0]);
                    assertEquals(shortSends ? "draft" : "draft\n", input.getText().toString());
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    press(connection, true);
                    assertEquals(holdSends ? 1 : 0, sends[0]);
                    assertEquals(holdSends ? "draft" : "draft\n", input.getText().toString());
                    // The keyboard's send action is the send key of every mode that allows sending.
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    connection.performEditorAction(EditorInfo.IME_ACTION_SEND);
                    assertEquals(mode.equals("button") ? 0 : 1, sends[0]);
                    assertEquals(mode.equals("button") ? "draft\n" : "draft", input.getText().toString());
                    // A keyboard without an action for this field inserts a line break instead.
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    connection.performEditorAction(EditorInfo.IME_ACTION_NONE);
                    assertEquals(0, sends[0]);
                    assertEquals("draft\n", input.getText().toString());
                    // A hold with bogus event timestamps still counts when the press arrival is old.
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    connection.sendKeyEvent(new KeyEvent(100, 100, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
                    android.os.SystemClock.sleep(ViewConfiguration.getLongPressTimeout() + 100);
                    connection.sendKeyEvent(new KeyEvent(100, 100, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
                    assertEquals(holdSends ? 1 : 0, sends[0]);
                    assertEquals(holdSends ? "draft" : "draft\n", input.getText().toString());
                    // A committed newline is a line break, never a send.
                    input.setText("draft"); input.setSelection(5); sends[0] = 0;
                    connection.commitText("\n", 1);
                    assertEquals(0, sends[0]);
                    assertEquals("draft\n", input.getText().toString());
                    sends[0] = 0; connection.commitText("pasted\ntext", 1);
                    assertEquals(0, sends[0]); assertTrue(input.getText().toString().contains("pasted\ntext"));
                }
                MobilePreferences.set(context, "enterMode", "send");
                InputConnection connection = input.onCreateInputConnection(new EditorInfo()); assertNotNull(connection);
                input.setText("draft"); sends[0] = 0;
                input.onKeyDown(KeyEvent.KEYCODE_ENTER, new KeyEvent(100, 100, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
                assertEquals(0, sends[0]);
                input.onKeyUp(KeyEvent.KEYCODE_ENTER, new KeyEvent(100, 120, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
                assertEquals(1, sends[0]);
                input.setEnabled(false); sends[0] = 0; press(connection, false); assertEquals(0, sends[0]);
                connection.commitText("\n", 1);
                assertEquals(0, sends[0]); assertEquals("draft", input.getText().toString());
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

    // The keyboard-visible input type stays single-line so keyboards keep their send key, while the
    // composer itself still wraps newlines over several lines.
    public void testMultiLineDisplayWithKeyboardSendKey() throws Exception {
        var context = getInstrumentation().getTargetContext();
        getInstrumentation().runOnMainSync(() -> {
            ComposerInput input = new ComposerInput(context);
            input.setLayoutParams(new android.widget.FrameLayout.LayoutParams(600, -2));
            input.useMultiLineInput();
            assertEquals(0, input.getInputType() & android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
            assertNull(input.getTransformationMethod());
            input.setText("first\nsecond");
            input.measure(android.view.View.MeasureSpec.makeMeasureSpec(600, android.view.View.MeasureSpec.AT_MOST),
                android.view.View.MeasureSpec.makeMeasureSpec(2000, android.view.View.MeasureSpec.AT_MOST));
            input.layout(0, 0, input.getMeasuredWidth(), input.getMeasuredHeight());
            assertEquals(2, input.getLineCount());
        });
    }
}
