package app.camellia.mobile;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

final class RemoteEntryGate {
    enum State { CONNECTING, READY, OFFLINE, SIGN_IN, TIMED_OUT, FAILED }
    interface Probe { State check() throws Exception; }
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Executor worker;
    private final Probe probe;
    private final Consumer<State> listener;
    private final long timeout;
    private boolean active, checking;
    private long revision, started;
    private final Runnable poll = this::check;
    private final Runnable deadline = this::timeOut;

    private void timeOut() {
        if (!active) return;
        stop(); listener.accept(State.TIMED_OUT);
    }

    RemoteEntryGate(Executor worker, Probe probe, Consumer<State> listener) { this(worker, probe, listener, 30_000); }

    RemoteEntryGate(Executor worker, Probe probe, Consumer<State> listener, long timeout) {
        this.worker = worker; this.probe = probe; this.listener = listener; this.timeout = timeout;
    }

    void start() {
        stop(); active = true; started = SystemClock.elapsedRealtime();
        listener.accept(State.CONNECTING); handler.postDelayed(deadline, timeout); check();
    }

    void stop() { active = false; revision++; handler.removeCallbacks(poll); handler.removeCallbacks(deadline); }

    private void check() {
        if (!active || checking) return;
        checking = true; long ticket = revision;
        worker.execute(() -> {
            State result;
            try { result = probe.check(); } catch (Exception error) { result = State.FAILED; }
            State outcome = result;
            handler.post(() -> {
                checking = false;
                if (!active) return;
                if (ticket != revision) { check(); return; }
                State state = outcome;
                long now = SystemClock.elapsedRealtime();
                handler.removeCallbacks(deadline);
                if (state == State.READY || state == State.OFFLINE) started = now;
                if (state == State.CONNECTING && now - started >= timeout) state = State.TIMED_OUT;
                if (state == State.CONNECTING) handler.postDelayed(deadline, Math.max(0, timeout - (now - started)));
                listener.accept(state);
                if (state == State.CONNECTING || state == State.READY || state == State.OFFLINE) handler.postDelayed(poll, 1500);
            });
        });
    }
}
