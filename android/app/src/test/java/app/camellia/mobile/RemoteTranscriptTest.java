package app.camellia.mobile;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.assertArrayEquals;

public class RemoteTranscriptTest {
    @Test public void keepsRowsBelowTheWindowWhileOlderPagesExist() {
        assertArrayEquals(new long[0], RemoteTranscript.superseded(List.of(1L, 2L, 3L, 4L), 3L, true, false));
    }

    @Test public void dropsRowsBelowASnapshotThatBeginsTheConversation() {
        assertArrayEquals(new long[]{1, 2}, RemoteTranscript.superseded(List.of(1L, 2L, 3L, 4L), 3L, false, false));
    }

    @Test public void dropsEveryCachedRowWhenTheConversationIsEmpty() {
        assertArrayEquals(new long[]{7, 8}, RemoteTranscript.superseded(List.of(7L, 8L), 0, false, false));
    }

    @Test public void keepsRowsTrimmedByTheLocalHistoryLimit() {
        assertArrayEquals(new long[0], RemoteTranscript.superseded(List.of(1L, 2L), 5L, false, true));
    }

    @Test public void keepsRowsWhenTheSnapshotOnlyHoldsItsOwnWindow() {
        assertArrayEquals(new long[0], RemoteTranscript.superseded(List.of(9L, 10L), 9L, false, false));
    }
}
