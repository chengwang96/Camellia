package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

/** Replays the delayed composing-word commit sent by an IME during rotation. */
public class EditorInputTest extends InstrumentationTestCase {
    private MainActivity activity;

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false); new CredentialStore(context).clear();
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        NativeActivityCleanup.finish(getInstrumentation(), activity); super.tearDown();
    }

    public void testFinishingAnUnchangedComposingWordPreservesTheCaretAndNormalCommits() throws Throwable {
        Throwable[] failure = {null};
        getInstrumentation().runOnMainSync(() -> { try {
            EditorInput editor = new EditorInput(activity); activity.setContentView(editor); editor.requestFocus();
            InputConnection connection = editor.onCreateInputConnection(new EditorInfo()); assertNotNull(connection);
            compose(editor, connection, "abxef", 3);
            connection.commitText("abxef", 1);
            assertEquals("abxef", editor.getText().toString());
            assertEquals("Finalizing the existing word must retain a caret inside that word", 3, editor.getSelectionStart());

            compose(editor, connection, "你好世界", 2); connection.commitText("你好世界", 1);
            assertEquals(2, editor.getSelectionStart());
            compose(editor, connection, "abxef", 3); connection.commitText("updated", 1);
            assertEquals("updated", editor.getText().toString()); assertEquals(7, editor.getSelectionStart());
            compose(editor, connection, "abxef", 3); editor.setSelection(0, 5); connection.commitText("abxef", 1);
            assertEquals("An explicit selected-word replacement still collapses its selection", 5, editor.getSelectionStart());
            compose(editor, connection, "abxef", 3); connection.commitText("abxef", 0);
            assertEquals("Explicit cursor-position commands must be honoured", 0, editor.getSelectionStart());
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                compose(editor, connection, "abxef", 3);
                connection.commitText("abxef", 1, new android.view.inputmethod.TextAttribute.Builder().build());
                assertEquals("The attributed IME API must retain the same behaviour", 3, editor.getSelectionStart());
            }
        } catch (Throwable error) { failure[0] = error; } });
        if (failure[0] != null) throw failure[0];
    }

    private void compose(EditorInput editor, InputConnection connection, String text, int cursor) {
        editor.setText(text); editor.setSelection(cursor); assertTrue(connection.setComposingRegion(0, text.length()));
    }
}
