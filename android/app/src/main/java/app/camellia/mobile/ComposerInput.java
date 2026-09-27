package app.camellia.mobile;

import android.content.Context;
import android.os.SystemClock;
import android.text.Editable;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.ViewConfiguration;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.widget.EditText;

final class ComposerInput extends EditText {
    private Runnable send;
    private boolean enterDown, held;
    private long enterDownAt;

    ComposerInput(Context context) { super(context); }

    void setSendAction(Runnable action) { send = action; }

    // Keyboards choose between their send key and a plain enter key from the editor info they are
    // handed. Flagging the editor as multi-line makes TextView add IME_FLAG_NO_ENTER_ACTION, which
    // turns the keyboard's send key back into a plain enter key and also takes away its own
    // hold-for-newline gesture, so let the keyboard see a plain text field and keep the multi-line
    // display on our side: committed and held newlines still wrap here because the view stays
    // non-single-line and only the editor info drops the multi-line flag.
    void useMultiLineInput() {
        setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
            | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        setRawInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
    }

    private String enterMode() { return MobilePreferences.enterMode(getContext()); }

    private void insertNewline() {
        Editable text = getText();
        if (text == null) return;
        int start = Math.max(0, getSelectionStart()), end = Math.max(0, getSelectionEnd());
        text.replace(Math.min(start, end), Math.max(start, end), "\n");
    }

    // The keyboard invoked its send/confirm function. Send-button-only mode keeps the keyboard
    // from sending; every other mode honours it, including keyboards that report a long press as
    // an editor action instead of key events.
    private void sendFromKeyboard() {
        if (!isEnabled()) return;
        if (enterMode().equals("button")) { insertNewline(); return; }
        if (send != null) send.run();
    }

    private void enter(boolean longPress) {
        if (!isEnabled()) return;
        String mode = enterMode();
        boolean sends = !mode.equals("button") && (mode.equals("send") != longPress);
        if (sends) { if (send != null) send.run(); }
        else insertNewline();
    }

    private boolean handleEnter(KeyEvent event) {
        int keyCode = event.getKeyCode();
        if (keyCode != KeyEvent.KEYCODE_ENTER && keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) return false;
        int action = event.getAction();
        if (action != KeyEvent.ACTION_DOWN && action != KeyEvent.ACTION_UP) return false;
        if (action == KeyEvent.ACTION_DOWN) {
            if (!enterDown) { enterDown = true; held = false; enterDownAt = SystemClock.uptimeMillis(); }
            held |= event.isLongPress() || event.getRepeatCount() > 0;
            return true;
        }
        held |= event.isLongPress();
        boolean perform = enterDown && !event.isCanceled();
        long eventHeld = event.getDownTime() > 0 && event.getDownTime() <= event.getEventTime()
            ? event.getEventTime() - event.getDownTime() : 0;
        long arrivalHeld = enterDown ? SystemClock.uptimeMillis() - enterDownAt : 0;
        boolean longPress = held || eventHeld >= ViewConfiguration.getLongPressTimeout()
            || arrivalHeld >= ViewConfiguration.getLongPressTimeout();
        enterDown = false; held = false;
        if (perform) enter(longPress);
        return true;
    }

    // A multi-line editor normally forces a plain enter key. Declare the action that matches the
    // chosen mode so the keyboard labels the key correctly and offers its own hold-for-newline
    // gesture: keyboards only provide that gesture while they show a send key.
    private void applyEnterOptions(EditorInfo info) {
        info.imeOptions &= ~(EditorInfo.IME_MASK_ACTION | EditorInfo.IME_FLAG_NO_ENTER_ACTION
            | EditorInfo.IME_FLAG_NAVIGATE_NEXT | EditorInfo.IME_FLAG_NAVIGATE_PREVIOUS);
        if (enterMode().equals("send")) info.imeOptions |= EditorInfo.IME_ACTION_SEND;
        else info.imeOptions |= EditorInfo.IME_ACTION_NONE | EditorInfo.IME_FLAG_NO_ENTER_ACTION;
    }

    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        return handleEnter(event) || super.onKeyDown(keyCode, event);
    }

    @Override public boolean onKeyUp(int keyCode, KeyEvent event) {
        return handleEnter(event) || super.onKeyUp(keyCode, event);
    }

    @Override protected void onFocusChanged(boolean focused, int direction, android.graphics.Rect previous) {
        enterDown = false; held = false;
        super.onFocusChanged(focused, direction, previous);
    }

    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        InputConnection connection = super.onCreateInputConnection(info);
        if (connection == null) return null;
        applyEnterOptions(info);
        return new InputConnectionWrapper(connection, false) {
            @Override public boolean sendKeyEvent(KeyEvent event) {
                return handleEnter(event) || super.sendKeyEvent(event);
            }
            @Override public boolean commitText(CharSequence text, int newCursorPosition) {
                // A committed newline is the keyboard inserting a line break, for example the
                // hold-for-newline gesture of a send key; it never means "send the draft".
                boolean newline = "\n".contentEquals(text);
                if (newline && !isEnabled()) return true;
                return super.commitText(text, newCursorPosition);
            }
            @Override public boolean performEditorAction(int action) {
                // IME_ACTION_NONE means the keyboard has no action for this field, which for a
                // multi-line editor is a plain enter key: insert a line break instead of sending.
                if (action == EditorInfo.IME_ACTION_NONE) { if (isEnabled()) insertNewline(); return true; }
                if (action == EditorInfo.IME_ACTION_SEND || action == EditorInfo.IME_ACTION_DONE
                        || action == EditorInfo.IME_ACTION_UNSPECIFIED) {
                    sendFromKeyboard(); return true;
                }
                return super.performEditorAction(action);
            }
        };
    }
}
