package app.camellia.mobile;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * The phone caches the transcript by seq so it can scroll back through earlier
 * pages. Editing the last message on the computer replaces that turn: the
 * revised message is appended with a higher seq and every row it supersedes
 * leaves the conversation, which can strand rows on this phone that the server
 * no longer has. A snapshot that starts the conversation at its first row says
 * nothing older can be paged to, so cached rows below it were replaced and must
 * go; while older pages still exist those rows belong to them and stay.
 */
final class RemoteTranscript {
    static long[] superseded(Collection<Long> cached, long firstVisibleSeq, boolean olderPagesAvailable, boolean trimmed) {
        if (olderPagesAvailable || trimmed) return new long[0];
        List<Long> stale = new ArrayList<>();
        for (Long seq : cached) if (seq != null && (firstVisibleSeq <= 0 || seq < firstVisibleSeq)) stale.add(seq);
        long[] result = new long[stale.size()];
        for (int index = 0; index < result.length; index++) result[index] = stale.get(index);
        return result;
    }
}
