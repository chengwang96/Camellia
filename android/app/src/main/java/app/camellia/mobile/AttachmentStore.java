package app.camellia.mobile;

import android.content.Context;
import android.util.Base64;
import android.util.Log;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.function.BooleanSupplier;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;

/** Binary attachments stay outside the preferences JSON and remain encrypted at rest. */
final class AttachmentStore {
    static final String PREFIX = "camellia-blob:";
    static final String TEXT_PREFIX = "camellia-text:";
    private static final byte[] AAD = "camellia.attachments.v1".getBytes(StandardCharsets.UTF_8);
    static final String[] SUFFIXES = {"", ".thumb", ".meta", ".meta.new"};
    private static final Object metadataWrites = new Object();
    private static final int META_BYTES = 56; // IV + authenticated version, file stamp and quoted UTF-8 length.
    private AttachmentStore() {}

    static boolean isReference(String value) { return value != null && value.matches("camellia-(blob|text):[a-f0-9-]{36}"); }

    private static File file(Context context, String reference) throws IOException {
        if (context == null || !isReference(reference)) throw new IOException("附件不可用，请重新添加 / Attachment unavailable; select it again");
        return new File(new File(context.getNoBackupFilesDir(), "chat-attachments"), reference.substring(reference.indexOf(':') + 1));
    }

    static String save(Context context, byte[] bytes) throws Exception {
        String reference = PREFIX + UUID.randomUUID();
        AttachmentMaintenance.created(reference);
        File target = file(context, reference), directory = target.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create attachment storage");
        encrypt(target, bytes);
        return reference;
    }

    static String saveText(Context context, String text) throws Exception {
        String reference = save(context, text.getBytes(StandardCharsets.UTF_8)).replace(PREFIX, TEXT_PREFIX);
        File target = file(context, reference);
        cacheTextLength(target, JsonStreams.quotedLength(text), target.length(), target.lastModified());
        return reference;
    }

    static long textJsonLength(Context context, String reference, BooleanSupplier cancelled) throws IOException {
        if (size(context, reference) > ChatAttachments.DOCUMENT_MAX_BYTES) throw new IOException("Attachment too large");
        File target = file(context, reference), metadata = new File(target.getPath() + ".meta");
        long size = target.length(), modified = target.lastModified();
        if (metadata.length() == META_BYTES) {
            try (DataInputStream input = new DataInputStream(decrypt(metadata, metadataAad(target)))) {
                int version = input.readInt(); long savedSize = input.readLong(), savedModified = input.readLong(), length = input.readLong();
                if (input.read() == -1 && version == 1 && savedSize == size && savedModified == modified && length >= 2) return length;
            } catch (IOException invalidCache) { /* Rebuild this optional cache from the authenticated attachment. */ }
        }
        long length;
        try (Reader input = new InputStreamReader(open(context, reference), StandardCharsets.UTF_8)) {
            length = JsonStreams.quotedLength(input, cancelled);
        }
        JsonStreams.check(cancelled);
        if (size != target.length() || modified != target.lastModified()) throw new IOException("Attachment changed while preparing upload");
        cacheTextLength(target, length, size, modified);
        return length;
    }

    private static byte[] metadataAad(File target) { return ("camellia.attachments.length.v1:" + target.getName()).getBytes(StandardCharsets.UTF_8); }

    private static void cacheTextLength(File target, long length, long size, long modified) {
        try (AttachmentMaintenance.Write writing = AttachmentMaintenance.writing()) {
            byte[] value = ByteBuffer.allocate(28).putInt(1).putLong(size).putLong(modified).putLong(length).array();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, CredentialStore.key());
            cipher.updateAAD(metadataAad(target));
            byte[] encrypted = cipher.doFinal(value);
            byte[] bytes = ByteBuffer.allocate(META_BYTES).put(cipher.getIV()).put(encrypted).array();
            File temporary = new File(target.getPath() + ".meta.new"), metadata = new File(target.getPath() + ".meta");
            synchronized (metadataWrites) {
                try {
                    Files.write(temporary.toPath(), bytes);
                    Files.move(temporary.toPath(), metadata.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } finally { Files.deleteIfExists(temporary.toPath()); }
            }
        } catch (Exception error) { Log.w("CamelliaAttachments", "Could not cache attachment text length", error); }
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
        return decrypt(file, AAD);
    }

    private static InputStream decrypt(File file, byte[] aad) throws IOException {
        long size = file.length() - 28;
        if (size < 0 || size > ChatAttachments.DOCUMENT_MAX_BYTES) throw new IOException("Invalid encrypted attachment size");
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] iv = new byte[12]; new DataInputStream(input).readFully(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, CredentialStore.key(), new GCMParameterSpec(128, iv)); cipher.updateAAD(aad);
            return new AuthenticatedInputStream(input, cipher, (int) size);
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

    static boolean remove(Context context, String value) {
        if (!isReference(value)) return true;
        try {
            File target = file(context, value); boolean removed = true;
            for (String suffix : SUFFIXES) {
                File item = new File(target.getPath() + suffix);
                if (item.exists() && !item.delete()) removed = false;
            }
            return removed;
        } catch (IOException ignored) { return false; }
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
        } else if (value instanceof Iterable<?>) {
            for (Object item : (Iterable<?>) value) collect(item, result);
        } else if (value instanceof String) {
            String reference = (String) value;
            if (reference.startsWith("data:image/jpeg;base64,") || reference.startsWith("data:application/pdf;base64,"))
                reference = reference.substring(reference.indexOf(',') + 1);
            if (isReference(reference)) result.add(reference);
        }
    }
}
