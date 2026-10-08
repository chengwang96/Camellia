package app.camellia.mobile;

import android.content.Context;
import android.net.Uri;
import android.provider.OpenableColumns;
import org.json.JSONObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;

/** Modern Office documents are read as text locally; PDFs retain their native document input. */
final class ChatDocument {
    private static final int MAX_TEXT = OfficeDocument.MAX_TEXT;
    private static final Set<String> TEXT = new HashSet<>(Arrays.asList("txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "html", "htm"));
    // Remote chat sends the original bytes to the computer, which can use its
    // document tools. Local chat can only extract the modern Office formats.
    private static final Set<String> REMOTE_DOCUMENTS = new HashSet<>(Arrays.asList("doc", "xls", "ppt", "rtf", "odt", "ods", "odp"));
    private ChatDocument() {}

    static JSONObject read(Context context, Uri uri, boolean local) throws Exception {
        String name = null; long declared = -1;
        try (android.database.Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (column >= 0) name = cursor.getString(column);
                column = cursor.getColumnIndex(OpenableColumns.SIZE); if (column >= 0 && !cursor.isNull(column)) declared = cursor.getLong(column);
            }
        }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        name = safeName(name);
        String extension = extension(name);
        if (!TEXT.contains(extension) && !Arrays.asList("pdf", "docx", "xlsx", "pptx").contains(extension)
            && (local || !REMOTE_DOCUMENTS.contains(extension)))
            throw new IOException(local ? "本机支持 PDF、DOCX、XLSX、PPTX 和文本；其他办公文档请先转换 / Local chat supports PDF, DOCX, XLSX, PPTX and text; convert other office documents first"
                : "支持 PDF、Word、Excel、PPT、RTF、OpenDocument 和文本文件 / Choose a PDF, Word, Excel, PowerPoint, RTF, OpenDocument or text file");
        if (declared > ChatAttachments.DOCUMENT_MAX_BYTES) throw new IOException("单个文档不能超过 10 MiB / Document exceeds 10 MiB");
        byte[] bytes;
        try (InputStream input = context.getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("Cannot open document");
            bytes = bounded(input, ChatAttachments.DOCUMENT_MAX_BYTES);
        }
        if (bytes.length == 0) throw new IOException("文档为空 / Document is empty");
        String text = null;
        if (extension.equals("pdf")) {
            if (bytes.length < 5 || !new String(bytes, 0, 5, StandardCharsets.US_ASCII).equals("%PDF-")) throw new IOException("PDF 文件无效 / Invalid PDF");
        } else if (local) text = TEXT.contains(extension) ? decodeText(bytes) : officeText(context, extension, bytes);
        if (text != null && blankText(text)) throw new IOException("未读到文档文字，请转换为 PDF / No document text found; convert it to PDF");
        if (text != null && text.length() > MAX_TEXT) throw new IOException("文档文字过多，请拆分文件 / Too much document text; split the file");
        String reference = AttachmentStore.save(context, bytes), textReference = null;
        try {
            JSONObject document = new JSONObject().put("name", name).put("data", reference).put("size", bytes.length)
                .put("mimeType", extension.equals("pdf") ? "application/pdf" : "text/plain").put("isImage", false);
            if (text != null) {
                textReference = AttachmentStore.saveText(context, text);
                document.put("text", textReference);
            }
            return document;
        } catch (Exception error) { AttachmentStore.remove(context, reference); AttachmentStore.remove(context, textReference); throw error; }
    }

    static String safeName(String value) {
        String name = value == null ? "document.txt" : value.replaceAll("[\\\\/\\p{Cntrl}\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "document.txt";
        if (name.length() > 180) {
            int dot = name.lastIndexOf('.'); String suffix = dot >= 0 && name.length() - dot < 16 ? name.substring(dot) : "";
            name = name.substring(0, 180 - suffix.length()) + suffix;
        }
        return name;
    }

    static String extension(String name) { int dot = name.lastIndexOf('.'); return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT); }

    static byte[] bounded(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[32768]; int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IOException("文件超过大小限制 / File exceeds size limit");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    static String decodeText(byte[] bytes) throws Exception {
        if (bytes.length >= 2 && (bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xfe || bytes[0] == (byte) 0xfe && bytes[1] == (byte) 0xff))
            return checkedText(Charset.forName("UTF-16").newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString());
        try { return checkedText(StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString().replaceFirst("^\\uFEFF", "")); }
        catch (CharacterCodingException error) { return checkedText(Charset.forName("GB18030").newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()); }
    }

    private static String checkedText(String text) throws IOException {
        if (text.indexOf('\0') >= 0 || text.length() > MAX_TEXT) throw new IOException("文档不是文本或文字过多 / Document is not text or contains too much text");
        return text;
    }

    private static boolean blankText(String text) {
        for (int index = 0; index < text.length(); index++) if (text.charAt(index) > ' ') return false;
        return true;
    }

    static String officeText(Context context, String extension, byte[] bytes) throws Exception {
        File directory = new File(context.getCacheDir(), OfficeImports.DIRECTORY);
        try (OfficeImports.Staged staged = OfficeImports.stage(directory, new ByteArrayInputStream(bytes))) {
            return OfficeDocument.read(staged.file, extension);
        }
    }
}
