package app.camellia.mobile;

import android.content.Context;
import android.widget.EditText;
import android.widget.LinearLayout;

/** Retained editors keep logical focus while rotation and IME bounds settle. */
final class EditorLayout extends LinearLayout {
    EditorLayout(Context context) { super(context); }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        var focused = findFocus();
        EditText editor = focused instanceof EditText ? (EditText) focused : null;
        int start = editor == null ? -1 : editor.getSelectionStart(), end = editor == null ? -1 : editor.getSelectionEnd();
        super.onLayout(changed, left, top, right, bottom);
        if (editor != null && editor.isShown() && editor.isEnabled()) {
            if (!editor.hasFocus()) editor.requestFocus();
            if (start >= 0 && end >= 0) editor.setSelection(Math.min(start, editor.length()), Math.min(end, editor.length()));
        }
    }
}
