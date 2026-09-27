package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class PairingPayloadTest {
    @Test public void readsTheDesktopPayload() {
        PairingPayload payload = PairingPayload.parse("{\"v\":1,\"type\":\"camellia-pair\",\"address\":\"http://100.80.1.2:43127\",\"code\":\"AABBCCDDEEFF001122334455\",\"name\":\"Work PC\"}");
        assertEquals("http://100.80.1.2:43127", payload.address);
        assertEquals("aabbccddeeff001122334455", payload.code);
        assertEquals("Work PC", payload.computerName);
    }

    @Test public void toleratesWhitespaceAndOptionalName() {
        PairingPayload payload = PairingPayload.parse(" {\n \"v\" : 1 , \"type\" : \"camellia-pair\" ,\n \"address\" : \"http://100.64.0.1:1\" , \"code\" : \"001122334455667788990011\" } ");
        assertEquals("http://100.64.0.1:1", payload.address);
        assertEquals("", payload.computerName);
    }

    @Test public void rejectsAnythingUnexpected() {
        String[] invalid = {
            "", "{}", "[]", "camellia-pair",
            "{\"type\":\"camellia-pair\",\"address\":\"http://100.64.0.1:1\",\"code\":\"001122334455667788990011\"}",
            "{\"v\":2,\"type\":\"camellia-pair\",\"address\":\"http://100.64.0.1:1\",\"code\":\"001122334455667788990011\"}",
            "{\"v\":1,\"type\":\"other\",\"address\":\"http://100.64.0.1:1\",\"code\":\"001122334455667788990011\"}",
            "{\"v\":1,\"type\":\"camellia-pair\",\"address\":\"http://192.168.1.5:43127\",\"code\":\"001122334455667788990011\"}",
            "{\"v\":1,\"type\":\"camellia-pair\",\"address\":\"http://evil.example:43127\",\"code\":\"001122334455667788990011\"}",
            "{\"v\":1,\"type\":\"camellia-pair\",\"address\":\"http://100.64.0.1:1\",\"code\":\"too-short\"}",
            "{\"v\":1,\"type\":\"camellia-pair\",\"address\":\"http://100.64.0.1:1\",\"code\":\"001122334455667788990011\",\"extra\":{\"a\":1}}"
        };
        for (String value : invalid) assertThrows(value, IllegalArgumentException.class, () -> PairingPayload.parse(value));
    }
}
