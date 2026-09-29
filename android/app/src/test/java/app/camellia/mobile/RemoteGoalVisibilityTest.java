package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteGoalVisibilityTest {
    @Test public void completedGoalLastsUntilANewerUserMessage() {
        RemoteGoalVisibility state = new RemoteGoalVisibility();
        assertTrue(state.show("goal-1", "complete", 2000, 1, 1000));
        assertTrue(state.show("goal-1", "complete", 2000, 1, 1000));
        assertFalse(state.show("goal-1", "complete", 2000, 3, 3000));
        // Losing the newest user row to the history window cannot revive it.
        assertFalse(state.show("goal-1", "complete", 2000, 0, 0));
    }

    @Test public void openingAnAlreadySupersededCompletionKeepsItHidden() {
        RemoteGoalVisibility state = new RemoteGoalVisibility();
        assertFalse(state.show("goal-1", "complete", 2000, 3, 3000));
        state.reset();
        assertFalse(state.show("goal-1", "complete", 2000, 3, 3000));
    }

    @Test public void oldDesktopShowsOnlyAnObservedCompletionThenDismissesIt() {
        RemoteGoalVisibility state = new RemoteGoalVisibility();
        assertFalse(state.show("report", "complete", 0, 3, 3000));
        assertTrue(state.show("report", "active", 0, 5, 5000));
        assertTrue(state.show("report", "complete", 0, 5, 5000));
        assertTrue(state.show("report", "complete", 0, 5, 5000));
        assertFalse(state.show("report", "complete", 0, 7, 7000));
        state.reset();
        assertFalse(state.show("report", "complete", 0, 7, 7000));
    }

    @Test public void unfinishedGoalsRemainActionableAfterNewMessages() {
        RemoteGoalVisibility state = new RemoteGoalVisibility();
        for (String phase : new String[]{"active", "paused", "blocked"}) {
            assertTrue(state.show("goal-1", phase, 0, 1, 1000));
            assertTrue(state.show("goal-1", phase, 0, 8, 8000));
        }
    }

    @Test public void newGoalsAndOtherConversationsDoNotInheritDismissal() {
        RemoteGoalVisibility state = new RemoteGoalVisibility();
        assertFalse(state.show("goal-1", "complete", 2000, 3, 3000));
        assertTrue(state.show("goal-2", "complete", 4000, 3, 3000));
        state.reset();
        assertTrue(state.show("goal-1", "complete", 2000, 1, 1000));
        assertFalse(state.show("", "", 0, 0, 0));
        assertFalse(state.show("report", "complete", 0, 1, 1000));
    }
}
