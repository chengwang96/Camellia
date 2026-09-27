package app.camellia.mobile;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The desktop shows a QR code that carries everything the phone needs to pair:
 * the Tailscale address and the one-time code. Keeping the payload to a flat,
 * versioned JSON object lets the phone reject anything unexpected instead of
 * feeding an arbitrary string through the pairing request.
 */
final class PairingPayload {
    static final String TYPE = "camellia-pair";

    final String address;
    final String code;
    final String computerName;

    private PairingPayload(String address, String code, String computerName) {
        this.address = address;
        this.code = code;
        this.computerName = computerName == null ? "" : computerName;
    }

    static PairingPayload parse(String text) {
        if (text == null) throw new IllegalArgumentException("Empty pairing code");
        Map<String, String> fields = flatObject(text.trim());
        if (!TYPE.equals(fields.get("type"))) throw new IllegalArgumentException("Not a Camellia pairing code");
        if (!"1".equals(fields.get("v"))) throw new IllegalArgumentException("Unsupported pairing version");
        String address = fields.get("address"), code = fields.get("code");
        if (address == null || code == null) throw new IllegalArgumentException("Pairing code is incomplete");
        Endpoint endpoint;
        try { endpoint = new Endpoint(address); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("Pairing code has an invalid address"); }
        if (!code.matches("[a-fA-F0-9]{24}")) throw new IllegalArgumentException("Pairing code is invalid");
        return new PairingPayload(endpoint.origin(), code.toLowerCase(java.util.Locale.ROOT), fields.get("name"));
    }

    private static Map<String, String> flatObject(String value) {
        if (value.length() < 2 || value.charAt(0) != '{' || value.charAt(value.length() - 1) != '}') {
            throw new IllegalArgumentException("Pairing code must be a JSON object");
        }
        Map<String, String> fields = new LinkedHashMap<>();
        int index = 1, end = value.length() - 1;
        while (true) {
            index = skipSpace(value, index, end);
            if (index == end) return fields;
            if (value.charAt(index) != '"') throw new IllegalArgumentException("Pairing code keys must be strings");
            StringBuilder key = new StringBuilder();
            index = string(value, index, end, key);
            index = skipSpace(value, index, end);
            if (index >= end || value.charAt(index) != ':') throw new IllegalArgumentException("Pairing code is malformed");
            index = skipSpace(value, index + 1, end);
            if (index >= end) throw new IllegalArgumentException("Pairing code is malformed");
            StringBuilder field = new StringBuilder();
            if (value.charAt(index) == '"') index = string(value, index, end, field);
            else index = number(value, index, end, field);
            fields.put(key.toString(), field.toString());
            index = skipSpace(value, index, end);
            if (index == end) return fields;
            if (value.charAt(index) != ',') throw new IllegalArgumentException("Pairing code is malformed");
            index++;
        }
    }

    private static int skipSpace(String value, int index, int end) {
        while (index < end && (value.charAt(index) == ' ' || value.charAt(index) == '\n' || value.charAt(index) == '\r' || value.charAt(index) == '\t')) index++;
        return index;
    }

    private static int string(String value, int index, int end, StringBuilder out) {
        index++;
        while (index < end) {
            char current = value.charAt(index++);
            if (current == '"') return index;
            if (current != '\\') { out.append(current); continue; }
            if (index >= end) break;
            char escape = value.charAt(index++);
            switch (escape) {
                case '"': case '\\': case '/': out.append(escape); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'u':
                    if (index + 4 > end) throw new IllegalArgumentException("Pairing code is malformed");
                    try { out.append((char) Integer.parseInt(value.substring(index, index + 4), 16)); }
                    catch (NumberFormatException error) { throw new IllegalArgumentException("Pairing code is malformed"); }
                    index += 4;
                    break;
                default: throw new IllegalArgumentException("Pairing code is malformed");
            }
        }
        throw new IllegalArgumentException("Pairing code has an unterminated string");
    }

    private static int number(String value, int index, int end, StringBuilder out) {
        int start = index;
        while (index < end && (Character.isDigit(value.charAt(index)) || value.charAt(index) == '-')) index++;
        if (index == start) throw new IllegalArgumentException("Pairing code must only contain strings and numbers");
        out.append(value, start, index);
        return index;
    }
}
