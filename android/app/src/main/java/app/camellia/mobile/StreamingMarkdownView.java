package app.camellia.mobile;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.widget.LinearLayout;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Main-thread View binding; one worker job plus the latest pending snapshot per reply. */
@android.annotation.SuppressLint("ViewConstructor") // Created programmatically with its renderer and scroll owner.
final class StreamingMarkdownView extends LinearLayout {
    interface Listener { void before(); void after(); default void close() {} }
    private static final ExecutorService PARSERS = Executors.newFixedThreadPool(2, task -> {
        Thread thread = new Thread(task, "markdown-parser"); thread.setDaemon(true); return thread;
    });
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final MarkdownView.Session session;
    private final Runnable dispatch = this::dispatch;
    private MarkdownStream stream;
    private Listener listener;
    private String source = "";
    private long revision, epoch;
    private boolean terminal, renderedFinal, busy, scheduled, disposed;
    long parsedCharacters;
    int parseCalls;

    StreamingMarkdownView(Context context, MarkdownView renderer, Listener listener) {
        super(context); setOrientation(VERTICAL); setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        setTag("markdown"); session = renderer.session(this); this.listener = listener;
    }

    void update(String value, boolean finished) {
        if (disposed) return;
        if (terminal == finished && (busy || scheduled || renderedFinal) && source.equals(value)) { source = value; return; }
        source = value; terminal = finished; revision++;
        if (finished && scheduled) { handler.removeCallbacks(dispatch); scheduled = false; }
        if (!busy && !scheduled) {
            scheduled = true; handler.postDelayed(dispatch, finished ? 0 : 50);
        }
    }

    // History is rendered once when opened. Streaming and completion parse on
    // the worker, keeping ordinary history insertion synchronous.
    void history(String value) {
        session.history(value);
        source = value; terminal = renderedFinal = true;
        parsedCharacters += value.length(); parseCalls++;
    }

    String source() { return source; }
    boolean idle() { return !busy && !scheduled; }
    int createdRoots() { return session.createdRoots; }
    boolean hasStreamState() { return stream != null; }

    private void dispatch() {
        scheduled = false;
        if (disposed || busy) return;
        busy = true;
        String value = source; boolean finished = terminal; long ticket = revision, owner = epoch;
        MarkdownStream current = stream == null ? new MarkdownStream() : stream; stream = current;
        PARSERS.execute(() -> {
            long before = current.parsedCharacters; int calls = current.parseCalls;
            MarkdownStream.Update update = current.update(value, finished);
            long characters = current.parsedCharacters - before; int count = current.parseCalls - calls;
            handler.post(() -> {
                busy = false;
                if (disposed) return;
                if (owner != epoch) { scheduled = true; handler.post(dispatch); return; }
                parsedCharacters += characters; parseCalls += count;
                // One job is in flight, so applied versions are monotonic. A
                // replaced reply is disposed and cannot accept an old result.
                if (listener != null) listener.before();
                session.apply(update);
                if (listener != null) listener.after();
                renderedFinal = finished;
                if (finished) stream = null;
                if (ticket != revision) { scheduled = true; handler.post(dispatch); }
            });
        });
    }

    void dispose() {
        disposed = true; revision++; handler.removeCallbacks(dispatch); scheduled = false;
        source = ""; stream = null; if (listener != null) listener.close(); listener = null;
    }

    void restart() {
        epoch++; revision++; stream = null; source = ""; renderedFinal = terminal = false;
        MarkdownStream.Update empty = new MarkdownStream.Update(false);
        empty.changes.add(new MarkdownStream.Change(0, java.util.Collections.emptyList())); session.apply(empty);
    }
}
