package app.camellia.mobile;

import android.content.Context;
import android.text.Editable;
import android.view.KeyEvent;
import android.view.ViewConfiguration;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.widget.EditText;

final class ComposerInput extends EditText {
    private Runnable send;
    private boolean enterDown, held;

    ComposerInput(Context context) { super(context); }

    void setSendAction(Runnable action) { send = action; }

    private void enter(boolean longPress) {
        if (!isEnabled()) return;
        String mode = MobilePreferences.enterMode(getContext());
        boolean sends = !mode.equals("button") && (mode.equals("send") != longPress);
        if (sends) { if (send != null) send.run(); }
        else {
            Editable text = getText();
            int start = Math.max(0, getSelectionStart()), end = Math.max(0, getSelectionEnd());
            text.replace(Math.min(start, end), Math.max(start, end), "\n");
        }
    }

    private boolean handleEnter(KeyEvent event) {
        if (event.getKeyCode() != KeyEvent.KEYCODE_ENTER && event.getKeyCode() != KeyEvent.KEYCODE_NUMPAD_ENTER) return false;
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (!enterDown) { enterDown = true; held = false; }
            held |= event.isLongPress() || event.getRepeatCount() > 0;
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_UP) {
            boolean perform = enterDown && !event.isCanceled();
            boolean longPress = held || event.getEventTime() - event.getDownTime() >= ViewConfiguration.getLongPressTimeout();
            enterDown = false; held = false;
            if (perform) enter(longPress);
            return true;
        }
        return true;
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
        return new InputConnectionWrapper(connection, false) {
            @Override public boolean sendKeyEvent(KeyEvent event) {
                return handleEnter(event) || super.sendKeyEvent(event);
            }
            @Override public boolean commitText(CharSequence text, int newCursorPosition) {
                if ("\n".contentEquals(text)) { enter(false); return true; }
                return super.commitText(text, newCursorPosition);
            }
            @Override public boolean performEditorAction(int action) {
                if (action == EditorInfo.IME_ACTION_SEND || action == EditorInfo.IME_ACTION_DONE
                        || action == EditorInfo.IME_ACTION_UNSPECIFIED) {
                    enter(false); return true;
                }
                return super.performEditorAction(action);
            }
        };
    }
}
