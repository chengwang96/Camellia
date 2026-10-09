package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.test.InstrumentationTestRunner;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;

public class GatewayIntegrationTest extends InstrumentationTestCase {
    public void testDesktopGatewayPairReadStreamAndRevoke() throws Exception {
        if (!"true".equals(((InstrumentationTestRunner) getInstrumentation()).getArguments().getString("gatewayIntegration"))) return;
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext());
        EmbeddedNetwork.setEnabled(false);
        RemoteApi client = new RemoteApi("http://100.64.0.1:43128");
        JSONObject request = client.json("/v1/pair/request", null, new JSONObject().put("code", "integration-fixture-only").put("name", "Android integration"));
        JSONObject credential = client.json("/v1/pair/claim", null, new JSONObject().put("id", request.getString("id")).put("claim", request.getString("claim")));
        String token = credential.getString("token");
        assertEquals("control", client.json("/v1/status", token, null).getString("permission"));
        JSONObject conversation = client.json("/v1/conversations", token, null).getJSONArray("conversations").getJSONObject(0);
        String id = conversation.getString("id");
        JSONObject searched = client.json("/v1/conversations?offset=0&limit=100&query=android+integration", token, null);
        assertEquals(id, searched.getJSONArray("conversations").getJSONObject(0).getString("id"));
        JSONObject artifact = client.json("/v1/conversations/" + id + "/artifacts", token, null).getJSONArray("artifacts").getJSONObject(0);
        assertEquals("手机产物.pdf", artifact.getString("name"));
        assertFalse(artifact.has("path"));
        java.io.File downloaded = java.io.File.createTempFile("artifact-test-", ".pdf", getInstrumentation().getTargetContext().getCacheDir());
        try {
            java.util.concurrent.atomic.AtomicLong progress = new java.util.concurrent.atomic.AtomicLong();
            try (var output = new java.io.FileOutputStream(downloaded)) {
                client.download("/v1/conversations/" + id + "/artifacts/" + artifact.getString("id"), token, output,
                    artifact.getLong("size"), (receivedBytes, total) -> progress.set(receivedBytes));
            }
            assertEquals(192 * 1024L, downloaded.length()); assertEquals(downloaded.length(), progress.get());
            try (var input = new java.io.FileInputStream(downloaded)) {
                for (int index = 0; index < 192 * 1024; index++) assertEquals(index % 251, input.read());
                assertEquals(-1, input.read());
            }
        } finally { downloaded.delete(); }
        verifyBackgroundDownload(artifact, id, token);
        verifyDefaultDirectoryDownload(artifact, id, token);
        AtomicInteger lists = new AtomicInteger();
        IOException complete = new IOException("List synchronization verified");
        try {
            client.listEvents(token, event -> {
                assertFalse(event.optString("listVersion").isEmpty());
                JSONObject page = client.json("/v1/conversations", token, null);
                int count = lists.incrementAndGet();
                assertEquals(count == 2 ? 2 : 1, page.optJSONArray("conversations").length());
                if (count == 3) throw complete;
                advanceListFixture(token, count == 1 ? "add" : "remove");
            });
            fail("Expected three list snapshots");
        } catch (IOException expected) { assertSame(complete, expected); }
        assertEquals(3, lists.get());
        verifyListScreen(credential);
        verifyLegacyListScreen(credential);
        verifyComputersPullCheck(credential);
        JSONObject info = client.json("/v1/status", token, null);
        String workspace = info.getJSONArray("workspaces").getJSONObject(0).getString("id");
        JSONObject create = operation("create", info.getString("instanceId")).put("workspaceId", workspace).put("engine", "codex");
        JSONObject created = client.json("/v1/commands", token, create);
        assertTrue(created.getBoolean("ok"));
        assertEquals(created.getJSONObject("conversation").getString("id"), client.json("/v1/commands", token, create).getJSONObject("conversation").getString("id"));
        JSONObject receipt = client.json("/v1/commands/" + create.getString("requestId"), token, null);
        assertEquals(created.getJSONObject("conversation").getString("id"), receipt.getJSONObject("conversation").getString("id"));
        verifyConversationActions(client, token, info.getString("instanceId"), workspace, created.getJSONObject("conversation").getString("id"));
        verifyAutomationAndSearch(client, token, info.getString("instanceId"), id);
        verifyApiKeyImport(client, token);
        JSONObject snapshot = client.json("/v1/conversations/" + id, token, null);
        assertEquals("Fixture answer", snapshot.getJSONArray("messages").getJSONObject(1).getString("text"));
        String server = snapshot.getString("instanceId");
        JSONObject send = operation("send", server).put("prompt", "Android test instruction").put("expectedSeq", snapshot.getJSONObject("conversation").getLong("seq"));
        android.graphics.Bitmap image = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888);
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); image.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, bytes); image.recycle();
        send.put("image", android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP));
        String endpoint = "/v1/conversations/" + id + "/commands";
        JSONObject accepted = client.json(endpoint, token, send);
        assertTrue(accepted.getBoolean("ok"));
        assertEquals(accepted.getLong("runId"), client.json(endpoint, token, send).getLong("runId"));
        snapshot = client.json("/v1/conversations/" + id, token, null);
        JSONObject approval = snapshot.getJSONObject("live").getJSONArray("approvals").getJSONObject(0);
        JSONObject respond = operation("approve", server).put("runId", accepted.getLong("runId")).put("approvalId", approval.getString("requestId"))
            .put("fingerprint", approval.getString("fingerprint")).put("allow", true);
        assertTrue(client.json(endpoint, token, respond).getBoolean("ok"));
        assertTrue(client.json(endpoint, token, respond).getBoolean("ok"));
        assertTrue(client.json(endpoint, token, operation("stop", server).put("runId", accepted.getLong("runId"))).getBoolean("ok"));
        AtomicInteger received = new AtomicInteger();
        client.incremental(true);
        client.events(id, token, event -> {
            assertEquals(id, event.optJSONObject("conversation").optString("id"));
            received.incrementAndGet();
        });
        assertTrue(received.get() >= 2);
        try { client.json("/v1/status", token, null); fail("Revoked credentials must fail"); }
        catch (RemoteApi.Failure expected) { assertEquals(401, expected.status); }
        client.cancel();
    }

    private void verifyAutomationAndSearch(RemoteApi client, String token, String instance, String id) throws Exception {
        String base = "/v1/conversations/" + id, endpoint = base + "/commands";
        JSONObject initial = client.json(base, token, null).getJSONObject("automation");
        assertEquals("Android automation fixture", initial.getJSONObject("goal").getString("objective"));
        assertEquals("paused", initial.getJSONObject("goal").getString("phase"));
        JSONObject resume = operation("goal-control", instance).put("operation", "resume");
        assertTrue(client.json(endpoint, token, resume).getBoolean("ok"));
        assertTrue(client.json(endpoint, token, resume).getBoolean("ok"));
        assertTrue(client.json(base, token, null).getJSONObject("automation").getJSONObject("goal").getBoolean("armed"));
        assertTrue(client.json(endpoint, token, operation("goal-control", instance).put("operation", "pause")).getBoolean("ok"));
        assertEquals("paused", client.json(base, token, null).getJSONObject("automation").getJSONObject("goal").getString("phase"));
        assertTrue(client.json(endpoint, token, operation("goal-control", instance).put("operation", "clear")).getBoolean("ok"));
        assertTrue(client.json(base, token, null).getJSONObject("automation").isNull("goal"));

        String task = initial.getJSONArray("tasks").getJSONObject(0).getString("id");
        for (String action : new String[]{"resume", "pause", "cancel"}) {
            JSONObject command = operation("task-control", instance).put("taskId", task).put("operation", action);
            assertTrue(client.json(endpoint, token, command).getBoolean("ok"));
            assertTrue(client.json(endpoint, token, command).getBoolean("ok"));
            String expected = action.equals("resume") ? "scheduled" : action.equals("pause") ? "paused" : "cancelled";
            assertEquals(expected, client.json(base, token, null).getJSONObject("automation").getJSONArray("tasks").getJSONObject(0).getString("status"));
        }
        assertFalse(client.json(endpoint, token, operation("task-control", instance).put("taskId", task).put("operation", "resume")).getBoolean("ok"));
        JSONObject snapshot = client.json(base, token, null);
        JSONObject search = operation("find", instance).put("query", "inside: remoteautomationneedle")
            .put("expectedSeq", snapshot.getJSONObject("conversation").getLong("seq"));
        JSONObject found = client.json(endpoint, token, search);
        assertTrue(found.getBoolean("ok")); assertEquals(1, found.getInt("count"));
        assertEquals(found.getLong("seq"), client.json(endpoint, token, search).getLong("seq"));
        JSONObject file = found.getJSONArray("files").getJSONObject(0);
        assertEquals("手机搜索结果.txt", file.getString("name")); assertFalse(file.has("path")); assertFalse(found.has("roots"));
        search.put("requestId", java.util.UUID.randomUUID().toString());
        assertFalse(client.json(endpoint, token, search).getBoolean("ok"));
        org.json.JSONArray artifacts = client.json(base + "/artifacts", token, null).getJSONArray("artifacts");
        JSONObject download = null;
        for (int index = 0; index < artifacts.length(); index++) {
            JSONObject item = artifacts.getJSONObject(index);
            if (item.getString("name").equals("手机搜索结果.txt")) download = item;
        }
        assertNotNull(download);
        var bytes = new java.io.ByteArrayOutputStream();
        client.download(base + "/artifacts/" + download.getString("id"), token, bytes, download.getLong("size"), (received, total) -> {});
        assertEquals("remoteautomationneedle: verified on the desktop", bytes.toString("UTF-8"));
    }

    private void advanceListFixture(String token, String operation) throws IOException {
        // Fixture coordination is deliberately outside the production RemoteApi
        // endpoint allowlist. Only the disposable host test serves this route.
        var connection = (java.net.HttpURLConnection) new java.net.URL("http://100.64.0.1:43128/fixture/list/" + operation).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
            assertEquals(200, connection.getResponseCode());
        } finally { connection.disconnect(); }
    }

    private void verifyListScreen(JSONObject credential) throws Exception {
        CredentialStore encrypted = new CredentialStore(getInstrumentation().getTargetContext());
        encrypted.clear();
        new ComputerStore(encrypted).save(new JSONObject().put("address", "http://100.64.0.1:43128")
            .put("token", credential.getString("token")).put("deviceId", credential.getString("deviceId")));
        MainActivity activity = (MainActivity) LocalChatFixture.start(getInstrumentation(), new android.content.Intent(
            getInstrumentation().getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var screen = MainActivity.class.getDeclaredMethod("listScreen"); screen.setAccessible(true); screen.invoke(activity);
                    var load = MainActivity.class.getDeclaredMethod("loadList", boolean.class); load.setAccessible(true); load.invoke(activity, false);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitConversationCount(activity, 1);
            advanceListFixture(credential.getString("token"), "add");
            awaitConversationCount(activity, 2);
            advanceListFixture(credential.getString("token"), "remove");
            awaitConversationCount(activity, 1);
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
            encrypted.clear();
        }
    }

    private void verifyConversationActions(RemoteApi client, String token, String server, String workspace, String first) throws Exception {
        JSONObject original = client.json("/v1/conversations/" + first, token, null).getJSONObject("conversation");
        org.json.JSONArray targets = new org.json.JSONArray().put(new JSONObject().put("id", first).put("seq", original.getLong("seq")));
        JSONObject rename = operation("rename", server).put("targets", targets).put("title", "手机重命名验证");
        assertTrue(client.json("/v1/commands", token, rename).getBoolean("ok"));
        assertTrue(client.json("/v1/commands", token, rename).getBoolean("ok"));
        JSONObject renamed = client.json("/v1/conversations/" + first, token, null).getJSONObject("conversation");
        assertEquals("手机重命名验证", renamed.getString("title"));
        targets.getJSONObject(0).put("seq", renamed.getLong("seq"));
        JSONObject pin = operation("pin", server).put("targets", targets).put("pinned", true);
        assertTrue(client.json("/v1/commands", token, pin).getBoolean("ok"));
        assertTrue(client.json("/v1/commands", token, pin).getBoolean("ok"));
        JSONObject pinned = client.json("/v1/conversations/" + first, token, null).getJSONObject("conversation");
        assertTrue(pinned.getBoolean("pinned"));
        assertEquals(first, client.json("/v1/conversations", token, null).getJSONArray("conversations").getJSONObject(0).getString("id"));
        JSONObject second = client.json("/v1/commands", token, operation("create", server).put("workspaceId", workspace).put("engine", "codex"))
            .getJSONObject("conversation");
        targets.getJSONObject(0).put("seq", pinned.getLong("seq"));
        targets.put(new JSONObject().put("id", second.getString("id")).put("seq", second.getLong("seq")));
        org.json.JSONArray staleTargets = new org.json.JSONArray(targets.toString());
        staleTargets.getJSONObject(1).put("seq", second.getLong("seq") + 1);
        assertFalse(client.json("/v1/commands", token, operation("delete", server).put("targets", staleTargets)).getBoolean("ok"));
        assertEquals(first, client.json("/v1/conversations/" + first, token, null).getJSONObject("conversation").getString("id"));
        assertEquals(second.getString("id"), client.json("/v1/conversations/" + second.getString("id"), token, null).getJSONObject("conversation").getString("id"));
        JSONObject delete = operation("delete", server).put("targets", targets);
        assertTrue(client.json("/v1/commands", token, delete).getBoolean("ok"));
        assertTrue(client.json("/v1/commands", token, delete).getBoolean("ok"));
        for (String id : new String[] {first, second.getString("id")}) {
            try { client.json("/v1/conversations/" + id, token, null); fail("Deleted conversation remains accessible"); }
            catch (RemoteApi.Failure expected) { assertEquals(404, expected.status); }
        }
    }

    private void verifyApiKeyImport(RemoteApi client, String token) throws Exception {
        JSONObject bundle = client.json("/v1/api-keys", token, null);
        assertEquals("camellia-api-routes", bundle.getString("format"));
        assertEquals(2, bundle.getInt("version"));
        assertEquals("fixture-secret", bundle.getJSONObject("config").getJSONArray("providers").getJSONObject(0)
            .getJSONArray("keys").getJSONObject(0).getString("key"));
        assertEquals(1, LocalChatConfig.routes(LocalChatConfig.parse(bundle.toString())).size());
        var context = getInstrumentation().getTargetContext();
        CredentialStore remote = new CredentialStore(context);
        remote.clear();
        new ComputerStore(remote).save(new JSONObject().put("address", "http://100.64.0.1:43128").put("token", token));
        LocalChatFixture.clear(context);
        android.app.Activity settings = LocalChatFixture.start(getInstrumentation(), new android.content.Intent(context, SettingsActivity.class)
            .putExtra("section", "providers").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> settings.getWindow().getDecorView().findViewWithTag("providerImportComputer").performClick());
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    android.app.AlertDialog confirm = settingsDialog(settings);
                    assertNotNull(confirm);
                    android.view.View decor = confirm.getWindow().getDecorView();
                    assertNotNull("The import must confirm in the app sheet style", decor.findViewWithTag("camelliaDialog"));
                    assertTrue("The confirmation must name the source computer",
                        ((android.widget.TextView) decor.findViewById(android.R.id.message)).getText().toString().contains("100.64.0.1:43128"));
                    assertTrue("Nothing may be read before the confirmation",
                        LocalChatConfig.routes(new LocalChatFixture(context).config()).isEmpty());
                    confirm.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            long deadline = android.os.SystemClock.elapsedRealtime() + 15_000;
            while (LocalChatConfig.routes(new LocalChatFixture(context).config()).isEmpty() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50);
            java.util.List<LocalChatConfig.Route> imported = LocalChatConfig.routes(new LocalChatFixture(context).config());
            assertEquals(1, imported.size());
            assertEquals("fixture-secret", imported.get(0).key);
            long statusDeadline = android.os.SystemClock.elapsedRealtime() + 5_000;
            String[] shown = {""};
            do {
                getInstrumentation().runOnMainSync(() -> shown[0] = ((android.widget.TextView) settings.getWindow().getDecorView()
                    .findViewWithTag("settingsStatus")).getText().toString());
                if (shown[0].contains("100.64.0.1:43128")) break;
                Thread.sleep(50);
            } while (android.os.SystemClock.elapsedRealtime() < statusDeadline);
            assertTrue("The success status must name the source computer: " + shown[0],
                shown[0].contains("100.64.0.1:43128") && (shown[0].contains("已从") || shown[0].contains("Imported")));
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> assertNotNull(settings.getWindow().getDecorView().findViewWithTag("providerEdit:0")));
        } finally {
            getInstrumentation().runOnMainSync(settings::finish);
            getInstrumentation().waitForIdleSync();
            LocalChatFixture.clear(context);
            remote.clear();
        }
    }

    private android.app.AlertDialog settingsDialog(android.app.Activity activity) {
        try { var field = activity.getClass().getDeclaredField("dialog"); field.setAccessible(true); return (android.app.AlertDialog) field.get(activity); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    private void verifyBackgroundDownload(JSONObject artifact, String conversation, String token) throws Exception {
        var context = getInstrumentation().getTargetContext();
        java.io.File directory = new java.io.File(context.getCacheDir(), "camera"); directory.mkdirs();
        java.io.File file = java.io.File.createTempFile("background-artifact-", ".pdf", directory);
        MainActivity activity = (MainActivity) LocalChatFixture.start(getInstrumentation(), new android.content.Intent(context, MainActivity.class)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            JSONObject selected = new JSONObject(artifact.toString()).put("address", "http://100.64.0.1:43128").put("conversation", conversation);
            ArtifactDownloads downloads = new ArtifactDownloads(activity, null);
            getInstrumentation().runOnMainSync(() -> downloads.show("http://100.64.0.1:43128", token, conversation));
            Thread.sleep(500);
            getInstrumentation().waitForIdleSync();
            var screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            if (screenshot != null) {
                try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "artifact-sheet.png"))) {
                    screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                } finally { screenshot.recycle(); }
            }
            getInstrumentation().runOnMainSync(downloads::close);
            getInstrumentation().runOnMainSync(() -> {
                try {
                    ArtifactDownloadService.start(activity, selected, token, CameraFileProvider.uri(context, file));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            Thread.sleep(250);
            assertTrue(ArtifactDownloadService.snapshot().detail, ArtifactDownloadService.snapshot().active());
            try { ArtifactDownloadService.start(activity, selected, token, CameraFileProvider.uri(context, file)); fail("Duplicate download accepted"); }
            catch (IOException expected) { }
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
            long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
            while (ArtifactDownloadService.snapshot().active() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50);
            assertEquals("complete", ArtifactDownloadService.snapshot().phase);
            assertEquals(192 * 1024L, file.length());
            try (var input = new java.io.FileInputStream(file)) {
                for (int index = 0; index < 192 * 1024; index++) assertEquals(index % 251, input.read());
            }
            MainActivity cancelActivity = (MainActivity) LocalChatFixture.start(getInstrumentation(), new android.content.Intent(context, MainActivity.class)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                getInstrumentation().runOnMainSync(() -> {
                    try { ArtifactDownloadService.start(cancelActivity, selected, token, CameraFileProvider.uri(context, file)); }
                    catch (Exception error) { throw new AssertionError(error); }
                });
                Thread.sleep(250);
                getInstrumentation().runOnMainSync(() -> ArtifactDownloadService.cancel(context));
                deadline = android.os.SystemClock.elapsedRealtime() + 5000;
                while (ArtifactDownloadService.snapshot().active() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(25);
                assertEquals("cancelled", ArtifactDownloadService.snapshot().phase);
            } finally { getInstrumentation().runOnMainSync(cancelActivity::finish); }
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            ArtifactDownloadService.cancel(context); file.delete();
        }
    }

    private void verifyDefaultDirectoryDownload(JSONObject artifact, String conversation, String token) throws Exception {
        var context = getInstrumentation().getTargetContext();
        DownloadDirectoryFixture.authorize(getInstrumentation());
        java.util.List<android.net.Uri> savedFiles = new java.util.ArrayList<>();
        java.util.Set<android.net.Uri> original = new java.util.HashSet<>(DownloadDirectoryFixture.files(context));
        android.app.Activity activity = null;
        ArtifactDownloads downloads = null;
        final int[] pickers = {0};
        android.app.Instrumentation.ActivityMonitor monitor = new android.app.Instrumentation.ActivityMonitor() {
            @Override public android.app.Instrumentation.ActivityResult onStartActivity(android.content.Intent intent) {
                if (!android.content.Intent.ACTION_CREATE_DOCUMENT.equals(intent.getAction())) return null;
                pickers[0]++; return new android.app.Instrumentation.ActivityResult(android.app.Activity.RESULT_CANCELED, null);
            }
        };
        getInstrumentation().addMonitor(monitor);
        try {
            for (int attempt = 0; attempt < 3; attempt++) {
                activity = getInstrumentation().startActivitySync(new android.content.Intent(context, PopupTestActivity.class)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
                android.app.Activity currentActivity = activity;
                ArtifactDownloads currentDownloads = new ArtifactDownloads(activity, null); downloads = currentDownloads;
                getInstrumentation().runOnMainSync(() -> {
                    try {
                        var choose = ArtifactDownloads.class.getDeclaredMethod("choose", JSONObject.class, String.class, String.class, String.class);
                        choose.setAccessible(true); choose.invoke(currentDownloads, artifact, "http://100.64.0.1:43128", token, conversation);
                    } catch (Exception error) { throw new AssertionError(error); }
                });
                assertTrue("Default-directory selection must start the download directly", ArtifactDownloadService.snapshot().active());
                assertEquals("Repeated downloads must never open a destination picker", 0, pickers[0]);
                getInstrumentation().runOnMainSync(() -> { currentDownloads.close(); currentActivity.finish(); });
                getInstrumentation().waitForIdleSync();
                if (attempt == 2) {
                    DownloadDirectory.clear(context);
                    assertTrue("Clearing the setting must retain the grant until the active download ends",
                        DownloadDirectory.hasPermission(context, DownloadDirectoryFixture.TREE));
                    Thread.sleep(250); ArtifactDownloadService.cancel(context);
                }
                long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
                while (ArtifactDownloadService.snapshot().active() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(50);
                if (attempt == 2) {
                    assertEquals("cancelled", ArtifactDownloadService.snapshot().phase);
                    assertFalse("A cleared directory grant must be released after cancellation",
                        DownloadDirectory.hasPermission(context, DownloadDirectoryFixture.TREE));
                    // Regain access to verify saved files and the removal of the cancelled partial file.
                    DownloadDirectoryFixture.authorize(getInstrumentation());
                } else {
                    assertEquals(ArtifactDownloadService.snapshot().detail, "complete", ArtifactDownloadService.snapshot().phase);
                    assertTrue("Finishing a download must preserve the default folder's grant",
                        DownloadDirectory.hasPermission(context, DownloadDirectoryFixture.TREE));
                    java.util.List<android.net.Uri> files = DownloadDirectoryFixture.files(context);
                    files.removeAll(original); files.removeAll(savedFiles);
                    assertEquals("Each download must create a separate file", 1, files.size());
                    savedFiles.add(files.get(0));
                    try (var input = context.getContentResolver().openInputStream(files.get(0))) {
                        for (int index = 0; index < 192 * 1024; index++) assertEquals(index % 251, input.read());
                        assertEquals(-1, input.read());
                    }
                }
                activity = null; downloads = null;
            }
            java.util.Set<android.net.Uri> remaining = new java.util.HashSet<>(DownloadDirectoryFixture.files(context));
            remaining.removeAll(original);
            assertEquals(new java.util.HashSet<>(savedFiles), remaining);
            try (var cursor = context.getContentResolver().query(savedFiles.get(1),
                    new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                assertTrue(cursor.moveToFirst()); assertEquals("手机产物 (1).pdf", cursor.getString(0));
            }
        } finally {
            getInstrumentation().removeMonitor(monitor);
            android.app.Activity lastActivity = activity; ArtifactDownloads lastDownloads = downloads;
            getInstrumentation().runOnMainSync(() -> { if (lastDownloads != null) lastDownloads.close(); if (lastActivity != null) lastActivity.finish(); });
            ArtifactDownloadService.cancel(context);
            for (android.net.Uri file : savedFiles) android.provider.DocumentsContract.deleteDocument(context.getContentResolver(), file);
            DownloadDirectory.clear(context);
        }
    }

    private void verifyLegacyListScreen(JSONObject credential) throws Exception {
        CredentialStore encrypted = new CredentialStore(getInstrumentation().getTargetContext());
        new ComputerStore(encrypted).save(new JSONObject().put("address", "http://100.64.0.1:43128")
            .put("token", credential.getString("token")).put("deviceId", credential.getString("deviceId")));
        MainActivity activity = (MainActivity) LocalChatFixture.start(getInstrumentation(), new android.content.Intent(
            getInstrumentation().getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var screen = MainActivity.class.getDeclaredMethod("listScreen"); screen.setAccessible(true); screen.invoke(activity);
                    var load = MainActivity.class.getDeclaredMethod("loadList", boolean.class); load.setAccessible(true); load.invoke(activity, false);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitConversationCount(activity, 1);
            advanceListFixture(credential.getString("token"), "add");
            awaitConversationCount(activity, 2, 22_000);
            getInstrumentation().runOnMainSync(() -> {
                android.widget.TextView status = activity.getWindow().getDecorView().findViewWithTag("connectionStatus");
                String message = status.getText().toString();
                assertTrue(message, message.contains("periodically") || message.contains("定时刷新"));
            });
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync(); encrypted.clear();
        }
    }

    private void verifyComputersPullCheck(JSONObject credential) throws Exception {
        String address = "http://100.64.0.1:43128";
        CredentialStore encrypted = new CredentialStore(getInstrumentation().getTargetContext());
        encrypted.clear();
        new ComputerStore(encrypted).save(new JSONObject().put("address", address)
            .put("token", credential.getString("token")).put("deviceId", credential.getString("deviceId")));
        MainActivity activity = (MainActivity) LocalChatFixture.start(getInstrumentation(), new android.content.Intent(
            getInstrumentation().getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("remoteControlEntry").performClick());
            awaitComputerState(activity, address, "Connected|已连接");
            var scroll = MainActivity.class.getDeclaredField("scroll"); scroll.setAccessible(true);
            getInstrumentation().runOnMainSync(() -> {
                try {
                    RefreshScrollView view = (RefreshScrollView) scroll.get(activity);
                    android.widget.TextView label = activity.getWindow().getDecorView().findViewWithTag("computerState:" + address);
                    pull(view, 35);
                    assertTrue("A pull below the threshold must not start a check", label.getText().toString().matches("Connected|已连接"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().runOnMainSync(() -> {
                try {
                    RefreshScrollView view = (RefreshScrollView) scroll.get(activity);
                    pull(view, 300 * activity.getResources().getDisplayMetrics().density);
                    android.widget.TextView label = activity.getWindow().getDecorView().findViewWithTag("computerState:" + address);
                    assertTrue("A pull on the computers page must start an active check, not just re-render",
                        label.getText().toString().matches("Checking…|正在检查…"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitComputerState(activity, address, "Connected|已连接");
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
            encrypted.clear();
        }
    }

    private void pull(RefreshScrollView view, float distance) {
        long time = android.os.SystemClock.uptimeMillis();
        float start = 20, end = start + distance;
        android.view.MotionEvent down = android.view.MotionEvent.obtain(time, time, android.view.MotionEvent.ACTION_DOWN, 20, start, 0);
        android.view.MotionEvent move = android.view.MotionEvent.obtain(time, time + 20, android.view.MotionEvent.ACTION_MOVE, 20, end, 0);
        android.view.MotionEvent up = android.view.MotionEvent.obtain(time, time + 40, android.view.MotionEvent.ACTION_UP, 20, end, 0);
        view.onInterceptTouchEvent(down);
        assertTrue("A downward drag from the top must be claimed by the refresh container", view.onInterceptTouchEvent(move));
        view.onTouchEvent(move); view.onTouchEvent(up);
        down.recycle(); move.recycle(); up.recycle();
    }

    private void awaitComputerState(MainActivity activity, String address, String states) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 15_000;
        java.util.concurrent.atomic.AtomicReference<String> seen = new java.util.concurrent.atomic.AtomicReference<>("");
        do {
            getInstrumentation().runOnMainSync(() -> {
                android.widget.TextView label = activity.getWindow().getDecorView().findViewWithTag("computerState:" + address);
                seen.set(label == null ? "" : label.getText().toString());
            });
            if (seen.get().matches(states)) return;
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.uptimeMillis() < deadline);
        assertEquals("The computer card must reflect a completed active check", states, seen.get());
    }

    private void awaitConversationCount(MainActivity activity, int expected) throws Exception {
        awaitConversationCount(activity, expected, 5000);
    }

    private void awaitConversationCount(MainActivity activity, int expected, long timeout) throws Exception {
        var conversations = MainActivity.class.getDeclaredField("conversations"); conversations.setAccessible(true);
        long deadline = android.os.SystemClock.uptimeMillis() + timeout;
        AtomicInteger count = new AtomicInteger();
        do {
            getInstrumentation().runOnMainSync(() -> {
                try { count.set(((java.util.Map<?, ?>) conversations.get(activity)).size()); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            if (count.get() == expected) return;
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.uptimeMillis() < deadline);
        assertEquals("The visible list must synchronize without a manual refresh", expected, count.get());
    }

    private JSONObject operation(String action, String instance) throws Exception {
        return new JSONObject().put("action", action).put("instanceId", instance).put("requestId", java.util.UUID.randomUUID().toString());
    }
}
