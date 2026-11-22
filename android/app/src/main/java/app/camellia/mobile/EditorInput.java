package app.camellia.mobile;

import android.content.Context;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.widget.EditText;

/** Keeps a replacement editor's first IME connection consistent with its restored cursor. */
class EditorInput extends EditText {
    private String restoreText;
    private int restoreStart, restoreEnd;

    EditorInput(Context context) { super(context); }

    @Override protected void onFocusChanged(boolean focused, int direction, android.graphics.Rect previous) {
        super.onFocusChanged(focused, direction, previous);
        if (focused) EditorFocusState.watch(this);
    }

    void prepareSelectionRestore(int start, int end) {
        restoreText = getText().toString(); restoreStart = start; restoreEnd = end;
        applyRestoredSelection();
    }

    private void applyRestoredSelection() {
        int length = length();
        setSelection(Math.max(0, Math.min(restoreStart, length)), Math.max(0, Math.min(restoreEnd, length)));
    }

    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        boolean restoring = restoreText != null && restoreText.equals(getText().toString());
        if (restoring) applyRestoredSelection();
        InputConnection connection = super.onCreateInputConnection(info);
        if (restoring && connection != null) {
            applyRestoredSelection();
            info.initialSelStart = getSelectionStart(); info.initialSelEnd = getSelectionEnd();
        }
        if (connection != null) restoreText = null;
        if (connection == null) return null;
        return android.os.Build.VERSION.SDK_INT >= 33 ? new AttributeConnection(connection) : new CursorConnection(connection);
    }

    private CommitCursor cursorForUnchangedWord(CharSequence text, int cursorPosition) {
        if (text == null || cursorPosition != 1 || getSelectionStart() != getSelectionEnd()) return null;
        int cursor = getSelectionStart(), wordStart = BaseInputConnection.getComposingSpanStart(getText());
        int wordEnd = BaseInputConnection.getComposingSpanEnd(getText());
        if (wordStart < 0 || cursor < wordStart || cursor >= wordEnd || text.length() != wordEnd - wordStart) return null;
        String word = text.toString();
        return matchesWord(wordStart, word) ? new CommitCursor(cursor, length(), wordStart, word) : null;
    }

    private boolean matchesWord(int start, String word) {
        if (start < 0 || start + word.length() > length()) return false;
        for (int index = 0; index < word.length(); index++) if (getText().charAt(start + index) != word.charAt(index)) return false;
        return true;
    }

    private void restoreCommitCursor(CommitCursor before) {
        if (before != null && length() == before.length && matchesWord(before.wordStart, before.word)) setSelection(before.cursor);
    }

    private static final class CommitCursor {
        final int cursor, length, wordStart; final String word;
        CommitCursor(int cursor, int length, int wordStart, String word) {
            this.cursor = cursor; this.length = length; this.wordStart = wordStart; this.word = word;
        }
    }

    private class CursorConnection extends InputConnectionWrapper {
        CursorConnection(InputConnection target) { super(target, false); }
        @Override public boolean commitText(CharSequence text, int cursorPosition) {
            // IMEs finalize a composing word during rotation. Recommitting the
            // same word must not move an existing caret from its middle to its end.
            CommitCursor before = cursorForUnchangedWord(text, cursorPosition);
            boolean result = super.commitText(text, cursorPosition); restoreCommitCursor(before); return result;
        }
    }

    @android.annotation.TargetApi(33)
    private final class AttributeConnection extends CursorConnection {
        AttributeConnection(InputConnection target) { super(target); }
        @Override public boolean commitText(CharSequence text, int cursorPosition, android.view.inputmethod.TextAttribute attributes) {
            CommitCursor before = cursorForUnchangedWord(text, cursorPosition);
            boolean result = super.commitText(text, cursorPosition, attributes); restoreCommitCursor(before); return result;
        }
    }
}
