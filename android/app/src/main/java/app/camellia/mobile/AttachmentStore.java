package app.camellia.mobile;

import android.content.Context;
import android.util.Base64;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.CipherInputStream;
import javax.crypto.spec.GCMParameterSpec;

/** Binary attachments stay outside the preferences JSON and remain encrypted at rest. */
final class AttachmentStore {
    static final String PREFIX = "camellia-blob:";
    static final String TEXT_PREFIX = "camellia-text:";
    private static final byte[] AAD = "camellia.attachments.v1".getBytes(StandardCharsets.UTF_8);
    private AttachmentStore() {}

    static boolean isReference(String value) { return value != null && value.matches("camellia-(blob|text):[a-f0-9-]{36}"); }

    private static File file(Context context, String reference) throws IOException {
        if (context == null || !isReference(reference)) throw new IOException("附件不可用，请重新添加 / Attachment unavailable; select it again");
        return new File(new File(context.getNoBackupFilesDir(), "chat-attachments"), reference.substring(reference.indexOf(':') + 1));
    }

    static String save(Context context, byte[] bytes) throws Exception {
        String reference = PREFIX + UUID.randomUUID();
        File target = file(context, reference), directory = target.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create attachment storage");
        encrypt(target, bytes);
        return reference;
    }

    private static void encrypt(File target, byte[] bytes) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, CredentialStore.key()); cipher.updateAAD(AAD);
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(cipher.getIV()); output.write(cipher.doFinal(bytes));
        } catch (Exception error) { target.delete(); throw error; }
    }

    static void savePreview(Context context, String reference, byte[] bytes) throws Exception {
        encrypt(new File(file(context, reference).getPath() + ".thumb"), bytes);
    }

    static byte[] preview(Context context, String value) throws IOException {
        if (isReference(value)) {
            File thumbnail = new File(file(context, value).getPath() + ".thumb");
            if (thumbnail.isFile()) try (InputStream input = decrypt(thumbnail)) { return ChatDocument.bounded(input, 1024 * 1024); }
        }
        return read(context, value);
    }

    static InputStream open(Context context, String value) throws IOException {
        if (!isReference(value)) {
            try { return new ByteArrayInputStream(Base64.decode(value, Base64.NO_WRAP)); }
            catch (IllegalArgumentException error) { throw new IOException("Invalid attachment", error); }
        }
        return decrypt(file(context, value));
    }

    private static InputStream decrypt(File file) throws IOException {
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] iv = new byte[12]; new DataInputStream(input).readFully(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, CredentialStore.key(), new GCMParameterSpec(128, iv)); cipher.updateAAD(AAD);
            return new CipherInputStream(input, cipher);
        } catch (Exception error) { input.close(); throw new IOException("Cannot read encrypted attachment", error); }
    }

    static long size(Context context, String value) throws IOException {
        if (!isReference(value)) return (long) value.length() / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
        File target = file(context, value);
        if (!target.isFile() || target.length() < 28) throw new IOException("附件已丢失，请重新添加 / Attachment is missing; select it again");
        return target.length() - 28;
    }

    static byte[] read(Context context, String value) throws IOException {
        if (size(context, value) > ChatAttachments.DOCUMENT_MAX_BYTES) throw new IOException("Attachment too large");
        try (InputStream input = open(context, value)) { return ChatDocument.bounded(input, ChatAttachments.DOCUMENT_MAX_BYTES); }
    }

    static void remove(Context context, String value) {
        if (!isReference(value)) return;
        try { File target = file(context, value); target.delete(); new File(target.getPath() + ".thumb").delete(); } catch (IOException ignored) {}
    }

    static java.util.Set<String> references(Object value) {
        java.util.Set<String> result = new java.util.HashSet<>(); collect(value, result); return result;
    }

    private static void collect(Object value, java.util.Set<String> result) {
        if (value instanceof org.json.JSONObject) {
            org.json.JSONObject object = (org.json.JSONObject) value;
            java.util.Iterator<String> keys = object.keys(); while (keys.hasNext()) collect(object.opt(keys.next()), result);
        } else if (value instanceof org.json.JSONArray) {
            org.json.JSONArray array = (org.json.JSONArray) value; for (int index = 0; index < array.length(); index++) collect(array.opt(index), result);
        } else if (value instanceof String && isReference((String) value)) result.add((String) value);
    }
}
