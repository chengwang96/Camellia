package app.camellia.mobile;

import android.app.Instrumentation;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;

final class InputDeliveryFixture {
    private InputDeliveryFixture() {}

    static void type(Instrumentation instrumentation, String text) {
        KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
        if (events == null) throw new AssertionError("No keyboard events for " + text);
        for (KeyEvent event : events) deliver(instrumentation, event);
        instrumentation.waitForIdleSync();
    }

    static void deliver(Instrumentation instrumentation, InputEvent event) {
        if (!instrumentation.getUiAutomation().injectInputEvent(event, true))
            throw new AssertionError("Android did not receive " + event);
    }
}
