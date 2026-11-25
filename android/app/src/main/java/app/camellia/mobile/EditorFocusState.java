package app.camellia.mobile;

import android.graphics.Rect;
import android.app.Activity;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;

/** Transfers an active editor to its replacement when the window layout changes. */
final class EditorFocusState {
    private static final java.util.WeakHashMap<EditText, Boolean> pendingIme = new java.util.WeakHashMap<>();
    private static final java.util.WeakHashMap<View, Boolean> watchedIme = new java.util.WeakHashMap<>();
    private static final java.util.WeakHashMap<View, Boolean> stableIme = new java.util.WeakHashMap<>();
    private static final java.util.WeakHashMap<View, int[]> configurationRevision = new java.util.WeakHashMap<>();
    private final boolean focused, keyboardVisible;
    private final int start, end;
    private final EditText source;
    private final Object tag;

    private EditorFocusState(EditText source, boolean focused, boolean keyboardVisible, int start, int end) {
        this.source = source; this.tag = source == null ? null : source.getTag();
        this.focused = focused; this.keyboardVisible = keyboardVisible; this.start = start; this.end = end;
    }

    static EditorFocusState capture(Activity activity) {
        return capture(activity.getWindow().getDecorView());
    }

    static android.view.Window focusedWindow(Activity activity, android.app.Dialog... dialogs) {
        android.view.Window shown = null;
        for (android.app.Dialog dialog : dialogs) {
            if (dialog == null || !dialog.isShowing() || dialog.getWindow() == null) continue;
            android.view.Window window = dialog.getWindow();
            if (window.getDecorView().hasWindowFocus()) return window;
            if (shown == null) shown = window;
        }
        // Window focus can temporarily disappear before a rotation callback.
        // Prefer the visible form to a background conversation composer then.
        android.app.Dialog registered = DialogWindows.focused(activity);
        if (registered != null) return registered.getWindow();
        return shown == null ? activity.getWindow() : shown;
    }

    static EditorFocusState capture(android.view.Window window) { return capture(window.getDecorView()); }

