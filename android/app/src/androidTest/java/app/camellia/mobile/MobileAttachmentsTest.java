package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public final class MobileAttachmentsTest extends InstrumentationTestCase {
    private Context context;
    private final ArrayList<String> references = new ArrayList<>();
    private final ArrayList<File> fixtures = new ArrayList<>();

    @Override protected void setUp() throws Exception {
        super.setUp(); context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "language", "zh-CN");
        new CredentialStore(context, "local-chat-private").clear();
    }
    @Override protected void tearDown() throws Exception {
        for (String reference : references) AttachmentStore.remove(context, reference);
        for (File file : fixtures) file.delete();
        new CredentialStore(context, "local-chat-private").clear(); super.tearDown();
    }

    public void testUnifiedCountAndOnlyRemoteAggregateBudget() throws Exception {
        String image = blob(new byte[ChatAttachments.IMAGE_MAX_BYTES]);
        List<String> twenty = Collections.nCopies(20, image);
        ChatAttachments.validate(context, twenty, Collections.emptyList(), false);
        try { ChatAttachments.validate(context, Collections.nCopies(21, image), Collections.emptyList(), false); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("20")); }
        ChatAttachments.validate(context, Collections.nCopies(8, image), Collections.emptyList(), true);
        try { ChatAttachments.validate(context, Collections.nCopies(9, image), Collections.emptyList(), true); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("32 MiB")); }
        JSONObject document = new JSONObject().put("data", blob(new byte[ChatAttachments.DOCUMENT_MAX_BYTES]));
        ChatAttachments.validate(context, Collections.emptyList(), Collections.singletonList(document), false);
        document.put("data", blob(new byte[ChatAttachments.DOCUMENT_MAX_BYTES + 1]));
        try { ChatAttachments.validate(context, Collections.emptyList(), Collections.singletonList(document), false); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("10 MiB")); }
    }

    public void testDocumentReadersKeepTextAndOfficeOrder() throws Exception {
        JSONObject text = read("notes.txt", "中文 notes\nsecond line".getBytes(StandardCharsets.UTF_8));
        assertEquals("中文 notes\nsecond line", new String(AttachmentStore.read(context, text.getString("text")), StandardCharsets.UTF_8));
        JSONObject word = read("notes.docx", zip(Map.of("word/document.xml", "<document><p><t>First</t></p><p><t>第二段</t></p></document>")));
        assertEquals("First\n第二段\n", new String(AttachmentStore.read(context, word.getString("text")), StandardCharsets.UTF_8));
        String sheet = ChatDocument.officeText("xlsx", zip(Map.of("xl/sharedStrings.xml", "<sst><si><t>Revenue</t></si></sst>",
            "xl/worksheets/sheet1.xml", "<worksheet><row><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\"><v>42</v></c></row></worksheet>")));
        assertTrue(sheet, sheet.contains("A1=Revenue\tB1=42"));
        String slides = ChatDocument.officeText("pptx", zip(Map.of("ppt/slides/slide10.xml", "<slide><p><t>Tenth</t></p></slide>",
            "ppt/slides/slide2.xml", "<slide><p><t>Second</t></p></slide>")));
        assertTrue(slides.indexOf("Second") < slides.indexOf("Tenth"));
        try { ChatDocument.officeText("docx", zip(Map.of("word/document.xml", "<!DOCTYPE x [<!ENTITY x SYSTEM 'file:///private'>]><p><t>&x;</t></p>"))); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("DTD")); }
        try { read("old.doc", new byte[]{1, 2, 3}); fail(); } catch (IOException expected) { assertTrue(expected.getMessage().contains("DOCX")); }
    }

    public void testRemoteMainstreamDocumentsPreserveOriginalBytes() throws Exception {
        List<JSONObject> documents = new ArrayList<>(); Map<String, byte[]> originals = new LinkedHashMap<>();
        for (String name : new String[]{"paper.pdf", "notes.doc", "notes.docx", "data.xls", "data.xlsx", "slides.ppt", "slides.pptx",
            "notes.rtf", "notes.odt", "data.ods", "slides.odp", "notes.txt", "notes.md", "data.csv"}) {
            byte[] bytes = (name.endsWith("pdf") ? "%PDF-1.7\n%%EOF\n" : "Original bytes: " + name).getBytes(StandardCharsets.UTF_8);
            JSONObject document = ChatDocument.read(context, Uri.fromFile(fixture(name, bytes)), false);
            references.add(document.getString("data")); documents.add(document); originals.put(name, bytes);
            assertFalse("Remote Office documents must not be replaced with extracted text", document.has("text"));
        }
        ChatAttachments.validateRemote(context, Collections.emptyList(), documents, true, true, true);
        JSONObject payload = new JSONObject().put("attachments", ChatAttachments.remote(Collections.emptyList(), documents));
        JSONArray sent = new JSONObject(AttachmentJson.string(context, payload)).getJSONArray("attachments");
        assertEquals(documents.size(), sent.length());
        for (int index = 0; index < sent.length(); index++) {
            JSONObject file = sent.getJSONObject(index);
            assertFalse(file.getBoolean("isImage"));
            assertTrue(file.getString("name"), Arrays.equals(originals.get(file.getString("name")), android.util.Base64.decode(file.getString("data"), android.util.Base64.NO_WRAP)));
        }
        try { ChatDocument.read(context, Uri.fromFile(fixture("program.exe", new byte[]{1})), false); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("PDF")); }
    }

    public void testRemoteFileSupportAndCapacityAreIndependent() throws Exception {
        JSONObject document = new JSONObject().put("data", blob(new byte[8 * 1024 * 1024]));
        ChatAttachments.validateRemote(context, Collections.emptyList(), Collections.singletonList(document), false, true, false);
        try { ChatAttachments.validateRemote(context, Collections.emptyList(), Collections.singletonList(document), false, false, true); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("documents")); }
        document.put("data", blob(new byte[9 * 1024 * 1024]));
        try { ChatAttachments.validateRemote(context, Collections.emptyList(), Collections.singletonList(document), false, true, true); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("8 MiB")); }
        ChatAttachments.validateRemote(context, Collections.emptyList(), Collections.singletonList(document), true, true, true);
        String image = blob(new byte[2 * 1024 * 1024]);
        ChatAttachments.validateRemote(context, Collections.singletonList(image), Collections.emptyList(), false, true, false);
        try { ChatAttachments.validateRemote(context, Collections.singletonList(image), Collections.emptyList(), false, false, true); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("1 MiB")); }
        String tiny = blob(new byte[]{1});
        try { ChatAttachments.validateRemote(context, Collections.nCopies(10, tiny), Collections.emptyList(), false, true, true); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("9")); }
        ChatAttachments.validateRemote(context, Collections.nCopies(10, tiny), Collections.emptyList(), true, true, true);
    }

    public void testImageCompressionIsIdenticalAndRetainsMoreResolution() throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(3600, 1800, Bitmap.Config.ARGB_8888); bitmap.eraseColor(0xff72a5dc);
        File file = fixture("large.png", new byte[0]);
        try (FileOutputStream output = new FileOutputStream(file)) { bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); }
        bitmap.recycle();
        String local = ChatImage.encode(context, Uri.fromFile(file), ChatImage.PHONE_MAX_SIDE, ChatImage.PHONE_MAX_BYTES);
        String remote = ChatImage.encode(context, Uri.fromFile(file), ChatImage.DESKTOP_MAX_SIDE, ChatImage.DESKTOP_MAX_BYTES);
        references.add(local); references.add(remote);
        byte[] bytes = AttachmentStore.read(context, local);
        assertTrue(Arrays.equals(bytes, AttachmentStore.read(context, remote)));
        Bitmap decoded = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        try { assertEquals(3072, decoded.getWidth()); assertEquals(1536, decoded.getHeight()); }
        finally { decoded.recycle(); }
        assertTrue(bytes.length <= ChatAttachments.IMAGE_MAX_BYTES);
    }

    public void testNativePdfAndTextSerializeForBothProtocolsWithoutPrivateReferences() throws Exception {
        byte[] pdfBytes = new byte[3 * 1024 * 1024]; System.arraycopy("%PDF-1.4\n".getBytes(StandardCharsets.US_ASCII), 0, pdfBytes, 0, 9);
        JSONObject pdf = read("paper.pdf", pdfBytes), text = read("notes.txt", "quoted \"中文\"\nnotes".getBytes(StandardCharsets.UTF_8));
        String image = blob(new byte[]{(byte) 255, (byte) 216, (byte) 255, (byte) 217});
        JSONObject user = new JSONObject().put("role", "user").put("content", "Inspect all files")
            .put("images", new JSONArray(Collections.nCopies(12, image))).put("documents", new JSONArray().put(pdf).put(text));
        for (String protocol : new String[]{"openai", "anthropic"}) {
            LocalChatConfig.Route route = new LocalChatConfig.Route("fixture", "Fixture", "fixture-model", protocol, "https://example.com/v1", "fixture-key");
            JSONObject body = LocalChatClient.request(route, new JSONArray().put(user));
            assertTrue("Persisted requests retain small references", body.toString().length() < 10000);
            String encoded = AttachmentJson.string(context, new JSONObject(body.toString()));
            assertFalse(encoded.contains("camellia-blob:")); assertFalse(encoded.contains("camellia-text:"));
            assertEquals(encoded.getBytes(StandardCharsets.UTF_8).length, AttachmentJson.length(context, body));
            JSONArray parts = new JSONObject(encoded).getJSONArray("messages").getJSONObject(0).getJSONArray("content");
            JSONObject document = parts.getJSONObject(13);
            String data = protocol.equals("anthropic") ? document.getJSONObject("source").getString("data")
                : document.getJSONObject("file").getString("file_data").substring("data:application/pdf;base64,".length());
            assertTrue(Arrays.equals(pdfBytes, android.util.Base64.decode(data, android.util.Base64.NO_WRAP)));
            assertEquals("quoted \"中文\"\nnotes", parts.getJSONObject(15).getString("text"));
        }
        LocalChatStore store = new LocalChatStore(context); JSONObject conversation = store.createConversation("", "fixture");
        conversation.getJSONArray("messages").put(user); store.save();
        assertEquals(12, new LocalChatStore(context).conversation(conversation.getString("id")).getJSONArray("messages").getJSONObject(0).getJSONArray("images").length());
    }

    public void testDraftAndFailedRemotePayloadPreserveMixedAttachments() throws Exception {
        JSONObject document = read("draft.txt", "draft".getBytes(StandardCharsets.UTF_8)); String image = blob(new byte[]{1, 2, 3});
        JSONObject conversation = new JSONObject().put("messages", new JSONArray().put(new JSONObject().put("role", "user")
            .put("documents", new JSONArray().put(document)).put("images", new JSONArray().put(image))));
        LocalChatDraft.save(conversation, "edit", 0, Collections.singletonList(image), Collections.singletonList(document));
        assertEquals("draft.txt", LocalChatDraft.documents(new JSONObject(conversation.toString())).getJSONObject(0).getString("name"));
        LocalChatDraft.save(conversation, "edit", 0, Collections.emptyList(), Collections.emptyList());
        assertEquals(0, LocalChatDraft.documents(conversation).length());
        JSONObject pending = new JSONObject().put("attachments", ChatAttachments.remote(Collections.nCopies(12, image), Collections.singletonList(document)));
        ArrayList<String> images = new ArrayList<>(); ArrayList<JSONObject> documents = new ArrayList<>();
        ChatAttachments.restore(new JSONObject(pending.toString()), images, documents);
        assertEquals(12, images.size()); assertEquals("draft.txt", documents.get(0).getString("name"));
        assertEquals(image, images.get(0));
    }

    public void testLocalPickerAcceptsDocumentsBesideTwelveImagesAndRejectsOverflow() throws Throwable {
        LocalChatStore store = new LocalChatStore(context);
        JSONObject provider = new JSONObject().put("id", "fixture").put("name", "Fixture").put("protocol", "openai").put("baseUrl", "https://example.com/v1")
            .put("keys", new JSONArray().put(new JSONObject().put("key", "fixture-key"))).put("models", new JSONArray().put(new JSONObject().put("id", "fixture-model").put("upstream", "fixture-model")));
        store.importConfig(new JSONObject().put("providers", new JSONArray().put(provider)));
        String id = store.createConversation("", LocalChatConfig.routes(store.config()).get(0).id).getString("id");
        LocalChatActivity activity = (LocalChatActivity) getInstrumentation().startActivitySync(new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        File document = fixture("mixed.txt", "read this document".getBytes(StandardCharsets.UTF_8));
        try {
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            ui(() -> {
                try {
                    List<String> images = (List<String>) field(activity, "selectedImages");
                    String image = blob(new byte[]{(byte) 255, (byte) 216, (byte) 255, (byte) 217});
                    images.addAll(Collections.nCopies(12, image));
                    activity.onActivityResult(63, Activity.RESULT_OK, new Intent().setData(Uri.fromFile(document)));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitSelection(activity);
            ui(() -> {
                assertEquals(1, ((List<?>) field(activity, "selectedDocuments")).size());
                assertEquals(13, ((ViewGroup) activity.getWindow().getDecorView().findViewWithTag("localImageTray")).getChildCount());
                assertTrue(activity.getWindow().getDecorView().findViewWithTag("localSend").isEnabled());
                ((List<String>) field(activity, "selectedImages")).addAll(Collections.nCopies(7, ((List<String>) field(activity, "selectedImages")).get(0)));
                activity.onActivityResult(63, Activity.RESULT_OK, new Intent().setData(Uri.fromFile(document)));
                assertEquals(1, ((List<?>) field(activity, "selectedDocuments")).size());
                assertTrue(((android.widget.TextView) field(activity, "status")).getText().toString().contains("20"));
            });
        } finally { ui(activity::finish); }
    }

    public void testRemoteDocumentPickerDraftAndFailedSendRestoreAllFiles() throws Throwable {
        CredentialStore remote = new CredentialStore(context); remote.clear();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        String id = "12345678-1234-1234-1234-123456789abc", address = "http://100.80.1.2:43127";
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        File document = fixture("remote-notes.txt", "remote document".getBytes(StandardCharsets.UTF_8));
        String image = blob(new byte[]{(byte) 255, (byte) 216, (byte) 255, (byte) 217});
        try {
            ui(() -> {
                try {
                    set(activity, "credentials", new JSONObject().put("address", address).put("token", "a".repeat(43)));
                    set(activity, "conversationId", id); set(activity, "conversationTitle", "Attachment test"); invoke(activity, "detailScreen");
                    set(activity, "canAttachments", true); set(activity, "canImage", true); set(activity, "canMultiImage", true);
                    set(activity, "connected", true); set(activity, "controlAllowed", true);
                    set(activity, "imageConversation", id); set(activity, "imageComputer", address);
                    ((List<String>) field(activity, "selectedImages")).addAll(Collections.nCopies(12, image));
                    activity.onActivityResult((Integer) field(activity, "PICK_DOCUMENT_REQUEST"), Activity.RESULT_OK, new Intent().setData(Uri.fromFile(document)));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitSelection(activity);
            ui(() -> {
                try {
                    assertEquals(1, ((List<?>) field(activity, "selectedDocuments")).size());
                    assertEquals(13, ((ViewGroup) field(activity, "imageTray")).getChildCount());
                    JSONObject saved = (JSONObject) field(activity, "credentials");
                    assertEquals(13, saved.getJSONObject("draftAttachments").getJSONObject(id).getJSONArray("attachments").length());
                    invoke(activity, "detailScreen");
                    List<String> images = (List<String>) field(activity, "selectedImages");
                    List<JSONObject> documents = (List<JSONObject>) field(activity, "selectedDocuments");
                    assertEquals(12, images.size()); assertEquals("remote-notes.txt", documents.get(0).getString("name"));
                    references.add(documents.get(0).getString("data"));
                    JSONObject payload = new JSONObject().put("action", "send").put("requestId", java.util.UUID.randomUUID().toString())
                        .put("prompt", "Review attachments").put("attachments", ChatAttachments.remote(images, documents));
                    saved = new JSONObject(((JSONObject) field(activity, "credentials")).toString()).put("pendingCommand",
                        new JSONObject().put("conversationId", id).put("payload", payload).put("draft", "Review attachments"));
                    new ComputerStore(remote).save(saved); set(activity, "credentials", saved);
                    set(activity, "outgoingMessage", saved.getJSONObject("pendingCommand"));
                    images.clear(); documents.clear();
                    var finish = MainActivity.class.getDeclaredMethod("finishCommand", JSONObject.class, JSONObject.class); finish.setAccessible(true);
                    finish.invoke(activity, payload, new JSONObject().put("ok", false).put("state", "failed").put("error", "Fixture rejection"));
                    assertEquals(12, images.size()); assertEquals(1, documents.size());
                    assertEquals("remote-notes.txt", documents.get(0).getString("name"));
                    assertFalse(((JSONObject) field(activity, "credentials")).has("pendingCommand"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { ui(activity::finish); remote.clear(); }
    }

    public void testOlderFileCapableDesktopCanPickAndSendPdfAndWord() throws Throwable {
        CredentialStore remote = new CredentialStore(context); remote.clear();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        byte[] pdfBytes = "%PDF-1.7\n%%EOF\n".getBytes(StandardCharsets.UTF_8), wordBytes = new byte[]{(byte) 0xd0, (byte) 0xcf, 17, (byte) 0xe0};
        File pdf = fixture("review.pdf", pdfBytes), word = fixture("legacy.doc", wordBytes);
        Intent[] picker = {null};
        var monitor = new android.app.Instrumentation.ActivityMonitor() {
            @Override public android.app.Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (!Intent.ACTION_GET_CONTENT.equals(intent.getAction())) return null;
                picker[0] = intent; return new android.app.Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
            }
        };
        getInstrumentation().addMonitor(monitor);
        try {
            ui(() -> {
                try {
                    set(activity, "credentials", new JSONObject().put("address", "http://100.80.1.2:43127").put("token", "a".repeat(43)));
                    set(activity, "conversationId", "12345678-1234-1234-1234-123456789abc"); set(activity, "conversationTitle", "Documents"); invoke(activity, "detailScreen");
                    set(activity, "connected", true); set(activity, "controlAllowed", true); set(activity, "api", null);
                    var capabilities = MainActivity.class.getDeclaredMethod("updateCapabilities", JSONObject.class); capabilities.setAccessible(true);
                    capabilities.invoke(activity, new JSONObject().put("permission", "control").put("capabilities", new JSONArray().put("image")));
                    invoke(activity, "pickImage");
                    android.app.Dialog dialog = (android.app.Dialog) field(activity, "computerDialog");
                    assertFalse(dialog.getWindow().getDecorView().findViewWithTag("remoteDocumentPicker").isEnabled()); dialog.dismiss();
                    capabilities.invoke(activity, new JSONObject().put("permission", "control").put("capabilities", new JSONArray().put("attachments")));
                    assertFalse((Boolean) field(activity, "canAttachments")); assertTrue((Boolean) field(activity, "canFileAttachments"));
                    invoke(activity, "pickImage"); dialog = (android.app.Dialog) field(activity, "computerDialog");
                    View files = dialog.getWindow().getDecorView().findViewWithTag("remoteDocumentPicker");
                    assertTrue("Basic file support must enable documents without the expanded capacity capability", files.isEnabled()); files.performClick();
                    assertNotNull(picker[0]); assertEquals("*/*", picker[0].getType());
                    assertTrue(picker[0].hasCategory(Intent.CATEGORY_OPENABLE)); assertTrue(picker[0].getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
                    android.content.ClipData selection = android.content.ClipData.newRawUri("PDF and Word", Uri.fromFile(pdf));
                    selection.addItem(new android.content.ClipData.Item(Uri.fromFile(word)));
                    Intent result = new Intent(); result.setClipData(selection);
                    activity.onActivityResult((Integer) field(activity, "PICK_DOCUMENT_REQUEST"), Activity.RESULT_OK, result);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitSelection(activity);
            ui(() -> {
                try {
                    List<JSONObject> documents = (List<JSONObject>) field(activity, "selectedDocuments"); assertEquals(2, documents.size());
                    for (JSONObject document : documents) references.add(document.getString("data"));
                    ((android.widget.EditText) field(activity, "composer")).setText("Read the PDF and Word documents");
                    var send = MainActivity.class.getDeclaredMethod("sendMessage", String.class); send.setAccessible(true); send.invoke(activity, "");
                    JSONObject pending = ((JSONObject) field(activity, "credentials")).getJSONObject("pendingCommand");
                    JSONObject payload = pending.getJSONObject("payload");
                    assertFalse(payload.has("image")); assertFalse(payload.has("images"));
                    JSONArray sent = new JSONObject(AttachmentJson.string(context, payload)).getJSONArray("attachments");
                    assertEquals(2, sent.length()); assertEquals("review.pdf", sent.getJSONObject(0).getString("name"));
                    assertEquals("legacy.doc", sent.getJSONObject(1).getString("name"));
                    assertTrue(Arrays.equals(pdfBytes, android.util.Base64.decode(sent.getJSONObject(0).getString("data"), android.util.Base64.NO_WRAP)));
                    assertTrue(Arrays.equals(wordBytes, android.util.Base64.decode(sent.getJSONObject(1).getString("data"), android.util.Base64.NO_WRAP)));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().removeMonitor(monitor); ui(activity::finish); remote.clear(); }
    }

    private void set(Object object, String name, Object value) throws Exception {
        var field = object.getClass().getDeclaredField(name); field.setAccessible(true); field.set(object, value);
    }
    private void invoke(Object object, String name) throws Exception {
        var method = object.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(object);
    }
    private String blob(byte[] bytes) throws Exception { String reference = AttachmentStore.save(context, bytes); references.add(reference); return reference; }
    private JSONObject read(String name, byte[] bytes) throws Exception {
        JSONObject document = ChatDocument.read(context, Uri.fromFile(fixture(name, bytes)), true);
        references.add(document.getString("data")); if (document.has("text")) references.add(document.getString("text")); return document;
    }
    private File fixture(String name, byte[] bytes) throws Exception {
        File directory = new File(context.getCacheDir(), "attachment-fixtures"); directory.mkdirs();
        File file = new File(directory, name); try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
        fixtures.add(file); return file;
    }
    private byte[] zip(Map<String, String> entries) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) { for (Map.Entry<String, String> entry : entries.entrySet()) {
            zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(entry.getValue().getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
        } } return bytes.toByteArray();
    }
    private Object field(Object object, String name) {
        try { var field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private void ui(Runnable runnable) throws Throwable {
        Throwable[] failure = new Throwable[1]; getInstrumentation().runOnMainSync(() -> { try { runnable.run(); } catch (Throwable error) { failure[0] = error; } });
        if (failure[0] != null) throw failure[0];
    }
    private void awaitSelection(Activity activity) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 10000;
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            boolean[] loading = {true}; getInstrumentation().runOnMainSync(() -> loading[0] = (Boolean) field(activity, "loadingImages"));
            if (!loading[0]) return; Thread.sleep(50);
        }
        fail("Attachment reading timed out");
    }
}
