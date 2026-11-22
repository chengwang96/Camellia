package app.camellia.mobile;

import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class LanMdnsProbeTest {
    @Test public void parsesCamelliaSrvTxtAndAddressRecords() throws Exception {
        String instance = "Camellia c9ab3075._camellia._tcp.local";
        String target = "HP.local";
        String fingerprint = "6e7a27fc91ed101a70913d3a1bb84972535b912edebdc47a4fe620ae8abcebb0";
        ByteArrayOutputStream packetBytes = new ByteArrayOutputStream();
        DataOutputStream packet = new DataOutputStream(packetBytes);
        packet.writeShort(0);
        packet.writeShort(0x8400);
        packet.writeShort(0);
        packet.writeShort(3);
        packet.writeShort(0);
        packet.writeShort(0);

        ByteArrayOutputStream srvBytes = new ByteArrayOutputStream();
        DataOutputStream srv = new DataOutputStream(srvBytes);
        srv.writeShort(0);
        srv.writeShort(0);
        srv.writeShort(4194);
        writeName(srv, target);
        writeRecord(packet, instance, 33, srvBytes.toByteArray());

        ByteArrayOutputStream txtBytes = new ByteArrayOutputStream();
        DataOutputStream txt = new DataOutputStream(txtBytes);
        writeTxt(txt, "id=c9ab3075-393e-478b-a4d5-7a92247579f9");
        writeTxt(txt, "ip=192.168.3.59");
        writeTxt(txt, "fp=" + fingerprint);
        writeTxt(txt, "name=HP");
        writeTxt(txt, "join=1");
        writeRecord(packet, instance, 16, txtBytes.toByteArray());

        writeRecord(packet, target, 1, new byte[]{(byte) 192, (byte) 168, 3, 59});
        byte[] data = packetBytes.toByteArray();

        List<LanMdnsProbe.Result> results = LanMdnsProbe.parse(data, data.length);
        assertEquals(1, results.size());
        LanMdnsProbe.Result result = results.get(0);
        assertEquals("c9ab3075-393e-478b-a4d5-7a92247579f9", result.computerId);
        assertEquals("HP", result.name);
        assertEquals("192.168.3.59", result.address);
        assertEquals(4194, result.port);
        assertEquals(fingerprint, result.fingerprint);
        assertTrue(result.joinable);
    }

    private static void writeRecord(DataOutputStream output, String name, int type, byte[] value)
            throws Exception {
        writeName(output, name);
        output.writeShort(type);
        output.writeShort(1);
        output.writeInt(120);
        output.writeShort(value.length);
        output.write(value);
    }

    private static void writeName(DataOutputStream output, String name) throws Exception {
        for (String label : name.split("\\.")) {
            byte[] value = label.getBytes(StandardCharsets.UTF_8);
            output.writeByte(value.length);
            output.write(value);
        }
        output.writeByte(0);
    }

    private static void writeTxt(DataOutputStream output, String value) throws Exception {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        output.writeByte(bytes.length);
        output.write(bytes);
    }
}