    static void watch(EditText input) {
        View root = input.getRootView();
        if (watchedIme.put(root, true) != null) return;
        root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            boolean visible = imeVisible(root);
            if (visible || root.hasWindowFocus() && !configurationRevision.containsKey(root)) stableIme.put(root, visible);
        });
    }

    private static EditorFocusState capture(View root) {
        View currentFocus = root.findFocus();
        EditText input = currentFocus instanceof EditText ? (EditText) currentFocus : null;
        if (input == null) return new EditorFocusState(null, false, false, 0, 0);
        watch(input);
        int[] revision = configurationRevision.computeIfAbsent(root, key -> new int[1]);
        int expected = ++revision[0];
        root.postDelayed(() -> {
            if (revision[0] != expected) return;
            configurationRevision.remove(root);
            boolean visible = imeVisible(root);
            if (visible || root.hasWindowFocus()) stableIme.put(root, visible);
        }, 1200);
        // A rotating window can temporarily lose window/IME ownership while its
        // editor still owns logical focus. Capture that intent before IME calls.
        boolean focused = input.hasFocus();
        int selectionStart = input.getSelectionStart(), selectionEnd = input.getSelectionEnd();
        boolean windowFocused = root.hasWindowFocus();
        boolean currentVisible = imeVisible(input);
        // Before rotation the window still owns the real IME state. Do not let a
        // cached pre-dismiss value make a hidden keyboard look visible again.
        if (windowFocused && !currentVisible) stableIme.put(root, false);
        Boolean stable = stableIme.get(root);
        boolean visible = windowFocused ? currentVisible : stable == null ? currentVisible : stable;
        InputMethodManager keyboard = input.getContext().getSystemService(InputMethodManager.class);
        boolean served = keyboard != null && keyboard.isActive(input);
        visible = visible && (windowFocused || served) || !served && pendingIme.containsKey(input);
        return new EditorFocusState(input, focused, visible, selectionStart, selectionEnd);
    }

    private static boolean imeVisible(View input) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets insets = input.getRootWindowInsets();
            if (insets != null) return insets.isVisible(WindowInsets.Type.ime());
        }
        Rect frame = new Rect(); input.getWindowVisibleDisplayFrame(frame);
        return input.getRootView().getHeight() - frame.bottom > 120 * input.getResources().getDisplayMetrics().density;
    }

    private static void showWhenServed(EditText input, InputMethodManager keyboard) {
        long deadline = SystemClock.uptimeMillis() + 2000;
        input.post(new Runnable() {
            @Override public void run() {
                if (!input.isAttachedToWindow() || !input.hasFocus() || !input.isShown() || !input.isEnabled()) return;
                if (input.hasWindowFocus() && input.isLaidOut() && keyboard.isActive(input)
                        && keyboard.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)) return;
                if (SystemClock.uptimeMillis() < deadline) input.postDelayed(this, 50);
            }
        });
    }

    private static void keepImeHiddenUntilTouch(EditText input) {
        boolean[] suppressed = {true};
        Runnable release = () -> {
            if (!suppressed[0]) return;
            suppressed[0] = false;
            input.setOnTouchListener(null);
            input.setShowSoftInputOnFocus(true);
        };
        input.setShowSoftInputOnFocus(false);
        input.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == android.view.MotionEvent.ACTION_DOWN) release.run();
            return false;
        });
        input.postDelayed(() -> {
            if (suppressed[0] && input.isAttachedToWindow() && imeVisible(input)) {
                InputMethodManager keyboard = input.getContext().getSystemService(InputMethodManager.class);
                if (keyboard != null) keyboard.hideSoftInputFromWindow(input.getWindowToken(), 0);
            }
            release.run();
        }, 750);
    }

    void restore(Activity activity) {
        restore(activity.getWindow().getDecorView());
    }

    void restore(android.view.Window window) { restore(window.getDecorView()); }

    private void restore(View root) {
        if (!focused) return;
        View replacement = tag == null ? null : root.findViewWithTag(tag);
        EditText input = replacement instanceof EditText ? (EditText) replacement : null;
        if (input != null && !keyboardVisible) keepImeHiddenUntilTouch(input);
        // Focusing can create an input connection immediately. Its initial
        // EditorInfo must already contain the restored selection.
        if (input instanceof EditorInput) ((EditorInput) input).prepareSelectionRestore(start, end);
        if (input != null) input.setSelection(Math.max(0, Math.min(start, input.length())), Math.max(0, Math.min(end, input.length())));
        if (input == null || !input.isShown() || !input.isEnabled() || !input.requestFocus()) {
            if (keyboardVisible) {
                InputMethodManager keyboard = root.getContext().getSystemService(InputMethodManager.class);
                if (keyboard != null) keyboard.hideSoftInputFromWindow(root.getWindowToken(), 0);
            }
            return;
        }
        int length = input.length();
        input.setSelection(Math.max(0, Math.min(start, length)), Math.max(0, Math.min(end, length)));
        // A retained form still owns its original input connection. Scheduling
        // another handoff can reopen the IME after the user has dismissed it.
        if (input == source) return;
        String restoredText = input.getText().toString();
        Runnable restoreSelection = () -> {
            if (restoredText.equals(input.getText().toString()))
                input.setSelection(Math.max(0, Math.min(start, input.length())), Math.max(0, Math.min(end, input.length())));
        };
        // Window focus can return after the replacement has already been laid
        // out. Preserve the latest intent across that last platform focus step.
        android.view.ViewTreeObserver focusObserver = input.getViewTreeObserver();
        EditorFocusState[] windowState = {this};
        String[] windowText = {restoredText};
        android.view.ViewTreeObserver.OnWindowFocusChangeListener windowFocus = new android.view.ViewTreeObserver.OnWindowFocusChangeListener() {
            @Override public void onWindowFocusChanged(boolean hasFocus) {
                if (!input.isAttachedToWindow() || !input.hasFocus() || !input.isEnabled()
                        || !restoredText.equals(input.getText().toString())) {
                    if (focusObserver.isAlive()) focusObserver.removeOnWindowFocusChangeListener(this);
                    return;
                }
                if (!hasFocus) {
                    EditorFocusState current = capture(root);
                    if (current.source == input) { windowState[0] = current; windowText[0] = input.getText().toString(); }
                    return;
                }
                if (focusObserver.isAlive()) focusObserver.removeOnWindowFocusChangeListener(this);
                EditorFocusState current = windowState[0];
                if (windowText[0].equals(input.getText().toString()))
                    input.setSelection(Math.max(0, Math.min(current.start, input.length())), Math.max(0, Math.min(current.end, input.length())));
                InputMethodManager keyboard = input.getContext().getSystemService(InputMethodManager.class);
                if (keyboard == null) return;
                keyboard.restartInput(input);
                if (current.keyboardVisible) showWhenServed(input, keyboard);
            }
        };
        focusObserver.addOnWindowFocusChangeListener(windowFocus);
        input.postDelayed(() -> { if (focusObserver.isAlive()) focusObserver.removeOnWindowFocusChangeListener(windowFocus); }, 10000);
        if (keyboardVisible && source != input && Build.VERSION.SDK_INT >= 30) {
            pendingIme.remove(source); pendingIme.put(input, true);
            Runnable finishHandoff = () -> {
                pendingIme.remove(input); input.setWindowInsetsAnimationCallback(null);
            };
            // Detaching the previous editor can finish hiding the IME after the
            // replacement has already requested it. Reapply once that handoff ends.
            input.setWindowInsetsAnimationCallback(new android.view.WindowInsetsAnimation.Callback(
                android.view.WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                @Override public android.view.WindowInsetsAnimation.Bounds onStart(android.view.WindowInsetsAnimation animation,
                    android.view.WindowInsetsAnimation.Bounds bounds) {
                    WindowInsets insets = input.getRootWindowInsets();
                    if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0
                        && insets != null && insets.isVisible(WindowInsets.Type.ime())) {
                        pendingIme.remove(input);
                    }
                    return bounds;
                }
                @Override public WindowInsets onProgress(WindowInsets insets, java.util.List<android.view.WindowInsetsAnimation> running) {
                    return insets;
                }
                @Override public void onEnd(android.view.WindowInsetsAnimation animation) {
                    if ((animation.getTypeMask() & WindowInsets.Type.ime()) == 0) return;
                    if (!restoredText.equals(input.getText().toString())) { finishHandoff.run(); return; }
                    WindowInsets insets = input.getRootWindowInsets();
                    if (animation.getFraction() < 1f) return;
                    if (insets != null && insets.isVisible(WindowInsets.Type.ime())) {
                        input.removeCallbacks(finishHandoff); finishHandoff.run(); return;
                    }
                    if (!pendingIme.containsKey(input)) {
                        input.removeCallbacks(finishHandoff); finishHandoff.run(); return;
                    }
                    input.post(() -> {
                        if (input.isAttachedToWindow() && input.hasWindowFocus() && input.hasFocus() && input.isEnabled()) {
                            InputMethodManager keyboard = input.getContext().getSystemService(InputMethodManager.class);
                            if (keyboard != null) showWhenServed(input, keyboard);
                        } else { input.removeCallbacks(finishHandoff); finishHandoff.run(); }
                    });
                }
            });
            input.postDelayed(finishHandoff, 10000);
        }
        // Focus and TextView's first layout can both apply the default cursor.
        // Reconnect after layout, before the replacement's first visible frame.
        input.getViewTreeObserver().addOnPreDrawListener(new android.view.ViewTreeObserver.OnPreDrawListener() {
            @Override public boolean onPreDraw() {
                input.getViewTreeObserver().removeOnPreDrawListener(this);
                if (!input.isAttachedToWindow() || !input.hasFocus() || !input.isEnabled()
                        || !restoredText.equals(input.getText().toString())) return true;
                InputMethodManager keyboard = input.getContext().getSystemService(InputMethodManager.class);
                if (keyboard == null) return true;
                restoreSelection.run(); keyboard.restartInput(input);
                if (keyboardVisible) showWhenServed(input, keyboard);
                return true;
            }
        });
        input.invalidate();
    }
}
