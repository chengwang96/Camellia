package app.camellia.mobile;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionFailureTest {
    @Test public void preservesNativeErrorAcrossJniAndJavaWrappers() {
        for (ConnectionFailure.Code code : ConnectionFailure.Code.values()) {
            Exception wrapped = new IOException("Embedded connection failed", new Exception("CAMELLIA_" + code.name()));
            assertEquals(code, ConnectionFailure.classify(wrapped, true));
            assertTrue(ConnectionFailure.message(wrapped, true, true).contains("[" + code + "]"));
            assertTrue(ConnectionFailure.message(wrapped, true, false).contains("[" + code + "]"));
        }
    }

    @Test public void distinguishesOfflineTimeoutProtocolAndUnknown() {
        assertEquals(ConnectionFailure.Code.OFFLINE, ConnectionFailure.classify(new SocketTimeoutException(), false));
        assertEquals(ConnectionFailure.Code.TIMEOUT, ConnectionFailure.classify(new SocketTimeoutException(), true));
        assertEquals(ConnectionFailure.Code.PROTOCOL_ERROR, ConnectionFailure.classify(new IOException("Invalid JSON"), true));
        assertEquals(ConnectionFailure.Code.CONNECTION_FAILED, ConnectionFailure.classify(new ConnectException("not necessarily refused"), true));
        assertEquals(ConnectionFailure.Code.STREAM_CLOSED, ConnectionFailure.classify(null, true));
    }

    @Test public void neverDisplaysRawTokensAddressesOrRemoteErrors() {
        String secret = "Bearer PRIVATE_TOKEN http://100.80.1.2:43127/private";
        Exception error = new IOException(secret, new Exception("CAMELLIA_UNKNOWN_" + secret));
        for (boolean chinese : new boolean[] { true, false }) {
            String message = ConnectionFailure.message(error, true, chinese);
            assertFalse(message.contains("PRIVATE_TOKEN"));
            assertFalse(message.contains("100.80"));
            assertTrue(message.contains("[CONNECTION_FAILED]"));
        }
    }
}
