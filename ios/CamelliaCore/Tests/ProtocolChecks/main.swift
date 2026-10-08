// Executable protocol checks for CamelliaCore.
//
// The rules ported from the Android client are pure logic, so they must be
// testable without Xcode. `../check-protocol.sh` compiles this file together
// with Sources and runs it. When Xcode is available the same cases move into an
// XCTest target unchanged.
import CryptoKit
import Foundation

var checks = 0
var failures: [String] = []

func check(_ condition: Bool, _ label: String) {
    checks += 1
    if !condition { failures.append("\(label): condition was false") }
}

func checkEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
    checks += 1
    if actual != expected { failures.append("\(label): got \(actual), expected \(expected)") }
}

func checkThrows<E: Error & Equatable>(_ expected: E, _ label: String, _ body: () throws -> Void) {
    checks += 1
    do {
        try body()
        failures.append("\(label): threw nothing, expected \(expected)")
    } catch let error as E where error == expected {
        // expected
    } catch {
        failures.append("\(label): threw \(error), expected \(expected)")
    }
}

let uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
let hash64 = String(repeating: "a", count: 64)
let token43 = String(repeating: "A", count: 43)

// MARK: - Android JSON boolean semantics

do {
    let json = try! JSONBody.object(Data(
        #"{"truth":true,"falsehood":false,"numberOne":1,"numberZero":0,"textTrue":"TRUE","textFalse":"false","textOne":"1"}"#.utf8))
    check(json.bool("truth"), "a JSON true remains true")
    check(!json.bool("falsehood", fallback: true), "a JSON false overrides a true fallback")
    check(!json.bool("numberOne"), "Android optBoolean does not turn numeric one into true")
    check(json.bool("numberZero", fallback: true), "Android optBoolean leaves numeric zero at the caller's fallback")
    check(json.bool("textTrue"), "Android optBoolean accepts case-insensitive true text")
    check(!json.bool("textFalse", fallback: true), "Android optBoolean accepts false text")
    check(!json.bool("textOne"), "Android optBoolean does not turn text one into true")
    check(!RemoteSettings(JSONObject(dictionary: ["editable": 1])).editable,
          "numeric editable does not open the remote settings controls")
    check(!RemoteApproval(JSONObject(dictionary: ["actionable": 1])).actionable,
          "numeric actionable does not open the remote approval controls")
}

// MARK: - Android composer text rules

checkEqual(ComposerText.androidTrim(" \t\nhello\r "), "hello", "Java trim removes ASCII edge space")
checkEqual(ComposerText.androidTrim("\u{001F}hello\u{001F}"), "hello", "Java trim removes edge controls")
checkEqual(ComposerText.androidTrim("\u{00A0}hello\u{00A0}"), "\u{00A0}hello\u{00A0}",
           "Java trim preserves non-breaking spaces")
checkEqual(ComposerText.remotePrompt("  code\n", chinese: false), "  code\n",
           "remote send preserves the full typed draft")
checkEqual(ComposerText.remotePrompt(" \r\n", chinese: false), "Please review these attachments.",
           "English attachment-only prompt")
checkEqual(ComposerText.remotePrompt(" \r\n", chinese: true), "请查看这些附件。",
           "Chinese attachment-only prompt")
checkEqual(ComposerText.remotePrompt("\u{00A0}", chinese: false), "\u{00A0}",
           "non-breaking space is content on Android")
check(!ComposerText.remoteHasMessage(composed: "/status", hasAttachments: false),
      "unsupported bare slash without attachments is disabled")
check(ComposerText.remoteHasMessage(composed: "/status", hasAttachments: true),
      "attachment permits a bare slash as ordinary text")
check(ComposerText.remoteHasMessage(composed: "/find", hasAttachments: false),
      "bare find is a valid remote request")
check(ComposerText.remoteHasMessage(composed: "", hasAttachments: true),
      "attachments alone enable a remote message")
check(!ComposerText.remoteHasMessage(composed: "", hasAttachments: false),
      "blank draft without attachments is disabled")
check(ComposerText.remoteHasMessage(composed: "\u{00A0}", hasAttachments: false),
      "non-breaking space is not blank under Java trim")
checkEqual(ComposerText.localTitle("", chinese: false), "Attachments",
           "English attachment-only local title")
checkEqual(ComposerText.localTitle("", chinese: true), "附件",
           "Chinese attachment-only local title")
checkEqual(ComposerText.localTitle("one\ntwo", chinese: false), "one two",
           "local title replaces line breaks")
checkEqual(ComposerText.localTitle(String(repeating: "x", count: 61), chinese: false),
           String(repeating: "x", count: 60), "local title is capped like Android")
checkEqual(ComposerText.localTitle(String(repeating: "x", count: 59) + "🐱z", chinese: false),
           String(repeating: "x", count: 59), "local title never saves half an emoji")
checkEqual(ComposerText.utf16Length("🐱"), 2, "Java field length counts an emoji as two units")
checkEqual(ComposerText.utf16Length("e\u{0301}"), 2,
           "Java field length counts a combining mark separately")
checkEqual(ComposerText.limited("ab🐱c", to: 4), "ab🐱",
           "Android field cap accepts an emoji when both units fit")
checkEqual(ComposerText.limited("abc🐱z", to: 4), "abc",
           "Android field cap does not save half an emoji")
checkEqual(ComposerText.limited("e\u{0301}z", to: 2), "e\u{0301}",
           "Android field cap uses UTF-16 rather than grapheme count")
check(ComposerText.localSearchMatches(title: "hello world", query: " "),
      "local search keeps a typed space as the query")
check(!ComposerText.localSearchMatches(title: "helloworld", query: " "),
      "local search does not turn a space query into an empty query")

// MARK: - Endpoint: accepted addresses

for (accepted, expected) in [
    ("http://100.64.0.1:43127", "http://100.64.0.1:43127"),
    ("http://100.127.255.255:65535", "http://100.127.255.255:65535"),
    ("http://100.100.100.100:1", "http://100.100.100.100:1"),
    ("http://100.64.0.1:43127/", "http://100.64.0.1:43127"),      // one trailing slash is tolerated
    ("  http://100.64.0.1:43127  ", "http://100.64.0.1:43127"),   // surrounding whitespace is trimmed
] {
    do {
        let endpoint = try Endpoint(accepted)
        checkEqual(endpoint.origin, expected, "accept \(accepted)")
    } catch {
        checks += 1
        failures.append("accept \(accepted): threw \(error)")
    }
}

do {
    let endpoint = try Endpoint("http://100.64.0.1:04312")
    checkEqual(endpoint.origin, "http://100.64.0.1:4312", "leading zeros in the port normalise away")
} catch {
    checks += 1
    failures.append("leading-zero port: threw \(error)")
}

// MARK: - Endpoint: malformed shapes

for malformed in [
    "https://100.64.0.1:43127",       // scheme must be http
    "100.64.0.1:43127",               // scheme is required
    "http://100.64.0.1",              // port is required
    "http://100.64.0.1:",             // empty port
    "http://100.64.0.1:43127/path",   // no path travel
    "http://100.64.0.1:43127//",      // only one trailing slash
    "http://100.64.0.1:1a",           // port is decimal
    "http://100.064.0.1:43127",       // no leading zeros in an octet
    "http://100.64.0.1:431270",       // five digits at most
    "http://example.com:43127",       // no hostnames
    "http://user@100.64.0.1:43127",   // no user info
    "http://101.64.0.1:43127",        // outside the Tailscale block
    "http://100.200.0.1:43127",       // three-digit octet must start with 1
    "http://100.64.0.1:43127?x=1",    // no query
] {
    checkThrows(EndpointError.malformedAddress, "reject \(malformed)") { _ = try Endpoint(malformed) }
}

// MARK: - Endpoint: range violations

for outOfRange in [
    "http://100.63.0.1:43127",        // below 100.64.0.0/10
    "http://100.128.0.1:43127",       // above 100.127.255.255
    "http://100.199.0.1:43127",       // shape is legal, block is not
    "http://100.64.0.256:43127",      // octet out of range
    "http://100.64.300.1:43127",      // octet out of range
    "http://100.64.0.1:0",            // port 0
    "http://100.64.0.1:65536",        // port above 65535
    "http://100.64.0.1:99999",        // port above 65535
] {
    checkThrows(EndpointError.notTailnet, "reject \(outOfRange)") { _ = try Endpoint(outOfRange) }
}

// MARK: - Endpoint: path allowlist

let endpoint = try Endpoint("http://100.64.0.1:43127")
for path in [
    "/v1/status",
    "/v1/commands",
    "/v1/pair/request",
    "/v1/pair/claim",
    "/v1/api-keys",
    "/v1/conversations",
    "/v1/conversations?offset=0",
    "/v1/conversations?offset=123456789012",
    "/v1/conversations/events",
    "/v1/conversations/\(uuid)",
    "/v1/conversations/\(uuid)/events",
    "/v1/conversations/\(uuid)/commands",
    "/v1/conversations/\(uuid)/read",
    "/v1/conversations/\(uuid)/artifacts",
    "/v1/conversations/\(uuid)/artifacts/\(hash64)",
    "/v1/conversations/\(uuid)?before=42",
] {
    check(endpoint.isAllowed(path: path), "allow \(path)")
}

for path in [
    "/v1",                                   // not an endpoint
    "/v1/status/",                           // no trailing slash
    "/v1/STATUS",                            // case matters
    "/v1/api-import",                        // desktop-only control endpoints
    "/v1/native-settings/read",
    "/v1/server-management",
    "/v1/conversations/\(uuid)/read/",        // no trailing slash on the read cursor either
    "/v1/conversations/notauuid/events",     // ids are 36 hex characters
    "/v1/conversations/\(String(uuid.dropLast()))",   // too short
    "/v1/conversations/\(uuid)/artifacts/\(String(hash64.dropLast()))", // hash is 64 characters
    "/v1/conversations?offset=1234567890123",          // offset is at most 12 digits
    "/v1/conversations?after=1",                       // only offset and before
    "/v1/conversations/\(uuid)/artifacts?x=1",
] {
    check(!endpoint.isAllowed(path: path), "refuse \(path)")
}

checkThrows(EndpointError.unsupportedPath, "url() enforces the allowlist") {
    _ = try endpoint.url("/v1/api-import")
}
checkEqual(try endpoint.url("/v1/status").absoluteString, "http://100.64.0.1:43127/v1/status", "url() builds from the origin")

// MARK: - Pairing payload

let goodCode = "abcdef0123456789abcdef01"
let goodPayload = #"{"v":1,"type":"camellia-pair","address":"http://100.64.0.1:43127","code":"ABCDEF0123456789ABCDEF01","name":"Cheng PC"}"#
do {
    let payload = try PairingPayload(goodPayload)
    checkEqual(payload.address, "http://100.64.0.1:43127", "pairing address is normalised")
    checkEqual(payload.code, goodCode, "pairing code is lower-cased")
    checkEqual(payload.computerName, "Cheng PC", "pairing name is kept")
} catch {
    checks += 1
    failures.append("valid pairing payload: threw \(error)")
}

do {
    let payload = try PairingPayload(#"{"type":"camellia-pair","v":"1","address":"http://100.64.0.1:43127","code":"\#(goodCode)"}"#)
    checkEqual(payload.computerName, "", "a missing name is empty")
    checkEqual(payload.code, goodCode, "a string version is accepted")
} catch {
    checks += 1
    failures.append("string version: threw \(error)")
}

// Whitespace, newlines and a trailing comma are tolerated; later keys win.
do {
    let payload = try PairingPayload(#"""
    {
      "type" : "camellia-pair" ,
      "v": 1,
      "address": "http://100.64.0.1:43127",
      "code": "\#(goodCode)",
      "type": "camellia-pair",
    }
    """#)
    checkEqual(payload.code, goodCode, "trailing comma and lenient whitespace")
} catch {
    checks += 1
    failures.append("lenient whitespace: threw \(error)")
}

do {
    let payload = try PairingPayload(#"{"type":"camellia-pair","v":1,"address":"http://100.64.0.1:43127","code":"\#(goodCode)","name":"a\u0041\nb"}"#)
    checkEqual(payload.computerName, "aA\nb", "escapes are decoded")
} catch {
    checks += 1
    failures.append("escapes: threw \(error)")
}

for (text, expected) in [
    ("{}", PairingError.notCamellia),
    (#"{"type":"other","v":1,"address":"http://100.64.0.1:43127","code":"\#(goodCode)"}"#, PairingError.notCamellia),
    (#"{"type":"camellia-pair","v":2,"address":"http://100.64.0.1:43127","code":"\#(goodCode)"}"#, PairingError.unsupportedVersion),
    (#"{"type":"camellia-pair","v":"01","address":"http://100.64.0.1:43127","code":"\#(goodCode)"}"#, PairingError.unsupportedVersion),
    (#"{"type":"camellia-pair","v":1,"code":"\#(goodCode)"}"#, PairingError.incomplete),
    (#"{"type":"camellia-pair","v":1,"address":"http://10.0.0.1:43127","code":"\#(goodCode)"}"#, PairingError.invalidAddress),
    (#"{"type":"camellia-pair","v":1,"address":"http://100.64.0.1:43127","code":"\#(String(goodCode.dropLast()))"}"#, PairingError.invalidCode),
    (#"{"type":"camellia-pair","v":1,"address":"http://100.64.0.1:43127","code":"\#(String(goodCode.dropLast()) + "g")"}"#, PairingError.invalidCode),
    (#"{"type":"camellia-pair","v":1,"address":"http://100.64.0.1:43127","code":"\#(goodCode)","nested":{"a":"b"}}"#, PairingError.flatValuesOnly),
    (#"{"type":"camellia-pair","v":1,"address":"http://100.64.0.1:43127","code":"\#(goodCode)","list":[1]}"#, PairingError.flatValuesOnly),
    (#"{1:"a"}"#, PairingError.keysMustBeStrings),
    (#"{"type":"camellia-pair""#, PairingError.notAnObject),
    (#"{"type":"camellia-pair" "v":"1"}"#, PairingError.malformed),
    (#"{"name":"unterminated}"#, PairingError.unterminatedString),
    ("not json at all", PairingError.notAnObject),
] {
    checkThrows(expected, "pairing reject \(text.prefix(48))") { _ = try PairingPayload(text) }
}
checkThrows(PairingError.empty, "pairing reject nil") { _ = try PairingPayload(nil) }

// MARK: - SSE reader

func snapshots(from stream: String, chunkSize: Int) throws -> [String] {
    var reader = SseReader()
    var found: [String] = []
    let bytes = Array(stream.utf8)
    var index = 0
    while index < bytes.count {
        let end = min(index + chunkSize, bytes.count)
        found += try reader.consume(bytes[index..<end])
        index = end
    }
    return found
}

let stream = "event: snapshot\ndata: {\"revision\":1}\n\n"
checkEqual(try snapshots(from: stream, chunkSize: 4096), [#"{"revision":1}"#], "one snapshot")

let crlf = "event: snapshot\r\ndata: {\"a\":1}\r\n\r\n"
checkEqual(try snapshots(from: crlf, chunkSize: 4096), [#"{"a":1}"#], "CRLF line endings")

let multi = "event: snapshot\ndata: line1\ndata: line2\n\n"
checkEqual(try snapshots(from: multi, chunkSize: 4096), ["line1\nline2"], "multi-line data joins with LF")

let heartbeat = "event: heartbeat\ndata: {}\n\nevent: snapshot\ndata: {\"ok\":true}\n\n"
checkEqual(try snapshots(from: heartbeat, chunkSize: 4096), [#"{"ok":true}"#], "only snapshot events are emitted")

checkEqual(try snapshots(from: "event: snapshot\ndata: {\"cut\":", chunkSize: 4096), [], "a truncated final line is not emitted")
checkEqual(try snapshots(from: "", chunkSize: 4096), [], "an empty stream emits nothing")

// A multi-byte character split across chunks must survive, and any chunk size
// must produce the same snapshot.
let unicode = "event: snapshot\ndata: {\"t\":\"脑网络 Ǆ 𝄞\"}\n\n"
let expectedUnicode = #"{"t":"脑网络 Ǆ 𝄞"}"#
checkEqual(try snapshots(from: unicode, chunkSize: 4096), [expectedUnicode], "unicode snapshot")
for size in 1...7 {
    checkEqual(try snapshots(from: unicode, chunkSize: size), [expectedUnicode], "unicode snapshot split every \(size) byte(s)")
}

// Android's Reader/StringBuilder limit UTF-16 code units, not UTF-8 bytes.
// These are below its 8M-character cap even though their wire size exceeds 8 MiB.
let largeUnicode = String(repeating: "界", count: 2_800_000)
let largeLine = try? snapshots(from: "event: snapshot\ndata: " + largeUnicode + "\n\n", chunkSize: 65_536)
check(largeLine?.first == largeUnicode, "a multi-byte SSE line below Android's character cap is accepted")
let linePart = String(repeating: "界", count: 1_500_000)
let largeEvent = try? snapshots(from: "event: snapshot\ndata: " + linePart + "\ndata: " + linePart + "\n\n",
                                chunkSize: 65_536)
check(largeEvent?.first == linePart + "\n" + linePart,
      "a multi-line SSE event below Android's character cap is accepted")

// MARK: - Redaction

checkEqual(Redaction.clean("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"), "Authorization: Bearer [redacted]", "bearer token redacted")
checkEqual(Redaction.clean("key sk-abcdef0123456789 leaked"), "key [redacted] leaked", "sk- key redacted")
checkEqual(Redaction.clean("token \(token43) end"), "token [redacted] end", "43-character token redacted")
checkEqual(Redaction.clean("  line one\n\n  line two  "), "line one line two", "whitespace collapsed and trimmed")
checkEqual(Redaction.clean(nil), "", "nil cleans to empty")
checkEqual(Redaction.clean(String(repeating: "x", count: 5000)).count, 4097, "long text is capped and ellipsised")

// MARK: - Failure messages

check(RemoteFailure.httpMessage(status: 401, detail: "", chinese: false).contains("[HTTP 401]"), "401 carries its status")
check(RemoteFailure.httpMessage(status: 401, detail: "", chinese: true).contains("重新配对"), "401 is bilingual")
check(RemoteFailure.httpMessage(status: 503, detail: "", chinese: false).contains("desktop service is unavailable"), "503 explains the gateway")
check(RemoteFailure.httpMessage(status: 418, detail: "boom", chinese: false).contains("Desktop detail: boom"), "detail is appended")
check(RemoteFailure.httpMessage(status: 418, detail: "Bearer \(token43)", chinese: false).contains("Bearer [redacted]"), "detail is redacted")

checkEqual(ConnectionFailureCode.parse("CAMELLIA_CONNECT_TIMEOUT"), .connectTimeout, "bridge code parsed")
checkEqual(ConnectionFailureCode.parse("ConnectException"), nil, "non-bridge text is not a code")
checkEqual(ConnectionFailureCode.message(for: .loginRequired), "CAMELLIA_LOGIN_REQUIRED", "bridge code rendered")
checkEqual(ConnectionFailureCode.classify(message: "CAMELLIA_NETWORK_STOPPED", online: true), .networkStopped, "stopped network classified")
checkEqual(ConnectionFailureCode.classify(message: nil, online: false), .offline, "no local network wins")
checkEqual(ConnectionFailureCode.classify(message: "Invalid snapshot", online: true), .protocolError, "protocol errors classified")
checkEqual(ConnectionFailureCode.classify(message: "Invalid device credential", online: true), .invalidCredential, "credential errors classified")
checkEqual(ConnectionFailureCode.classify(message: "embedded network closed", online: true), .cancelled, "closed bridge is a cancellation")
checkEqual(ConnectionFailureCode.classify(message: "something else", online: true), .connectionFailed, "unknown failures are undetermined")
checkEqual(ConnectionFailureCode.allCases.count, 17, "every Android failure code is ported")
check(ConnectionFailureCode.loginRequired.text(chinese: true).hasSuffix("[LOGIN_REQUIRED]"), "text carries the code suffix")

// MARK: - Credential shape

check(Credential.isDeviceToken(token43), "43 base64url characters is a device token")
check(!Credential.isDeviceToken(String(token43.dropLast())), "42 characters is not")
check(!Credential.isDeviceToken(String(repeating: "A", count: 42) + "!"), "a non-base64url character is not")

// MARK: - Remote transcript
//
// The merge rules are where a snapshot-based protocol quietly goes wrong: get
// them wrong and the user sees a duplicated or missing message with no error
// anywhere. They are checked against the same cases the Android client has to
// survive.

func remoteSnapshot(_ text: String) -> RemoteSnapshot {
    RemoteSnapshot(try! JSONBody.object(Data(text.utf8)))
}

do {
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"permission\":\"control\",\"nextBefore\":0,"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"private\"}],"
        + "\"live\":{\"text\":\"working\"}}"
    ))
    checkEqual(transcript.messages.count, 1, "access-loss fixture starts with a visible message")
    check(transcript.live != nil && transcript.hasOlder && transcript.connected,
          "access-loss fixture starts with live content and an older-page cursor")
    transcript.hideMessagesAfterAccessFailure()
    check(transcript.messages.isEmpty && transcript.pendingProcess.isEmpty,
          "a terminal access loss removes cached messages and tool rows")
    check(transcript.live == nil && !transcript.hasOlder && transcript.connected,
          "a refused one-shot request clears content without disconnecting a live stream")
    transcript.suspend()
    check(!transcript.connected, "a terminal stream failure withdraws control separately")
}

do {
    let transcript = RemoteTranscript()

    // A first snapshot is taken whole.
    check(transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":5,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"},{\"seq\":2,\"role\":\"assistant\",\"text\":\"b\"}]}"
    )), "a fresh snapshot is accepted")
    checkEqual(transcript.messages.map { $0.message.seq }, [1, 2], "both rows land")

    // An explicit null means the desktop holds nothing older, so the row behind
    // the page was replaced and must not survive beside its replacement.
    check(transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":6,\"nextBefore\":null,\"messages\":[{\"seq\":2,\"role\":\"assistant\",\"text\":\"b2\"},{\"seq\":3,\"role\":\"assistant\",\"text\":\"c\"}]}"
    )), "a later snapshot is accepted")
    checkEqual(transcript.messages.map { $0.message.seq }, [2, 3], "rows behind the page are dropped when the desktop says nothing older exists")
    checkEqual(transcript.messages.first?.message.text ?? "", "b2", "the replacement wins over the cached copy")
}

do {
    // A desktop that never mentions paging counts as still holding earlier
    // pages. This is the case that quietly loses history when the flag is read
    // the other way round, so it gets its own case.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"},{\"seq\":2,\"role\":\"assistant\",\"text\":\"b\"}]}"
    ))
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"messages\":[{\"seq\":3,\"role\":\"assistant\",\"text\":\"c\"},{\"seq\":4,\"role\":\"assistant\",\"text\":\"d\"}]}"
    ))
    checkEqual(transcript.messages.map { $0.message.seq }, [1, 2, 3, 4], "a missing nextBefore keeps older rows")
}

do {
    // Same shape, but the desktop reports a cursor: still no deletion of rows
    // behind the page.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"},{\"seq\":2,\"role\":\"assistant\",\"text\":\"b\"}]}"
    ))
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"messages\":[{\"seq\":3,\"role\":\"assistant\",\"text\":\"c\"}],\"nextBefore\":1}"
    ))
    checkEqual(transcript.messages.map { $0.message.seq }, [1, 2, 3], "older rows survive when the desktop still holds them")
}

do {
    // Android's preloaded detail draws cached rows only. It deliberately does
    // not revive an old approval, goal, queue or editable settings panel while
    // waiting for the live stream to establish current permission.
    let transcript = RemoteTranscript()
    transcript.showPrefetched(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":5,\"permission\":\"control\",\"settings\":{\"editable\":true},"
        + "\"live\":{},\"automation\":{\"goal\":{\"id\":\"g1\",\"phase\":\"active\"}},"
        + "\"queue\":[{\"id\":\"q1\"}],\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"cached\"}]}"
    ))
    checkEqual(transcript.messages.map { $0.message.seq }, [1], "preloading draws the cached history")
    check(!transcript.connected, "preloading does not establish a live connection")
    check(transcript.permission == nil, "preloading does not grant cached control")
    check(transcript.settings == nil, "preloading does not restore cached settings")
    check(transcript.live == nil, "preloading does not restore a cached reply")
    check(transcript.automation == nil, "preloading does not restore cached automation")
    check(!transcript.canQueue && transcript.queue.isEmpty, "preloading does not restore the cached queue")
}

do {
    // An empty page behind which nothing exists means the desktop has no rows
    // at all, so everything cached was replaced.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"))
    _ = transcript.apply(remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":2,\"nextBefore\":null,\"messages\":[]}"))
    checkEqual(transcript.messages.count, 0, "an empty page with nothing older clears the transcript")
}

do {
    // Android applies permission and settings before checking for a messages
    // array, but leaves the rendered history, live reply, queue and automation
    // alone if that array is absent. An explicit empty array is different.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"permission\":\"control\",\"settings\":{\"version\":\"s1\",\"editable\":true},"
        + "\"automation\":{\"goal\":{\"id\":\"g1\",\"objective\":\"ship\",\"phase\":\"active\",\"armed\":true}},"
        + "\"live\":{},\"queue\":[{\"id\":\"q1\",\"text\":\"next\"}],\"queueVersion\":5,"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}],\"nextBefore\":3}"
    ))
    let partial = remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":2,\"permission\":\"read\",\"queue\":[]}")
    check(!partial.hasMessages, "a snapshot without a messages array is recognized as partial")
    _ = transcript.apply(partial)
    checkEqual(transcript.messages.map { $0.message.seq }, [1], "a partial snapshot retains rendered history")
    checkEqual(transcript.nextBefore, 3, "a partial snapshot retains the paging cursor")
    checkEqual(transcript.permission, .read, "a partial snapshot still revokes control")
    checkEqual(transcript.settings?.editable, nil, "a missing settings object revokes the stale edit option")
    checkEqual(transcript.queue.map(\.id), ["q1"], "a partial snapshot does not replace the rendered queue")
    checkEqual(transcript.automation?.goal?.id, "g1", "a partial snapshot does not replace the rendered goal")
    check(transcript.live != nil, "a partial snapshot does not replace the rendered live reply")

    let full = remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":3,\"permission\":\"read\",\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"
    )
    check(full.hasMessages, "a snapshot with a messages array is recognized as complete")
    _ = transcript.apply(full)
    checkEqual(transcript.automation?.goal?.id, nil, "a complete snapshot without automation removes the old goal")
    check(!transcript.showsGoal, "a removed goal is not displayed")
    check(transcript.live == nil, "a complete snapshot without live removes the old reply")
    check(!transcript.canQueue, "a complete snapshot without queue removes queue capability")
}

do {
    // The paging cursor is only adopted while the oldest cached row sits at or
    // behind the page; otherwise it would point into rows already on screen.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":5,\"role\":\"user\",\"text\":\"e\"},{\"seq\":6,\"role\":\"assistant\",\"text\":\"f\"}]}"
    ))
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"messages\":[{\"seq\":5,\"role\":\"user\",\"text\":\"e\"},{\"seq\":6,\"role\":\"assistant\",\"text\":\"f\"},{\"seq\":7,\"role\":\"assistant\",\"text\":\"g\"}],\"nextBefore\":4}"
    ))
    checkEqual(transcript.nextBefore, 4, "the paging cursor is kept when the oldest row is inside the page")
}

do {
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":9,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"))
    // A cursor that moves backwards is a retransmit, not news.
    check(!transcript.apply(remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":4,\"messages\":[{\"seq\":9,\"role\":\"user\",\"text\":\"z\"}]}")),
          "an out-of-order cursor is discarded")
    checkEqual(transcript.messages.map { $0.message.seq }, [1], "the stale snapshot changed nothing")
}

do {
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"))
    // A different instance is a restarted desktop: cached rows describe a
    // session that no longer exists.
    _ = transcript.apply(remoteSnapshot("{\"instanceId\":\"B\",\"cursor\":1,\"messages\":[{\"seq\":7,\"role\":\"user\",\"text\":\"g\"}]}"))
    checkEqual(transcript.messages.map { $0.message.seq }, [7], "an instance switch clears the cached session")
}

// MARK: - Older pages

do {
    // Reconnecting the same detail keeps the pages the person already loaded,
    // but Android disables controls until a fresh snapshot has arrived.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":5,\"permission\":\"control\",\"messages\":[{\"seq\":5,\"role\":\"user\",\"text\":\"e\"},{\"seq\":6,\"role\":\"assistant\",\"text\":\"f\"}],\"nextBefore\":4}"
    ))
    checkEqual(transcript.permission, .control, "detail control follows the snapshot permission")
    _ = transcript.mergeOlder(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":4,\"messages\":[{\"seq\":3,\"role\":\"user\",\"text\":\"c\"},{\"seq\":4,\"role\":\"assistant\",\"text\":\"d\"}],\"nextBefore\":2}"
    ))
    transcript.suspend()
    check(!transcript.connected, "a reconnect disables actions until a new snapshot")
    checkEqual(transcript.permission, .control, "a reconnect keeps the last displayed permission as data")
    checkEqual(transcript.messages.map { $0.message.seq }, [3, 4, 5, 6],
               "a reconnect keeps previously loaded history")
    checkEqual(transcript.nextBefore, 2, "a reconnect keeps the earlier-page cursor")
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":6,\"permission\":\"read\",\"messages\":[{\"seq\":5,\"role\":\"user\",\"text\":\"e\"},{\"seq\":6,\"role\":\"assistant\",\"text\":\"f2\"}],\"nextBefore\":4}"
    ))
    check(transcript.connected, "a fresh snapshot restores controls")
    checkEqual(transcript.permission, .read, "revoked control is reflected without a list refresh")
    checkEqual(transcript.messages.map { $0.message.seq }, [3, 4, 5, 6],
               "a fresh page still preserves the previously loaded older rows")
}

do {
    // An earlier page is folded in by seq, with no supersede: its first seq is
    // smaller than anything cached, so `apply` would delete the newer rows the
    // person is reading. `mergeOlder` must add the older rows and keep the rest.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":5,\"messages\":[{\"seq\":5,\"role\":\"user\",\"text\":\"e\"},{\"seq\":6,\"role\":\"assistant\",\"text\":\"f\"}],\"nextBefore\":4}"
    ))
    check(transcript.hasOlder, "a page with a cursor offers to load earlier")
    check(transcript.mergeOlder(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":4,\"messages\":[{\"seq\":3,\"role\":\"user\",\"text\":\"c\"},{\"seq\":4,\"role\":\"assistant\",\"text\":\"d\"}],\"nextBefore\":2}"
    )), "an earlier page merges")
    checkEqual(transcript.messages.map { $0.message.seq }, [3, 4, 5, 6], "the earlier rows are added and the newer rows kept")
    checkEqual(transcript.nextBefore, 2, "and the cursor advances to the page's own cursor")
}

do {
    // The final page carries a null cursor, so nothing older exists and the
    // control has to stop offering.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":4,\"messages\":[{\"seq\":4,\"role\":\"assistant\",\"text\":\"d\"}],\"nextBefore\":2}"
    ))
    check(transcript.hasOlder, "the first page has more behind it")
    _ = transcript.mergeOlder(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"messages\":[{\"seq\":2,\"role\":\"assistant\",\"text\":\"b\"}],\"nextBefore\":null}"
    ))
    checkEqual(transcript.nextBefore, nil, "a null cursor means the earliest page")
    check(!transcript.hasOlder, "and nothing older is offered after it")
}

do {
    // A page from another desktop instance is a restarted session: merging it
    // would splice two conversations together.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":5,\"messages\":[{\"seq\":5,\"role\":\"user\",\"text\":\"e\"}],\"nextBefore\":4}"
    ))
    check(!transcript.mergeOlder(remoteSnapshot(
        "{\"instanceId\":\"B\",\"cursor\":4,\"messages\":[{\"seq\":9,\"role\":\"user\",\"text\":\"z\"}],\"nextBefore\":2}"
    )), "an earlier page from another instance is refused")
    checkEqual(transcript.messages.map { $0.message.seq }, [5], "and nothing was spliced in")
}

do {
    // Past the local cap the phone stops offering to page: the desktop's cursor
    // would point into rows the phone has dropped.
    let transcript = RemoteTranscript()
    let rows = (1...700).map { "{\"seq\":\($0),\"role\":\"assistant\",\"text\":\"m\"}" }.joined(separator: ",")
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":700,\"messages\":[\(rows)],\"nextBefore\":1}"
    ))
    check(!transcript.hasOlder, "an evicted transcript stops offering earlier pages")
    check(transcript.mergeOlder(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"assistant\",\"text\":\"m\"}],\"nextBefore\":null}"
    )), "an earlier page still merges after a trim")
    check(!transcript.hasOlder, "but the control stays off after the trim")
}

// MARK: - Scroll follow

do {
    // The rule Android applies per update is
    // `content.bottom - viewport.bottom < dp(120)`, so the threshold and the
    // direction of the subtraction are both load-bearing.
    checkEqual(ScrollFollow.threshold, 120, "the follow threshold is Android's dp(120)")

    let fresh = ScrollFollowTracker()
    check(fresh.isAtBottom, "a tracker nobody has measured yet follows")

    let half = ScrollFollowTracker()
    half.updateViewport(800)
    check(half.isAtBottom, "one edge on its own is not enough to stop following")

    // Sitting exactly at the end: the two edges coincide.
    let resting = ScrollFollowTracker()
    resting.updateViewport(800)
    resting.updateContent(800)
    check(resting.isAtBottom, "content ending at the viewport bottom follows")

    // Shorter than the viewport: the content's end is above the viewport's, and
    // there is nothing below to read.
    let short = ScrollFollowTracker()
    short.updateViewport(800)
    short.updateContent(650)
    check(short.isAtBottom, "content shorter than the viewport follows")

    // Scrolled up by less than the threshold still counts as following…
    let justUnder = ScrollFollowTracker()
    justUnder.updateViewport(800)
    justUnder.updateContent(919)
    check(justUnder.isAtBottom, "119 points up is still following")

    // …and at or beyond it does not. The comparison is strict, so 120 is out.
    let atLimit = ScrollFollowTracker()
    atLimit.updateViewport(800)
    atLimit.updateContent(920)
    check(!atLimit.isAtBottom, "120 points up has stopped following")

    let wellUp = ScrollFollowTracker()
    wellUp.updateViewport(800)
    wellUp.updateContent(1100)
    check(!wellUp.isAtBottom, "reading 300 points up has stopped following")

    // Coming back down restores it, in the order the two probes may arrive.
    let returning = ScrollFollowTracker()
    returning.updateViewport(800)
    returning.updateContent(1100)
    check(!returning.isAtBottom, "up first, then…")
    returning.updateViewport(799)
    returning.updateContent(800)
    check(returning.isAtBottom, "…back at the end follows again")

    // A deliberate move to the end follows before the geometry catches up.
    let forced = ScrollFollowTracker()
    forced.updateViewport(800)
    forced.updateContent(1200)
    check(!forced.isAtBottom, "reading far up stops following")
    forced.following()
    check(forced.isAtBottom, "sending forces the next growth to be followed")
}

// MARK: - Message queue

do {
    // The queue is only offered by a desktop that sends the field at all: an
    // older one refuses `queue: true` as an unknown option, so the composer must
    // not offer to enqueue against it.
    let transcript = RemoteTranscript()
    checkEqual(transcript.canQueue, false, "a desktop that says nothing about a queue does not have one")
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"
    ))
    checkEqual(transcript.canQueue, false, "a snapshot without a queue field leaves the feature off")

    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"queue\":[{\"id\":\"q1\",\"text\":\"first\",\"state\":\"queued\",\"attachments\":[{\"name\":\"a.jpg\"},{\"name\":\"b.pdf\"}]}],"
        + "\"queueVersion\":10,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"
    ))
    checkEqual(transcript.canQueue, true, "a queue field turns the feature on")
    checkEqual(transcript.queue.count, 1, "the queued message is kept")
    checkEqual(transcript.queue.first?.attachmentCount ?? -1, 2, "the attachment count is read")
    checkEqual(transcript.queueVersion, 10, "the queue revision is kept")

    // A snapshot from a desktop that has not caught up must not restore entries
    // the newer one already removed.
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":3,\"queue\":[],\"queueVersion\":9,"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"
    ))
    checkEqual(transcript.queue.count, 1, "an older queue revision is ignored")

    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":4,\"queue\":[],\"queueVersion\":11,"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"a\"}]}"
    ))
    checkEqual(transcript.queue.count, 0, "a newer queue revision is taken")
}

// MARK: - Goal visibility

do {
    // A goal that is still live is always shown.
    var visibility = RemoteGoalVisibility()
    checkEqual(visibility.show(key: "g1", phase: "active", completedAt: 0,
                               latestUserSeq: 5, latestUserAt: 500), true,
               "a running goal is shown")

    // Completion is shown until the user says something newer than it.
    checkEqual(visibility.show(key: "g1", phase: "complete", completedAt: 900,
                               latestUserSeq: 5, latestUserAt: 500), true,
               "a fresh completion is shown")
    checkEqual(visibility.show(key: "g1", phase: "complete", completedAt: 900,
                               latestUserSeq: 6, latestUserAt: 1000), false,
               "a completion behind the newest user turn is dismissed")
}

do {
    // An older desktop dates nothing: a completion the phone never saw running
    // must not reappear on every open.
    var visibility = RemoteGoalVisibility()
    checkEqual(visibility.show(key: "g1", phase: "complete", completedAt: 0,
                               latestUserSeq: 5, latestUserAt: 500), false,
               "an undated completion nobody watched finish stays hidden")

    // But one watched finish is shown, and dismissed once a newer turn arrives.
    var watched = RemoteGoalVisibility()
    _ = watched.show(key: "g1", phase: "active", completedAt: 0, latestUserSeq: 5, latestUserAt: 500)
    checkEqual(watched.show(key: "g1", phase: "complete", completedAt: 0,
                            latestUserSeq: 5, latestUserAt: 500), true,
               "a completion we watched happen is shown")
    checkEqual(watched.show(key: "g1", phase: "complete", completedAt: 0,
                            latestUserSeq: 6, latestUserAt: 900), false,
               "and is dismissed by the next user turn")

    // A different goal starts over rather than inheriting the dismissal.
    checkEqual(watched.show(key: "g2", phase: "active", completedAt: 0,
                            latestUserSeq: 6, latestUserAt: 900), true,
               "a new goal is not covered by the last one's dismissal")
    // An absent goal clears the state entirely.
    checkEqual(watched.show(key: "", phase: "", completedAt: 0,
                            latestUserSeq: 6, latestUserAt: 900), false,
               "no goal means nothing to show")
    checkEqual(watched.show(key: "g2", phase: "active", completedAt: 0,
                            latestUserSeq: 6, latestUserAt: 900), true,
               "after an absent goal, a live one is shown again")
}

do {
    // The transcript drives the same rule from the snapshot's own goal.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"automation\":{\"goal\":{\"id\":\"g1\",\"objective\":\"ship it\",\"phase\":\"active\",\"armed\":true,\"roundsStarted\":3}},"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"go\"}]}"
    ))
    checkEqual(transcript.showsGoal, true, "a live goal from the snapshot is shown")
    checkEqual(transcript.automation?.goal?.isRunning ?? false, true, "an armed active goal reads as running")

    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"automation\":{\"goal\":{\"id\":\"g1\",\"objective\":\"ship it\",\"phase\":\"complete\",\"armed\":false,\"completedAt\":100,\"roundsStarted\":3},"
        + "\"tasks\":[{\"id\":\"t1\",\"instruction\":\"poll\",\"status\":\"paused\",\"intervalMinutes\":30}]},"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"go\",\"at\":50}]}"
    ))
    checkEqual(transcript.showsGoal, true, "a completion newer than the last turn is shown")
    checkEqual(transcript.automation?.tasks.count ?? 0, 1, "the scheduled task is kept")
    checkEqual(transcript.automation?.tasks.first?.isPaused ?? false, true, "a paused task reads as paused")

    transcript.reset()
    checkEqual(transcript.showsGoal, false, "resetting clears the goal")
    checkEqual(transcript.canQueue, false, "resetting clears the queue capability")
}

do {
    let transcript = RemoteTranscript()
    // A tool row contributes steps but no prose; the assistant that follows
    // inherits them, because the desktop attaches process to the run not to
    // every row.
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":["
        + "{\"seq\":1,\"role\":\"user\",\"text\":\"go\"},"
        + "{\"seq\":2,\"role\":\"tool\",\"text\":\"\",\"process\":[{\"type\":\"tool\",\"title\":\"web_search\",\"status\":\"completed\"}]},"
        + "{\"seq\":3,\"role\":\"assistant\",\"text\":\"done\"}]}"
    ))
    checkEqual(transcript.messages.map(\.id), [1, 3], "a tool row is not a separate message bubble")
    checkEqual(transcript.messages.last?.process.count ?? 0, 1, "the assistant inherits the tool step")
    checkEqual(transcript.messages.last?.process.first?.title ?? "", "web_search", "the inherited step is the tool's")
}

do {
    // Android clears carried tool steps after each assistant row. A note does
    // not consume them, and a new user turn discards them altogether.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":["
        + "{\"seq\":1,\"role\":\"user\",\"text\":\"go\"},"
        + "{\"seq\":2,\"role\":\"tool\",\"process\":[{\"type\":\"tool\",\"title\":\"first\"}]},"
        + "{\"seq\":3,\"role\":\"note\",\"text\":\"notice\"},"
        + "{\"seq\":4,\"role\":\"assistant\",\"text\":\"one\"},"
        + "{\"seq\":5,\"role\":\"assistant\",\"text\":\"two\"},"
        + "{\"seq\":6,\"role\":\"tool\",\"process\":[{\"type\":\"tool\",\"title\":\"second\"}]},"
        + "{\"seq\":7,\"role\":\"user\",\"text\":\"again\"}]}"
    ))
    checkEqual(transcript.messages.map(\.id), [1, 3, 4, 5, 7], "tool rows do not create bubbles")
    checkEqual(transcript.messages.first(where: { $0.id == 3 })?.process.count, 0,
               "a note does not borrow pending tool steps")
    checkEqual(transcript.messages.first(where: { $0.id == 4 })?.process.first?.title, "first",
               "the next assistant consumes pending tool steps")
    checkEqual(transcript.messages.first(where: { $0.id == 5 })?.process.count, 0,
               "the following assistant does not inherit consumed steps")
    checkEqual(transcript.pendingProcess.count, 0, "a new user turn discards leftover tool steps")
}

do {
    // A tool row at the end becomes the live reply's execution process, or a
    // standalone process block when no live reply is present.
    let transcript = RemoteTranscript()
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"go\"},"
        + "{\"seq\":2,\"role\":\"tool\",\"process\":[{\"type\":\"tool\",\"title\":\"search\"}]}]}"
    ))
    checkEqual(transcript.pendingProcess.first?.title, "search", "a trailing tool has a pending process block")
    checkEqual(transcript.messages.map(\.id), [1], "the trailing tool is not itself a bubble")
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":2,\"live\":{\"text\":\"working\"},"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"go\"},"
        + "{\"seq\":2,\"role\":\"tool\",\"process\":[{\"type\":\"tool\",\"title\":\"search\"}]}]}"
    ))
    checkEqual(transcript.liveProcess.first?.title, "search", "a live reply inherits pending tool steps")
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":3,\"live\":{\"process\":[{\"type\":\"thinking\",\"title\":\"own\"}]},"
        + "\"messages\":[{\"seq\":1,\"role\":\"user\",\"text\":\"go\"},"
        + "{\"seq\":2,\"role\":\"tool\",\"process\":[{\"type\":\"tool\",\"title\":\"search\"}]}]}"
    ))
    checkEqual(transcript.liveProcess.first?.title, "own", "live process entries override inherited steps")
}

do {
    let transcript = RemoteTranscript()
    var rows: [String] = []
    for index in 1...650 { rows.append("{\"seq\":\(index),\"role\":\"user\",\"text\":\"m\(index)\"}") }
    _ = transcript.apply(remoteSnapshot("{\"instanceId\":\"A\",\"cursor\":1,\"messages\":[\(rows.joined(separator: ","))]}"))
    check(transcript.messages.count <= RemoteTranscript.maximumRows, "an oversized session is trimmed")
    checkEqual(transcript.messages.last?.message.seq ?? 0, 650, "trimming evicts the oldest, not the newest")
}

do {
    // Android's 4 MiB cap counts tool input and text as well as message text.
    let transcript = RemoteTranscript()
    let toolInput = String(repeating: "p", count: RemoteTranscript.maximumBytes)
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"nextBefore\":1,\"messages\":["
        + "{\"seq\":1,\"role\":\"tool\",\"text\":\"a\",\"process\":[{\"input\":\"\(toolInput)\"}]},"
        + "{\"seq\":2,\"role\":\"assistant\",\"text\":\"b\"}]}"
    ))
    checkEqual(transcript.messages.map { $0.message.seq }, [2], "tool input counts toward Android's history cap")
    check(!transcript.hasOlder, "evicting a tool-heavy row disables paging into a hole")
}

do {
    // Java String.length counts UTF-16 units, not the three UTF-8 bytes used
    // by this CJK character. Both rows fit Android's cap.
    let transcript = RemoteTranscript()
    let chinese = String(repeating: "界", count: RemoteTranscript.maximumBytes / 3 + 1)
    _ = transcript.apply(remoteSnapshot(
        "{\"instanceId\":\"A\",\"cursor\":1,\"messages\":["
        + "{\"seq\":1,\"role\":\"user\",\"text\":\"\(chinese)\"},"
        + "{\"seq\":2,\"role\":\"assistant\",\"text\":\"b\"}]}"
    ))
    checkEqual(transcript.messages.map { $0.message.seq }, [1, 2], "UTF-16 text stays within Android's history cap")
}

// MARK: - Commands and policy

do {
    // A repeated prompt earlier in history is not evidence that a new send
    // arrived. Android requires the same instance plus expectedSeq + 1 until
    // the command response supplies an exact userSeq.
    let echo = RemoteOutgoingEcho(instanceId: "desktop-A", expectedSeq: 10,
                                  prompt: "repeat")
    let old = RemoteMessage(seq: 4, role: .user, text: "repeat", at: 0)
    let next = RemoteMessage(seq: 11, role: .user, text: "repeat", at: 0)
    let different = RemoteMessage(seq: 11, role: .user, text: "different", at: 0)
    let assistant = RemoteMessage(seq: 11, role: .assistant, text: "repeat", at: 0)
    check(!echo.matches(old, currentInstanceId: "desktop-A"),
          "an older identical prompt does not settle a new outgoing message")
    check(echo.matches(next, currentInstanceId: "desktop-A"),
          "the next exact user row settles a send without a returned sequence")
    check(!echo.matches(different, currentInstanceId: "desktop-A"),
          "a changed prompt at the expected sequence does not settle it")
    check(!echo.matches(assistant, currentInstanceId: "desktop-A"),
          "an assistant row is never a submitted user echo")
    check(!echo.matches(next, currentInstanceId: "desktop-B"),
          "a restarted or switched desktop cannot settle the old send")
    var exact = echo
    exact.userSeq = 13
    check(exact.matches(RemoteMessage(seq: 13, role: .user, text: "server copy", at: 0),
                        currentInstanceId: "desktop-A"),
          "a returned user sequence overrides prompt matching")
    check(!exact.matches(next, currentInstanceId: "desktop-A"),
          "once a user sequence is known the fallback row cannot settle it")
}

checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":true,\"state\":\"\",\"userSeq\":12}".utf8)))),
           .accepted(userSeq: 12), "an accepted command carries the user seq")
checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":true,\"state\":\"pending\"}".utf8)))),
           .pending, "pending means ask again with the same request id")
checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":true,\"state\":\"unknown\"}".utf8)))),
           .unknown, "unknown means the desktop lost the record")
checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":false,\"state\":\"rejected\"}".utf8)))),
           .rejected, "a refused command returns the draft")
checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":false}".utf8)))),
           .rejected, "a blank refusal does not become an accepted command")
checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":false,\"state\":\"unknown\"}".utf8)))),
           .unknown, "unknown keeps the request journal even without ok")
checkEqual(CommandAck(result: CommandResult(try! JSONBody.object(Data("{\"ok\":false,\"state\":\"pending\"}".utf8)))),
           .pending, "pending is retried by id even without ok")

do {
    // A workspace creation answers with the workspace it made. Android reloads
    // the list on that object rather than on `ok` alone, so the field has to
    // come through — an `ok` with nothing in it would otherwise be treated as
    // success and leave the list without the new heading.
    let created = CommandResult(try! JSONBody.object(Data(
        "{\"ok\":true,\"state\":\"\",\"workspace\":{\"id\":\"w9\",\"name\":\"Notes\"}}".utf8)))
    checkEqual(created.workspace?.id, "w9", "a created workspace is read back")
    checkEqual(created.workspace?.name, "Notes", "with its name")
    check(created.conversation == nil, "and no conversation, which is what separates the two create paths")

    let conversationOnly = CommandResult(try! JSONBody.object(Data(
        "{\"ok\":true,\"state\":\"\",\"conversation\":{\"id\":\"c9\",\"title\":\"Chat\"}}".utf8)))
    check(conversationOnly.workspace == nil, "a conversation creation carries no workspace")
}

do {
    var backoff = RemoteBackoff()
    checkEqual(backoff.next(after: 503), 2, "the first empty stream waits two seconds")
    checkEqual(backoff.next(after: 503), 4, "the second empty stream waits four seconds")
    checkEqual(backoff.next(after: 429), 60, "a 429 asks for the fixed delay")
    checkEqual(backoff.attempts, 3, "rate limiting still advances the failure count")
    checkEqual(backoff.next(after: 503), 16, "a later failure continues from the 429 attempt")
    check(backoff.next(after: 503) <= RemoteBackoff.maximumDelay, "backoff stops at the ceiling")
    checkEqual(backoff.next(after: nil, received: true), 1,
               "a stream that delivered a snapshot retries after one second")
    checkEqual(backoff.attempts, 0, "a delivered snapshot resets the counter")
    checkEqual(backoff.next(after: 503), 2, "the next empty stream starts over at two seconds")
}

do {
    var reads = RemoteReadState()
    let conversation = RemoteConversation(try! JSONBody.object(Data(
        "{\"id\":\"c1\",\"lastReplyAt\":500,\"replyReadAt\":100,\"seq\":3}".utf8)))
    check(reads.unread(address: "http://100.64.0.1:43127", token: "t", conversation: conversation), "a newer reply is unread")
    reads.markRead(address: "http://100.64.0.1:43127", token: "t", conversation: conversation)
    check(!reads.unread(address: "http://100.64.0.1:43127", token: "t", conversation: conversation), "marking read clears it")
    // The same session id on another computer must not share the state.
    check(reads.unread(address: "http://100.64.0.2:43127", token: "u", conversation: conversation), "another computer keeps its own read state")
}

do {
    let running = RemoteConversation(JSONObject(dictionary: ["id": "running", "activity": "running"]))
    let empty = RemoteConversation(JSONObject(dictionary: ["id": "empty", "activity": ""]))
    let future = RemoteConversation(JSONObject(dictionary: ["id": "future", "activity": "waiting-for-tool"]))
    checkEqual(running.activity, .running, "known remote activity still shows its status")
    checkEqual(empty.activity, nil, "an explicit empty activity is idle like Android")
    checkEqual(future.activity, nil, "an unknown activity does not claim the chat is running")

    let missingName = RemoteConversation(JSONObject(dictionary: ["id": "missing", "workspaceId": "w1"]))
    let emptyName = RemoteConversation(JSONObject(dictionary: ["id": "empty-name", "workspaceId": "w1", "workspaceName": ""]))
    checkEqual(missingName.workspaceName, nil, "a missing row workspace name can fall back to the workspace list")
    checkEqual(emptyName.workspaceName, "", "an explicit empty row workspace name stays empty like optString")
    check(!(missingName.json.keys.contains("workspaceName")), "cached rows keep an absent workspace name absent")
}

do {
    let capabilities = RemoteCapabilities(["create", "attachments", "image"])
    check(capabilities.allows(.attachments, permission: .read), "attachments do not need control")
    check(!capabilities.allows(.create, permission: .read), "creating needs control")
    check(capabilities.allows(.create, permission: .control), "creating works once control is granted")
    check(!capabilities.allows(.archive, permission: .read), "archiving needs control too")
}

// MARK: - Answering a tool request
//
// An approval answer is the one command whose refusal is silent. The desktop
// builds the same 409 for a missing `allow`, for a stale fingerprint and for an
// approval that moved on, and says "Approval changed or needs desktop input" —
// so a client that merely forgot to send the boolean is told, in so many words,
// that the thing it is looking at is out of date. That is exactly what the
// phone used to be told: it sent the id and the fingerprint and no answer, and
// no approval could ever be granted from it.

do {
    let approval = RemoteApproval(try! JSONBody.object(Data(
        #"{"requestId":"6f1c0b7e-3a2d-4f5b-8c9d-0e1f2a3b4c5d","fingerprint":"abc","toolName":"Bash","details":"rm -rf build","actionable":true}"#.utf8)))
    checkEqual(approval.requestId, "6f1c0b7e-3a2d-4f5b-8c9d-0e1f2a3b4c5d", "the request id is read")
    checkEqual(approval.toolName, "Bash", "and the tool it names")
    check(approval.actionable, "and whether this phone may answer it at all")

    let yes = approval.answer(instanceId: "inst-1", runId: 7, allow: true)
    checkEqual(yes["allow"] as? Bool, true, "an answer carries allow, and as a real boolean")
    checkEqual(yes["approvalId"] as? String, approval.requestId, "naming the request")
    checkEqual(yes["fingerprint"] as? String, "abc", "and the fingerprint it was shown for")
    checkEqual(yes["runId"] as? Int64, 7, "and the run, so a restarted one cannot inherit it")
    checkEqual(yes["instanceId"] as? String, "inst-1", "and the instance the command has to name")

    // A refusal is the same command with the other answer: the desktop picks
    // its `reject_once` option from this, so the boolean is the whole
    // difference between allowing a tool and denying it.
    let no = approval.answer(instanceId: "inst-1", runId: 7, allow: false)
    checkEqual(no["allow"] as? Bool, false, "a refusal is the same answer, turned down")
    checkEqual(Set(no.keys), Set(yes.keys), "with no field the phone would have to add or drop")

    // A question, or a prompt too long to show, is not answerable from here —
    // the desktop says so and refuses the command however it is built.
    let question = RemoteApproval(try! JSONBody.object(Data(
        #"{"requestId":"r","fingerprint":"f","toolName":"Ask","details":"which file?","actionable":false}"#.utf8)))
    check(!question.actionable, "a question is not answerable from the phone")
}

do {
    // Android renders every approval, including questions and oversized
    // prompts, when the device has control. A read-only device sees none of
    // their details or buttons; it gets one desktop-only notice instead.
    let live = RemoteLive(try! JSONBody.object(Data(
        #"{"pendingApprovals":2,"approvals":[{"requestId":"ask","toolName":"Ask","details":"which file?","actionable":false},{"requestId":"allow","toolName":"Bash","details":"pwd","actionable":true}]}"#.utf8)))
    checkEqual(live.visibleApprovals(canControl: true).map(\.id), ["ask", "allow"],
               "control devices see actionable and desktop-only approvals in order")
    checkEqual(live.visibleApprovals(canControl: false).map(\.id), [],
               "read-only devices do not see approval cards")
    check(live.showsDesktopApprovalNotice(canControl: false),
          "a read-only device sees a notice when approval is pending")
    check(!live.showsDesktopApprovalNotice(canControl: true),
          "a control device sees each request instead of a generic notice")
    let idle = RemoteLive(JSONObject(dictionary: ["pendingApprovals": 0]))
    check(!idle.showsDesktopApprovalNotice(canControl: false),
          "a read-only device without pending approvals sees no notice")
}

do {
    // Android shows a tail-only warning for truncated history/live text and
    // never offers resend-edit on a user row lacking its original beginning.
    let truncated = RemoteMessage(try! JSONBody.object(Data(
        #"{"seq":7,"role":"user","text":"last part","textTruncated":true}"#.utf8)))
    let complete = RemoteMessage(seq: 7, role: .user, text: "whole prompt", at: 0)
    let assistant = RemoteMessage(seq: 8, role: .assistant, text: "reply", at: 0)
    check(truncated.textTruncated, "a snapshot preserves the message truncation flag")
    check(!RenderedMessage(message: truncated, process: []).isEditCandidate(lastUserSeq: 7),
          "a truncated user prompt cannot be resent as though it were complete")
    check(RenderedMessage(message: complete, process: []).isEditCandidate(lastUserSeq: 7),
          "the latest complete user prompt can be edited")
    check(!RenderedMessage(message: complete, process: []).isEditCandidate(lastUserSeq: 9),
          "an older complete user prompt cannot be edited")
    check(!RenderedMessage(message: complete, process: []).isEditCandidate(lastUserSeq: nil),
          "an unconfirmed latest user sequence cannot be edited")
    check(!RenderedMessage(message: assistant, process: []).isEditCandidate(lastUserSeq: 8),
          "an assistant row cannot be edited as a user prompt")
    let live = RemoteLive(try! JSONBody.object(Data(
        #"{"text":"tail","textTruncated":true}"#.utf8)))
    check(live.textTruncated, "the live reply also preserves the truncation flag")
}

// MARK: - Sealed credentials

do {
    let key = SymmetricKey(data: Data(repeating: 7, count: 32))
    let other = SymmetricKey(data: Data(repeating: 9, count: 32))
    let sealed = try! CredentialSeal.seal(Data("hello".utf8), using: key)
    check(String(decoding: (try! CredentialSeal.open(sealed, using: key)), as: UTF8.self) == "hello",
          "sealed credentials open again")
    checkThrows(SealedCredentialError.authenticationFailed, "another key cannot open them") {
        _ = try CredentialSeal.open(sealed, using: other)
    }
    let tampered = SealedCredential(nonce: sealed.nonce, ciphertext: sealed.ciphertext + Data([0]), tag: sealed.tag)
    checkThrows(SealedCredentialError.authenticationFailed, "edited ciphertext is rejected") {
        _ = try CredentialSeal.open(tampered, using: key)
    }
    checkThrows(SealedCredentialError.authenticationFailed, "a blob sealed under another alias is rejected") {
        _ = try CredentialSeal.open(sealed, using: key, context: "camellia.remote.v2")
    }
    // The stored shape is Android's: iv plus ciphertext-with-tag, both base64.
    check(SealedCredential(json: JSONObject(dictionary: sealed.json)) == sealed, "the envelope survives its JSON shape")
    check(SealedCredential(json: JSONObject(dictionary: sealed.json))?.json["data"] as? String == sealed.json["data"] as? String,
          "and writes back the same bytes")
    check(SealedCredential(json: JSONObject(dictionary: ["iv": "!!!", "data": ""])) == nil, "a broken envelope reads as absent")
}

// MARK: - The vault, written and read back
//
// The one place the envelope, the file and the store's own rules meet. Each is
// checked alone above; this checks that a computer saved through the store
// survives being sealed to disk and opened again, which is what a relaunch does.

do {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-file-key-check-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("key")
    let keys = FileSecretKeyStore(url: url)
    _ = try keys.key()
    let first = try Data(contentsOf: url)
    checkEqual(first.count, 32, "a new file key has 32 bytes")
    _ = try keys.key()
    checkEqual(try Data(contentsOf: url), first, "reopening a file key preserves its bytes")
    let damaged = Data([1, 2, 3])
    try damaged.write(to: url, options: .atomic)
    checkThrows(FileSecretKeyError.invalidLength, "an invalid file key is refused") {
        _ = try keys.key()
    }
    checkEqual(try Data(contentsOf: url), damaged, "an invalid file key is never replaced")
}

do {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-vault-check-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let vault = SealedCredentialVault(
        url: directory.appendingPathComponent("credential.json"),
        keys: FileSecretKeyStore(url: directory.appendingPathComponent("credential.key")))
    let store = ComputerStore(vault: vault)

    check(try store.all().isEmpty, "a fresh vault holds no computers")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let emptyURL = directory.appendingPathComponent("empty.json")
    try Data().write(to: emptyURL)
    let emptyVault = SealedCredentialVault(url: emptyURL, keys: FileSecretKeyStore(url: directory.appendingPathComponent("empty.key")))
    do {
        _ = try emptyVault.load()
        check(false, "an existing empty credential file is not treated as a new vault")
    } catch SealedCredentialVault.Failure.unreadable {
        check(true, "an existing empty credential file is not treated as a new vault")
    } catch {
        check(false, "an existing empty credential file reports unreadable")
    }
    let unreadableURL = directory.appendingPathComponent("unreadable.json")
    try FileManager.default.createDirectory(at: unreadableURL, withIntermediateDirectories: true)
    let unreadableVault = SealedCredentialVault(url: unreadableURL,
        keys: FileSecretKeyStore(url: directory.appendingPathComponent("unreadable.key")))
    do {
        _ = try unreadableVault.load()
        check(false, "a failed credential file read is not treated as a new vault")
    } catch {
        check(error is CocoaError, "a failed credential file read is not treated as a new vault")
    }
    let computer = PairedComputer(address: "http://100.64.0.1:43127", name: "phone", computerName: "Studio",
                                  token: token43, deviceId: "d1", permission: .control)
    try store.save(computer)

    // A new store over the same file, which is what the next launch is.
    let reopened = ComputerStore(vault: vault)
    checkEqual(try reopened.all().count, 1, "the computer survives being sealed and reopened")
    checkEqual(try reopened.current().token ?? "", token43, "with its token")
    checkEqual(try reopened.current().permission, .control, "and its permission")

    // Reopening under a different key must not silently succeed with garbage.
    let stranger = SealedCredentialVault(
        url: directory.appendingPathComponent("credential.json"),
        keys: FileSecretKeyStore(url: directory.appendingPathComponent("other.key")))
    var threw = false
    do { _ = try stranger.load() } catch { threw = true }
    check(threw, "a file read with the wrong key is refused")
}

// MARK: - Computer store

do {
    // A single-computer install from before the computer list existed.
    let vault = MemoryCredentialVault(#"{"address":"http://100.64.0.1:43127","name":"phone","token":"\#(token43)","deviceId":"d1"}"#)
    let store = ComputerStore(vault: vault)
    checkEqual(try store.all().count, 1, "a saved computer without a computers map still lists one")
    checkEqual(try store.all().first?.address ?? "", "http://100.64.0.1:43127", "keyed by its address")
    checkEqual(try store.current().address, "http://100.64.0.1:43127", "and it is the current computer")
}

do {
    let vault = MemoryCredentialVault()
    try vault.save(JSONObject(dictionary: ["token": token43, "deviceId": "d1"]))
    let store = ComputerStore(vault: vault)
    do {
        _ = try store.all()
        check(false, "a paired profile without an address is not silently discarded")
    } catch CredentialStoreError.unreadable {
        check(true, "a paired profile without an address is not silently discarded")
    }
    check(try vault.load().has("token"), "rejecting the corrupt profile does not rewrite its credentials")
}

do {
    let vault = MemoryCredentialVault()
    try vault.save(JSONObject(dictionary: ["computers": ["http://100.64.0.1:43127": "damaged"]]))
    let store = ComputerStore(vault: vault)
    do {
        _ = try store.all()
        check(false, "a malformed list entry is not dropped on read")
    } catch CredentialStoreError.unreadable {
        check(true, "a malformed list entry is not dropped on read")
    }
    do {
        try store.save(PairedComputer(address: "http://100.64.0.2:43127"))
        check(false, "a save cannot overwrite a list with a malformed entry")
    } catch CredentialStoreError.unreadable {
        check(true, "a save cannot overwrite a list with a malformed entry")
    }
    checkEqual(try vault.load().object("computers")?.text("http://100.64.0.1:43127"),
               "damaged", "a rejected save leaves the stored list intact")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    var pending = PairedComputer(address: "http://100.64.0.1:43127", name: "phone", claim: "cl", pairingId: "i1", expiresAt: 60_000)
    try store.save(pending)
    checkEqual(try store.all().count, 0, "a request waiting for approval is not a computer yet")
    checkEqual(try store.current().claim ?? "", "cl", "but it is stored, so the flow can resume")
    pending.token = token43
    pending.deviceId = "d1"
    pending.claim = nil
    pending.pairingId = nil
    pending.expiresAt = nil
    try store.save(pending)
    checkEqual(try store.all().count, 1, "once the desktop approves it joins the list")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let studio = PairedComputer(address: "http://100.64.0.1:43127", name: "phone", computerName: "Studio", token: token43, deviceId: "d1")
    let laptop = PairedComputer(address: "http://100.64.0.2:43127", name: "phone", computerName: "Laptop", token: token43, deviceId: "d2")
    try store.save(studio)
    try store.save(laptop)
    checkEqual(try store.all().count, 2, "both computers are remembered")
    checkEqual(try store.current().address, "http://100.64.0.2:43127", "the newest pairing becomes the current one")
    try store.rename(address: "http://100.64.0.1:43127", name: "Desk")
    checkEqual(try store.all().first?.computerName ?? "", "Desk", "a rename survives in the list")
    checkEqual(try store.current().computerName, "Laptop", "and does not leak into the other computer")
    let switched = try store.select("http://100.64.0.1:43127")
    checkEqual(switched.computerName, "Desk", "switching keeps the stored label")
    checkEqual(try store.current().address, "http://100.64.0.1:43127", "switching changes the current computer")
    try store.remove("http://100.64.0.1:43127")
    checkEqual(try store.all().count, 1, "removing drops it from the list")
    checkEqual(try store.current().address, "", "and leaves no current computer when it was the current one")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let pending = PairedComputer(address: "http://100.64.0.1:43127", name: "phone", claim: "cl", pairingId: "i1", expiresAt: 60_000)
    try store.save(pending)
    let cleared = try store.clearClaim()
    check(cleared.claim == nil && cleared.pairingId == nil && cleared.expiresAt == nil, "clearing drops the claim")
    checkEqual(cleared.address, "http://100.64.0.1:43127", "and keeps the address")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let old = PairedComputer(address: "http://100.64.0.1:43127", name: "phone",
                             claim: "old", pairingId: "i1", expiresAt: 60_000)
    var newer = old
    newer.claim = "new"
    newer.pairingId = "i2"
    try store.save(old)
    try store.save(newer)
    checkEqual(try store.clearClaim(ifMatching: old), false,
               "a late failure cannot clear a newer claim on the same computer")
    checkEqual(try store.current().claim ?? "", "new", "the newer claim remains stored")
    checkEqual(try store.clearClaim(ifMatching: newer), true,
               "the matching request can clear its own claim")
    checkEqual(try store.current().claim ?? "", "", "and only its own claim is removed")
}

do {
    var computer = PairedComputer(address: "http://100.64.0.1:43127", token: token43, deviceId: "d1")
    check(computer.hasUsableToken, "a 43-character token is usable")
    computer.token = String(repeating: "A", count: 42)
    check(!computer.hasUsableToken, "one character short is not")
    checkEqual(computer.displayName, "http://100.64.0.1:43127", "an unnamed computer shows its address")
    computer.computerName = "Studio"
    checkEqual(computer.displayName, "Studio", "a named one shows its name")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let studio = PairedComputer(address: "http://100.64.0.1:43127", name: "phone",
                                token: token43, deviceId: "d1")
    let laptop = PairedComputer(address: "http://100.64.0.2:43127", name: "phone",
                                token: token43, deviceId: "d2")
    try store.save(studio)
    try store.save(laptop)
    let request = "request-1"
    try store.update(address: studio.address) { computer in
        computer.pendingCreate = JSONObject(dictionary: ["action": "create", "requestId": request])
        computer.pendingCommand = JSONObject(dictionary: [
            "conversationId": "c1",
            "payload": ["action": "send", "requestId": request, "prompt": "hello"],
        ])
        computer.drafts = JSONObject(dictionary: ["c1": "unfinished"])
        computer.draftEdits = JSONObject(dictionary: ["c1": 7])
        computer.draftAttachments = JSONObject(dictionary: [
            "c1": ["attachments": [["name": "a.txt", "data": "YWJj", "isImage": false]]],
        ])
    }
    checkEqual(try store.current().address, laptop.address,
               "updating another profile does not select it")
    let restored = try store.all().first { $0.address == studio.address }!
    checkEqual(restored.pendingCreate?.text("requestId") ?? "", request,
               "a pending list command survives in its profile")
    checkEqual(restored.pendingCommand?.text("conversationId") ?? "", "c1",
               "a pending conversation command survives in its profile")
    checkEqual(restored.drafts?.text("c1") ?? "", "unfinished",
               "remote draft text survives in its profile")
    checkEqual(restored.draftEdits?.long("c1") ?? -1, 7,
               "the draft edit target survives too")
    checkEqual(restored.draftAttachments?.object("c1")?.objects("attachments").count ?? 0, 1,
               "and so does its attachment selection")
    try store.update(address: studio.address) { computer in
        computer.pendingCreate = nil
        computer.pendingCommand = nil
    }
    let cleared = try store.all().first { $0.address == studio.address }!
    check(cleared.pendingCreate == nil && cleared.pendingCommand == nil,
          "an explicit profile update clears completed command journals")
}

do {
    let address = "http://100.64.0.1:43127"
    let vault = MemoryCredentialVault(#"{"address":"http://100.64.0.1:43127","name":"phone","token":"\#(token43)","deviceId":"d1","futureOption":{"enabled":true}}"#)
    let store = ComputerStore(vault: vault)
    try store.update(address: address) { $0.drafts = JSONObject(dictionary: ["c1": "hello"]) }
    checkEqual(try store.current().json["futureOption"] as? [String: Bool] ?? [:],
               ["enabled": true], "updating a draft preserves an unknown profile field")
    try store.save(PairedComputer(address: address, name: "phone", token: token43, deviceId: "d1"))
    checkEqual(try store.current().json["futureOption"] as? [String: Bool] ?? [:],
               ["enabled": true], "saving the profile also preserves the unknown field")
    checkEqual(try vault.load().object("computers")?.object(address)?.object("futureOption")?.bool("enabled"),
               true, "the sealed list record retains it as well")
}

// MARK: - Preferences

do {
    let preferences = MobilePreferences(store: DictionaryPreferenceStore(), modelName: "iPhone 15")
    checkEqual(preferences.language, .system, "language follows the system by default")
    checkEqual(preferences.theme, .system, "appearance follows the system by default")
    checkEqual(preferences.enterMode, .send, "an unset enter mode reads as send")
    checkEqual(preferences.deviceName, "iPhone 15", "the device name falls back to the model")
    checkEqual(preferences.signature, "system:system", "the signature is language and appearance")
    checkEqual(preferences.keepAlive, false, "keeping the tunnel open is off by default")

    let store = DictionaryPreferenceStore(["language": "zh-CN", "theme": "dark", "enterMode": "button", "deviceName": "   "])
    let stored = MobilePreferences(store: store, modelName: "iPhone")
    checkEqual(stored.enterMode, .button, "a stored enter mode is read back")
    checkEqual(stored.deviceName, "iPhone", "a blank stored name falls back to the model")
    checkEqual(stored.signature, "zh-CN:dark", "the signature follows the stored values")
    checkEqual(AppLanguage.simplifiedChinese.tag ?? "", "zh-Hans", "the stored language maps to a locale tag")
    check(AppLanguage.system.tag == nil, "following the system means no tag of our own")
    store.set("nonsense", for: "enterMode")
    checkEqual(stored.enterMode, .send, "an unknown enter mode falls back rather than failing")
    stored.keepAlive = true
    checkEqual(stored.keepAlive, true, "keeping the tunnel open can be turned on")
}

// MARK: - Conversation-list layout

do {
    // Workspace folding is remembered per computer *and* per workspace, which
    // is what stops one desktop's layout from being applied to another.
    let store = DictionaryPreferenceStore()
    let preferences = MobilePreferences(store: store, modelName: "iPhone")

    checkEqual(preferences.isWorkspaceCollapsed(address: "studio", workspace: "w1"), false,
               "a workspace with no stored choice starts expanded")
    preferences.setWorkspace("w1", collapsed: true, address: "studio")
    checkEqual(preferences.isWorkspaceCollapsed(address: "studio", workspace: "w1"), true,
               "a folded workspace is read back")
    checkEqual(preferences.isWorkspaceCollapsed(address: "laptop", workspace: "w1"), false,
               "the same workspace id on another computer is not folded")
    checkEqual(preferences.isWorkspaceCollapsed(address: "studio", workspace: ""), false,
               "the independent group has its own key")
    preferences.setWorkspace("w1", collapsed: false, address: "studio")
    checkEqual(preferences.isWorkspaceCollapsed(address: "studio", workspace: "w1"), false,
               "unfolding is stored rather than merely forgotten")
    checkEqual(store.string("collapsed:studio/w1"), "0", "an unfolded group keeps an explicit key")
}

// MARK: - Pairing flow

enum TestError: Error, Equatable { case boom }

struct StubHttpError: Error, RemoteHttpError {
    let status: Int
    let detail: String
}

final class StubPairing: PairingTransport {
    var requests: [(origin: String, code: String, name: String)] = []
    var claims: [(origin: String, id: String, claim: String)] = []
    var requestResult: Result<PairRequestResult, Error> = .failure(TestError.boom)
    var claimResult: (Int) -> Result<PairClaimResult, Error> = { _ in .failure(TestError.boom) }
    private var claimCount = 0

    func pairRequest(origin: String, code: String, name: String) throws -> PairRequestResult {
        requests.append((origin, code, name))
        return try requestResult.get()
    }

    func pairClaim(origin: String, id: String, claim: String) throws -> PairClaimResult {
        claims.append((origin, id, claim))
        claimCount += 1
        return try claimResult(claimCount).get()
    }
}

func pairRequestResult(id: String = "i1", claim: String = "cl", expiresAt: Int64 = 60_000, computerName: String = "Studio") -> PairRequestResult {
    PairRequestResult(try! JSONBody.object(Data(
        #"{"id":"\#(id)","claim":"\#(claim)","expiresAt":\#(expiresAt),"computerName":"\#(computerName)"}"#.utf8)))
}

func pairClaimResult(state: String = "approved", token: String = token43, permission: String = "control", deviceId: String = "d1") -> PairClaimResult {
    PairClaimResult(try! JSONBody.object(Data(
        #"{"state":"\#(state)","token":"\#(token)","permission":"\#(permission)","deviceId":"\#(deviceId)"}"#.utf8)))
}

func pairingHarness(now: Int64 = 10) -> (PairingController, ManualScheduler, ComputerStore, StubPairing) {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let transport = StubPairing()
    let scheduler = ManualScheduler()
    let pairing = PairingController(
        transport: transport, store: store, scheduler: scheduler,
        clock: { now }, pollInterval: 5, worker: { $0() }, notify: { $0() })
    return (pairing, scheduler, store, transport)
}

/// A pairing transport whose first dial runs an event in the middle of itself.
///
/// A dial waits on the tunnel, and the form stays live while it does, so a
/// second 请求配对 can be dispatched while the first request is still open.
/// Reproducing that needs a call back into the flow at exactly the moment the
/// first dial is open, which is what `duringFirstDial` is for.
final class DiallingStub: PairingTransport {
    var duringFirstDial: (() -> Void)?
    var requests = 0
    var claims = 0
    var origins: [String] = []

    func pairRequest(origin: String, code: String, name: String) throws -> PairRequestResult {
        requests += 1
        origins.append(origin)
        let mine = requests
        if mine == 1 { duringFirstDial?() }
        // No computerName: the desktop that raised this does not report one.
        return pairRequestResult(id: "i\(mine)", claim: "cl\(mine)", computerName: "")
    }

    func pairClaim(origin: String, id: String, claim: String) throws -> PairClaimResult {
        claims += 1
        return pairClaimResult()
    }
}

/// A harness whose worker queue is captured rather than run.
///
/// The checks drive the requests themselves, which is what turns a race into a
/// repeatable interleaving: a suite that sometimes sees the bug is a suite that
/// sometimes passes.
func queueingHarness(now: Int64 = 10) -> (PairingController, ManualScheduler, ComputerStore, DiallingStub, () -> Void) {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let transport = DiallingStub()
    let scheduler = ManualScheduler()
    var queued: [() -> Void] = []
    let pairing = PairingController(
        transport: transport, store: store, scheduler: scheduler,
        clock: { now }, pollInterval: 5,
        worker: { queued.append($0) }, notify: { $0() })
    return (pairing, scheduler, store, transport, { while !queued.isEmpty { queued.removeFirst()() } })
}

let goodDraft = PairingDraft(address: "100.64.0.1", port: "43127", code: "0123456789ABCDEF01234567", name: "phone")

do {
    let (pairing, _, _, _) = pairingHarness()
    checkThrows(PairingFieldError(.address, "请填写电脑的 Tailscale IP，例如 100.80.1.2。"), "a host that is not a tailnet address is blamed on the address") {
        try pairing.start(PairingDraft(address: "example.com", port: "43127", code: goodDraft.code, name: "phone"))
    }
    checkThrows(PairingFieldError(.port, "端口应为 1–65535。"), "an out-of-range port is blamed on the port") {
        try pairing.start(PairingDraft(address: "100.64.0.1", port: "99999", code: goodDraft.code, name: "phone"))
    }
    checkThrows(PairingFieldError(.name, "请输入本机名称，最多 80 个字符。"), "an empty name is refused") {
        try pairing.start(PairingDraft(address: "100.64.0.1", port: "43127", code: goodDraft.code, name: "   "))
    }
    checkEqual(try PairingController.validate(name: String(repeating: "🐱", count: 40), code: goodDraft.code).name,
               String(repeating: "🐱", count: 40), "pair name accepts exactly 80 UTF-16 units")
    checkThrows(PairingFieldError(.name, "请输入本机名称，最多 80 个字符。"),
                "pair name rejects 82 UTF-16 units") {
        _ = try PairingController.validate(name: String(repeating: "🐱", count: 41), code: goodDraft.code)
    }
    checkEqual(try PairingController.validate(name: "\u{00A0}a\u{00A0}", code: goodDraft.code).name,
               "\u{00A0}a\u{00A0}", "pair name retains Java-trimmed non-breaking spaces")
    checkThrows(PairingFieldError(.code, "请填写电脑生成的 24 位配对码，或重新扫码。"), "a short code is refused") {
        try pairing.start(PairingDraft(address: "100.64.0.1", port: "43127", code: "nope", name: "phone"))
    }
}

do {
    let (pairing, scheduler, store, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    try pairing.start(goodDraft)
    checkEqual(transport.requests.first?.origin ?? "", "http://100.64.0.1:43127",
               "the request carries the validated draft address")

    var stored = PairedComputer(address: "http://100.64.0.2:43127", name: "laptop")
    stored.pairingId = "i9"
    stored.claim = "cl9"
    stored.expiresAt = 9_999_999
    try store.save(stored)
    try pairing.resume()
    scheduler.drain(limit: 2)
    checkEqual(transport.claims.last?.origin ?? "", "http://100.64.0.2:43127",
               "the resumed claim carries its stored computer address")
}

do {
    let (pairing, _, _, transport, runQueued) = queueingHarness()
    let second = PairingDraft(address: "100.64.0.2", port: "43127", code: goodDraft.code, name: "phone")
    transport.duringFirstDial = {
        try? pairing.start(second)
        runQueued()
    }
    try pairing.start(goodDraft)
    runQueued()
    checkEqual(transport.origins, ["http://100.64.0.1:43127", "http://100.64.0.2:43127"],
               "overlapping requests each keep their own immutable computer address")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let transport = StubPairing()
    let scheduler = ManualScheduler()
    var notices: [() -> Void] = []
    let pairing = PairingController(transport: transport, store: store, scheduler: scheduler,
                                    worker: { $0() }, notify: { notices.append($0) })
    transport.requestResult = .success(pairRequestResult(expiresAt: 60_000))
    try pairing.start(goodDraft)
    let staleNotices = notices
    notices = []
    transport.requestResult = .success(pairRequestResult(id: "i2", claim: "cl2", expiresAt: 70_000))
    let second = PairingDraft(address: "100.64.0.2", port: "43127", code: goodDraft.code, name: "phone")
    try pairing.start(second)
    notices.forEach { $0() }
    staleNotices.forEach { $0() }
    checkEqual(pairing.phase, .awaitingApproval(expiry: 70_000),
               "old queued UI notifications cannot overwrite the newer pairing state")
    checkEqual(pairing.draft.address, second.address, "the newer form remains intact")
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    let transport = StubPairing()
    let scheduler = ManualScheduler()
    var notices: [() -> Void] = []
    let pairing = PairingController(transport: transport, store: store, scheduler: scheduler,
                                    clock: { 10 }, worker: { $0() }, notify: { notices.append($0) })
    transport.requestResult = .success(pairRequestResult())
    transport.claimResult = { _ in .success(pairClaimResult()) }
    try pairing.start(goodDraft)
    scheduler.drain(limit: 1)
    let second = PairingDraft(address: "100.64.0.2", port: "43127", code: goodDraft.code, name: "phone")
    try pairing.start(second)
    notices.forEach { $0() }
    checkEqual(pairing.draft.address, second.address,
               "an old approval's queued draft clear cannot erase a newer pairing form")
}

do {
    let (pairing, scheduler, store, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    // The desktop answers "not yet" once, which is the normal case on the way
    // to an approval, and the flow has to keep asking.
    transport.claimResult = { $0 < 2 ? .success(pairClaimResult(state: "pending")) : .success(pairClaimResult()) }
    try pairing.start(goodDraft)
    checkEqual(transport.requests.first?.code ?? "", "0123456789abcdef01234567", "the code goes out in lower case")
    checkEqual(transport.requests.first?.name ?? "", "phone", "and with the phone's name")
    if case .awaitingApproval(let expiry) = pairing.phase {
        checkEqual(expiry, 60_000, "the deadline the desktop gave is published")
    } else {
        check(false, "the request leaves the flow waiting for approval")
    }
    checkEqual(pairing.draft.code, "", "the accepted one-time code is not kept in the reopened form")
    checkEqual(scheduler.pending.count, 1, "one claim poll is scheduled")
    checkEqual(scheduler.pending.first ?? 0, 5, "five seconds later, as on Android")
    checkEqual(transport.claims.count, 0, "nothing is claimed before the first poll")
    checkEqual(scheduler.drain(), 2, "the poll repeats until the desktop approves")
    if case .approved(let computer) = pairing.phase {
        checkEqual(computer.token ?? "", token43, "the token is stored")
        checkEqual(computer.deviceId ?? "", "d1", "the device id is stored")
        checkEqual(computer.computerName, "Studio", "the desktop's own name is kept")
        check(computer.isPaired, "and the computer counts as paired")
    } else {
        check(false, "the flow ends approved")
    }
    checkEqual(try store.current().token ?? "", token43, "the pairing is persisted")
    checkEqual(try store.all().count, 1, "and appears in the computer list")
}

do {
    let (pairing, scheduler, store, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    transport.claimResult = { _ in .failure(StubHttpError(status: 503, detail: "offline")) }
    try pairing.start(goodDraft)
    scheduler.drain(limit: 1)
    check(try store.current().isAwaitingApproval, "a transient claim failure keeps the resumable request")
    checkEqual(pairing.draft.code, "", "a claim retry does not expose the consumed code")
    try pairing.resume()
    checkEqual(scheduler.pending.count, 1, "the stored claim can be resumed without a new code")
    transport.claimResult = { _ in .success(pairClaimResult()) }
    scheduler.drain(limit: 1)
    if case .approved = pairing.phase { check(true, "the resumed request can be approved") }
    else { check(false, "the resumed request can be approved") }
}

do {
    // What the phone reported after a real pairing: the desktop could see the
    // device and the 电脑 sheet said 已连接, but 远程控制 offered to pair from
    // scratch. A second 请求配对 — a double tap, or a re-tap because the first
    // looked like it had done nothing — puts two requests in flight, and the
    // desktop approves one of them. The other's dial can come back afterwards,
    // and it used to write its own claim as the *current* computer, taking the
    // credentials off a pairing that had just succeeded.
    let (pairing, scheduler, store, transport, runQueued) = queueingHarness()
    transport.duringFirstDial = {
        try? pairing.start(goodDraft)
        runQueued()
        scheduler.drain()
    }
    try pairing.start(goodDraft)
    runQueued()
    scheduler.drain()

    checkEqual(transport.requests, 2, "both taps reach the desktop")
    if case .approved = pairing.phase {
        check(true, "the superseded dial does not overwrite the approval")
    } else {
        check(false, "the superseded dial does not overwrite the approval")
    }
    checkEqual(try store.all().count, 1, "the approved pairing is the one in the list")
    check(try store.current().isPaired,
          "and it is still the current computer, so 远程控制 opens the conversation list")
    checkEqual(try store.current().address, try store.all().first?.address ?? "",
               "the current computer and the computer list agree on which computer it is")
}

do {
    // The state the old build left on the phone: the list holds the approved
    // pairing while the top level holds a late request for the same address.
    // Nothing re-pairs on its own, so the next launch has to read it correctly
    // rather than showing 已连接 in one place and 添加电脑 in the other.
    let vault = MemoryCredentialVault()
    let store = ComputerStore(vault: vault)
    let address = "http://100.64.0.1:43127"
    try store.save(PairedComputer(address: address, name: "phone", computerName: "HP",
                                  token: token43, deviceId: "d1", permission: .control))
    var stale = PairedComputer(address: address, name: "phone",
                               claim: "cl", pairingId: "i1", expiresAt: 60_000)
    var top = stale.json
    top["computers"] = (try vault.load()).object("computers")?.raw ?? [:]
    try vault.save(JSONObject(dictionary: top))

    check(try store.current().isPaired, "a current computer left behind by a late request reads back as paired")
    checkEqual(try store.all().count, 1, "the list still holds the pairing")

    // And the same write through the store cannot do it again: a request that
    // brings no credentials never takes away the ones on file.
    try store.save(stale)
    check(try store.current().isPaired, "a request in flight does not un-pair the computer it is aimed at")
    checkEqual(try store.all().first?.token ?? "", token43, "the list keeps the token it had")
    checkEqual(try store.all().count, 1, "and the request does not list itself")
    checkEqual(try store.current().claim ?? "", "cl", "while the claim is still there to resume from")

    stale.claim = nil
    stale.pairingId = nil
    stale.expiresAt = nil
    try store.save(stale)
    check(try store.current().isPaired, "and a save that carries nothing at all does not either")
}

do {
    let (pairing, scheduler, store, transport) = pairingHarness(now: 5_000)
    transport.requestResult = .success(pairRequestResult(expiresAt: 1_000))
    try pairing.start(goodDraft)
    scheduler.drain(limit: 2)
    check(pairing.phase == .expired, "a deadline that has already passed ends the wait")
    checkEqual(transport.claims.count, 0, "without asking the desktop about a dead claim")
    checkEqual(try store.current().claim ?? "", "", "and the claim is dropped")
}

do {
    let (pairing, scheduler, store, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    transport.claimResult = { _ in .failure(StubHttpError(status: 401, detail: "revoked")) }
    try pairing.start(goodDraft)
    scheduler.drain(limit: 2)
    if case .failed(let message) = pairing.phase {
        check(message.contains("[HTTP 401]"), "a refused claim is reported with its status")
    } else {
        check(false, "a refused claim is reported")
    }
    checkEqual(try store.current().claim ?? "", "", "and the claim is dropped so a new code can be used")
}

do {
    // A token that does not have the gateway's shape would fail every later
    // request as a 401, so it is refused here instead of being stored.
    let (pairing, scheduler, store, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    transport.claimResult = { _ in .success(pairClaimResult(token: String(repeating: "A", count: 42))) }
    try pairing.start(goodDraft)
    scheduler.drain(limit: 2)
    check(pairing.phase == .failed(PairingFlowError.unusableCredentials.localizedDescription), "a malformed token is refused")
    checkEqual(try store.current().token ?? "", "", "and nothing is stored")
}

do {
    // Same for a permission this build does not have a name for.
    let (pairing, scheduler, _, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    transport.claimResult = { _ in .success(pairClaimResult(permission: "admin")) }
    try pairing.start(goodDraft)
    scheduler.drain(limit: 2)
    check(pairing.phase == .failed(PairingFlowError.unusableCredentials.localizedDescription), "an unknown permission is refused")
}

do {
    let (pairing, _, _, transport) = pairingHarness()
    transport.requestResult = .failure(StubHttpError(status: 429, detail: "slow down"))
    try pairing.start(goodDraft)
    if case .failed(let message) = pairing.phase {
        check(message.contains("[HTTP 429]"), "a refused request is reported with its status")
    } else {
        check(false, "a refused request is reported")
    }
}

do {
    let store = ComputerStore(vault: MemoryCredentialVault())
    try store.save(PairedComputer(address: "http://100.64.0.1:43127", name: "phone", claim: "cl", pairingId: "i1", expiresAt: 60_000))
    let transport = StubPairing()
    transport.claimResult = { _ in .success(pairClaimResult()) }
    let scheduler = ManualScheduler()
    let pairing = PairingController(transport: transport, store: store, scheduler: scheduler,
                                    clock: { 10 }, pollInterval: 5, worker: { $0() }, notify: { $0() })
    try pairing.resume()
    checkEqual(transport.claims.count, 0, "resuming does not claim before the first poll")
    scheduler.drain()
    checkEqual(transport.claims.first?.id ?? "", "i1", "the stored claim is the one used")
    checkEqual(transport.claims.first?.claim ?? "", "cl", "with its handle")
    if case .approved = pairing.phase { check(true, "resuming finishes the pairing") } else { check(false, "resuming finishes the pairing") }
}

do {
    let (pairing, _, _, _) = pairingHarness()
    checkThrows(PairingFlowError.nothingToResume, "resuming with no stored request is refused") { try pairing.resume() }
}

do {
    let (pairing, scheduler, _, transport) = pairingHarness()
    transport.requestResult = .success(pairRequestResult())
    transport.claimResult = { _ in .success(pairClaimResult(state: "pending")) }
    try pairing.start(goodDraft)
    pairing.cancel()
    checkEqual(scheduler.pending.count, 0, "cancelling stops the polls")
    checkEqual(scheduler.drain(), 0, "and nothing already scheduled still runs")
    check(pairing.phase == .idle, "cancelling returns to idle")
}

do {
    let payload = try PairingPayload(#"{"type":"camellia-pair","v":"1","address":"http://100.64.0.1:43127","code":"0123456789abcdef01234567"}"#)
    let draft = PairingDraft(payload: payload, name: "phone")
    checkEqual(draft.address, "100.64.0.1", "the QR's origin becomes the address field")
    checkEqual(draft.port, "43127", "and its port the port field")
    checkEqual(draft.code, "0123456789abcdef01234567", "the code is carried over")
    checkEqual(try PairingController.validate(draft).origin, "http://100.64.0.1:43127", "so resubmitting rebuilds the same origin")
}

// MARK: - Markdown
//
// The assistant's prose arrives as Markdown and there is no commonmark on iOS,
// so the reader lives in the core and is checked here. The shapes below are
// what the views lay out; getting one wrong is invisible in a unit test of the
// networking code but obvious on screen.

func shape(_ value: MarkdownBlock) -> String {
    switch value {
    case .heading(let level, let inline): return "h\(level)[\(inline.map(ishape).joined(separator: ""))]"
    case .paragraph(let inline): return "p[\(inline.map(ishape).joined(separator: ""))]"
    case .code(let language, let text): return "code(\(language))[\(text)]"
    case .list(let ordered, let start, let items):
        return "list(\(ordered ? "o" : "u"):\(start)){" + items.map { $0.map(shape).joined(separator: ",") }.joined(separator: ";") + "}"
    case .quote(let blocks): return "quote{" + blocks.map(shape).joined(separator: ",") + "}"
    case .divider: return "hr"
    case .table(let rows):
        return "table{" + rows.map { row in
            row.map { "\($0.header ? "H" : "c")\($0.alignment.rawValue.first.map(String.init) ?? "s")[\($0.inline.map(ishape).joined(separator: ""))]" }.joined(separator: "|")
        }.joined(separator: ";") + "}"
    }
}

func ishape(_ value: MarkdownInline) -> String {
    switch value {
    case .text(let text): return text
    case .code(let text): return "`\(text)`"
    case .strong(let children): return "*" + children.map(ishape).joined(separator: "") + "*"
    case .emphasis(let children): return "_" + children.map(ishape).joined(separator: "") + "_"
    case .strikethrough(let children): return "~" + children.map(ishape).joined(separator: "") + "~"
    case .link(let destination, let children): return "[\(children.map(ishape).joined(separator: ""))](\(destination))"
    case .image(let alt, let destination): return "![\(alt.map(ishape).joined(separator: ""))](\(destination))"
    case .lineBreak: return "\n"
    }
}

func shapes(_ source: String) -> String {
    MarkdownParser.parse(source).displayed.map(shape).joined(separator: " ")
}

do {
    checkEqual(shapes("# Title"), "h1[Title]", "one hash is a level-one heading")
    checkEqual(shapes("### Deep"), "h3[Deep]", "three hashes are a level-three heading")
    checkEqual(shapes("####### Too many"), "p[Too many]", "seven hashes is not a heading")
    checkEqual(shapes("Title #"), "p[Title #]", "nor is a lone trailing hash")
    checkEqual(shapes("### Padded ###"), "h3[Padded]", "closing hashes are decoration")
}

do {
    checkEqual(shapes("plain text"), "p[plain text]", "a bare line is a paragraph")
    checkEqual(shapes("a **bold** word"), "p[a *bold* word]", "double asterisks are strong")
    checkEqual(shapes("an _italic_ word"), "p[an _italic_ word]", "single underscores are emphasis")
    checkEqual(shapes("some `code` here"), "p[some `code` here]", "backticks are inline code")
    checkEqual(shapes("a ~~gone~~ word"), "p[a ~gone~ word]", "double tildes are struck through")
    checkEqual(shapes("[text](https://a.b/c)"), "p[[text](https://a.b/c)]", "a link keeps its destination")
    checkEqual(shapes("![alt](https://a.b/i.png)"), "p[![alt](https://a.b/i.png)]", "an image keeps its address")
    checkEqual(shapes("**bold _and_ more**"), "p[*bold _and_ more*]", "emphasis nests inside strong")
    checkEqual(shapes("a \\*star\\* b"), "p[a *star* b]", "a backslash escapes punctuation")
    checkEqual(shapes("un`closed"), "p[un`closed]", "an unclosed backtick stays literal")
    checkEqual(shapes("a **b"), "p[a **b]", "an unclosed strong stays literal")
}

do {
    checkEqual(shapes("```swift\nlet x = 1\n```"), "code(swift)[let x = 1]", "a fenced block keeps its language")
    checkEqual(shapes("```\nplain\n```"), "code()[plain]", "a fence without a language has none")
    checkEqual(shapes("```js\nunclosed"), "code(js)[unclosed]", "an unclosed fence still becomes code")
    checkEqual(shapes("~~~\nbody\n~~~"), "code()[body]", "tildes fence too")
}

do {
    checkEqual(shapes("- one\n- two"), "list(u:0){p[one];p[two]}", "bullets are an unordered list")
    checkEqual(shapes("3. three\n4. four"), "list(o:3){p[three];p[four]}", "an ordered list keeps its start number")
    checkEqual(shapes("1. **bold** item"), "list(o:1){p[*bold* item]}", "a list item is parsed inline too")
    checkEqual(shapes("- one\n\n  continued"), "list(u:0){p[one],p[continued]}", "an indented line continues the item")
    checkEqual(shapes("- one\n\nafter"), "list(u:0){p[one]} p[after]", "a flush line ends the list")
}

do {
    checkEqual(shapes("| a | b |\n|---|---|\n| 1 | 2 |"),
               "table{Hs[a]|Hs[b];cs[1]|cs[2]}", "a table keeps its header row")
    checkEqual(shapes("| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |"),
               "table{Hs[l]|Hc[c]|He[r];cs[1]|cc[2]|ce[3]}", "each column keeps its own alignment")
    checkEqual(shapes("a | b\n--|--"), "table{Hs[a]|Hs[b]}", "pipes at the edges are optional")
    checkEqual(shapes("| a |\n| - |\nnot a table"), "table{Hs[a]} p[not a table]", "a row without a pipe ends the table")
    checkEqual(shapes("|a|\n|b|"), "p[|a|\n|b|]", "without a divider row the pipes are just text")
}

do {
    checkEqual(shapes("> quoted\n> more"), "quote{p[quoted\nmore]}", "a quote holds its lines as one paragraph")
    checkEqual(shapes("> outer\n\nafter"), "quote{p[outer]} p[after]", "a blank line ends the quote")
    checkEqual(shapes("---"), "hr", "three dashes are a divider")
    checkEqual(shapes("_ _ _"), "hr", "so are three spaced underscores")
    checkEqual(shapes("- - -"), "hr", "a rule outranks a list, as in commonmark")
}

do {
    check(MarkdownLink.isSafe("https://example.com/a"), "an https link can be opened")
    check(MarkdownLink.isSafe("http://example.com/a"), "an http link can be opened")
    check(!MarkdownLink.isSafe("javascript:alert(1)"), "a javascript link cannot")
    check(!MarkdownLink.isSafe("file:///etc/passwd"), "a file link cannot")
    check(!MarkdownLink.isSafe("https://user:pw@example.com/"), "a link carrying credentials cannot")
    check(!MarkdownLink.isSafe("https://"), "a link without a host cannot")
    check(!MarkdownLink.isSafe("/relative/path"), "a relative link cannot")
}

do {
    let source = String(repeating: "- item\n", count: 1400)
    let document = MarkdownParser.parse(source)
    check(document.truncated, "a document past the node limit is abandoned")
    checkEqual(document.displayed.count, 1, "and shown as a single block")
    checkEqual(document.displayed.first.map(shape) ?? "", "p[\(source)]", "with the source verbatim")
    checkEqual(MarkdownParser.parse(String(repeating: "|a|b|\n|-|-|\n", count: 900)).truncated, true,
               "a wall of table cells is abandoned too")
    checkEqual(MarkdownParser.parse("").displayed.count, 0, "an empty document has no blocks")
    checkEqual(MarkdownParser.parse("").plainText.count, 0, "and no text")
}

do {
    let document = MarkdownParser.parse("# Head\n\nBody `x` and [link](https://a.b).")
    checkEqual(document.plainText, "Head\n\nBody x and link.", "the plain text drops the markup")
    checkEqual(MarkdownParser.parse("- one\n- two\n").plainText, "one\ntwo", "and reads a list line by line")
    check(!document.isEmpty, "a document with blocks is not empty")
    check(MarkdownParser.parse("").isEmpty, "one without is")
}

do {
    let pathological = String(repeating: "[", count: 8000)
    checkEqual(MarkdownParser.parse(pathological).plainText, pathological, "unclosed brackets remain literal without repeated suffix scans")
    check(!MarkdownParser.parse(String(repeating: "[", count: 8000) + "]").displayed.isEmpty,
          "nested link labels share an index and have bounded depth")
    check(MarkdownParser.parse("reply", isCancelled: { true }).truncated, "background parsing can exit on cancellation")
    check(MarkdownParser.parse(String(repeating: "x", count: MarkdownParser.maximumSourceBytes + 1)).truncated,
          "large sources fall back before allocating delimiter indexes")
    check(MarkdownParser.parse(String(repeating: "a `x` ", count: 12_000)).truncated,
          "inline node allocation is bounded")
    checkEqual(shapes("hello\u{3000}**\u{3000}**"), "p[hello\u{3000}**\u{3000}**]", "Unicode-only whitespace keeps unclosed emphasis literal")
    let cache = MarkdownDocumentCache(maximumBytes: 4000, maximumEntries: 2)
    for source in ["one", "two"] { cache.insert(MarkdownParser.parse(source)) }
    _ = cache.document(for: "one")
    cache.insert(MarkdownParser.parse("three"))
    checkEqual(cache.count, 2, "completed Markdown cache entry count is bounded")
    check(cache.document(for: "two") == nil && cache.document(for: "one") != nil,
          "completed Markdown cache keeps the recently used document")
    cache.insert(MarkdownParser.parse(String(repeating: "huge", count: 2000)))
    check(cache.bytes <= 4000 && cache.count == 2, "an oversized document cannot grow the completed cache")
}

// MARK: - Node state

do {
    check(NodeState(raw: "Running").isRunning, "the bridge's Running is the only state that carries traffic")
    check(NodeState(raw: "NeedsLogin").awaitsSignIn, "NeedsLogin waits for the person")
    check(NodeState(raw: "NeedsMachineAuth").awaitsSignIn, "so does NeedsMachineAuth")
    check(NodeState(raw: "Starting") == .starting, "Starting is its own state")
    check(!NodeState(raw: "Starting").isRunning, "a node on its way up is not yet usable")
    check(!NodeState(raw: "Stopped").isRunning, "nor is one that stopped")
    // The bridge writes an em dash when it has no state at all, and the app
    // reads an empty string before the first reply arrives. Both mean the same
    // thing and neither should surface as an unknown state.
    check(NodeState(raw: "") == .notStarted, "an empty state reads as not started")
    check(NodeState(raw: "NoState") == .notStarted, "as does the bridge's NoState")
    check(NodeState(raw: "—") == .notStarted, "as does its placeholder dash")
    // A state added to the bridge before this build knows it is shown verbatim
    // rather than hidden.
    check(NodeState(raw: "Reloading") == .other("Reloading"), "an unknown state is kept")
    checkEqual(NodeState(raw: "Reloading").label(), "Reloading", "and shown as it came")
    checkEqual(NodeState(raw: "Running").label(), "已连接", "the known states have names")
    checkEqual(NodeState(raw: "NeedsLogin").label(chinese: false), "Waiting for sign-in",
               "and an English name for each")
}

// MARK: - Remote entry gate

do {
    var gate = EntryGateTracker(now: 100)
    func observe(_ now: TimeInterval, _ node: NodeState = .starting,
                 online: Bool = true, embedded: Bool = true,
                 login: Bool = false, failed: Bool = false) -> RemoteEntryGate {
        gate.observe(now: now, online: online, embedded: embedded,
                     node: node, hasLoginURL: login, failed: failed)
    }
    checkEqual(observe(100), .connecting, "the home remote entry begins connecting")
    checkEqual(gate.remaining(now: 100), 30, "the initial entry gets a full deadline")
    checkEqual(observe(129.9), .connecting, "a node gets the full thirty seconds")
    checkEqual(observe(130), .timedOut, "a stalled node points the person to Mobile access")
    gate.restart(now: 131)
    checkEqual(observe(131), .connecting, "retry starts a new connection window")
    checkEqual(observe(132, .needsLogin), .signIn, "a login requirement is actionable at once")
    checkEqual(observe(132, login: true), .signIn, "a login URL is actionable too")
    checkEqual(observe(132, failed: true), .failed, "a probe error shows the retry path")
    checkEqual(observe(140, online: false), .offline, "the missing route is reported before probing")
    checkEqual(observe(141), .connecting, "reconnection gets a new deadline")
    checkEqual(observe(141, .running), .ready, "a running node opens the remote card")
    checkEqual(observe(170), .connecting, "a previously running node gets a new startup window")
    checkEqual(gate.remaining(now: 170), 1,
               "a reconnecting node keeps the remaining deadline from its last ready probe")
    checkEqual(observe(171, embedded: false), .ready, "external VPN mode uses reachability")
    checkEqual(observe(172, online: false, embedded: false), .offline,
               "external VPN mode still reports an offline route")

    var signInGate = EntryGateTracker(now: 200)
    checkEqual(signInGate.observe(now: 240, online: true, embedded: true,
                                  node: .needsLogin, hasLoginURL: false, failed: false),
               .signIn, "in-app sign-in stays actionable beyond the initial deadline")
    checkEqual(signInGate.observe(now: 241, online: true, embedded: true,
                                  node: .starting, hasLoginURL: false, failed: false),
               .connecting, "closing in-app sign-in gets a fresh connection window")
}

// MARK: - What the device may do

do {
    let full = RemoteAccess(JSONObject(dictionary: [
        "permission": "control",
        "capabilities": ["create", "create-workspace", "move", "archive", "conversation-actions",
                         "image", "multi-image", "attachments", "expanded-attachments"],
    ]))
    check(full.canDrive, "control drives")
    check(full.canCreate, "control plus create can create")
    check(full.canArchive, "control plus archive can archive")
    check(full.canMove, "control plus move can move")
    check(full.canManageConversations, "control plus conversation-actions can manage")
    check(full.canCreateWorkspace, "and create-workspace, which Android also gates on control")
    check(full.canAttachImages, "images need no more than being offered")
    check(full.canAttachFiles, "so do files")
    checkEqual(full.imageLimit, 8, "multi-image allows a tray of eight")
}

do {
    let readOnly = RemoteAccess(JSONObject(dictionary: [
        "permission": "read",
        "capabilities": ["create", "create-workspace", "archive", "move", "conversation-actions", "image"],
    ]))
    check(!readOnly.canDrive, "read does not drive")
    check(!readOnly.canCreate, "so create is withheld even though the desktop lists it")
    check(!readOnly.canCreateWorkspace, "and create-workspace, for the same reason")
    check(!readOnly.canArchive, "and archive")
    check(!readOnly.canMove, "and move")
    // The one that is easy to get wrong: Android gates conversation-actions on
    // control in the same breath as the other four, so a read-only pairing must
    // not be offered rename, pin and delete.
    check(!readOnly.canManageConversations, "and conversation-actions, which is gated on control too")
    check(readOnly.canAttachImages, "but images are offered on a read-only pairing")
}

do {
    checkEqual(RemoteAccess(JSONObject(dictionary: ["capabilities": ["image"]])).permission, .read,
               "a missing permission reads as read rather than control")
    // A desktop that never advertises the command would answer with an error the
    // person cannot act on, so control alone must not offer it.
    check(!RemoteAccess(JSONObject(dictionary: ["permission": "control",
                                                "capabilities": ["create"]])).canCreateWorkspace,
          "control without the capability does not allow creating a workspace")
    checkEqual(RemoteAccess(JSONObject(dictionary: ["permission": "control", "capabilities": ["image"]])).imageLimit, 1,
               "a single-image desktop takes one")
    checkEqual(RemoteAccess.readOnly.capabilities.rawValue, 0, "read-only carries no capabilities")
    checkEqual(RemoteAccess(JSONObject(dictionary: ["permission": "control", "capabilities": ["nonsense"]])).canCreate,
               false, "an unknown capability is ignored rather than guessed at")
    // Android treats either spelling as "files are supported".
    check(RemoteAccess(JSONObject(dictionary: ["capabilities": ["attachments"]])).canAttachFiles,
          "the older attachments flag is enough for files")
    check(RemoteAccess(JSONObject(dictionary: ["capabilities": ["expanded-attachments"]])).canAttachFiles,
          "so is the expanded one")
    check(!RemoteAccess(JSONObject(dictionary: ["capabilities": []])).canAttachFiles,
          "and neither flag means no files")
}

do {
    // The three-tier attachment count, read off the capabilities the desktop
    // advertises rather than decided here.
    let expanded = RemoteAccess(JSONObject(dictionary: ["capabilities": ["image", "multi-image", "expanded-attachments"]]))
    checkEqual(expanded.attachmentCount, 20, "a desktop that says expanded takes the full twenty")
    check(expanded.canAttach, "and offers an attach button")
    check(expanded.allowsMultipleImages, "and a tray")

    let legacyFiles = RemoteAccess(JSONObject(dictionary: ["capabilities": ["image", "attachments"]]))
    checkEqual(legacyFiles.attachmentCount, 9, "one that only says attachments takes the legacy nine")
    check(!legacyFiles.usesExpandedAttachments, "and is not treated as expanded")

    let single = RemoteAccess(JSONObject(dictionary: ["capabilities": ["image"]]))
    checkEqual(single.attachmentCount, 1, "and one that takes a single image takes exactly one")
    check(single.canAttach, "but still offers an attach button")

    let none = RemoteAccess(JSONObject(dictionary: ["permission": "control", "capabilities": ["create"]]))
    check(!none.canAttach, "a desktop that takes no attachments offers no button at all")
}

do {
    let page = RemoteListPage(try! JSONBody.object(Data(
        #"{"protocol":1,"permission":"control","capabilities":["create"],"conversations":[],"nextOffset":-1}"#.utf8)))
    check(page.access?.canCreate == true, "the list page carries the access when the desktop puts it there")

    // An older desktop answers with a list and nothing else; the caller has to
    // ask /v1/status instead, which is exactly what a nil access is for.
    let bare = RemoteListPage(try! JSONBody.object(Data(#"{"conversations":[]}"#.utf8)))
    check(bare.access == nil, "a list without a protocol advertises nothing")
    checkEqual(bare.nextOffset, -1, "and still reads as the last page")
}

// MARK: - Engines

do {
    // A desktop that says nothing keeps the five Android has always offered.
    checkEqual(RemoteEngine.available(advertised: nil).map(\.rawValue),
               ["codex", "claude", "kimi", "dsh", "antigravity"],
               "no advertised list keeps the five defaults")

    // One that advertises is taken at its word — filtered to the names this
    // client can label, in the desktop's order, without repeats.
    checkEqual(RemoteEngine.available(advertised: ["pi", "codex", "pi", "nope", "claude"]).map(\.rawValue),
               ["pi", "codex", "claude"],
               "an advertised list is filtered, deduped and kept in its order")

    // Advertising an empty list is not the same as saying nothing: it offers no
    // engine at all, which is the distinction the nil-vs-empty split protects.
    checkEqual(RemoteEngine.available(advertised: []).count, 0, "an empty advertisement offers no engine")

    checkEqual(RemoteEngine.pi.label, "Pi", "Pi keeps its spelling")
    checkEqual(RemoteEngine.codex.label, "CODEX", "the rest are upper-cased")
}

do {
    let page = RemoteListPage(try! JSONBody.object(Data(
        #"{"protocol":1,"permission":"control","engines":["codex","pi"],"conversations":[]}"#.utf8)))
    checkEqual(page.availableEngines.map(\.rawValue), ["codex", "pi"],
               "the list page carries the engines the desktop advertises")

    let bare = RemoteListPage(try! JSONBody.object(Data(#"{"conversations":[]}"#.utf8)))
    check(bare.engines == nil, "a list that says nothing about engines leaves it nil")
    checkEqual(bare.availableEngines.map(\.rawValue),
               ["codex", "claude", "kimi", "dsh", "antigravity"],
               "and falls back to the five defaults")
}

// MARK: - Remote model groups

do {
    let legacy = RemoteModelChoice(JSONObject(dictionary: ["id": "legacy", "name": "Legacy"]))
    checkEqual(legacy.connection, "api", "a missing model connection defaults to API, as on Android")
    check(!legacy.isSubscription, "the legacy model is not a subscription")
    let unnamed = RemoteModelChoice(JSONObject(dictionary: ["id": "raw-id"]))
    checkEqual(unnamed.name, "raw-id", "a missing display name falls back to the model id")
    let explicitlyBlank = RemoteModelChoice(JSONObject(dictionary: ["id": "blank", "name": ""]))
    checkEqual(explicitlyBlank.name, "", "an explicit blank name is not replaced")
    let subscription = RemoteModelChoice(JSONObject(dictionary: [
        "id": "account", "name": "Account", "connection": "subscription",
    ]))
    check(subscription.isSubscription, "a subscription keeps its separate heading")
    let unknown = RemoteModelChoice(JSONObject(dictionary: [
        "id": "unknown", "name": "Unknown", "connection": "other",
    ]))
    checkEqual(unknown.connection, "other", "an explicit unknown connection is not silently rewritten")
}

// MARK: - Attachments: limits and count

do {
    checkEqual(AttachmentLimits.maxCount, 20, "twenty attachments per message")
    checkEqual(AttachmentLimits.imageMaxSide, 3072, "images are capped at 3072 on the longest side")
    checkEqual(AttachmentLimits.imageMaxBytes, 4 * 1024 * 1024, "and at 4 MiB each")
    checkEqual(AttachmentLimits.documentMaxBytes, 10 * 1024 * 1024, "a document may be 10 MiB")
    checkEqual(AttachmentLimits.remoteMaxBytes, 32 * 1024 * 1024, "and a remote send 32 MiB in total")

    checkEqual(AttachmentRules.remoteCount(expanded: true, files: true, multiImage: true), 20,
               "the expanded flag means the full twenty")
    checkEqual(AttachmentRules.remoteCount(expanded: false, files: true, multiImage: false), 9,
               "an older file-capable desktop takes nine")
    checkEqual(AttachmentRules.remoteCount(expanded: false, files: false, multiImage: true), 9,
               "so does a multi-image one")
    checkEqual(AttachmentRules.remoteCount(expanded: false, files: false, multiImage: false), 1,
               "and a single-image one takes exactly one")
}

// MARK: - Attachments: validation

do {
    let oversizedImage = RemoteAttachment(name: "a.jpg", data: "blob-a", isImage: true)
    let apkErrors: [(AttachmentError, String)] = [
        (.tooMany(count: 20), "每条消息最多 20 个附件 / Up to 20 attachments per message"),
        (.imageTooBig, "图片压缩后不能超过 4 MiB / Compressed image exceeds 4 MiB"),
        (.documentTooBig, "单个文档不能超过 10 MiB / Document exceeds 10 MiB"),
        (.remoteTotalTooBig, "远程附件合计不能超过 32 MiB / Remote attachments exceed 32 MiB total"),
        (.remoteTooMany(count: 9), "当前电脑最多 9 个附件，更新电脑端可提高限额 / This desktop supports 9 attachments; update it for higher limits"),
        (.remoteLegacyTotalTooBig, "当前电脑附件合计最多 8 MiB，更新电脑端可提高至 32 MiB / This desktop supports 8 MiB total; update it for 32 MiB"),
        (.documentsUnsupported, "发送文档需要更新并重启电脑端 / Update and restart the desktop to send documents"),
        (.legacyImageTooBig, "当前电脑每张图片最多 1 MiB，更新电脑端可提高限额 / This desktop supports 1 MiB per image; update it for higher limits"),
        (.missing, "附件已丢失，请重新添加 / Attachment is missing; select it again"),
        (.storageUnavailable, "附件不可用，请重新添加 / Attachment unavailable; select it again"),
        (.unreadableImage, "Unreadable image"),
        (.imageTooLargeAfterCompression, "Image too large"),
    ]
    for (error, message) in apkErrors {
        checkEqual(error.localizedDescription, message, "APK attachment feedback for \(error)")
    }
    checkThrows(AttachmentError.missing, "an attachment without a readable size is refused") {
        try AttachmentRules.validate([oversizedImage], sizes: [:])
    }
    checkThrows(AttachmentError.missing, "remote attachment validation also refuses a missing size") {
        try AttachmentRules.validateRemote([oversizedImage], sizes: [:],
                                           expanded: true, files: true, multiImage: true)
    }
    checkThrows(AttachmentError.imageTooBig, "an image over 4 MiB is refused") {
        try AttachmentRules.validate([oversizedImage],
                                     sizes: ["blob-a": Int64(AttachmentLimits.imageMaxBytes) + 1])
    }

    let oversizedDocument = RemoteAttachment(name: "a.zip", data: "blob-b", isImage: false)
    checkThrows(AttachmentError.documentTooBig, "a document over 10 MiB is refused") {
        try AttachmentRules.validate([oversizedDocument],
                                     sizes: ["blob-b": Int64(AttachmentLimits.documentMaxBytes) + 1])
    }

    let many = (0..<21).map { RemoteAttachment(name: "a\($0).jpg", data: "blob-\($0)", isImage: true) }
    checkThrows(AttachmentError.tooMany(count: 20), "twenty-one attachments is one too many") {
        try AttachmentRules.validate(many, sizes: many.reduce(into: [String: Int64]()) { $0[$1.data] = 1 })
    }

    // Local chat talks straight to the provider and has no desktop transfer
    // budget. Nine four-megabyte images are individually valid there even
    // though the same selection is too large to send through a desktop.
    let heavy = (0..<9).map { RemoteAttachment(name: "h\($0).jpg", data: "heavy-\($0)", isImage: true) }
    do {
        try AttachmentRules.validate(heavy,
                                     sizes: heavy.reduce(into: [String: Int64]()) { $0[$1.data] = Int64(4 * 1024 * 1024) })
        check(true, "local chat has no remote transfer total")
    } catch {
        check(false, "local chat has no remote transfer total: threw \(error)")
    }
    checkThrows(AttachmentError.remoteTotalTooBig, "a remote total over 32 MiB is refused") {
        try AttachmentRules.validateRemote(
            heavy,
            sizes: heavy.reduce(into: [String: Int64]()) { $0[$1.data] = Int64(4 * 1024 * 1024) },
            expanded: true, files: true, multiImage: true)
    }
}

// MARK: - Attachments: the older desktop's lower limits

do {
    let ten = (0..<10).map { RemoteAttachment(name: "i\($0).jpg", data: "l-\($0)", isImage: true) }
    let tenSizes = ten.reduce(into: [String: Int64]()) { $0[$1.data] = 1 }
    checkThrows(AttachmentError.remoteTooMany(count: 9), "an older desktop takes at most nine") {
        try AttachmentRules.validateRemote(ten, sizes: tenSizes, expanded: false, files: true, multiImage: true)
    }
    // The same ten sail through once the desktop advertises the expanded cap,
    // which is what makes the count a property of the desktop and not a rule.
    do {
        try AttachmentRules.validateRemote(ten, sizes: tenSizes, expanded: true, files: true, multiImage: true)
        check(true, "the expanded desktop takes the same ten")
    } catch {
        check(false, "the expanded desktop takes the same ten: threw \(error)")
    }

    let heavy = (0..<5).map { RemoteAttachment(name: "h\($0).jpg", data: "h-\($0)", isImage: true) }
    let heavySizes = heavy.reduce(into: [String: Int64]()) { $0[$1.data] = Int64(2 * 1024 * 1024) }
    checkThrows(AttachmentError.remoteLegacyTotalTooBig, "an older file-capable desktop caps the total at 8 MiB") {
        try AttachmentRules.validateRemote(heavy, sizes: heavySizes, expanded: false, files: true, multiImage: true)
    }

    let document = [RemoteAttachment(name: "a.pdf", data: "d", isImage: false)]
    checkThrows(AttachmentError.documentsUnsupported, "a desktop with no file support cannot take a document") {
        try AttachmentRules.validateRemote(document, sizes: ["d": 10], expanded: false, files: false, multiImage: true)
    }

    let large = [RemoteAttachment(name: "a.jpg", data: "img", isImage: true)]
    checkThrows(AttachmentError.legacyImageTooBig, "and caps each image at 1 MiB") {
        try AttachmentRules.validateRemote(large, sizes: ["img": Int64(1024 * 1024) + 1],
                                           expanded: false, files: false, multiImage: true)
    }
}

// MARK: - Attachments: wire shape

do {
    let image = RemoteAttachment(name: "whatever.jpg", data: "blob-a", isImage: true)
    let document = RemoteAttachment(name: "报告.pdf", data: "blob-b", isImage: false)

    let payload = AttachmentRules.payload([document, image])
    checkEqual(payload.count, 2, "both files travel")
    checkEqual(payload[0]["name"] as? String, "mobile-image-1.jpg", "images are renamed and put first")
    checkEqual(payload[1]["name"] as? String, "报告.pdf", "documents keep the name they arrived with")
    checkEqual(payload[1]["isImage"] as? Bool, false, "and are marked as documents")

    let restored = AttachmentRules.restore(JSONObject(dictionary: ["attachments": [
        ["name": "a.jpg", "data": "blob-a", "isImage": true],
        ["name": "b.pdf", "data": "blob-b", "isImage": false],
    ]]))
    checkEqual(restored.count, 2, "a draft's attachments are rebuilt")
    checkEqual(restored[1].name, "b.pdf", "with the names they were saved under")

    let older = AttachmentRules.restore(JSONObject(dictionary: ["images": ["blob-1", "blob-2"]]))
    checkEqual(older.count, 2, "the images-only draft shape still reads")
    check(older.allSatisfy(\.isImage), "and is all images")

    let oldest = AttachmentRules.restore(JSONObject(dictionary: ["image": "blob-1"]))
    checkEqual(oldest.count, 1, "so does the single-image draft shape")

    checkEqual(AttachmentRules.legacyField(for: [image])?.key, "image", "one image uses the legacy single field")
    checkEqual(AttachmentRules.legacyField(for: [image,
        RemoteAttachment(name: "b.jpg", data: "c", isImage: true)])?.key,
               "images", "several images use the legacy list")
    check(AttachmentRules.legacyField(for: [image, document]) == nil, "a document has no legacy field")
}

// MARK: - Artifact references

do {
    checkEqual(ArtifactReferences.names(from: "已生成 `build/app.apk`，可以安装。"), ["app.apk"],
               "a backtick-quoted path is a file reference")
    checkEqual(ArtifactReferences.names(from: "见 [报告](docs/report.pdf)。"), ["report.pdf"],
               "so is a markdown link target")
    checkEqual(ArtifactReferences.names(from: "![预览](img/shot.png)"), ["shot.png"],
               "including an image link")
    checkEqual(ArtifactReferences.names(from: "`https://example.com/a.pdf`"), [],
               "an absolute URL is not a local file")
    checkEqual(ArtifactReferences.names(from: "`data:application/pdf;base64,AAAA`"), [],
               "neither is a data URL, however much it ends in a document extension")
    checkEqual(ArtifactReferences.names(from: "`src/main.js`"), [],
               "an extension not worth downloading is skipped")
    checkEqual(ArtifactReferences.names(from: "`a.pdf` 和 `a.pdf`"), ["a.pdf"],
               "the same file named twice is listed once")
    checkEqual(ArtifactReferences.names(from: "`C:\\out\\report.docx`"), ["report.docx"],
               "a Windows path reduces to its base name")
    checkEqual(ArtifactReferences.names(from: "```\n`build/app.apk`\n```"), [],
               "a path inside a code fence is an example, not a file")
    checkEqual(ArtifactReferences.names(from: "`readme.md`"), ["readme.md"], "markdown counts as a file")
    checkEqual(ArtifactReferences.names(from: "`a.PDF`"), ["a.PDF"], "the extension match ignores case")
    checkEqual(ArtifactReferences.names(from: "`a.pdf` `b.pdf` `c.pdf`", limit: 2), ["a.pdf", "b.pdf"],
               "the walk stops at the limit")
}

do {
    checkEqual(ArtifactReferences.kind(of: "setup.exe"), .package, "an installer is a package")
    checkEqual(ArtifactReferences.kind(of: "报告.pdf"), .pdf, "a PDF is a PDF")
    checkEqual(ArtifactReferences.kind(of: "data.csv"), .spreadsheet, "a CSV is a spreadsheet")
    checkEqual(ArtifactReferences.kind(of: "notes.md"), .text, "markdown is text for the purpose of the label")
    checkEqual(ArtifactReferences.fileExtension(of: "报告.pdf"), "PDF", "the chip shows the extension uppercased")
    checkEqual(ArtifactReferences.fileExtension(of: "README"), "?", "a name with no extension has none to show")

    checkEqual(ArtifactReferences.sorted(["z.md", "a.pdf", "setup.apk", "b.png"]),
               ["setup.apk", "z.md", "b.png", "a.pdf"],
               "packages first, then readable files in message order, then documents")
    checkEqual(ArtifactReferences.priority(of: "x.HTML"), 1, "an HTML file is promoted by extension, not by kind")
    checkEqual(ArtifactReferences.priority(of: "x.pdf"), 2, "a PDF is not")
}

// MARK: - Attachment store

do {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-attachment-checks-\(UUID().uuidString)", isDirectory: true)
    let store = AttachmentStore(directory: directory, keys: FileSecretKeyStore(url: directory.appendingPathComponent("key")))

    let payload = Data((0..<4096).map { UInt8($0 % 251) })
    let reference = try store.save(payload)
    check(AttachmentStore.isReference(reference), "a saved blob is named by a reference")
    check(reference.hasPrefix("camellia-blob:"), "under the blob prefix")
    checkEqual(try store.size(reference), Int64(payload.count), "and reports the payload size, not the file's")
    checkEqual(try store.open(reference), payload, "the bytes come back unchanged")
    let emptyReference = try store.save(Data())
    checkEqual(try store.size(emptyReference), 0, "an empty sealed blob has zero payload bytes")
    checkEqual(try store.open(emptyReference), Data(), "an empty sealed blob can be opened")
    store.remove(emptyReference)

    // The sealed layout is the reason `size` can be a subtraction: twelve bytes
    // of nonce and a sixteen-byte tag sit around the ciphertext.
    let name = String(reference.dropFirst(AttachmentStore.prefix.count))
    let onDisk = (try FileManager.default.attributesOfItem(
        atPath: directory.appendingPathComponent(name).path)[.size] as? NSNumber)?.int64Value ?? -1
    checkEqual(onDisk, Int64(payload.count + 28), "the file on disk is the payload plus a nonce and a tag")

    try store.savePreview(reference, Data("thumb".utf8))
    checkEqual(try store.preview(reference), Data("thumb".utf8), "a preview is preferred over the full file")

    let textBlob = try store.save(Data("extracted text".utf8))
    let textReference = textBlob.replacingOccurrences(of: AttachmentStore.prefix,
                                                       with: AttachmentStore.textPrefix)
    let resolved = try RemoteAttachmentJSON.resolve([
        "prompt": reference,
        "attachments": [["name": "photo.jpg", "data": reference]],
        "images": [reference],
        "document": ["text": textReference],
        "wrapped": "data:image/jpeg;base64," + reference,
    ], using: store)
    let encodedPayload = payload.base64EncodedString()
    let resolvedAttachment = ((resolved["attachments"] as? [[String: Any]])?.first)?["data"] as? String
    checkEqual(resolvedAttachment, encodedPayload, "a remote attachment reference becomes Base64")
    checkEqual((resolved["images"] as? [String])?.first, encodedPayload,
               "references in a binary array inherit the field name")
    checkEqual((resolved["document"] as? [String: Any])?["text"] as? String, "extracted text",
               "a sealed document-text reference becomes UTF-8 text")
    checkEqual(resolved["prompt"] as? String, reference,
               "a reference-looking prompt is not opened")
    checkEqual(resolved["wrapped"] as? String, "data:image/jpeg;base64," + reference,
               "a data URI outside a binary field is left alone")
    checkThrows(AttachmentError.storageUnavailable, "a binary reference needs an attachment store") {
        _ = try RemoteAttachmentJSON.resolve(["image": reference], using: nil)
    }

    let encoded = payload.base64EncodedString()
    checkEqual(try store.open(encoded), payload, "raw base64 opens without a blob behind it")
    checkEqual(try store.size(encoded), Int64(payload.count), "and its size is computed rather than read")
    check(!AttachmentStore.isReference(encoded), "base64 is not mistaken for a reference")

    store.remove(reference)
    store.remove(textReference)
    checkThrows(AttachmentError.missing, "a removed blob is gone") { _ = try store.size(reference) }

    checkEqual(AttachmentStore.references(in: ["a": reference, "b": [reference, "not-a-blob"]]),
               Set([reference]), "references are found wherever they are nested")
    try? FileManager.default.removeItem(at: directory)
}

// MARK: - Shared attachment ownership and crash recovery

do {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("camellia-blob-owners-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("blobs")
    let keys = FileSecretKeyStore(url: root.appendingPathComponent("key"))
    let beforeCrash = AttachmentStore(directory: directory, keys: keys)
    let shared = try beforeCrash.save(Data("shared".utf8))
    let remoteOnly = try beforeCrash.save(Data("other".utf8))
    let pending = try beforeCrash.save(Data("pending".utf8))
    let orphan = try beforeCrash.save(Data("orphan".utf8))
    try beforeCrash.savePreview(orphan, Data("thumb".utf8))
    try Data("keep unknown files".utf8).write(to: directory.appendingPathComponent("notes"))
    let attachments = AttachmentStore(directory: directory, keys: keys)
    try attachments.reconcile()
    checkEqual(try attachments.size(orphan), 6, "collection waits for every owner to load")
    let local = try LocalChatStore(directory: root.appendingPathComponent("local"), keys: keys, attachments: attachments)
    let id = try local.createConversation(workspaceId: "", routeId: "p/m")["id"] as! String
    try local.update(id) { $0["draftImages"] = [shared] }
    let vault = MemoryCredentialVault()
    try vault.save(JSONObject(dictionary: ["address": "active", "pendingCommand": ["image": pending],
        "computers": ["active": ["address": "active", "pendingCommand": ["image": pending], "draftAttachments": ["c": ["attachments": [["data": shared]]]]],
                      "other": ["address": "other", "draftAttachments": ["c": ["attachments": [["data": remoteOnly]]]],
                                "pendingCommand": ["document": ["text": pending.replacingOccurrences(of: AttachmentStore.prefix, with: AttachmentStore.textPrefix)]]]]]))
    let remote = ComputerStore(vault: vault, attachments: attachments)
    try remote.synchronizeAttachmentReferences()
    let inFlight = try attachments.save(Data("in flight".utf8))
    try attachments.reconcile()
    checkThrows(AttachmentError.missing, "startup removes a crash-orphaned blob") { _ = try attachments.size(orphan) }
    let orphanFile = directory.appendingPathComponent(String(orphan.dropFirst(AttachmentStore.prefix.count)))
    check(!FileManager.default.fileExists(atPath: orphanFile.appendingPathExtension("thumb").path), "the orphan thumbnail is removed with its blob")
    check(FileManager.default.fileExists(atPath: directory.appendingPathComponent("notes").path), "unmanaged files are retained")
    checkEqual(try attachments.size(inFlight), 9, "an import lease survives concurrent startup collection")
    checkEqual(try attachments.size(remoteOnly), 5, "an unselected computer's draft survives collection")
    checkEqual(try attachments.size(pending), 7, "pending commands and text aliases survive collection")

    let state = root.appendingPathComponent("local/state")
    let saved = try Data(contentsOf: state)
    try FileManager.default.removeItem(at: state)
    try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
    let rejected = try attachments.save(Data("rejected".utf8))
    var failed = false
    do { try local.update(id) { $0["draftImages"] = [rejected] } } catch { failed = true }
    attachments.remove(rejected)
    check(failed, "an attachment draft commit reports its storage failure")
    checkThrows(AttachmentError.missing, "rollback releases newly sealed files after a failed draft commit") { _ = try attachments.size(rejected) }
    checkEqual(try attachments.size(shared), 6, "failed attachment commits preserve the previous durable selection")
    try FileManager.default.removeItem(at: state)
    try saved.write(to: state)
    try local.deleteConversation(id)
    checkEqual(try attachments.size(shared), 6, "releasing the local owner does not delete another owner's file")
    try remote.update(address: "active") { $0.draftAttachments = nil }
    checkThrows(AttachmentError.missing, "the last durable owner releases the shared file") { _ = try attachments.size(shared) }
    attachments.remove(pending)
    checkEqual(try attachments.size(pending), 7, "explicit discard cannot remove a pending command's durable file")
    try remote.remove("other")
    checkThrows(AttachmentError.missing, "forgetting an unselected computer releases its draft files") { _ = try attachments.size(remoteOnly) }
    checkEqual(try attachments.size(pending), 7, "a top-level pending command remains an owner")
    attachments.remove(inFlight)
    checkThrows(AttachmentError.missing, "discarding an uncommitted import releases its lease") { _ = try attachments.size(inFlight) }

    let rollbackFile = try attachments.save(Data("original history".utf8))
    attachments.updateReferences(owner: "local", references: [rollbackFile])
    let hold = attachments.holdReferences([rollbackFile])
    attachments.updateReferences(owner: "local", references: [])
    try attachments.reconcile()
    checkEqual(try attachments.open(rollbackFile), Data("original history".utf8),
               "a prepared rewrite retains files required by cancellation rollback")
    attachments.updateReferences(owner: "local", references: [rollbackFile])
    attachments.releaseHeldReferences(hold)
    checkEqual(try attachments.size(rollbackFile), 16, "a restored durable owner survives releasing its temporary hold")
    let completedHold = attachments.holdReferences([rollbackFile])
    attachments.updateReferences(owner: "local", references: [])
    attachments.releaseHeldReferences(completedHold)
    checkThrows(AttachmentError.missing, "a completed replacement releases its old history files") { _ = try attachments.size(rollbackFile) }

    let protected = try attachments.save(Data("protected".utf8))
    let unreadableOwner = AttachmentStore(directory: directory, keys: keys)
    unreadableOwner.updateReferences(owner: "local", references: [])
    let badVault = MemoryCredentialVault()
    try badVault.save(JSONObject(dictionary: ["computers": 123]))
    checkThrows(CredentialStoreError.unreadable, "a malformed owner prevents cleanup registration") {
        try ComputerStore(vault: badVault, attachments: unreadableOwner).synchronizeAttachmentReferences()
    }
    try unreadableOwner.reconcile()
    checkEqual(try unreadableOwner.size(protected), 9, "an unreadable owner prevents orphan deletion")
}

do {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("camellia-pure-blob-paths-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("not-created")
    let store = AttachmentStore(directory: directory, keys: FileSecretKeyStore(url: root.appendingPathComponent("key")))
    let missing = AttachmentStore.prefix + UUID().uuidString.lowercased()
    _ = try? store.size(missing)
    _ = try? store.open(missing)
    _ = try? store.preview(missing)
    store.remove(missing)
    check(!FileManager.default.fileExists(atPath: directory.path), "attachment lookup/read/discard do not create their directory")
    let reference = try store.save(Data("first write".utf8))
    checkEqual(try store.open(reference), Data("first write".utf8), "the first attachment write creates its directory once")
}

// MARK: - Artifact pages

do {
    let page = RemoteArtifactPage(try! JSONBody.object(Data(
        #"{"artifacts":[{"id":"a","name":"报告.pdf","size":123,"extension":"pdf"}],"nextOffset":20}"#.utf8)))
    checkEqual(page.items.count, 1, "a page of artifacts reads")
    checkEqual(page.items[0].kind, .pdf, "and each file is classified by its name")
    checkEqual(page.items[0].size, 123, "with its stated size")
    checkEqual(page.nextOffset, 20, "and the offset for the next page")
    check(!page.isLast, "so there is more to load")

    // The desktop omits `nextOffset` on the final page; that is not an error,
    // it is the signal to hide the load-more button.
    let last = RemoteArtifactPage(try! JSONBody.object(Data(#"{"artifacts":[]}"#.utf8)))
    check(last.isLast, "a page with no offset is the last one")
}

// MARK: - Local chat: endpoint validation

do {
    checkEqual(try LocalChatConfiguration.endpoint("https://api.example.com/v1"), "https://api.example.com/v1",
               "a remote HTTPS endpoint is accepted")
    checkEqual(try LocalChatConfiguration.endpoint("https://api.example.com/v1///"), "https://api.example.com/v1",
               "trailing slashes are stripped")
    checkEqual(try LocalChatConfiguration.endpoint("  https://api.example.com  "), "https://api.example.com",
               "surrounding whitespace is trimmed")
    checkEqual(try LocalChatConfiguration.endpoint("http://localhost:8080/v1"), "http://localhost:8080/v1",
               "plain HTTP is allowed for loopback only")
    checkEqual(try LocalChatConfiguration.endpoint("http://127.0.0.1:8080"), "http://127.0.0.1:8080",
               "including the IPv4 loopback")

    checkThrows(LocalChatConfigError.insecureURL, "a plaintext remote host is refused") {
        _ = try LocalChatConfiguration.endpoint("http://api.example.com")
    }
    checkThrows(LocalChatConfigError.insecureURL, "credentials in the URL are refused") {
        _ = try LocalChatConfiguration.endpoint("https://user:pass@api.example.com")
    }
    checkThrows(LocalChatConfigError.insecureURL, "a query string is refused") {
        _ = try LocalChatConfiguration.endpoint("https://api.example.com?key=abc")
    }
    checkThrows(LocalChatConfigError.insecureURL, "a fragment is refused") {
        _ = try LocalChatConfiguration.endpoint("https://api.example.com#x")
    }
    checkThrows(LocalChatConfigError.invalidURL, "a non-URL is refused") {
        _ = try LocalChatConfiguration.endpoint("not a url")
    }
    checkThrows(LocalChatConfigError.invalidURL, "Java trim does not remove a non-breaking URL prefix") {
        _ = try LocalChatConfiguration.endpoint("\u{00A0}https://api.example.com")
    }
}

// MARK: - Local chat: routes

func providerConfig(_ overrides: [String: Any]) -> [String: Any] {
    var provider: [String: Any] = [
        "id": "p1",
        "name": "P",
        "protocol": "openai",
        "baseUrl": "https://api.example.com",
        "keys": [["key": "sk-aaa"]] as [[String: Any]],
        "models": [["id": "m1", "upstream": "gpt-4o"]] as [[String: Any]],
    ]
    for (key, value) in overrides { provider[key] = value }
    return ["providers": [provider]]
}

do {
    let config: [String: Any] = [
        "providers": [
            [
                "id": "p1",
                "name": "Provider One",
                "protocol": "dual",
                "baseUrl": "https://api.example.com/v1",
                "anthropicBaseUrl": "https://api.example.com",
                "keys": [
                    ["key": "sk-aaa", "enabled": true] as [String: Any],
                    ["key": "sk-bbb", "enabled": false] as [String: Any],
                    ["key": "sk-aaa", "enabled": true] as [String: Any],
                ] as [[String: Any]],
                "models": [
                    ["id": "gpt", "upstream": "gpt-4o"] as [String: Any],
                    ["id": "claude", "upstream": "claude-sonnet-4-6", "protocol": "anthropic"] as [String: Any],
                ] as [[String: Any]],
            ] as [String: Any]
        ]
    ]
    let routes = try LocalChatConfiguration.routes(config)
    checkEqual(routes.count, 2, "one route per model")
    checkEqual(routes[0].id, "p1/gpt", "the route id joins provider and model")
    checkEqual(routes[0].label, "Provider One · gpt", "and the label is the provider name joined to the model id")
    checkEqual(routes[0].model, "gpt-4o", "the wire model is the provider's upstream name")
    checkEqual(routes[0].wireProtocol, "openai", "dual resolves to openai for a model that did not say otherwise")
    checkEqual(routes[0].keys, ["sk-aaa"], "disabled and repeated keys collapse to one enabled key")
    checkEqual(routes[0].baseURL, "https://api.example.com/v1", "an openai model uses the base URL")

    checkEqual(routes[1].wireProtocol, "anthropic", "a model may override the provider protocol")
    checkEqual(routes[1].baseURL, "https://api.example.com", "an anthropic model prefers the anthropic base URL")
    checkEqual(routes[1].displayName, "claude", "the model half of the label splits off")
    checkEqual(routes[1].providerName, "Provider One", "and the provider half is whatever is left")
    checkEqual(routes[1].isAnthropic, true, "the route knows which protocol it speaks")

    checkEqual(try LocalChatConfiguration.routes(providerConfig([:])).count, 1, "a minimal provider yields a route")
    checkEqual(try LocalChatConfiguration.routes(providerConfig(["enabled": false])).count, 0,
               "a disabled provider yields nothing rather than an error")
    checkEqual(try LocalChatConfiguration.routes(providerConfig(["enabled": 0])).count, 1,
               "Android optBoolean uses its true fallback for numeric provider zero")
    checkEqual(try LocalChatConfiguration.routes(providerConfig(["enabled": "0"])).count, 1,
               "Android optBoolean uses its true fallback for string provider zero")
    checkEqual(try LocalChatConfiguration.routes(providerConfig(["enabled": "FALSE"])).count, 0,
               "Android optBoolean accepts case-insensitive false text")
    checkEqual(try LocalChatConfiguration.routes(providerConfig([
        "keys": [["key": "sk-aaa", "enabled": false]] as [[String: Any]],
    ])).count, 0, "so does a provider whose every key is disabled")
    checkEqual(try LocalChatConfiguration.routes(providerConfig([
        "keys": [["key": "sk-aaa", "enabled": 0]] as [[String: Any]],
    ])).count, 1, "Android optBoolean uses its true fallback for numeric key zero")
    checkEqual(try LocalChatConfiguration.routes(providerConfig([
        "protocol": "anthropic",
        "models": [["id": "m1", "upstream": "claude-3-5-sonnet"]] as [[String: Any]],
    ]))[0].wireProtocol, "anthropic", "auto under an anthropic provider resolves to anthropic")

    checkThrows(LocalChatConfigError.duplicateProvider, "an empty provider id is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig(["id": ""]))
    }
    do {
        var config = providerConfig([:])
        let provider = (config["providers"] as! [[String: Any]])[0]
        config["providers"] = [provider, provider]
        checkThrows(LocalChatConfigError.duplicateProvider, "a repeated provider id is refused") {
            _ = try LocalChatConfiguration.routes(config)
        }
    }
    checkThrows(LocalChatConfigError.unsupportedProtocol, "an unknown provider protocol is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig(["protocol": "gemini"]))
    }
    checkThrows(LocalChatConfigError.invalidKey, "an empty key is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig(["keys": [["key": "   "]] as [[String: Any]]]))
    }
    checkThrows(LocalChatConfigError.invalidKey, "a key carrying a newline is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig(["keys": [["key": "a\nb"]] as [[String: Any]]]))
    }
    checkEqual(try LocalChatConfiguration.routes(providerConfig([
        "keys": [["key": "\u{00A0}sk\u{00A0}"]] as [[String: Any]],
    ]))[0].key, "\u{00A0}sk\u{00A0}", "route keeps non-breaking spaces in an API key")
    check(LocalChatConfiguration.validModel("\u{00A0}"),
          "Java model validation permits a non-breaking space")
    check(LocalChatConfiguration.validModel("\u{007F}"),
          "Java model validation permits DEL")
    check(LocalChatConfiguration.validModel(String(repeating: "🐱", count: 100)),
          "model permits exactly 200 UTF-16 units")
    check(!LocalChatConfiguration.validModel(String(repeating: "🐱", count: 101)),
          "model refuses 202 UTF-16 units")
    checkThrows(LocalChatConfigError.invalidModel, "a model id with whitespace is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig([
            "models": [["id": "a b", "upstream": "x"]] as [[String: Any]],
        ]))
    }
    checkThrows(LocalChatConfigError.invalidModel, "a repeated model id is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig([
            "models": [["id": "m", "upstream": "x"], ["id": "m", "upstream": "y"]] as [[String: Any]],
        ]))
    }
    checkThrows(LocalChatConfigError.unsupportedModelProtocol, "an unknown model protocol is refused") {
        _ = try LocalChatConfiguration.routes(providerConfig([
            "models": [["id": "m", "upstream": "x", "protocol": "gemini"]] as [[String: Any]],
        ]))
    }
    checkThrows(LocalChatConfigError.invalidStructure, "a provider missing its base URL is a structure error") {
        _ = try LocalChatConfiguration.routes(["providers": [["id": "p1", "keys": [], "models": []]]])
    }
}

// MARK: - Local chat: provider editor

do {
    let original: [String: Any] = [
        "version": 9,
        "futureTopLevel": "kept",
        "providers": [
            [
                "id": "p1", "name": "Old", "type": "gateway",
                "baseUrl": "https://old.example.com", "protocol": "openai",
                "enabled": true, "futureProvider": 42,
                "keys": [["id": "k1", "key": "old-key", "enabled": true,
                          "futureKey": "kept"] as [String: Any]],
                "models": [["id": "m1", "upstream": "old-model", "protocol": "auto",
                            "futureModel": true] as [String: Any]],
            ] as [String: Any],
            [
                "id": "p2", "name": "Untouched", "baseUrl": "https://two.example.com",
                "protocol": "openai", "keys": [["key": "two-key"]],
                "models": [["id": "m2", "upstream": "model-two"]],
            ] as [String: Any],
        ] as [[String: Any]],
    ]
    let draft: [String: Any] = [
        "id": "p1", "name": "  Updated  ", "baseUrl": " https://api.example.com/v1/// ",
        "anthropicBaseUrl": " https://anthropic.example.com/ ", "protocol": "dual", "enabled": true,
        "keys": [["id": "k1", "key": "  new-key  ", "enabled": false] as [String: Any]],
        "models": [["id": "m1", "upstream": " new-model ", "protocol": "anthropic"] as [String: Any]],
    ]

    let edited = try LocalProviderEditor.upsert(draft, in: original)
    checkEqual(edited["version"] as? Int, 9, "editing preserves the config version")
    checkEqual(edited["futureTopLevel"] as? String, "kept", "editing preserves unknown top-level fields")
    let providers = edited["providers"] as! [[String: Any]]
    checkEqual(providers.count, 2, "editing replaces one provider rather than the whole list")
    let provider = providers[0]
    checkEqual(provider["name"] as? String, "Updated", "provider names are trimmed")
    checkEqual(provider["baseUrl"] as? String, "https://api.example.com/v1", "provider URLs are normalised")
    checkEqual(provider["anthropicBaseUrl"] as? String, "https://anthropic.example.com",
               "alternate URLs are normalised")
    checkEqual(provider["type"] as? String, "gateway", "an existing provider type survives")
    checkEqual(provider["futureProvider"] as? Int, 42, "unknown provider fields survive")
    let key = (provider["keys"] as! [[String: Any]])[0]
    checkEqual(key["key"] as? String, "new-key", "keys are trimmed")
    checkEqual(key["enabled"] as? Bool, false, "a key's enabled state is updated")
    checkEqual(key["futureKey"] as? String, "kept", "unknown key fields survive")
    let model = (provider["models"] as! [[String: Any]])[0]
    checkEqual(model["upstream"] as? String, "new-model", "upstream model ids are trimmed")
    var unusualDraft = draft
    unusualDraft["name"] = "\u{00A0}Provider\u{00A0}"
    unusualDraft["keys"] = [["id": "k1", "key": "\u{00A0}secret\u{00A0}"]] as [[String: Any]]
    unusualDraft["models"] = [["id": "m1", "upstream": "\u{00A0}model\u{00A0}"]] as [[String: Any]]
    let unusual = try LocalProviderEditor.upsert(unusualDraft, in: original)
    let unusualProvider = (unusual["providers"] as! [[String: Any]])[0]
    checkEqual(unusualProvider["name"] as? String, "\u{00A0}Provider\u{00A0}",
               "manual editor keeps Java-trimmed non-breaking spaces in provider names")
    checkEqual(((unusualProvider["keys"] as! [[String: Any]])[0])["key"] as? String,
               "\u{00A0}secret\u{00A0}", "manual editor keeps non-breaking spaces in keys")
    checkEqual(((unusualProvider["models"] as! [[String: Any]])[0])["upstream"] as? String,
               "\u{00A0}model\u{00A0}", "manual editor keeps non-breaking spaces in model ids")
    checkEqual(model["futureModel"] as? Bool, true, "unknown model fields survive")
    checkEqual((providers[1]["name"] as? String), "Untouched", "other providers are untouched")

    let disabled = try LocalProviderEditor.setEnabled(false, providerID: "p1", in: edited)
    let disabledProvider = (disabled["providers"] as! [[String: Any]])[0]
    checkEqual(disabledProvider["enabled"] as? Bool, false, "a provider can be disabled")
    checkEqual(disabledProvider["futureProvider"] as? Int, 42, "disabling is otherwise lossless")

    let unchanged = try LocalProviderEditor.setEnabled(false, providerID: "missing", in: edited)
    checkEqual((unchanged["providers"] as! [[String: Any]]).count, 2,
               "disabling an unknown provider is a no-op")
    let removed = try LocalProviderEditor.remove(providerID: "p1", from: edited)
    checkEqual((removed["providers"] as! [[String: Any]]).count, 1, "one provider can be removed")
    checkEqual(((removed["providers"] as! [[String: Any]])[0]["id"] as? String), "p2",
               "removing one provider leaves the others")

    checkThrows(LocalProviderEditError.missingName, "a provider needs a visible name") {
        var invalid = draft
        invalid["name"] = "   "
        _ = try LocalProviderEditor.upsert(invalid, in: original)
    }
    checkThrows(LocalProviderEditError.missingKey, "a provider needs a key row") {
        var invalid = draft
        invalid["keys"] = [Any]()
        _ = try LocalProviderEditor.upsert(invalid, in: original)
    }
    checkThrows(LocalProviderEditError.missingModel, "a provider needs a model row") {
        var invalid = draft
        invalid["models"] = [Any]()
        _ = try LocalProviderEditor.upsert(invalid, in: original)
    }
    checkEqual(LocalProviderEditError.missingName.description, "请输入供应商名称",
               "the provider name error matches Android's localizable label")
    checkEqual(LocalProviderEditError.missingKey.description, "请填写 API Key",
               "the key error matches Android's localizable label")
    checkEqual(LocalProviderEditError.missingModel.description, "至少填写一个模型 ID",
               "the model error matches Android's localizable label")
    checkThrows(LocalChatConfigError.insecureURL, "the editor applies route URL security") {
        var invalid = draft
        invalid["baseUrl"] = "http://api.example.com"
        _ = try LocalProviderEditor.upsert(invalid, in: original)
    }

    var fresh = draft
    fresh["id"] = ""
    fresh["keys"] = [["id": "", "key": "fresh-key"] as [String: Any]]
    let inserted = try LocalProviderEditor.upsert(fresh, in: ["providers": [Any]()])
    let insertedProvider = (inserted["providers"] as! [[String: Any]])[0]
    check(!(insertedProvider["id"] as? String ?? "").isEmpty, "a new provider receives an id")
    checkEqual(insertedProvider["type"] as? String, "custom", "a new provider is custom")
    check(!(((insertedProvider["keys"] as! [[String: Any]])[0]["id"] as? String) ?? "").isEmpty,
          "a new key receives an id")
}

// MARK: - Local chat: import and export

do {
    checkEqual(try LocalChatConfiguration.parse(
        #"{"format":"camellia-api-routes","version":2,"config":{"providers":[]}}"#).count, 1,
        "a well-formed bundle parses")
    checkEqual(try LocalChatConfiguration.parse(
        "\u{feff}{\"format\":\"camellia-api-routes\",\"version\":2,\"config\":{\"providers\":[]}}").count, 1,
        "a leading byte-order mark is tolerated")
    checkThrows(LocalChatConfigError.malformedJSON, "text that is not JSON is refused") {
        _ = try LocalChatConfiguration.parse("hello")
    }
    checkThrows(LocalChatConfigError.malformedJSON, "Java trim leaves a non-breaking JSON prefix") {
        _ = try LocalChatConfiguration.parse(
            "\u{00A0}{\"format\":\"camellia-api-routes\",\"version\":2,\"config\":{\"providers\":[]}}")
    }
    checkThrows(LocalChatConfigError.malformedJSON, "a bare array is refused") {
        _ = try LocalChatConfiguration.parse("[]")
    }
    checkThrows(LocalChatConfigError.wrongFormat, "another bundle format is refused") {
        _ = try LocalChatConfiguration.parse(#"{"format":"other","version":2,"config":{"providers":[]}}"#)
    }
    checkThrows(LocalChatConfigError.wrongFormat, "version 1 is refused") {
        _ = try LocalChatConfiguration.parse(#"{"format":"camellia-api-routes","version":1,"config":{"providers":[]}}"#)
    }
    checkThrows(LocalChatConfigError.missingProviders, "a bundle without a config is refused") {
        _ = try LocalChatConfiguration.parse(#"{"format":"camellia-api-routes","version":2}"#)
    }
    checkThrows(LocalChatConfigError.missingProviders, "a config without providers is refused") {
        _ = try LocalChatConfiguration.parse(#"{"format":"camellia-api-routes","version":2,"config":{}}"#)
    }
    checkThrows(LocalChatConfigError.duplicateProvider, "an invalid provider inside a bundle is still caught") {
        _ = try LocalChatConfiguration.parse(
            #"{"format":"camellia-api-routes","version":2,"config":{"providers":[{"id":"","baseUrl":"https://a.com","keys":[],"models":[]}]}}"#)
    }

    let config = providerConfig([:])
    let exported = try LocalChatConfiguration.export(config)
    check(exported.contains("\"camellia-api-routes\""), "an export names its format")
    check(exported.contains("\"version\" : 2"), "and its version")
    let reimported = try LocalChatConfiguration.parse(exported)
    checkEqual(try LocalChatConfiguration.routes(reimported).count, 1, "an exported config round-trips")
}

// MARK: - Local chat: thinking levels

do {
    checkEqual(LocalChatThinking.normalize("medium"), "medium", "medium is kept")
    checkEqual(LocalChatThinking.normalize("high"), "high", "high is kept")
    checkEqual(LocalChatThinking.normalize("low"), "auto", "anything else collapses to auto")
    checkEqual(LocalChatThinking.normalize(""), "auto", "including empty")

    checkEqual(LocalChatThinking.label("medium"), "标准", "medium reads as 标准")
    checkEqual(LocalChatThinking.label("high"), "进阶", "high reads as 进阶")
    checkEqual(LocalChatThinking.label("auto"), "默认", "auto reads as 默认")
    checkEqual(LocalChatThinking.display("minimal"), "快速", "a desktop level maps onto the shared wording")
    checkEqual(LocalChatThinking.display("low"), "快速", "as does its alias")
    checkEqual(LocalChatThinking.display("xhigh"), "极限", "and the extreme one")
    checkEqual(LocalChatThinking.display("off"), "关闭", "off is shown rather than hidden")
    checkEqual(LocalChatThinking.display("weird"), "weird", "an unrecognised level is passed through trimmed")
    checkEqual(LocalChatThinking.display(" Weird "), "Weird",
               "trimmed, but keeping the provider's own capitalisation")
    checkEqual(LocalChatThinking.display("\u{00A0}"), "\u{00A0}",
               "Java trim keeps a non-breaking space in a reported thinking level")
    checkEqual(LocalChatThinking.display("\u{00A0}high\u{00A0}"), "\u{00A0}high\u{00A0}",
               "a non-breaking space does not turn a provider level into high")
    checkEqual(LocalChatThinking.display(nil), "默认", "a missing level reads as the default")
    checkEqual(LocalChatThinking.display(""), "默认", "and so does an empty one")
}

do {
    let openai = LocalChatRoute(id: "a", label: "P · m", model: "gpt-4o",
                                wireProtocol: "openai", baseURL: "https://api.example.com", keys: ["sk-a"])
    let adaptive = LocalChatRoute(id: "b", label: "P · m", model: "claude-opus-4-6",
                                  wireProtocol: "anthropic", baseURL: "https://api.example.com", keys: ["sk-a"])
    let budget = LocalChatRoute(id: "c", label: "P · m", model: "claude-3-7-sonnet-20250219",
                                wireProtocol: "anthropic", baseURL: "https://api.example.com", keys: ["sk-a"])
    let old = LocalChatRoute(id: "d", label: "P · m", model: "claude-3-5-sonnet-20241022",
                             wireProtocol: "anthropic", baseURL: "https://api.example.com", keys: ["sk-a"])

    checkEqual(LocalChatThinking.adaptive(adaptive), true, "a 4.6 opus takes adaptive thinking")
    checkEqual(LocalChatThinking.adaptive(LocalChatRoute(id: "x", label: "P · m", model: "claude-mythos-1",
                                                        wireProtocol: "anthropic", baseURL: "https://a.com", keys: ["k"])),
               true, "so does the mythos line")
    checkEqual(LocalChatThinking.adaptive(old), false, "an older sonnet does not")
    checkEqual(LocalChatThinking.budget(budget), true, "3.7 sonnet takes a token budget")
    checkEqual(LocalChatThinking.budget(LocalChatRoute(id: "x", label: "P · m", model: "claude-opus-4",
                                                      wireProtocol: "anthropic", baseURL: "https://a.com", keys: ["k"])),
               true, "so does a bare opus-4")
    checkEqual(LocalChatThinking.budget(openai), false, "gpt-4o takes neither")

    checkEqual(LocalChatThinking.supported(openai), true, "an openai route can always express a level")
    checkEqual(LocalChatThinking.supported(old), false, "a model that reads no level cannot")
    checkEqual(LocalChatThinking.effective(old, "high"), "auto", "so the level is dropped rather than sent")

    var body: [String: Any] = [:]
    LocalChatThinking.apply(openai, "high", to: &body)
    checkEqual(body["reasoning_effort"] as? String, "high", "openai gets a reasoning_effort")
    check(body["thinking"] == nil, "and nothing else")

    body = [:]
    LocalChatThinking.apply(adaptive, "medium", to: &body)
    checkEqual((body["thinking"] as? [String: Any])?["type"] as? String, "adaptive", "an adaptive model gets an adaptive block")
    checkEqual((body["output_config"] as? [String: Any])?["effort"] as? String, "medium", "with the effort beside it")
    checkEqual(body["max_tokens"] as? Int, 16384, "and room to think")

    body = [:]
    LocalChatThinking.apply(budget, "high", to: &body)
    checkEqual((body["thinking"] as? [String: Any])?["type"] as? String, "enabled", "a budget model gets an enabled block")
    checkEqual((body["thinking"] as? [String: Any])?["budget_tokens"] as? Int, 8192, "high buys a large budget")
    checkEqual(body["max_tokens"] as? Int, 8192 + 4096, "and the cap is raised above it")

    body = [:]
    LocalChatThinking.apply(budget, "medium", to: &body)
    checkEqual((body["thinking"] as? [String: Any])?["budget_tokens"] as? Int, 2048, "medium buys a smaller one")

    body = [:]
    LocalChatThinking.apply(old, "high", to: &body)
    check(body.isEmpty, "an unsupported level leaves the body untouched")

    body = [:]
    LocalChatThinking.apply(openai, "auto", to: &body)
    check(body.isEmpty, "and auto is the same as saying nothing")
}

// MARK: - Local chat: HTTP errors

do {
    let unauthorized = LocalChatHTTPError.from(
        status: 401, source: #"{"error":{"message":"Invalid API key sk-secret"}}"#,
        keys: ["sk-secret"], host: "api.example.com", attempt: 1, total: 1)
    check(unauthorized.tryNextKey, "a rejected key is worth rotating")
    check(unauthorized.message.contains("密钥认证被拒绝"), "and reads as an authentication failure")
    check(unauthorized.message.contains("api.example.com"), "the host is named so two providers can be told apart")
    check(!unauthorized.message.contains("sk-secret"), "and the key never reaches the message")
    check(unauthorized.message.contains("[redacted]"), "it is replaced instead")

    let limited = LocalChatHTTPError.from(status: 429, source: "", keys: [], host: "h", attempt: 1, total: 1)
    check(limited.tryNextKey, "a rate limit is worth rotating")
    check(limited.message.contains("达到额度或速率限制"), "and reads as a limit")

    let upstream = LocalChatHTTPError.from(status: 500, source: "", keys: [], host: "h", attempt: 1, total: 1)
    check(!upstream.tryNextKey, "an upstream fault is not — a different key would hit the same wall")
    check(upstream.message.contains("上游服务暂时异常"), "and says so")

    let gateway = LocalChatHTTPError.from(status: 403, source: "<html><body>Blocked</body></html>",
                                          keys: ["sk-a"], host: "h", attempt: 1, total: 1)
    check(!gateway.tryNextKey, "an HTML body means a gateway answered, not the provider")
    check(gateway.message.contains("网络网关拒绝访问"), "and the wording says a key is not the problem")
    check(!gateway.message.contains("服务商信息"), "an HTML body is not echoed back at all")

    let quota = LocalChatHTTPError.from(status: 403, source: #"{"error":{"message":"quota exceeded"}}"#,
                                        keys: [], host: "h", attempt: 1, total: 1)
    check(quota.tryNextKey, "a quota refusal on 403 is worth rotating")
    check(quota.message.contains("额度或套餐权限不足"), "and reads as a quota problem")

    let region = LocalChatHTTPError.from(status: 403, source: #"{"error":{"message":"not available in your region"}}"#,
                                         keys: [], host: "h", attempt: 1, total: 1)
    check(!region.tryNextKey, "a region block is not — every key is blocked in the same country")
    check(region.message.contains("服务商拒绝访问"), "and the wording is the plain access-denied one")

    let payment = LocalChatHTTPError.from(status: 402, source: "", keys: [], host: "h", attempt: 1, total: 1)
    check(payment.tryNextKey, "a payment-required status is worth rotating")
    check(payment.message.contains("额度或套餐权限不足"), "and reads as a quota problem")

    let explicit = LocalChatHTTPError.from(status: 400, source: #"{"error":{"code":"insufficient_quota"}}"#,
                                           keys: [], host: "h", attempt: 1, total: 1)
    check(explicit.tryNextKey, "an explicit quota code on a 400 is worth rotating")
    check(explicit.message.contains("额度或套餐权限不足"), "even though 400 usually means a bad request")

    let redirect = LocalChatHTTPError.from(status: 302, source: "", keys: [], host: "h", attempt: 1, total: 1)
    check(redirect.message.contains("重定向"), "a redirect is explained rather than followed")

    let rotated = LocalChatHTTPError.from(status: 401, source: "", keys: [], host: "api.example.com", attempt: 2, total: 3)
    check(rotated.message.contains("Key attempt 2/3"), "the rotation position is shown when there is more than one key")
    check(LocalChatHTTPError.from(status: 401, source: "", keys: [], host: "h", attempt: 1, total: 1)
        .message.contains("Key attempt") == false, "and hidden when there is only one")

    checkEqual(LocalChatHTTPError.redact("sent sk-secret and Bearer abc123",
                                         keys: ["sk-secret"]),
               "sent [redacted] and Bearer [redacted]", "a key and a bearer token both come out")
    checkEqual(LocalChatHTTPError.redact(#"{"key":"abc"}"#, keys: ["abc"]),
               #"{"key":"[redacted]"}"#, "a key echoed inside JSON is matched in its escaped form")
    check(LocalChatHTTPError.redact("api_key: sk-abcdef123456", keys: []).contains("sk-abcdef123456") == false,
          "an sk- shaped token needs no key list to be caught")
    checkEqual(LocalChatHTTPError.redact("a\nb\tc", keys: []), "a b c", "and whitespace is collapsed")
    check(LocalChatHTTPError.redact(String(repeating: "x", count: 800), keys: []).count == 501,
          "a long body is capped at five hundred characters plus an ellipsis")
}

// MARK: - Local chat: request building

/// Stands in for the attachment store: a blob reference becomes a marked
/// string, anything else is passed through, exactly as `AttachmentJson` does.
struct StubResolver: LocalChatAttachmentResolving {
    func wireBase64(_ value: String) throws -> String {
        value.hasPrefix(AttachmentStore.prefix) ? "b64(" + value + ")" : value
    }
    func wireText(_ value: String) throws -> String {
        value.hasPrefix(AttachmentStore.textPrefix) ? "text(" + value + ")" : value
    }
}

let openAIRoute = LocalChatRoute(id: "p/m", label: "P · m", model: "gpt-4o",
                                 wireProtocol: "openai", baseURL: "https://api.example.com", keys: ["sk-a"])
let anthropicRoute = LocalChatRoute(id: "p/m2", label: "P · m2", model: "claude-3-5-sonnet",
                                    wireProtocol: "anthropic", baseURL: "https://api.example.com", keys: ["sk-a"])

do {
    let history: [[String: Any]] = [
        ["role": "user", "content": "hi"],
        ["role": "assistant", "content": "hello"],
        ["role": "system", "content": "ignored"],
        ["role": "user", "content": ""],
    ]
    let body = try LocalChatRequest.build(route: openAIRoute, history: history,
                                          thinking: "auto", using: StubResolver())
    checkEqual(body["model"] as? String, "gpt-4o", "the body names the provider's model")
    checkEqual(body["stream"] as? Bool, true, "and asks for a stream")
    check(body["max_tokens"] == nil, "an openai request does not carry a token cap")
    let messages = body["messages"] as? [[String: Any]] ?? []
    checkEqual(messages.count, 2, "empty turns and non-chat roles are dropped")
    checkEqual(messages[0]["role"] as? String, "user", "the first turn is kept in order")
    checkEqual(messages[1]["content"] as? String, "hello", "with its text unchanged")

    let anthropicBody = try LocalChatRequest.build(route: anthropicRoute, history: history,
                                                   thinking: "auto", using: StubResolver())
    checkEqual(anthropicBody["max_tokens"] as? Int, 4096, "an anthropic request always carries a token cap")

    var thinkingHistory: [[String: Any]] = [["role": "user", "content": "hi"]]
    let high = try LocalChatRequest.build(route: openAIRoute, history: thinkingHistory,
                                          thinking: "high", using: StubResolver())
    checkEqual(high["reasoning_effort"] as? String, "high", "the thinking level rides along with the body")
    let unsupported = try LocalChatRequest.build(route: anthropicRoute, history: thinkingHistory,
                                                 thinking: "high", using: StubResolver())
    check(unsupported["thinking"] == nil, "and is dropped for a model that cannot read it")
    checkEqual(unsupported["max_tokens"] as? Int, 4096, "leaving the plain cap in place")
    thinkingHistory = []
}

do {
    let blob = AttachmentStore.prefix + "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    let textBlob = AttachmentStore.textPrefix + "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

    // An image, sent to an OpenAI-compatible endpoint.
    let imageHistory: [[String: Any]] = [["role": "user", "content": "what is this", "images": [blob]]]
    let openai = try LocalChatRequest.build(route: openAIRoute, history: imageHistory,
                                            thinking: "auto", using: StubResolver())
    let openAIParts = (openai["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]] ?? []
    checkEqual(openAIParts.count, 2, "an attached turn becomes text plus the attachment")
    checkEqual(openAIParts[0]["type"] as? String, "text", "the text part comes first")
    checkEqual(openAIParts[1]["type"] as? String, "image_url", "and an openai image is an image_url part")
    checkEqual((openAIParts[1]["image_url"] as? [String: Any])?["url"] as? String,
               "data:image/jpeg;base64,b64(" + blob + ")", "whose URL is a data URL over the resolved bytes")

    // The same image, sent to Anthropic.
    let anthropic = try LocalChatRequest.build(route: anthropicRoute, history: imageHistory,
                                               thinking: "auto", using: StubResolver())
    let anthropicParts = (anthropic["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]] ?? []
    checkEqual(anthropicParts[1]["type"] as? String, "image", "an anthropic image is an image block")
    let source = anthropicParts[1]["source"] as? [String: Any] ?? [:]
    checkEqual(source["type"] as? String, "base64", "carrying an inline base64 source")
    checkEqual(source["media_type"] as? String, "image/jpeg", "typed as JPEG")
    checkEqual(source["data"] as? String, "b64(" + blob + ")", "and the resolved bytes")

    // A PDF, both ways.
    let pdf: [String: Any] = ["name": "报告.pdf", "data": blob, "mimeType": "application/pdf", "isImage": false]
    let pdfHistory: [[String: Any]] = [["role": "user", "content": "read this", "documents": [pdf]]]
    let openaiPDF = try LocalChatRequest.build(route: openAIRoute, history: pdfHistory,
                                               thinking: "auto", using: StubResolver())
    let filePart = ((openaiPDF["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]])?[1] ?? [:]
    checkEqual(filePart["type"] as? String, "file", "an openai PDF is a file part")
    checkEqual((filePart["file"] as? [String: Any])?["filename"] as? String, "报告.pdf", "named as it was picked")
    checkEqual((filePart["file"] as? [String: Any])?["file_data"] as? String,
               "data:application/pdf;base64,b64(" + blob + ")", "with a PDF data URL")

    let anthropicPDF = try LocalChatRequest.build(route: anthropicRoute, history: pdfHistory,
                                                  thinking: "auto", using: StubResolver())
    let documentPart = ((anthropicPDF["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]])?[1] ?? [:]
    checkEqual(documentPart["type"] as? String, "document", "an anthropic PDF is a document block")
    checkEqual(documentPart["title"] as? String, "报告.pdf", "titled with the file name")
    checkEqual((documentPart["source"] as? [String: Any])?["media_type"] as? String, "application/pdf", "and typed as PDF")

    // A spreadsheet has no native block in either protocol, so its extracted
    // text is inlined as two parts.
    let sheet: [String: Any] = ["name": "book.xlsx", "data": blob, "mimeType": "text/plain",
                                "isImage": false, "text": textBlob]
    let sheetHistory: [[String: Any]] = [["role": "user", "content": "", "documents": [sheet]]]
    let inlined = try LocalChatRequest.build(route: openAIRoute, history: sheetHistory,
                                             thinking: "auto", using: StubResolver())
    let inlinedParts = (inlined["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]] ?? []
    checkEqual(inlinedParts.count, 2, "a text document contributes two parts and no preamble text")
    checkEqual(inlinedParts[0]["text"] as? String,
               "Attached document: book.xlsx\nThe next text block is document content.",
               "the first names the document")
    checkEqual(inlinedParts[1]["text"] as? String, "text(" + textBlob + ")",
               "the second is the extracted text")

    let lost: [String: Any] = ["name": "book.xlsx", "data": blob, "mimeType": "text/plain", "isImage": false]
    checkThrows(LocalChatRequestError.documentTextUnavailable,
                "a text document whose extraction was lost is refused, not sent as a name alone") {
        _ = try LocalChatRequest.build(route: openAIRoute, history: [["role": "user", "content": "", "documents": [lost]]],
                                       thinking: "auto", using: StubResolver())
    }

    let numericContent = try LocalChatRequest.build(route: openAIRoute,
        history: [["role": "user", "content": 42]], thinking: "auto", using: StubResolver())
    checkEqual((numericContent["messages"] as? [[String: Any]])?.first?["content"] as? String,
               "42", "Android optString keeps a numeric history message")
    let decimalContent = try LocalChatRequest.build(route: openAIRoute,
        history: [["role": "user", "content": NSNumber(value: 1.0)]],
        thinking: "auto", using: StubResolver())
    checkEqual((decimalContent["messages"] as? [[String: Any]])?.first?["content"] as? String,
               "1.0", "Android String.valueOf keeps a decimal point on a floating JSON number")

    let numericImage = try LocalChatRequest.build(route: openAIRoute,
        history: [["role": "user", "content": "look", "images": [42]]],
        thinking: "auto", using: StubResolver())
    let numericImageParts = (numericImage["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]]
    checkEqual((numericImageParts?.last?["image_url"] as? [String: Any])?["url"] as? String,
               "data:image/jpeg;base64,42", "Android getString does not silently drop a numeric image entry")

    let numericText: [String: Any] = ["name": "data.txt", "mimeType": "text/plain", "text": 42]
    let numericDocument = try? LocalChatRequest.build(route: openAIRoute,
        history: [["role": "user", "content": "", "documents": [numericText]]],
        thinking: "auto", using: StubResolver())
    let numericParts = (numericDocument?["messages"] as? [[String: Any]])?.first?["content"] as? [[String: Any]]
    checkEqual(numericParts?.last?["text"] as? String, "42",
               "Android getString keeps numeric extracted document text")

    for (label, document) in [
        ("non-object document", "bad" as Any),
        ("PDF without a name", ["mimeType": "application/pdf", "data": blob] as Any),
        ("PDF without data", ["mimeType": "application/pdf", "name": "file.pdf"] as Any),
    ] {
        var rejected = false
        do {
            _ = try LocalChatRequest.build(route: openAIRoute,
                history: [["role": "user", "content": "look", "documents": [document]]],
                thinking: "auto", using: StubResolver())
        } catch { rejected = true }
        check(rejected, "Android rejects a \(label) instead of sending a partial attachment")
    }
    checkEqual(LocalChatRequestError.documentTextUnavailable.localizedDescription,
               LocalChatRequestError.documentTextUnavailable.description,
               "missing document text has a readable notice instead of a Swift error code")
    checkEqual(LocalChatRequestError.invalidAttachment.localizedDescription,
               LocalChatRequestError.invalidAttachment.description,
               "invalid attachment metadata has a readable notice")
}

// MARK: - Local chat: tool loop

do {
    let openai = LocalToolLoop.definitions(wireProtocol: "openai")
    checkEqual(openai.count, 2, "two tools are offered")
    checkEqual(openai[0]["type"] as? String, "function", "an openai tool is a function")
    let function = openai[0]["function"] as? [String: Any] ?? [:]
    checkEqual(function["name"] as? String, "web_search", "the first is a search")
    let parameters = function["parameters"] as? [String: Any] ?? [:]
    checkEqual(parameters["additionalProperties"] as? Bool, false, "with no room for an invented argument")
    checkEqual(parameters["required"] as? [String], ["query"], "and one required field")
    let properties = parameters["properties"] as? [String: [String: Any]] ?? [:]
    checkEqual(properties["query"]?["maxLength"] as? Int, 500, "capped at the same length the validator enforces")
    checkEqual((openai[1]["function"] as? [String: Any])?["name"] as? String, "web_fetch", "the second reads one page")

    let anthropic = LocalToolLoop.definitions(wireProtocol: "anthropic")
    check(anthropic[0]["input_schema"] != nil, "an anthropic tool carries an input_schema")
    check(anthropic[0]["function"] == nil, "and no function wrapper")
    let fetchSchema = anthropic[1]["input_schema"] as? [String: Any] ?? [:]
    checkEqual(fetchSchema["required"] as? [String], ["url"], "the fetch takes a URL")
    checkEqual((fetchSchema["properties"] as? [String: [String: Any]])?["url"]?["maxLength"] as? Int, 2048,
               "capped at 2048")
}

do {
    try LocalToolLoop.validate("web_search", ["query": "weather"])
    try LocalToolLoop.validate("web_fetch", ["url": "https://example.com"])
    checkThrows(LocalToolError.notAllowed, "a third tool name is refused") {
        try LocalToolLoop.validate("web_read", ["query": "x"])
    }
    checkThrows(LocalToolError.invalidArguments, "a search with two arguments is refused") {
        try LocalToolLoop.validate("web_search", ["query": "x", "url": "https://example.com"])
    }
    checkThrows(LocalToolError.invalidArguments, "a search with no query field is refused") {
        try LocalToolLoop.validate("web_search", ["url": "https://example.com"])
    }
    checkThrows(LocalToolError.invalidArguments, "a non-string argument is refused") {
        try LocalToolLoop.validate("web_search", ["query": 42])
    }
    checkThrows(LocalToolError.invalidArguments, "a blank query is refused") {
        try LocalToolLoop.validate("web_search", ["query": "   "])
    }
    check((try? LocalToolLoop.validate("web_search", ["query": "\u{00A0}"])) != nil,
          "a non-breaking space is content under Android's tool argument trim")
    checkThrows(LocalToolError.invalidArguments, "a query carrying a newline is refused") {
        try LocalToolLoop.validate("web_search", ["query": "a\nb"])
    }
    checkThrows(LocalToolError.invalidArguments, "an over-long query is refused") {
        try LocalToolLoop.validate("web_search", ["query": String(repeating: "x", count: 501)])
    }
    try LocalToolLoop.validate("web_search", ["query": String(repeating: "x", count: 500)])
    try LocalToolLoop.validateName("web_search")
    checkThrows(LocalToolError.invalidToolName, "an over-long name is refused") {
        try LocalToolLoop.validateName(String(repeating: "a", count: 65))
    }
}

do {
    checkEqual(try LocalToolLoop.arguments(#"{"query":"a"}"#)["query"] as? String, "a", "a call's arguments parse")
    checkThrows(LocalToolError.invalidArguments, "a bare array is not an argument object") {
        _ = try LocalToolLoop.arguments("[1]")
    }
    checkThrows(LocalToolError.invalidArguments, "trailing content after the object is refused") {
        _ = try LocalToolLoop.arguments(#"{"query":"a"} garbage"#)
    }
    checkThrows(LocalToolError.argumentsTooLarge, "an oversized argument blob is refused") {
        _ = try LocalToolLoop.arguments(#"{"query":""# + String(repeating: "x", count: 8192) + #""}"#)
    }
}

do {
    let openAICall = try JSONBody.object(Data(#"""
    {"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"a\"}"}}]},"finish_reason":"tool_calls"}]}
    """#.utf8))
    check(LocalToolLoop.hasCalls(openAICall, wireProtocol: "openai"), "an openai tool call is seen")
    check(LocalToolLoop.completedToolCall(openAICall, wireProtocol: "openai"), "and its stop reason is the right one")
    let calls = try LocalToolLoop.calls(openAICall, wireProtocol: "openai")
    checkEqual(calls.count, 1, "one call is read")
    checkEqual(LocalToolLoop.callName(calls[0], wireProtocol: "openai"), "web_search", "with its name")
    checkEqual(try LocalToolLoop.callArguments(calls[0], wireProtocol: "openai")["query"] as? String, "a",
               "and its parsed arguments")

    let textOnly = try JSONBody.object(Data(#"{"choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}"#.utf8))
    check(!LocalToolLoop.hasCalls(textOnly, wireProtocol: "openai"), "a plain answer carries no calls")
    checkEqual(LocalToolLoop.hasCalls(try JSONBody.object(Data(#"{"choices":[]}"#.utf8)), wireProtocol: "openai"),
               false, "and neither does an empty choices list")

    let badType = try JSONBody.object(Data(#"{"choices":[{"message":{"tool_calls":[{"id":"c","type":"computer"}]}}]}"#.utf8))
    checkThrows(LocalToolError.unsupportedToolType, "an openai call that is not a function is refused") {
        _ = try LocalToolLoop.calls(badType, wireProtocol: "openai")
    }

    let anthropicCall = try JSONBody.object(Data(#"""
    {"content":[{"type":"text","text":"let me look"},{"type":"tool_use","id":"t1","name":"web_fetch","input":{"url":"https://example.com"}}],"stop_reason":"tool_use"}
    """#.utf8))
    check(LocalToolLoop.hasCalls(anthropicCall, wireProtocol: "anthropic"), "an anthropic tool_use is seen")
    let anthropicCalls = try LocalToolLoop.calls(anthropicCall, wireProtocol: "anthropic")
    checkEqual(anthropicCalls.count, 1, "the text block beside it is not mistaken for a call")
    checkEqual(LocalToolLoop.callName(anthropicCalls[0], wireProtocol: "anthropic"), "web_fetch", "with its name")
    checkEqual(try LocalToolLoop.callArguments(anthropicCalls[0], wireProtocol: "anthropic")["url"] as? String,
               "https://example.com", "and its input object")
    let echoed = try LocalToolLoop.assistantMessage(anthropicCall, wireProtocol: "anthropic")
    checkEqual(echoed["role"] as? String, "assistant", "the assistant turn echoes back verbatim")
    checkEqual((echoed["content"] as? [Any])?.count, 2, "including the text block beside the call")

    check(!LocalToolLoop.completedToolCall(
        try JSONBody.object(Data(#"{"content":[],"stop_reason":"max_tokens"}"#.utf8)),
        wireProtocol: "anthropic"), "a truncated response is not a completed tool call")
}

do {
    var seen = Set<String>()
    checkEqual(try LocalToolLoop.claimCallID("c1", seen: &seen), "c1", "a fresh id is claimed")
    checkThrows(LocalToolError.invalidCallID, "the same id twice is refused") {
        _ = try LocalToolLoop.claimCallID("c1", seen: &seen)
    }
    checkThrows(LocalToolError.invalidCallID, "an empty id is refused") {
        _ = try LocalToolLoop.claimCallID("", seen: &seen)
    }
    checkThrows(LocalToolError.invalidCallID, "a missing id is refused") {
        _ = try LocalToolLoop.claimCallID(nil, seen: &seen)
    }
    checkThrows(LocalToolError.invalidCallID, "an over-long id is refused") {
        _ = try LocalToolLoop.claimCallID(String(repeating: "a", count: 201), seen: &seen)
    }
}

do {
    checkEqual(LocalToolLoop.sourcesSection(["https://a", "https://b", "https://a"]),
               "\n\n---\nSources / 来源\n\n- <https://a>\n- <https://b>",
               "sources are listed once each under a heading")
    checkEqual(LocalToolLoop.finishing("answer", sources: []), "answer", "no sources means no block")
    checkEqual(LocalToolLoop.finishing("answer", sources: ["https://a"]),
               "answer\n\n---\nSources / 来源\n\n- <https://a>", "otherwise it is appended")
    check(LocalToolLoop.failureMessage(for: "web_search").contains("Do not repeat the same search"),
          "a failed search tells the model not to retry")
    check(LocalToolLoop.failureMessage(for: "web_fetch").contains("No private-network access"),
          "a failed fetch explains the restriction")
    checkEqual(LocalToolLoop.maxRounds, 8, "eight rounds")
    checkEqual(LocalToolLoop.maxCalls, 16, "sixteen calls")
    checkEqual(LocalToolLoop.deadlineSeconds, 180, "three minutes")
}

// MARK: - Local chat: web URL policy

do {
    checkEqual(try LocalWebTools.publicURL("https://example.com/page?q=1").absoluteString,
               "https://example.com/page?q=1", "a public HTTPS URL is accepted")
    checkEqual(try LocalWebTools.publicURL("https://example.com/page#section").absoluteString,
               "https://example.com/page", "a fragment is dropped")
    checkEqual(try LocalWebTools.publicURL("https://example.com:443/x").absoluteString,
               "https://example.com/x", "the default port is fine")

    checkThrows(LocalWebError.insecureURL, "plain HTTP is refused") {
        _ = try LocalWebTools.publicURL("http://example.com")
    }
    checkThrows(LocalWebError.insecureURL, "a non-standard port is refused") {
        _ = try LocalWebTools.publicURL("https://example.com:8443/x")
    }
    checkThrows(LocalWebError.insecureURL, "credentials in the URL are refused") {
        _ = try LocalWebTools.publicURL("https://user:pass@example.com")
    }
    checkThrows(LocalWebError.invalidURL, "a URL with a space is refused") {
        _ = try LocalWebTools.publicURL("https://example.com/a b")
    }
    checkThrows(LocalWebError.invalidURL, "a URL with a backslash is refused") {
        _ = try LocalWebTools.publicURL(#"https://example.com\@evil.com"#)
    }
    checkThrows(LocalWebError.invalidURL, "an over-long URL is refused") {
        _ = try LocalWebTools.publicURL("https://example.com/" + String(repeating: "a", count: 2048))
    }
    checkThrows(LocalWebError.privateHost, "a .local name is refused") {
        _ = try LocalWebTools.publicURL("https://printer.local")
    }
    checkThrows(LocalWebError.privateHost, "an .internal name is refused") {
        _ = try LocalWebTools.publicURL("https://git.internal")
    }
    checkThrows(LocalWebError.privateHost, "a single-label host is refused") {
        _ = try LocalWebTools.publicURL("https://router")
    }
    for blocked in ["https://127.0.0.1/", "https://10.0.0.5/", "https://192.168.1.1/",
                    "https://172.16.0.1/", "https://169.254.1.1/", "https://100.64.0.1/",
                    "https://0.0.0.0/", "https://224.0.0.1/", "https://198.18.0.1/",
                    "https://203.0.113.9/", "https://[::1]/", "https://[2001:db8::1]/",
                    "https://[fe80::1]/"] {
        checkThrows(LocalWebError.nonPublicAddress, "\(blocked) is a non-public address") {
            _ = try LocalWebTools.publicURL(blocked)
        }
    }
    checkEqual(try LocalWebTools.publicURL("https://8.8.8.8/").host, "8.8.8.8", "a public literal is allowed")
    checkEqual(try LocalWebTools.publicURL("https://[2606:4700:4700::1111]/").host, "2606:4700:4700::1111",
               "so is a public IPv6 literal")
    // A dotted string that is not four octets is not an address and is not a
    // name either; Android lets the lookup fail, so refusing it here matches.
    checkThrows(LocalWebError.nonPublicAddress, "a dotted string that is not an address is refused") {
        _ = try LocalWebTools.publicURL("https://1.2.3.4.5/")
    }

    checkEqual(LocalWebTools.addressIsPublic("8.8.8.8"), true, "8.8.8.8 is public")
    checkEqual(LocalWebTools.addressIsPublic("192.168.0.1"), false, "192.168.0.1 is not")
    checkEqual(LocalWebTools.addressIsPublic("100.127.255.255"), false, "the carrier-NAT block is not")
    checkEqual(LocalWebTools.addressIsPublic("100.63.255.255"), true, "but the address just below it is")
    checkEqual(LocalWebTools.addressIsPublic("example.com"), nil, "a hostname is not an address")
    checkEqual(LocalWebTools.addressIsPublic("2606:4700::1111"), true, "a public IPv6 is")
    checkEqual(LocalWebTools.addressIsPublic("2001:db8::1"), false, "the documentation block is not")
    checkEqual(LocalWebTools.addressIsPublic("::ffff:8.8.8.8"), true, "an embedded IPv4 tail parses")
}

// MARK: - Local chat: web text extraction

do {
    let page = """
    <html><head><title>  A   Page  </title><style>p{color:red}</style></head>
    <body><nav>menu</nav><p>Hello &amp; goodbye</p><script>evil()</script>
    <footer>foot</footer><!-- comment --><p>x&nbsp;y &#65; &#x42;</p></body></html>
    """
    checkEqual(LocalWebTools.text(fromHTML: page), "Hello & goodbye x y A B",
               "the body is read, furniture dropped, entities decoded and whitespace collapsed")
    checkEqual(LocalWebTools.title(fromHTML: page), "A Page", "the title is read from the head")
    checkEqual(LocalWebTools.text(fromHTML: "<p>no body tag</p>"), "no body tag",
               "a fragment with no body tag is read whole")
    checkEqual(LocalWebTools.text(fromHTML: "<body><p>a</p><p>b</p></body>"), "a b",
               "block tags become spaces rather than running words together")
}

do {
    let result = try LocalWebTools.fetchResult(url: "https://example.com/", html: """
    <html><head><title>Doc</title></head><body><p>body text</p></body></html>
    """)
    checkEqual(result["untrusted"] as? Bool, true, "a fetched page is always marked untrusted")
    checkEqual(result["text"] as? String, "body text", "with its readable text")
    checkEqual(result["truncated"] as? Bool, false, "and a truncation flag")
    checkEqual((result["sources"] as? [[String: Any]])?.first?["title"] as? String, "Doc", "the title becomes the source")
    checkThrows(LocalWebError.noReadableText, "a page with nothing readable is an error") {
        _ = try LocalWebTools.fetchResult(url: "https://example.com/",
                                          html: "<html><body><script>x()</script></body></html>")
    }
    let long = try LocalWebTools.fetchResult(url: "https://example.com/",
                                             html: "<body>" + String(repeating: "a", count: 13000) + "</body>")
    checkEqual((long["text"] as? String)?.count, 12000, "a long page is clipped")
    checkEqual(long["truncated"] as? Bool, true, "and says so")
}

do {
    let feed = """
    <?xml version="1.0"?><rss><channel>
      <item><title>First</title><link>https://example.com/1</link><description>&lt;p&gt;one&lt;/p&gt;</description></item>
      <item><title>Second</title><link>https://example.com/2</link><description>two</description></item>
      <item><title>Repeat</title><link>https://example.com/1</link><description>dup</description></item>
      <item><title>Private</title><link>https://127.0.0.1/x</link><description>no</description></item>
    </channel></rss>
    """
    let sources = try LocalWebTools.rssResults(xml: feed, baseURL: "https://www.bing.com/search?format=rss")
    checkEqual(sources.count, 2, "public, non-repeated items are kept")
    checkEqual(sources[0]["title"] as? String, "First", "in feed order")
    checkEqual(sources[0]["url"] as? String, "https://example.com/1", "with their link")
    checkEqual(sources[0]["snippet"] as? String, "one", "and the description read as text, not markup")
    checkThrows(LocalWebError.unsafeXML, "a feed with a DOCTYPE is refused") {
        _ = try LocalWebTools.rssResults(xml: "<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><rss/>",
                                         baseURL: "https://www.bing.com/")
    }
    checkThrows(LocalWebError.noResults("RSS search returned no readable results: https://www.bing.com/"),
                "an empty feed is an error") {
        _ = try LocalWebTools.rssResults(xml: "<rss><channel></channel></rss>", baseURL: "https://www.bing.com/")
    }
}

do {
    let page = """
    <div class="result"><h3 class="t"><a href="https://example.com/a">First result</a></h3>
      <div class="c-abstract">the first snippet</div></div>
    <div class="result"><h3 class="t"><a rl-link-href="https://example.com/b">Second result</a></h3></div>
    <div class="result"><h3 class="t"><a href="https://127.0.0.1/secret">Private</a></h3></div>
    """
    let sources = try LocalWebTools.searchResults(html: page, baseURL: "https://www.baidu.com/s?wd=x")
    checkEqual(sources.count, 2, "results are read and a private one dropped")
    checkEqual(sources[0]["title"] as? String, "First result", "with the anchor text as the title")
    checkEqual(sources[0]["snippet"] as? String, "the first snippet", "and the snippet container read")
    checkEqual(sources[1]["url"] as? String, "https://example.com/b", "a rl-link-href is preferred over href")
    checkEqual(sources[1]["snippet"] as? String, "", "a missing snippet is not fatal")
    checkEqual(LocalWebTools.resolve("//example.com/x", against: "https://a.com"), "https://example.com/x",
               "a protocol-relative link resolves to HTTPS")
    checkEqual(LocalWebTools.resolve("/x", against: "https://a.com/p"), "https://a.com/x",
               "a rooted link resolves against the base")
}

// MARK: - Local chat: documents

do {
    checkEqual(ChatDocument.safeName("report.pdf"), "report.pdf", "a plain name is kept")
    checkEqual(ChatDocument.safeName("a/b\\c.txt"), "a_b_c.txt", "path separators become underscores")
    checkEqual(ChatDocument.safeName("a\nb.txt"), "a_b.txt", "so do control characters")
    checkEqual(ChatDocument.safeName("a\u{202e}gnp.txt"), "a_gnp.txt", "and bidi overrides")
    checkEqual(ChatDocument.safeName(nil), "document.txt", "a missing name gets a default")
    checkEqual(ChatDocument.safeName(".."), "document.txt", "so does a traversal name")
    checkEqual(ChatDocument.safeName("   "), "document.txt", "and a blank one")
    let long = ChatDocument.safeName(String(repeating: "a", count: 200) + ".txt")
    checkEqual(long.count, 180, "an over-long name is truncated")
    check(long.hasSuffix(".txt"), "keeping its extension")
    checkEqual(ChatDocument.safeName("\u{00A0}report\u{00A0}.txt"), "\u{00A0}report\u{00A0}.txt",
               "a filename keeps edge non-breaking spaces like Java trim")
    checkEqual(ChatDocument.safeName(String(repeating: "🐱", count: 90) + ".txt"),
               String(repeating: "🐱", count: 88) + ".txt",
               "a filename's 180-unit limit counts surrogate pairs")

    checkEqual(ChatDocument.fileExtension("Report.PDF"), "pdf", "the extension is lowercased")
    checkEqual(ChatDocument.fileExtension("README"), "", "a name with no dot has none")
}

do {
    checkEqual(try ChatDocument.decodeText(Data("hello".utf8)), "hello", "UTF-8 decodes")
    checkEqual(try ChatDocument.decodeText(Data([0xef, 0xbb, 0xbf] + Array("hello".utf8))), "hello",
               "a UTF-8 byte-order mark is consumed")
    checkEqual(try ChatDocument.decodeText(Data([0xff, 0xfe, 0x41, 0x00])), "A", "UTF-16LE with a mark decodes")
    checkEqual(try ChatDocument.decodeText(Data([0xfe, 0xff, 0x00, 0x41])), "A", "so does UTF-16BE")
    // GB18030's "中" is D6 D0, which is not valid UTF-8.
    checkEqual(try ChatDocument.decodeText(Data([0xd6, 0xd0])), "中", "a GB18030 file is read rather than refused")
    checkThrows(LocalChatDocumentError.notText, "a file with a NUL byte is not text") {
        _ = try ChatDocument.decodeText(Data([0x68, 0x00, 0x69]))
    }
    checkEqual(try ChatDocument.bounded(Data(repeating: 1, count: 10), limit: 10).count, 10,
               "a buffer at the limit is fine")
    checkThrows(LocalChatDocumentError.fileTooLarge, "one past the limit is not") {
        _ = try ChatDocument.bounded(Data(repeating: 1, count: 11), limit: 10)
    }
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-document-read-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let exact = directory.appendingPathComponent("exact.txt")
    try Data("abcd".utf8).write(to: exact)
    checkEqual(try ChatDocument.readFile(at: exact, limit: 4), Data("abcd".utf8),
               "a picked file at the byte limit is read")
    checkThrows(LocalChatDocumentError.fileTooLarge, "a picked file above the byte limit is refused") {
        _ = try ChatDocument.readFile(at: exact, limit: 3)
    }
    checkEqual(LocalChatDocumentError.fileTooLarge.localizedDescription,
               LocalChatDocumentError.fileTooLarge.description,
               "a file limit error has a readable UI description")
}

do {
    let text = try ChatDocument.read(name: "notes.md", data: Data("# hi".utf8), local: true)
    checkEqual(text.text, "# hi", "a text file is read as-is")
    checkEqual(text.mimeType, "text/plain", "and typed as text")

    let pdf = try ChatDocument.read(name: "a.pdf", data: Data("%PDF-1.7 rest".utf8), local: true)
    checkEqual(pdf.isPDF, true, "a PDF is recognised by its magic")
    checkEqual(pdf.text, nil, "and keeps its bytes rather than extracting text")
    checkEqual(pdf.mimeType, "application/pdf", "so it is typed as a PDF")
    checkThrows(LocalChatDocumentError.invalidPDF, "a file that claims to be a PDF but is not is refused") {
        _ = try ChatDocument.read(name: "a.pdf", data: Data("hello".utf8), local: true)
    }
    checkThrows(LocalChatDocumentError.empty, "an empty file is refused") {
        _ = try ChatDocument.read(name: "a.txt", data: Data(), local: true)
    }
    checkEqual(try ChatDocument.read(name: "a.txt", data: Data("\u{00A0}".utf8), local: true).text,
               "\u{00A0}", "Java trim does not call a non-breaking space an empty document")
    checkThrows(LocalChatDocumentError.unsupportedLocal, "a legacy .doc is refused by local chat") {
        _ = try ChatDocument.read(name: "a.doc", data: Data("x".utf8), local: true)
    }
    let forwarded = try ChatDocument.read(name: "a.docx".replacingOccurrences(of: "docx", with: "doc"),
                                          data: Data("x".utf8), local: false)
    checkEqual(forwarded.text, nil, "but a remote chat forwards it to the computer untouched")
    checkThrows(LocalChatDocumentError.unsupportedRemote, "an unknown extension is refused either way") {
        _ = try ChatDocument.read(name: "a.exe", data: Data("x".utf8), local: false)
    }
}

do {
    let maximum = String(repeating: "🐱", count: ChatDocument.maxText / 2)
    checkEqual(try ChatDocument.decodeText(Data(maximum.utf8)), maximum,
               "text at the two-million UTF-16-unit limit is accepted")
    checkThrows(LocalChatDocumentError.notText, "one more surrogate pair exceeds the text limit") {
        _ = try ChatDocument.decodeText(Data((maximum + "🐱").utf8))
    }
    let output = OfficeOutput()
    output.append(maximum)
    checkEqual(output.failure, nil, "Office output uses the same UTF-16 limit")
    output.append("🐱")
    checkEqual(output.failure, .tooMuchText, "Office output rejects one pair past the limit")

    let xml = "<sst><si><t>" + String(repeating: "a", count: ChatDocument.maxText)
        + "</t></si><si><t>x</t></si></sst>"
    let parser = XMLParser(data: Data(xml.utf8))
    let shared = SharedStringsParser()
    parser.delegate = shared
    check(parser.parse(), "separate spreadsheet shared strings are each allowed up to the text limit")
    checkEqual(shared.strings.count, 2, "an unused large shared string does not reject the next one")
}

if let directory = ProcessInfo.processInfo.environment["CAMELLIA_FIXTURES"] {
    let root = URL(fileURLWithPath: directory)
    func fixture(_ name: String) throws -> Data { try Data(contentsOf: root.appendingPathComponent(name)) }

    do {
        let document = try ChatDocument.read(name: "sample.docx", data: try fixture("sample.docx"), local: true)
        checkEqual(document.text ?? "", "Hello\tworld\n第二段\n",
                   "a Word document's runs and paragraphs come out in order")

        let sheet = try ChatDocument.read(name: "sample.xlsx", data: try fixture("sample.xlsx"), local: true)
        checkEqual(sheet.text ?? "", "\n[xl/worksheets/sheet1.xml]\nA1=Alpha\tB1=42\t\nA2=Beta\t\n",
                   "a spreadsheet names each cell, resolves shared strings and keeps rows apart")

        let deck = try ChatDocument.read(name: "sample.pptx", data: try fixture("sample.pptx"), local: true)
        checkEqual(deck.text ?? "", "\n[ppt/slides/slide1.xml]\nSlide one title\n\n[ppt/slides/slide2.xml]\nSlide two title\n",
                   "slides come out in numeric order, each under its own part name")
    } catch {
        checks += 3
        failures.append("Office fixtures: threw \(error)")
    }

    do {
        let sheet = try fixture("sample.xlsx")
        checkThrows(LocalChatDocumentError.invalidOffice, "a ZIP that is not an Office document is refused") {
            _ = try ChatDocument.officeText(extension: "docx", data: Data("not a zip at all".utf8))
        }
        checkThrows(LocalChatDocumentError.invalidOffice, "a DOCX missing its document part is refused") {
            _ = try ChatDocument.officeText(extension: "docx", data: sheet)
        }
    } catch {
        checks += 2
        failures.append("Office fixture errors: threw \(error)")
    }
} else {
    print("note: CAMELLIA_FIXTURES is unset; the Office fixture checks were skipped")
}

// MARK: - Demand-driven byte bodies

final class PullProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var consumed = 0
    private var finished = 0
    var reads: Int { lock.lock(); defer { lock.unlock() }; return consumed }
    var finishes: Int { lock.lock(); defer { lock.unlock() }; return finished }
    func next() -> Int { lock.lock(); defer { lock.unlock() }; let value = consumed; consumed += 1; return value }
    func finish() { lock.lock(); finished += 1; lock.unlock() }
}
struct PullProbeBytes: AsyncSequence {
    typealias Element = UInt8
    let probe: PullProbe
    let count: Int
    var delayed = false
    struct AsyncIterator: AsyncIteratorProtocol {
        let source: PullProbeBytes
        mutating func next() async throws -> UInt8? {
            let index = source.probe.next()
            if source.delayed { try await Task.sleep(nanoseconds: 3_000_000_000) }
            return index < source.count ? UInt8(index % 251) : nil
        }
    }
    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(source: self) }
}

do {
    let probe = PullProbe()
    let body = LocalChatBody.pull(PullProbeBytes(probe: probe, count: 1000)) { probe.finish() }
    try await Task.sleep(nanoseconds: 10_000_000)
    checkEqual(probe.reads, 0, "a byte body does not produce before its consumer asks")
    var iterator = body.makeAsyncIterator()
    var output: [UInt8] = []
    for _ in 0..<20 {
        for _ in 0..<50 { if let byte = try await iterator.next() { output.append(byte) } }
        try await Task.sleep(nanoseconds: 1_000_000)
        checkEqual(probe.reads, output.count, "a slow byte consumer causes no independent read-ahead")
    }
    checkEqual(output, (0..<1000).map { UInt8($0 % 251) }, "pull reading preserves every byte in order")
    check(try await iterator.next() == nil, "pull reading delivers EOF")
    checkEqual(probe.finishes, 1, "EOF closes the underlying response once")
}
do {
    let probe = PullProbe()
    let body = LocalChatBody.pull(PullProbeBytes(probe: probe, count: 1000, delayed: true)) { probe.finish() }
    let reader = Task {
        do { for try await _ in body {} ; return false }
        catch { return error is CancellationError }
    }
    check(await pump(seconds: 2) { probe.reads == 1 }, "a demand-driven read can suspend at its source")
    reader.cancel()
    check(await reader.value, "consumer cancellation propagates through a suspended byte read")
    checkEqual(probe.finishes, 1, "cancellation closes the response once")
}

// MARK: - Local chat: drafts

do {
    var conversation: [String: Any] = [
        "messages": [
            ["role": "user", "content": "first", "images": ["blob-a"]] as [String: Any],
            ["role": "assistant", "content": "reply"] as [String: Any],
            ["role": "user", "content": "second", "images": ["blob-b"]] as [String: Any],
        ] as [Any],
        "draft": "half written",
    ]
    checkEqual(LocalChatDraft.editIndex(conversation), nil, "with no target nothing is being edited")
    conversation["draftEditIndex"] = 2
    checkEqual(LocalChatDraft.editIndex(conversation), 2, "the last user turn can be edited")
    conversation["draftEditIndex"] = 0
    checkEqual(LocalChatDraft.editIndex(conversation), nil, "an earlier user turn cannot")
    conversation["draftEditIndex"] = 1
    checkEqual(LocalChatDraft.editIndex(conversation), nil, "neither can an assistant turn")
    conversation["draftEditIndex"] = 9
    checkEqual(LocalChatDraft.editIndex(conversation), nil, "nor an out-of-range index")
    conversation.removeValue(forKey: "draftEditIndex")

    checkEqual(LocalChatDraft.text(conversation), "half written", "the draft text is read")
    checkEqual(LocalChatDraft.images(conversation), [], "with no draft images and no target there are none")

    conversation["draftEditIndex"] = 2
    checkEqual(LocalChatDraft.images(conversation), ["blob-b"],
               "editing a turn starts from that turn's own attachments")
    check(LocalChatDraft.documents(conversation).isEmpty, "and its documents")

    LocalChatDraft.save(&conversation, text: "new", editIndex: nil)
    check(conversation["draftEditIndex"] == nil, "saving without a target drops the target")
    checkEqual(LocalChatDraft.text(conversation), "new", "and keeps the text")

    // An empty list is a deliberate removal, so it has to be written rather than
    // left off, or the read would fall back to the message being edited.
    LocalChatDraft.save(&conversation, text: "new", editIndex: 2, images: [], documents: [])
    checkEqual(LocalChatDraft.images(conversation), [], "removing every attachment sticks")

    LocalChatDraft.save(&conversation, text: "new", editIndex: 2, images: ["blob-c"], documents: [["name": "a.pdf"]])
    checkEqual(LocalChatDraft.images(conversation), ["blob-c"], "and adding one replaces the set")
    checkEqual(LocalChatDraft.documents(conversation).count, 1, "documents come along")

    LocalChatDraft.clear(&conversation)
    check(conversation["draft"] == nil, "clearing removes the text")
    check(conversation["draftImages"] == nil, "and every attachment key")
}

// MARK: - Local chat: storage

do {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-localchat-checks-\(UUID().uuidString)", isDirectory: true)
    let keys = FileSecretKeyStore(url: root.appendingPathComponent("key"))
    let attachments = AttachmentStore(directory: root.appendingPathComponent("attachments"), keys: keys)
    let directory = root.appendingPathComponent("store")
    defer { try? FileManager.default.removeItem(at: root) }

    let store = try LocalChatStore(directory: directory, keys: keys, attachments: attachments)
    try attachments.reconcile(requiredOwners: ["local"])
    checkEqual(store.conversations().count, 0, "a fresh store is empty")

    let workspace = try store.createWorkspace(name: "Work")
    let chat = try store.createConversation(workspaceId: workspace["id"] as! String, routeId: "p/m")
    checkEqual(store.conversations().count, 1, "a conversation is created")
    checkEqual(store.orderedConversations(workspace["id"] as! String).count, 1, "and filed under its workspace")
    checkEqual(store.orderedConversations("").count, 0, "and not under the unfiled list")

    let second = try store.createConversation(workspaceId: "", routeId: "p/m")
    checkEqual(store.orderedConversations("").count, 1, "an unfiled conversation lands in the unfiled list")
    try store.pinConversation(second["id"] as! String, pinned: true)
    check(store.orderedConversations("")[0]["pinned"] as? Bool ?? false, "a pinned conversation sorts first")

    try store.archiveConversation(chat["id"] as! String, archived: true)
    checkEqual(store.orderedConversations(workspace["id"] as! String).count, 0, "an archived conversation is hidden")
    try store.archiveConversation(chat["id"] as! String, archived: false)
    checkEqual(store.orderedConversations(workspace["id"] as! String).count, 1, "and comes back when unarchived")

    let third = try store.createConversation(workspaceId: workspace["id"] as! String, routeId: "p/m")
    checkEqual(store.orderedConversations(workspace["id"] as! String).count, 2, "a second workspace conversation is filed there")

    try store.configureTools(chat["id"] as! String, enabled: true)
    checkEqual(store.conversation(chat["id"] as! String)?["webTools"] as? Bool, true, "web tools are recorded per conversation")
    checkThrows(LocalChatStoreError.conversationNotFound, "and cannot be set on a missing conversation") {
        try store.configureTools("nope", enabled: true)
    }

    try store.importConfig(["providers": [["id": "p1"]]])
    checkEqual((store.config()["providers"] as? [Any])?.count, 1, "an imported config is stored")

    // The whole point of sealing: nothing readable on disk, and the same
    // envelope layout the attachments use.
    let onDisk = try Data(contentsOf: directory.appendingPathComponent("state"))
    check(!onDisk.isEmpty, "the state file exists")
    check(!String(decoding: onDisk, as: UTF8.self).contains("Work"), "and its contents are not readable")
    checkEqual(onDisk.count % 1, 0, "a sealed file is bytes, not text")

    // A second store on the same directory sees everything the first wrote.
    let reopened = try LocalChatStore(directory: directory, keys: keys, attachments: attachments)
    checkEqual(reopened.conversations().count, 3, "a reopened store keeps every conversation")
    checkEqual((reopened.config()["providers"] as? [Any])?.count, 1, "and the configuration")

    // Attachments are swept when the reference that named them goes away.
    let reference = try attachments.save(Data("a photo".utf8))
    try store.update(chat["id"] as! String) { conversation in
        conversation["messages"] = [["role": "user", "content": "look", "images": [reference]] as [String: Any]]
    }
    checkEqual(try attachments.size(reference), 7, "the attachment is on disk while a conversation names it")
    try store.deleteConversation(chat["id"] as! String)
    checkThrows(AttachmentError.missing, "and is swept once nothing does") {
        _ = try attachments.size(reference)
    }

    try store.deleteWorkspace(workspace["id"] as! String)
    checkEqual(store.workspaces().count, 0, "a deleted workspace is gone")
    checkEqual(store.orderedConversations("").count, 2, "and its conversations fall back to the unfiled list")

    try store.deleteConversations([second["id"] as! String, third["id"] as! String])
    checkEqual(store.conversations().count, 0, "deleting a set removes them all")

    // Renaming does not change the ordering of older saved records.
    let board = try store.createWorkspace(name: "Board")
    let boardId = board["id"] as! String
    let alpha = try store.createConversation(workspaceId: boardId, routeId: "p/m")
    let beta = try store.createConversation(workspaceId: boardId, routeId: "p/m")
    let gamma = try store.createConversation(workspaceId: boardId, routeId: "p/m")
    checkEqual(store.orderedConversations(boardId).count, 3, "three conversations are filed")

    try store.renameWorkspace(boardId, to: "Renamed board")
    checkEqual(store.workspaces().first { ($0["id"] as? String) == boardId }?["name"] as? String,
               "Renamed board", "a workspace can be renamed")
    checkEqual(store.workspaces().count, 1, "and renaming neither adds nor drops one")
    checkThrows(LocalChatStoreError.workspaceNotFound, "renaming an unknown workspace is refused") {
        try store.renameWorkspace("nope", to: "x")
    }

    // Newest first is the default, so the list draws gamma, beta, alpha; the
    // reversed order has to be the stored one, not just what is in memory.
    let drawn = [alpha["id"] as! String, beta["id"] as! String, gamma["id"] as! String]
    for (order, id) in drawn.enumerated() { try store.update(id) { $0["order"] = order } }
    checkEqual(store.orderedConversations(boardId).map { $0["id"] as? String },
               drawn.map { Optional($0) }, "legacy order fields still determine the displayed sequence")

    let reordered = try LocalChatStore(directory: directory, keys: keys, attachments: attachments)
    checkEqual(reordered.orderedConversations(boardId).map { $0["id"] as? String },
               drawn.map { Optional($0) }, "and survives a reopen")
    checkEqual(reordered.workspaces().first { ($0["id"] as? String) == boardId }?["name"] as? String,
               "Renamed board", "as does a rename")

    try store.deleteWorkspace(boardId)
    checkEqual(store.workspaces().count, 0, "the board is gone again")
}

// MARK: - Local chat: client

/// A transport that answers from a script, so the client's real decisions —
/// which key, how a stream is read, when the loop stops — are checked without
/// a provider.
final class StubTransport: LocalChatTransporting {
    struct Reply {
        let status: Int
        let contentType: String
        let body: String
    }

    private var replies: [Reply]
    private let lock = NSLock()
    private var _sent: [LocalChatHTTPRequest] = []
    private var _cancelCount = 0

    init(_ replies: [Reply]) { self.replies = replies }

    var sent: [LocalChatHTTPRequest] {
        lock.lock(); defer { lock.unlock() }
        return _sent
    }

    var cancelCount: Int {
        lock.lock(); defer { lock.unlock() }
        return _cancelCount
    }

    func cancel() {
        lock.lock(); _cancelCount += 1; lock.unlock()
    }

    /// Takes the next reply, or repeats the last one once the script is spent.
    private func record(_ request: LocalChatHTTPRequest) -> Reply {
        lock.lock(); defer { lock.unlock() }
        _sent.append(request)
        return replies.count > 1 ? replies.removeFirst() : replies[0]
    }

    func send(_ request: LocalChatHTTPRequest) async throws -> LocalChatHTTPResponse {
        let reply = record(request)
        return LocalChatHTTPResponse(status: reply.status,
                                     contentType: reply.contentType,
                                     host: request.url.host ?? "",
                                     bytes: LocalChatBody.text(reply.body))
    }
}

/// Holds an SSE response open after its first event, so the test can tell a
/// genuinely streamed update from the final callback at end-of-stream.
final class HeldStreamTransport: LocalChatTransporting {
    private let status: Int
    let started = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var continuation: AsyncThrowingStream<UInt8, Error>.Continuation?

    init(status: Int = 200) { self.status = status }

    func send(_ request: LocalChatHTTPRequest) async throws -> LocalChatHTTPResponse {
        let bytes = AsyncThrowingStream<UInt8, Error> { continuation in
            lock.lock(); self.continuation = continuation; lock.unlock()
        }
        started.signal()
        return LocalChatHTTPResponse(status: status, contentType: "text/event-stream",
                                     host: request.url.host ?? "", bytes: bytes)
    }

    func emit(_ text: String) {
        lock.lock(); let output = continuation; lock.unlock()
        for byte in text.utf8 { output?.yield(byte) }
    }

    func cancel() {
        lock.lock(); let output = continuation; lock.unlock()
        output?.finish()
    }
}

/// A tool run that records what it was asked and answers from a script.
final class StubExecutor: LocalToolExecuting {
    var calls: [(name: String, arguments: [String: Any])] = []
    var result: [String: Any] = [:]

    func execute(_ name: String, _ arguments: [String: Any]) async throws -> [String: Any] {
        calls.append((name, arguments))
        return result
    }

    func cancel() {}
}

/// Where the listeners write, so no closure has to capture a mutable var.
final class Capture {
    var text = ""
    var thinking = ""
    var entries: [[String: Any]] = []
    var response: JSONObject?

    var listener: LocalChatListener {
        LocalChatListener(
            onText: { self.text = $0 },
            onThinking: { self.thinking = $0 },
            onResponse: { self.response = $0 },
            onTool: { self.entries.append($0) })
    }
}

func localRoute(keys: [String], wire: String = "openai") -> LocalChatRoute {
    LocalChatRoute(id: "r", label: "P · m", model: "m", wireProtocol: wire,
                   baseURL: "https://api.example.com/v1", keys: keys)
}

do {
    // A rejected key advances to the next; the request is aimed at the right
    // endpoint and carries the credential the provider expects.
    let rotation = StubTransport([
        .init(status: 401, contentType: "application/json",
              body: #"{"error":{"message":"invalid api key"}}"#),
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":"ok"}}]}"#),
    ])
    let capture = Capture()
    let answer = try? await LocalChatClient(transport: rotation).chat(
        route: localRoute(keys: ["k1", "k2"]),
        body: ["model": "m", "messages": [], "stream": true], listener: capture.listener)
    checkEqual(answer, "ok", "a rejected key retries on the next")
    checkEqual(rotation.sent.count, 2, "and both keys were sent")
    checkEqual(rotation.sent.first?.headers["Authorization"], "Bearer k1", "the first key goes out first")
    checkEqual(rotation.sent.last?.headers["Authorization"], "Bearer k2", "then the second")
    checkEqual(rotation.sent.first?.url.absoluteString,
               "https://api.example.com/v1/chat/completions", "openai posts to chat/completions")
    checkEqual(rotation.sent.first?.headers["Accept"], "text/event-stream, application/json",
               "the provider is told a stream is acceptable")
    check(capture.response != nil, "a buffered reply reaches the listener")

    // A region block is not the key's fault, so the next key is not spent on it.
    let blocked = StubTransport([
        .init(status: 403, contentType: "application/json",
              body: #"{"error":{"message":"This model is not available in your region"}}"#),
    ])
    var blockedError: LocalChatHTTPError?
    do {
        _ = try await LocalChatClient(transport: blocked).chat(
            route: localRoute(keys: ["k1", "k2"]),
            body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    } catch let error as LocalChatHTTPError { blockedError = error }
    check(blockedError != nil, "a region block is reported")
    checkEqual(blocked.sent.count, 1, "and the next key is not spent on it")

    // Anthropic reaches /messages and sends both credential headers.
    let anthropic = StubTransport([
        .init(status: 200, contentType: "application/json",
              body: #"{"content":[{"type":"text","text":"hi"}]}"#),
    ])
    let anthropicCapture = Capture()
    _ = try? await LocalChatClient(transport: anthropic).chat(
        route: localRoute(keys: ["a1"], wire: "anthropic"),
        body: ["model": "m", "messages": [], "stream": true], listener: anthropicCapture.listener)
    checkEqual(anthropic.sent.first?.url.absoluteString,
               "https://api.example.com/v1/messages", "anthropic posts to messages")
    checkEqual(anthropic.sent.first?.headers["x-api-key"], "a1", "and carries x-api-key")
    checkEqual(anthropic.sent.first?.headers["anthropic-version"], "2023-06-01", "and the version header")
    checkEqual(anthropicCapture.text, "hi", "a buffered anthropic reply is read")
}

do {
    // An OpenAI stream, terminated the way providers terminate it.
    let openai = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: #"data: {"choices":[{"delta":{"content":"He"}}]}"# + "\n\n"
                  + #"data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}]}"# + "\n\n"),
    ])
    let capture = Capture()
    let answer = try? await LocalChatClient(transport: openai).chat(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [], "stream": true], listener: capture.listener)
    checkEqual(answer, "Hello", "an OpenAI stream is assembled from its deltas")
    checkEqual(capture.text, "Hello", "and the listener held the whole reply")

    let held = HeldStreamTransport()
    let firstChunk = DispatchSemaphore(value: 0)
    let heldReply = Task.detached {
        try? await LocalChatClient(transport: held).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "stream": true],
            listener: LocalChatListener(onText: { if $0 == "He" { firstChunk.signal() } }))
    }
    check(waitForSignal(held.started, seconds: 2), "the held stream starts")
    held.emit(#"data: {"choices":[{"delta":{"content":"He"}}]}"# + "\n\n")
    check(waitForSignal(firstChunk, seconds: 2),
          "the first SSE chunk reaches the listener before the stream ends")
    held.emit("data: [DONE]\n\n")
    held.cancel()
    checkEqual(await heldReply.value, "He", "the held stream still completes")

    // `[DONE]` is a terminator in its own right.
    let done = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: #"data: {"choices":[{"delta":{"content":"Hi"}}]}"# + "\n\n"
                  + "data: [DONE]\n\n"),
    ])
    let doneCapture = Capture()
    let doneAnswer = try? await LocalChatClient(transport: done).chat(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [], "stream": true], listener: doneCapture.listener)
    checkEqual(doneAnswer, "Hi", "[DONE] ends a stream")

    // An Anthropic stream, thinking included.
    let anthropic = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: #"data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}"# + "\n\n"
                  + #"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"# + "\n\n"
                  + #"data: {"type":"message_stop"}"# + "\n\n"),
    ])
    let anthropicCapture = Capture()
    let anthropicAnswer = try? await LocalChatClient(transport: anthropic).chat(
        route: localRoute(keys: ["k"], wire: "anthropic"),
        body: ["model": "m", "messages": [], "stream": true], listener: anthropicCapture.listener)
    checkEqual(anthropicAnswer, "Hi", "an Anthropic stream is assembled")
    checkEqual(anthropicCapture.thinking, "hmm", "and its thinking is delivered")

    // A stream that stops without a terminator is an interruption, not a reply.
    let cut = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: #"data: {"choices":[{"delta":{"content":"partial"}}]}"# + "\n\n"),
    ])
    var cutError: LocalChatError?
    do {
        _ = try await LocalChatClient(transport: cut).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    } catch let error as LocalChatError { cutError = error }
    checkEqual(cutError, .interrupted, "a stream cut short is reported, not saved")

    // An error event mid-stream keeps what arrived and is reported.
    let broken = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: #"data: {"error":{"message":"boom"}}"# + "\n\n"),
    ])
    var brokenError: LocalChatError?
    do {
        _ = try await LocalChatClient(transport: broken).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    } catch let error as LocalChatError { brokenError = error }
    if case .streamError(let detail)? = brokenError {
        check(detail.contains("boom"), "a stream error carries the provider's own words")
    } else {
        check(false, "a stream error is raised")
    }

    // A failure body that never ends is not allowed to hold up the error.
    let flood = StubTransport([
        .init(status: 500, contentType: "text/plain", body: String(repeating: "x", count: 40000)),
    ])
    var floodError: LocalChatHTTPError?
    do {
        _ = try await LocalChatClient(transport: flood).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    } catch let error as LocalChatHTTPError { floodError = error }
    check(floodError?.message.hasPrefix("API HTTP 500") == true, "an upstream error names its status")
    check(floodError?.tryNextKey == false, "and is not retried on another key")

    let chineseError = StubTransport([
        .init(status: 400, contentType: "application/json",
              body: #"{"error":{"message":""# + String(repeating: "界", count: 11_000) + #""}}"#),
    ])
    var providerError: LocalChatHTTPError?
    do {
        _ = try await LocalChatClient(transport: chineseError).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    } catch let error as LocalChatHTTPError { providerError = error }
    check(providerError?.message.contains("服务商信息 / Provider:") == true,
          "a multi-byte provider error below Android's character cap preserves the detail")

    let idleError = HeldStreamTransport(status: 500)
    let errorFinished = DispatchSemaphore(value: 0)
    let errorTask = Task.detached { () -> LocalChatHTTPError? in
        defer { errorFinished.signal() }
        do {
            _ = try await LocalChatClient(transport: idleError).chat(
                route: localRoute(keys: ["k"]),
                body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
            return nil
        } catch let error as LocalChatHTTPError { return error }
        catch { return nil }
    }
    check(waitForSignal(idleError.started, seconds: 2), "a silent HTTP error body starts reading")
    let errorTimedOut = waitForSignal(errorFinished, seconds: 7)
    check(errorTimedOut, "a silent HTTP error body is bounded to Android's five-second timeout")
    if !errorTimedOut { idleError.cancel() }
    checkEqual(await errorTask.value?.tryNextKey, false, "a timed-out upstream error is not retried")
}

do {
    // Android's BufferedReader and StringBuilder limit UTF-16 code units,
    // not UTF-8 bytes. A Chinese reply may occupy more than 2 MiB on the
    // wire while remaining comfortably below Android's 2M-character cap.
    let chinese = String(repeating: "界", count: 700_000)
    let buffered = StubTransport([
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":""# + chinese + #""}}]}"#),
    ])
    let bufferedAnswer = try? await LocalChatClient(transport: buffered).chat(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    check(bufferedAnswer == chinese, "a multi-byte buffered reply below Android's character cap is accepted")

    let streamed = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: #"data: {"choices":[{"delta":{"content":""# + chinese
                  + #""},"finish_reason":"stop"}]}"# + "\n\n"),
    ])
    let streamedAnswer = try? await LocalChatClient(transport: streamed).chat(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    check(streamedAnswer == chinese, "a multi-byte SSE event below Android's character cap is accepted")

    let nonJavaWhitespace = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: "data: \u{00A0}[DONE]\u{00A0}\n\n"),
    ])
    var whitespaceError: LocalChatError?
    do {
        _ = try await LocalChatClient(transport: nonJavaWhitespace).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "stream": true], listener: Capture().listener)
    } catch let error as LocalChatError { whitespaceError = error }
    checkEqual(whitespaceError, .unsupportedFormat, "SSE data uses Android's trim boundary")
}

do {
    // The tool loop: a first round that asks for a search, a second that
    // answers, and a Sources block assembled from what the search returned.
    let twoRound = StubTransport([
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"swift world model\"}"}}]},"finish_reason":"tool_calls"}]}"#),
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":"Answer [1]"},"finish_reason":"stop"}]}"#),
    ])
    let executor = StubExecutor()
    executor.result = ["untrusted": true,
                       "sources": [["url": "https://example.com/a", "title": "A"]]]
    let capture = Capture()
    let answer = try? await LocalChatClient(transport: twoRound).chatWithTools(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [], "stream": true],
        listener: capture.listener, executor: executor)
    checkEqual(answer, "Answer [1]\n\n---\nSources / 来源\n\n- <https://example.com/a>",
               "a tool round ends in an answer with its sources")
    checkEqual(executor.calls.count, 1, "the loop ran the tool exactly once")
    checkEqual(executor.calls.first?.name, "web_search", "and ran the tool the model named")
    checkEqual(executor.calls.first?.arguments["query"] as? String, "swift world model",
               "with the arguments the model produced")
    checkEqual(twoRound.sent.count, 2, "two rounds were sent")
    checkEqual(capture.entries.first?["status"] as? String, "running", "the tool entry starts running")
    checkEqual(capture.entries.last?["status"] as? String, "completed", "and finishes completed")

    // The first request carries the tools, a system banner and no streaming.
    if let first = twoRound.sent.first,
       let object = try? JSONSerialization.jsonObject(with: first.body) as? [String: Any] {
        check(object["tools"] != nil, "the first round declares the tools")
        checkEqual(object["stream"] as? Bool, false, "and asks for a whole JSON reply")
        let messages = object["messages"] as? [Any] ?? []
        checkEqual((messages.first as? [String: Any])?["role"] as? String, "system",
                   "with the rules ahead of the conversation")
    } else {
        check(false, "the first request body is readable")
    }

    // A provider that streams in tool mode cannot be parsed for calls.
    let streaming = StubTransport([
        .init(status: 200, contentType: "text/event-stream",
              body: "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"),
    ])
    var streamingError: LocalToolError?
    do {
        _ = try await LocalChatClient(transport: streaming).chat(
            route: localRoute(keys: ["k"]),
            body: ["model": "m", "messages": [], "tools": [], "stream": false],
            listener: Capture().listener)
    } catch let error as LocalToolError { streamingError = error }
    checkEqual(streamingError, .requiresJSON, "a streamed reply in tool mode is refused")

    // A cancelled request does nothing and says so.
    let idle = StubTransport([
        .init(status: 200, contentType: "application/json", body: "{}"),
    ])
    let client = LocalChatClient(transport: idle)
    check(!client.isCancelled, "a fresh client is not cancelled")
    client.cancel()
    check(client.isCancelled, "and cancellation is remembered")
    checkEqual(idle.cancelCount, 1, "and cancellation closes the transport")
    var cancelError: LocalChatError?
    do {
        _ = try await client.chat(route: localRoute(keys: ["k"]),
                                  body: ["model": "m", "messages": [], "stream": true],
                                  listener: Capture().listener)
    } catch let error as LocalChatError { cancelError = error }
    checkEqual(cancelError, .cancelled, "a cancelled client sends nothing")
    checkEqual(idle.sent.count, 0, "and the transport was never used")
}

do {
    // Android's JSONObject.toString().length() measures UTF-16 code units.
    // Multi-byte tool context and output below those caps must not fail early.
    let longPrompt = String(repeating: "界", count: 700_000)
    let contextTransport = StubTransport([
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":"ok"}}]}"#),
    ])
    let contextAnswer = try? await LocalChatClient(transport: contextTransport).chatWithTools(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [["role": "user", "content": longPrompt]], "stream": true],
        listener: Capture().listener, executor: StubExecutor())
    checkEqual(contextAnswer, "ok", "multi-byte tool context below Android's character cap is accepted")
    checkEqual(contextTransport.sent.count, 1, "the accepted tool context is actually sent")

    let resultTransport = StubTransport([
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"weather\"}"}}]},"finish_reason":"tool_calls"}]}"#),
        .init(status: 200, contentType: "application/json",
              body: #"{"choices":[{"message":{"role":"assistant","content":"ok"}}]}"#),
    ])
    let executor = StubExecutor()
    executor.result = ["untrusted": true, "text": String(repeating: "界", count: 7_000)]
    let capture = Capture()
    let resultAnswer = try? await LocalChatClient(transport: resultTransport).chatWithTools(
        route: localRoute(keys: ["k"]),
        body: ["model": "m", "messages": [], "stream": true],
        listener: capture.listener, executor: executor)
    checkEqual(resultAnswer, "ok", "a multi-byte tool result still reaches the final answer")
    checkEqual(capture.entries.last?["status"] as? String, "completed",
               "a tool result below Android's character cap is not marked failed")
}

// MARK: - Remote list cache
//
// The list the phone draws on launch before the tunnel has answered. What has to
// hold is the round trip through the seal, the bound, and that nothing readable
// is left on disk.

do {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-listcache-check-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("list.json")
    let keys = FileSecretKeyStore(url: directory.appendingPathComponent("cache.key"))
    let cache = RemoteListCache(url: file, keys: keys, clock: { 1_700_000_000_000 })

    func conversation(_ id: String, title: String, updated: Int64,
                      workspace: String? = nil, pinned: Bool = false,
                      activity: String? = nil) -> RemoteConversation {
        var value: [String: Any] = ["id": id, "title": title, "seq": updated, "pinned": pinned,
                                    "updatedAt": updated, "workspaceName": "Work",
                                    "lastReplyAt": updated, "replyReadAt": 0]
        if let workspace { value["workspaceId"] = workspace }
        if let activity { value["activity"] = activity }
        return RemoteConversation(JSONObject(dictionary: value))
    }

    let address = "http://100.64.0.1:43127"
    check(cache.load(address: address, token: token43) == nil, "a fresh cache holds nothing")

    let rows = [conversation("a", title: "First", updated: 30, workspace: "w1", pinned: true, activity: "running"),
                conversation("b", title: "Second", updated: 20),
                conversation("c", title: "Third", updated: 10, workspace: "w1")]
    cache.save(address: address, token: token43, conversations: rows, nextOffset: 50,
               workspaces: [RemoteWorkspace(id: "w1", name: "Work")], includeUnassigned: true)

    let entry = cache.load(address: address, token: token43)
    checkEqual(entry?.conversations.count, 3, "the saved rows come back")
    checkEqual(entry?.conversations.first?.title, "First", "with their titles")
    check((entry?.conversations.first?.pinned ?? false) == true, "and their pinned flag")
    check((entry?.conversations.first?.activity) == .running, "and their activity")
    checkEqual(entry?.conversations.first?.workspaceId, "w1", "and their workspace")
    check((entry?.conversations[1].workspaceId) == nil, "an independent row stays independent")
    checkEqual(entry?.workspaces.first?.name, "Work", "the workspaces come back")
    check((entry?.includeUnassigned ?? false) == true, "and whether independent rows are allowed")
    checkEqual(entry?.nextOffset, 50, "and the resume point")
    checkEqual(entry?.savedAt, 1_700_000_000_000, "and when it was written")

    // The token is never written out, not even as a key of the stored map.
    check(!RemoteListCache.key(address: address, token: token43).contains(token43),
          "the cache key does not contain the token")
    check(!RemoteListCache.key(address: address, token: token43).isEmpty,
          "but it is not empty either")
    check(RemoteListCache.key(address: address, token: token43)
          != RemoteListCache.key(address: address, token: String(repeating: "B", count: 43)),
          "and two tokens are two entries")

    // A new store over the same file, which is what the next launch is.
    let reopened = RemoteListCache(url: file, keys: keys)
    checkEqual(reopened.load(address: address, token: token43)?.conversations.count, 3,
               "the cache survives being sealed and reopened")
    check(reopened.load(address: address, token: String(repeating: "B", count: 43)) == nil,
          "another token has no cached list")

    // Disposable by design: a cache read with the wrong key reads as empty
    // rather than throwing or, worse, as somebody's data.
    let stranger = RemoteListCache(url: file,
                                   keys: FileSecretKeyStore(url: directory.appendingPathComponent("other.key")))
    check(stranger.load(address: address, token: token43) == nil, "a cache read with the wrong key is empty")

    // Nothing legible is left behind.
    let raw = (try? Data(contentsOf: file)) ?? Data()
    let text = String(decoding: raw, as: UTF8.self)
    check(!text.isEmpty, "the cache was written to disk")
    check(!text.contains("\"conversations\""), "the stored rows are not legible")
    check(!text.contains("First"), "nor are their titles")

    // The bound, and the resume point it implies.
    let many = (0..<1005).map { conversation("id-\($0)", title: "C\($0)", updated: Int64(1005 - $0)) }
    cache.save(address: address, token: token43, conversations: many, nextOffset: -1,
               workspaces: [], includeUnassigned: false)
    let bounded = cache.load(address: address, token: token43)
    checkEqual(bounded?.conversations.count, RemoteListCache.conversationLimit,
               "a list longer than the bound is stored up to it")
    checkEqual(bounded?.nextOffset, Int64(RemoteListCache.conversationLimit),
               "and says where to resume instead of claiming to be complete")

    cache.remove(address: address, token: token43)
    check(cache.load(address: address, token: token43) == nil, "a removed entry is gone")
    checkEqual(cache.count, 0, "and stops counting")
}

do {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-listcache-evict-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = RemoteListCache(url: directory.appendingPathComponent("list.json"),
                                keys: FileSecretKeyStore(url: directory.appendingPathComponent("k")))
    func row(_ title: String) -> RemoteConversation {
        RemoteConversation(JSONObject(dictionary: ["id": "x", "title": title]))
    }
    for index in 0...RemoteListCache.entryLimit {
        cache.save(address: "http://100.64.0.\(index):43127", token: token43,
                   conversations: [row("T\(index)")], nextOffset: -1,
                   workspaces: [], includeUnassigned: false)
    }
    checkEqual(cache.count, RemoteListCache.entryLimit,
               "the cache keeps at most \(RemoteListCache.entryLimit) computers")
    checkEqual(cache.load(address: "http://100.64.0.\(RemoteListCache.entryLimit):43127",
                          token: token43)?.conversations.first?.title,
               "T\(RemoteListCache.entryLimit)", "and the newest one is among them")
}

// MARK: - Remote prefetch

do {
    let cancellation = RemoteRequestCancellation()
    var closed = 0
    check(cancellation.install { closed += 1 }, "a live request can register its abort")
    cancellation.cancel()
    checkEqual(closed, 1, "cancelling an active request closes its transport")
    cancellation.cancel()
    checkEqual(closed, 1, "repeated cancellation does not close twice")
    check(!cancellation.install { closed += 1 }, "a cancelled request cannot start later")
    checkEqual(closed, 2, "a late transport is closed immediately")
    cancellation.clear()
    checkEqual(closed, 2, "clearing an abort does not close it again")
}
do {
    let cancellation = RemoteRequestCancellation()
    let old = cancellation.ticket()
    var closed = 0
    check(cancellation.install({ closed += 1 }, ticket: old), "an ordinary request registers")
    cancellation.cancelCurrent()
    checkEqual(closed, 1, "switching screens closes the current request")
    check(!cancellation.install({ closed += 1 }, ticket: old),
          "a request opened after its screen left cannot start")
    checkEqual(closed, 2, "the stale request socket closes immediately")
    let fresh = cancellation.ticket()
    check(cancellation.install({ closed += 1 }, ticket: fresh),
          "the next screen can use the same transport")
    cancellation.clear(ticket: old)
    cancellation.cancelCurrent()
    checkEqual(closed, 3, "stale cleanup cannot erase the new request's abort")
}
//
// The snapshots fetched ahead of a tap. What has to hold is the freshness test,
// the two bounds, and that one computer's entries are not another's.

do {
    func snapshot(_ id: String, text: String = "hi",
                  seq: Int64 = 1, updated: Int64 = 1, activity: String? = nil) -> RemoteSnapshot {
        var conversation: [String: Any] = ["id": id, "title": id, "seq": seq, "updatedAt": updated]
        if let activity { conversation["activity"] = activity }
        return RemoteSnapshot(JSONObject(dictionary: [
            "conversation": conversation,
            "messages": [["seq": 1, "role": "user", "text": text, "at": 1]],
        ]))
    }
    func row(_ id: String, seq: Int64 = 1, updated: Int64 = 1, activity: String? = nil) -> RemoteConversation {
        var value: [String: Any] = ["id": id, "title": id, "seq": seq, "updatedAt": updated]
        if let activity { value["activity"] = activity }
        return RemoteConversation(JSONObject(dictionary: value))
    }

    var now: TimeInterval = 1000
    let prefetch = RemotePrefetch(
        budget: RemotePrefetch.Budget(bytes: 400, perSnapshot: 512, freshness: 60, immediate: 10, entries: 4),
        clock: { now })

    check(prefetch.cached(address: "a", token: "t", id: "c1") == nil, "nothing is prefetched to start")
    prefetch.store(address: "a", token: "t", snapshot: snapshot("c1"))
    checkEqual(prefetch.cached(address: "a", token: "t", id: "c1")?.conversation?.id ?? "", "c1",
               "a stored snapshot comes back")
    check(prefetch.cached(address: "a", token: "t", id: "c2") == nil, "and only the one that was stored")
    check(prefetch.cached(address: "a", token: "other", id: "c1") == nil,
          "another token on the same address sees nothing")

    // Android never replaces a useful prefetched page with a snapshot that
    // has a conversation but no messages array. Otherwise reopening the page
    // would briefly draw an empty transcript as though its rows were gone.
    prefetch.store(address: "a", token: "t", snapshot: RemoteSnapshot(JSONObject(dictionary: [
        "conversation": ["id": "c1", "title": "c1", "seq": 2, "updatedAt": 2],
    ])))
    checkEqual(prefetch.cached(address: "a", token: "t", id: "c1")?.messages.map(\.seq), [1],
               "a partial snapshot does not replace a cached transcript")
    prefetch.store(address: "a", token: "t", snapshot: RemoteSnapshot(JSONObject(dictionary: [
        "conversation": ["id": "c2", "title": "c2", "seq": 1, "updatedAt": 1],
    ])))
    check(prefetch.cached(address: "a", token: "t", id: "c2") == nil,
          "a partial snapshot does not create a blank cached transcript")

    // Freshness follows the row's signature and the clock.
    check(prefetch.isFresh(address: "a", token: "t", conversation: row("c1")), "a just-stored row is fresh")
    check(!prefetch.isFresh(address: "a", token: "t", conversation: row("c1", seq: 2)),
          "a row whose sequence moved is not fresh")
    check(!prefetch.isFresh(address: "a", token: "t", conversation: row("c1", activity: "running")),
          "nor one whose activity changed")
    now += 61
    check(!prefetch.isFresh(address: "a", token: "t", conversation: row("c1")),
          "nor one past the freshness window")
    check(prefetch.cached(address: "a", token: "t", id: "c1") != nil,
          "though a stale snapshot is still worth drawing")

    // Not everything offered is worth keeping.
    prefetch.store(address: "a", token: "t", snapshot: RemoteSnapshot(JSONObject(dictionary: ["messages": []])))
    checkEqual(prefetch.count, 1, "a snapshot that names no conversation is ignored")
    prefetch.store(address: "a", token: "t", snapshot: snapshot(""))
    checkEqual(prefetch.count, 1, "and so is one with an empty id")
    prefetch.store(address: "a", token: "t", snapshot: snapshot("big", text: String(repeating: "x", count: 600)))
    check(prefetch.cached(address: "a", token: "t", id: "big") == nil,
          "a snapshot past the per-entry ceiling is refused")

    // Least recently used goes first.
    prefetch.clear()
    prefetch.store(address: "a", token: "t", snapshot: snapshot("keep", text: String(repeating: "k", count: 100)))
    prefetch.store(address: "a", token: "t", snapshot: snapshot("drop", text: String(repeating: "d", count: 100)))
    _ = prefetch.cached(address: "a", token: "t", id: "keep")
    prefetch.store(address: "a", token: "t", snapshot: snapshot("third", text: String(repeating: "t", count: 100)))
    check(prefetch.cached(address: "a", token: "t", id: "keep") != nil, "the recently read snapshot is kept")
    check(prefetch.cached(address: "a", token: "t", id: "drop") == nil, "and the least recently used one is evicted")
    check(prefetch.weight <= prefetch.budgetBytes, "and the byte budget holds")

    // The entry cap is what the byte estimate cannot see.
    let capped = RemotePrefetch(
        budget: RemotePrefetch.Budget(bytes: 1 << 20, perSnapshot: 1 << 20, freshness: 60, immediate: 10, entries: 3))
    for index in 0..<10 { capped.store(address: "a", token: "t", snapshot: snapshot("e\(index)")) }
    checkEqual(capped.count, 3, "the entry cap holds whatever the byte estimate says")

    // Forgetting one computer leaves the other alone.
    prefetch.clear()
    prefetch.store(address: "a", token: "t", snapshot: snapshot("mine"))
    prefetch.store(address: "b", token: "t", snapshot: snapshot("theirs"))
    prefetch.forgetComputer(address: "a", token: "t")
    check(prefetch.cached(address: "a", token: "t", id: "mine") == nil, "a removed computer's snapshots are gone")
    check(prefetch.cached(address: "b", token: "t", id: "theirs") != nil, "and the other computer keeps its own")
    prefetch.forget(address: "b", token: "t", id: "theirs")
    checkEqual(prefetch.count, 0, "a single forget empties the last one")

    // The bounds are Android's: a sixteenth of memory, floored and capped.
    checkEqual(RemotePrefetch.Budget.standard(physicalMemory: 1 << 30).bytes, 32 * 1024 * 1024,
               "a large device takes the cap")
    checkEqual(RemotePrefetch.Budget.standard(physicalMemory: 1 << 20).bytes, 8 * 1024 * 1024,
               "a small one takes the floor")
    checkEqual(RemotePrefetch.Budget.standard(physicalMemory: 256 * 1024 * 1024).bytes, 16 * 1024 * 1024,
               "and one in between takes its sixteenth")
}

// MARK: - Remote prefetch scheduling

do {
    let owner = RemotePrefetchPlan.Owner(address: "http://100.64.0.1:43127", token: token43,
                                         endpoint: try Endpoint("http://100.64.0.1:43127"))
    let other = RemotePrefetchPlan.Owner(address: "http://100.64.0.2:43127", token: token43,
                                         endpoint: try Endpoint("http://100.64.0.2:43127"))
    let cache = RemotePrefetch(clock: { 1000 })
    func row(_ index: Int, updated: Int64? = nil) -> RemoteConversation {
        RemoteConversation(JSONObject(dictionary: [
            "id": String(format: "00000000-0000-0000-0000-%012d", index),
            "title": "row \(index)", "seq": 1, "updatedAt": updated ?? Int64(index),
        ]))
    }
    var plan = RemotePrefetchPlan()
    plan.schedule(owner, rows: (1...12).map { row($0) }, nextOffset: 100,
                  initial: true, now: 1000, cache: cache)
    checkEqual(plan.pendingCount, 13, "twelve rows and one later page enter the prefetch plan")
    check(plan.hasImmediate, "a fresh list has immediate work")
    checkEqual(plan.delay(now: 1000, lastInteraction: 1000), 0,
               "recent snapshots do not wait for idle time")
    plan.schedule(owner, rows: [row(12, updated: 13)], nextOffset: 100,
                  initial: false, now: 1000, cache: cache)
    checkEqual(plan.pendingCount, 13, "repeated lists replace pending rows and deduplicate pages")

    for index in stride(from: 12, through: 3, by: -1) {
        let work = plan.take(idle: false, cache: cache)
        if case .snapshot(let selected)? = work?.target {
            checkEqual(selected.id, row(index).id, "immediate snapshots follow recent-first order")
        } else {
            check(false, "an immediate snapshot was expected")
        }
    }
    check(plan.take(idle: false, cache: cache) == nil,
          "older snapshots and page requests wait for an idle window")
    check(!plan.hasImmediate, "after ten recent rows only idle work remains")
    checkEqual(plan.delay(now: 1000.5, lastInteraction: 1000), 1.5,
               "recent interaction delays the idle walk")
    checkEqual(plan.delay(now: 1003, lastInteraction: 1000), 0.5,
               "idle requests keep the Android half-second floor")
    if case .snapshot(let selected)? = plan.take(idle: true, cache: cache)?.target {
        checkEqual(selected.id, row(2).id, "older snapshots continue in recency order")
    } else {
        check(false, "the first idle snapshot was expected")
    }
    _ = plan.take(idle: true, cache: cache)
    let firstPage = plan.take(idle: true, cache: cache)
    if case .page(let offset)? = firstPage?.target {
        checkEqual(offset, 100, "the next list page follows older snapshots")
    } else {
        check(false, "an idle page request was expected")
    }
    if let firstPage {
        plan.completedPage(firstPage, rows: [row(13)], nextOffset: 200, now: 1003, cache: cache)
    }
    checkEqual(plan.pendingCount, 2, "a fetched page queues its rows and its successor")
    plan.schedule(owner, rows: [], nextOffset: 100, initial: false, now: 1004, cache: cache)
    checkEqual(plan.pendingCount, 2, "a page fetched less than a minute ago stays fresh")
    plan.schedule(owner, rows: [], nextOffset: 100, initial: false, now: 1064, cache: cache)
    checkEqual(plan.pendingCount, 3, "an old page can be revisited")

    plan.cancel()
    cache.store(address: owner.address, token: owner.token,
                snapshot: RemoteSnapshot(JSONObject(dictionary: [
                    "conversation": row(1).json, "messages": [],
                ])))
    plan.schedule(owner, rows: [row(1), row(2),
                                RemoteConversation(JSONObject(dictionary: ["id": "not-a-uuid"]))],
                  nextOffset: -1, initial: true, now: 1065, cache: cache)
    checkEqual(plan.pendingCount, 1, "fresh and malformed snapshot ids are not requested")
    plan.schedule(other, rows: [row(3)], nextOffset: -1,
                  initial: true, now: 1065, cache: cache)
    plan.remove(owner)
    checkEqual(plan.pendingCount, 1, "clearing one computer leaves another's work")
    plan.cancel()
    check(plan.delay(now: 1065, lastInteraction: 1000) == nil,
          "canceling a prefetch round leaves no timer work")
    plan.schedule(owner, rows: [], nextOffset: 100, initial: false, now: 1065, cache: cache)
    checkEqual(plan.delay(now: 1065, lastInteraction: 1065), 2,
               "an idle page alone waits for quiet")
    plan.schedule(other, rows: [row(4)], nextOffset: -1,
                  initial: true, now: 1065, cache: cache)
    checkEqual(plan.delay(now: 1065, lastInteraction: 1065), 0,
               "a new recent row outranks an already scheduled idle page")
}

// MARK: - Location consent
//
// The two parts of the location feature that are pure: whether a question earns
// a permission prompt at all, and the note the desktop's model actually reads.
// The dialog and the CoreLocation call are checked by check-camera.sh, which can
// reach them; these cannot be, and are the two that decide what the model is
// told.

do {
    // Questions that need to know where the person is.
    check(LocationContext.isRelevant("我在哪？"), "a question about where I am is relevant")
    check(LocationContext.isRelevant("我的位置在哪里"), "so is one naming my location")
    check(LocationContext.isRelevant("附近有什么好吃的推荐"), "and one asking about what is nearby")
    check(LocationContext.isRelevant("这里天气怎么样"), "and one asking about the weather here")
    check(LocationContext.isRelevant("今天会下雨吗"), "and a placeless question about today's weather")
    check(LocationContext.isRelevant("near me"), "and the English form")
    check(LocationContext.isRelevant("Where am I?"), "including mixed case")
    check(LocationContext.isRelevant("today's weather"), "and English weather with no place named")
    check(LocationContext.isRelevant("  我的位置  "), "surrounding whitespace does not matter")

    // Questions that do not.
    check(!LocationContext.isRelevant("帮我写一个 Swift 函数"),
          "an ordinary coding question is not about location")
    check(!LocationContext.isRelevant("不要定位，只告诉我时区"),
          "an explicit refusal is not read as a request")
    check(!LocationContext.isRelevant("don't use my location"),
          "nor is the English refusal, which also contains the words it refuses")
    check(!LocationContext.isRelevant("不使用我的位置"), "nor the Chinese one")
    check(!LocationContext.isRelevant("把这段翻译成英文：我在哪"),
          "text to be translated is somebody else's sentence")
    check(!LocationContext.isRelevant("quoted: near me"), "nor is a quotation")
    check(!LocationContext.isRelevant("看看这段代码\n```\n我在哪\n```"),
          "a code block is not a question about the reader")

    // A fix that can be sent.
    let note = LocationContext.approximate(latitude: 31.2304, longitude: 121.4737,
                                          accuracy: 100, age: 1)
    check(note?.contains("Latitude: 31.23; longitude: 121.47") == true,
          "a fix is written to two decimals")
    check(note?.contains("uncertainty: at least 2000 m.") == true,
          "and never claims better than two kilometres")
    check(note?.contains("not as an exact address") == true,
          "and says what it may not be used for")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 5000, age: 0)?
        .contains("uncertainty: at least 5000 m.") == true,
          "a worse fix states its own worse accuracy")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 2000, age: 0)?
        .contains("uncertainty: at least 2000 m.") == true,
          "the floor is inclusive")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 120, age: 0)?
        .contains("uncertainty: at least 2000 m.") == true,
          "and a very good fix is still stated as the floor")

    // A fix that cannot.
    check(LocationContext.approximate(latitude: 91, longitude: 0, accuracy: 100, age: 0) == nil,
          "a latitude out of range is refused")
    check(LocationContext.approximate(latitude: 0, longitude: 181, accuracy: 100, age: 0) == nil,
          "so is a longitude out of range")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: -1, age: 0) == nil,
          "so is a negative accuracy")
    check(LocationContext.approximate(latitude: .nan, longitude: 0, accuracy: 100, age: 0) == nil,
          "so is a fabricated latitude")
    check(LocationContext.approximate(latitude: 0, longitude: .infinity, accuracy: 100, age: 0) == nil,
          "so is an infinite longitude")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 100, age: 121) == nil,
          "a fix older than two minutes is refused")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 100, age: 120) != nil,
          "the age limit is inclusive")
    check(LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 100, age: -1) == nil,
          "a fix dated in the future is refused")

    // And the two answers a caller gets, which are always text to append.
    check(LocationContext.note(latitude: 0, longitude: 0, accuracy: 200, age: 1)
          == LocationContext.approximate(latitude: 0, longitude: 0, accuracy: 200, age: 1),
          "a usable fix produces its note")
    checkEqual(LocationContext.note(latitude: 91, longitude: 0, accuracy: 100, age: 0),
               LocationContext.unavailable,
               "an unusable one produces the not-provided note")
    check(LocationContext.unavailable.contains("Do not guess"),
          "which tells the model not to guess")
    check(LocationContext.unavailable.hasPrefix("\n\n"),
          "and is a block to append rather than a sentence to replace")
    check(note?.hasPrefix("\n\n") == true, "as is the location note")
}

// MARK: - Computer status
//
// What the computers list says about each pairing, and how a failed check is
// explained. The three labels and the two tests on them come straight from
// Android's `computerStates`; the failure text is the same split Android's
// `failureMessage` makes between an HTTP answer and a tunnel one.

do {
    checkEqual(ComputerStatus.unchecked, "待检查", "a fresh computer is not yet checked")
    checkEqual(ComputerStatus.checking, "正在检查…", "a check in flight says so")
    checkEqual(ComputerStatus.connected, "已连接", "a reached computer is connected")
    check(ComputerStatus.unchecked != ComputerStatus.checking,
          "and the three labels are distinct, since the row compares them by value")

    check(ComputerStatus.isChecking(ComputerStatus.unchecked), "not-yet-checked reads as checking")
    check(ComputerStatus.isChecking(ComputerStatus.checking), "and so does checking")
    check(!ComputerStatus.isChecking(ComputerStatus.connected), "a connected computer is not checking")
    check(!ComputerStatus.isChecking("电脑配对凭据无效或已撤销，请重新配对。 [HTTP 401]"),
          "nor is one whose check failed")

    check(ComputerStatus.isConnected(ComputerStatus.connected), "connected reads as connected")
    check(!ComputerStatus.isConnected(ComputerStatus.checking), "checking does not")
    checkEqual(ComputerStatus.display(ComputerStatus.unchecked, chinese: false), "Not checked",
               "the unchecked status is English on an English phone")
    checkEqual(ComputerStatus.display(ComputerStatus.checking, chinese: false), "Checking…",
               "the in-flight status is English on an English phone")
    checkEqual(ComputerStatus.display(ComputerStatus.connected, chinese: false), "Connected",
               "the connected status is English on an English phone")

    // An HTTP answer explains itself.
    let refused = ComputerStatus.failure(status: 401, detail: "", message: nil, online: true)
    check(refused.contains("重新配对"), "a 401 tells the person to pair again")
    check(refused.contains("[HTTP 401]"), "and carries the status")
    let refusedEnglish = ComputerStatus.failure(status: 401, detail: "", message: nil,
                                                 online: true, chinese: false)
    check(refusedEnglish.contains("Pair") && refusedEnglish.contains("[HTTP 401]"),
          "a revoked computer explains the next step in English")

    let gateway = ComputerStatus.failure(status: 502, detail: "", message: nil, online: true)
    check(gateway.contains("[HTTP 502]"), "a 502 is reported as the gateway's problem")

    let detailed = ComputerStatus.failure(status: 403, detail: "no workspace", message: nil, online: true)
    check(detailed.contains("电脑返回详情：no workspace"), "a returned detail is appended")

    // Anything else is the bridge's code.
    let stopped = ComputerStatus.failure(status: nil, detail: "", message: "CAMELLIA_NETWORK_STOPPED", online: true)
    check(stopped.hasSuffix("[NETWORK_STOPPED]"), "a bridge code explains a tunnel failure")

    let offline = ComputerStatus.failure(status: nil, detail: "", message: nil, online: false)
    check(offline.hasSuffix("[OFFLINE]"), "a failure with the node down is a network failure first")

    let protocolMismatch = ComputerStatus.failure(status: nil, detail: "", message: "Unsupported protocol", online: true)
    check(protocolMismatch == ConnectionFailureCode.protocolError.text(chinese: true),
          "a protocol mismatch folds into the same text both platforms show")
}

// MARK: - A stream must not hold the queue a request needs
//
// What the phone actually reported: pairing succeeded, the computer's name was
// on the title bar, and the conversation list was empty with nothing said about
// why. `RemoteSession.watch` holds its queue for as long as a stream is open,
// and a stream is open until the screen changes. When that was the same queue
// `conversations` was submitted to, the list's own fetch never ran: the queue
// was occupied by the stream that was waiting for the desktop to say something,
// the fetch waiting for the desktop to answer sat behind it, `listLoading`
// never cleared and the screen stayed empty.
//
// Android never had it: `MainActivity.worker` is a two-thread pool, so one
// long-lived stream leaves a thread free for requests.
//
// Scheduling cannot be seen in a payload, so the transport is the seam that
// makes it visible: the real `RemoteSession` is driven against a desktop that
// answers, holds its stream open, and counts what it was asked.

/// A desktop answering on the wire, with no tunnel behind it.
final class FakeDesktop: RemoteTransport {
    /// One answer per `/v1/conversations` offset, exactly as the gateway builds
    /// them — `connectionInfo` merged into `reader.list(...)` merged with the
    /// stamp, which is why `protocol` rides on the list page itself.
    var listPages: [String: String] = [:]
    var snapshotBody = "{}"
    var streamBody = "event: snapshot\ndata: {\"listVersion\":\"v1\"}\n\n"
    var streamClosesAfterChunk = false
    var streamFailureAfterChunk: Error?
    /// The `/v1/status` answer, for the fallback an older page triggers.
    var statusBody = #"{"protocol":1,"permission":"control","capabilities":["artifacts","create"],"engines":["claude","codex"]}"#
    var offsetsAsked: [Int] = []
    var statusAsked = 0
    private let streamLock = NSLock()
    private var streamCount = 0
    private var latestStream: FakeStream?
    var openedStreams: Int {
        streamLock.lock()
        defer { streamLock.unlock() }
        return streamCount
    }
    var lastStream: FakeStream? {
        streamLock.lock()
        defer { streamLock.unlock() }
        return latestStream
    }
    var statusEntered: DispatchSemaphore?
    var statusRelease: DispatchSemaphore?
    var statusExited: DispatchSemaphore?
    var cancelCount = 0
    var cancelCurrentCount = 0
    var commandEntered: DispatchSemaphore?
    /// Thrown by `stream` instead of opening one, for the fallback path.
    var streamFailure: Error?
    private var oneShotStreamFailures: [Error] = []

    func failNextStream(_ error: Error) {
        streamLock.lock()
        oneShotStreamFailures.append(error)
        streamLock.unlock()
    }

    enum Refused: Error { case notImplemented }

    func status() throws -> RemoteStatus {
        let release = statusRelease
        statusEntered?.signal()
        if let release { _ = release.wait(timeout: .now() + 3) }
        statusExited?.signal()
        statusAsked += 1
        return RemoteStatus(try JSONBody.object(Data(statusBody.utf8)))
    }

    func cancel() {
        cancelCount += 1
        statusRelease?.signal()
    }

    func cancelCurrentRequest() {
        cancelCurrentCount += 1
        statusRelease?.signal()
    }

    func conversations(offset: Int) throws -> RemoteListPage {
        offsetsAsked.append(offset)
        guard let body = listPages[String(offset)] else { throw Refused.notImplemented }
        return RemoteListPage(try JSONBody.object(Data(body.utf8)))
    }

    func conversation(id: String, before: Int64?) throws -> RemoteSnapshot {
        RemoteSnapshot(try JSONBody.object(Data(snapshotBody.utf8)))
    }

    func command(_ action: String, conversationId: String?, payload: [String: Any]) throws -> CommandResult {
        commandEntered?.signal()
        return CommandResult(try JSONBody.object(Data("{}".utf8)))
    }

    func artifacts(conversationId: String, offset: Int64) throws -> RemoteArtifactPage {
        RemoteArtifactPage(try JSONBody.object(Data("{}".utf8)))
    }

    func apiKeys() throws -> [String: Any] { [:] }

    func markRead(conversationId: String, lastReplyAt: Int64) throws -> JSONObject {
        try JSONBody.object(Data("{}".utf8))
    }

    func artifact(conversationId: String, hash: String, expectedSize: Int64) throws -> Data { Data() }

    func stream(_ path: String) throws -> RemoteStreamHandle {
        streamLock.lock()
        let oneShot = oneShotStreamFailures.isEmpty ? nil : oneShotStreamFailures.removeFirst()
        streamLock.unlock()
        if let oneShot { throw oneShot }
        if let streamFailure { throw streamFailure }
        let opened = FakeStream(subject: path, body: streamBody,
                                finishAfterChunk: streamClosesAfterChunk,
                                failureAfterChunk: streamFailureAfterChunk)
        streamLock.lock()
        latestStream = opened
        streamCount += 1
        streamLock.unlock()
        return opened
    }
}

do {
    let destination = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-fake-artifact-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: destination) }
    var progress: (Int64, Int64)?
    try FakeDesktop().artifact(conversationId: "conversation", hash: hash64,
                               expectedSize: 0, to: destination, transfer: ArtifactTransfer()) {
        progress = ($0, $1)
    }
    checkEqual(try Data(contentsOf: destination), Data(),
               "test transport's default artifact writer creates a file")
    checkEqual(progress?.0, 0, "test transport reports completed artifact bytes")
} catch {
    checks += 1
    failures.append("test transport artifact writer: threw \(error)")
}
let cancelledArtifact = ArtifactTransfer()
cancelledArtifact.cancel()
checkThrows(ArtifactTransfer.Failure.cancelled, "cancelled artifact never starts writing") {
    try FakeDesktop().artifact(conversationId: "conversation", hash: hash64,
                               expectedSize: 0,
                               to: FileManager.default.temporaryDirectory
                                   .appendingPathComponent("camellia-unused-artifact-\(UUID().uuidString)"),
                               transfer: cancelledArtifact, progress: { _, _ in })
}
var lateAbortCalled = false
cancelledArtifact.setAbort { lateAbortCalled = true }
check(lateAbortCalled, "late artifact socket immediately closes after cancellation")

/// An HTTP refusal, as any transport would raise it.
///
/// `RemoteSession` has to classify it without knowing which transport produced
/// it — reading `RemoteApi.Failure` directly is what kept the session welded to
/// the tunnel framework, and with it the scheduling that broke.
struct RefusedHTTP: Error, RemoteHttpError {
    let status: Int
    let detail = ""
}

/// An open snapshot stream, of the kind a live desktop keeps open.
final class FakeStream: RemoteStreamHandle {
    private let lock = NSLock()
    private let closed = DispatchSemaphore(value: 0)
    private var done = false
    private let subject: String
    private let body: Data
    private let finishAfterChunk: Bool
    private let failureAfterChunk: Error?

    init(subject: String, body: String = "event: snapshot\ndata: {\"listVersion\":\"v1\"}\n\n",
         finishAfterChunk: Bool = false, failureAfterChunk: Error? = nil) {
        self.subject = subject
        self.body = Data(body.utf8)
        self.finishAfterChunk = finishAfterChunk
        self.failureAfterChunk = failureAfterChunk
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return done
    }

    var path: String { subject }

    func run(onChunk: @escaping (Data) throws -> Void) throws {
        // One snapshot on the way in, as the gateway writes on subscribe.
        try onChunk(body)
        if let failureAfterChunk { throw failureAfterChunk }
        if finishAfterChunk { return }
        // Then nothing, for as long as the desktop holds the stream — which is
        // the call the queue has to survive.
        closed.wait()
    }

    func cancel() {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { closed.signal() }
    }
}

/// Runs the main queue until `done`, or gives up.
///
/// The session hands every answer back through `DispatchQueue.main.async`, and
/// a command-line program only drains that while something is turning — so a
/// check that merely slept would report the answer as missing.
///
/// Two turns, because this file has top-level `await` and that changes who does
/// the turning. Up to the first suspension the top-level code runs as ordinary
/// synchronous code, and the main queue is drained by a run loop, which is what
/// the manual turn below does. From the first `await` on, the top-level code is
/// async main, and the main queue is drained by the concurrency runtime while
/// the task is suspended — a manual run loop no longer reaches it. Doing both
/// is the only version that holds on either side of that line; a probe of this
/// file found the run loop alone going quiet for every check after the first
/// `await`, which read as four checks failing for reasons of their own.
/// Turns the run loop once, without taking `RunLoop.current` from an async
/// function — that property is unavailable in async contexts and is an error in
/// the Swift 6 language mode, while the underlying call is not.
private func turnRunLoop(seconds: TimeInterval) {
    CFRunLoopRunInMode(CFRunLoopMode.defaultMode, seconds, true)
}

private func waitForSignal(_ semaphore: DispatchSemaphore, seconds: TimeInterval) -> Bool {
    semaphore.wait(timeout: .now() + seconds) == .success
}

func pump(seconds: TimeInterval, until done: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while !done(), Date() < deadline {
        turnRunLoop(seconds: 0.005)
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return done()
}

func isConnected(_ state: RemoteStreamState) -> Bool {
    if case .connected = state { return true }
    return false
}

/// The list page a desktop builds: its connection info, the list, and the stamp.
func listPage(_ conversations: String, workspaces: String = #"[{"id":"w1","name":"研究"}]"#,
              nextOffset: String = "null", protocolVersion: String? = "1",
              engines: String? = #"["claude","codex"]"#) -> String {
    var fields = [
        #""workspaces":\#(workspaces)"#,
        #""includeUnassigned":true"#,
        #""conversations":[\#(conversations)]"#,
        #""nextOffset":\#(nextOffset)"#,
        #""cursor":91"#,
        #""instanceId":"inst-1""#,
    ]
    if let protocolVersion {
        fields.append(#""protocol":\#(protocolVersion)"#)
        fields.append(#""permission":"control""#)
        fields.append(#""capabilities":["artifacts","send","create"]"#)
    }
    if let engines { fields.append(#""engines":\#(engines)"#) }
    return "{" + fields.joined(separator: ",") + "}"
}

let paired = PairedComputer(address: "http://100.64.0.1:43127", name: "phone",
                            computerName: "HP", token: token43, deviceId: "d1", permission: .control)

do {
    // Android treats a malformed snapshot as a stream failure and retries.
    // Silently skipping it leaves an open connection with no visible progress.
    let desktop = FakeDesktop()
    desktop.streamBody = "event: snapshot\ndata: not json\n\n"
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains { if case .reconnecting = $0 { return true }; return false } },
          "a malformed remote snapshot closes its stream and enters retry")
    session.invalidate()
}

do {
    // Android does not count a list event as received until its list refetch
    // succeeds. A failed refetch closes the stream and starts at two seconds.
    let desktop = FakeDesktop()
    desktop.streamClosesAfterChunk = true
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    var events = 0
    let failure = NSError(domain: "list-fetch", code: 1)
    session.watchList(onEvent: { _, _, finish in
        events += 1
        finish(.failure(failure))
    }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains {
        if case .reconnecting(let delay, _) = $0 { return delay == 2 }
        return false
    } }, "a failed event-driven list refetch closes the stream and retries after two seconds")
    checkEqual(events, 1, "the failing list event is delivered once")
    check(!states.contains(where: isConnected), "a failed list refetch does not announce connected")
    session.invalidate()
}

do {
    // A parsed list event followed by a 404 from its refetch is not evidence
    // that the *event endpoint* is missing. Android reserves polling for a
    // 404 before the event listener has received anything.
    let desktop = FakeDesktop()
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watchList(onEvent: { _, _, finish in finish(.failure(RefusedHTTP(status: 404))) },
                      onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains { if case .failed = $0 { return true }; return false } },
          "a list refetch 404 after an event is terminal")
    check(!states.contains { if case .unsupported = $0 { return true }; return false },
          "a list refetch 404 does not enable legacy polling")
    session.invalidate()
}

do {
    // The stream may close right after the event. It still waits for the
    // refetch result before choosing Android's one-second successful pace.
    let desktop = FakeDesktop()
    desktop.streamClosesAfterChunk = true
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    var finishList: ((Result<Void, Error>) -> Void)?
    session.watchList(onEvent: { _, _, finish in finishList = finish },
                      onState: { states.append($0) })
    check(await pump(seconds: 2) { finishList != nil }, "a list event waits for its refetch")
    check(!states.contains { if case .reconnecting = $0 { return true }; return false },
          "stream close does not race ahead of a pending list refetch")
    finishList?(.success(()))
    check(await pump(seconds: 2) { states.contains {
        if case .reconnecting(let delay, _) = $0 { return delay == 1 }
        return false
    } }, "a successful event-driven list refetch uses the one-second retry pace")
    check(states.contains(where: isConnected), "the successful list refetch announces connected")
    session.invalidate()
}

do {
    // Production list events submit their GET on the ordinary request queue.
    // Waiting for its acknowledgement must not occupy that queue itself.
    let desktop = FakeDesktop()
    desktop.listPages["0"] = listPage("[]")
    let session = try RemoteSession(computer: paired, transport: desktop)
    var page: ConversationPage?
    var states: [RemoteStreamState] = []
    session.watchList(onEvent: { _, _, finish in
        session.conversations { result in
            if case .success(let value) = result { page = value }
            finish(result.map { _ in () })
        }
    }, onState: { states.append($0) })
    check(await pump(seconds: 3) { page != nil && states.contains(where: isConnected) },
          "an event-driven list GET completes while the stream waits for its result")
    checkEqual(desktop.offsetsAsked, [0], "the event-driven list fetch reads its first page once")
    session.invalidate()
}

do {
    // After a failed refetch, the next stream must not skip the same cursor:
    // Android only skips an unchanged first event on attempt zero.
    let desktop = FakeDesktop()
    desktop.streamClosesAfterChunk = true
    let session = try RemoteSession(computer: paired, transport: desktop)
    var maySkip: [Bool] = []
    session.watchList(onEvent: { _, unchanged, finish in
        maySkip.append(unchanged)
        if maySkip.count == 1 {
            finish(.failure(NSError(domain: "list-fetch", code: 1)))
        } else {
            finish(.success(()))
        }
    }, onState: { _ in })
    check(await pump(seconds: 4) { maySkip.count >= 2 },
          "a failed list refetch is followed by a new event stream")
    checkEqual(Array(maySkip.prefix(2)), [true, false],
               "the retry refetches even if its first event has the same cursor")
    session.invalidate()
}

do {
    // A page switch cancels the pending acknowledgement too. Otherwise the
    // serial stream queue cannot open the detail stream behind it.
    let desktop = FakeDesktop()
    let session = try RemoteSession(computer: paired, transport: desktop)
    var finishList: ((Result<Void, Error>) -> Void)?
    session.watchList(onEvent: { _, _, finish in finishList = finish }, onState: { _ in })
    check(await pump(seconds: 2) { finishList != nil },
          "a list event is pending before switching pages")
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { _ in })
    check(await pump(seconds: 2) { desktop.openedStreams == 2 },
          "switching pages releases a pending list event and opens detail")
    checkEqual(desktop.lastStream?.path, "/v1/conversations/\(uuid)/events",
               "the new stream belongs to the detail page")
    finishList?(.success(()))
    session.invalidate()
}

do {
    // Android counts a parsed event before the detail screen filters out a
    // different conversation. A short stream still uses the one-second pace.
    let desktop = FakeDesktop()
    let wrong = "8f14e45f-ceea-467a-9e0f-3d1c8f2b7a44"
    desktop.streamBody = "event: snapshot\ndata: {\"conversation\":{\"id\":\"\(wrong)\"}}\n\n"
    desktop.streamClosesAfterChunk = true
    let session = try RemoteSession(computer: paired, transport: desktop)
    var delivered = 0
    var retryDelay: TimeInterval?
    session.watch(conversationId: uuid, onSnapshot: { _ in delivered += 1 }, onState: {
        if case .reconnecting(let delay, _) = $0 { retryDelay = delay }
    })
    check(await pump(seconds: 2) { retryDelay != nil },
          "a short wrong-conversation stream still enters paced reconnect")
    checkEqual(retryDelay, 1, "a parsed but filtered snapshot resets the retry delay")
    checkEqual(delivered, 0, "a foreign snapshot never reaches the detail screen")
    session.invalidate()
}

do {
    // The screen must not advertise a usable live connection before it has
    // applied the snapshot whose permission makes controls safe to enable.
    let desktop = FakeDesktop()
    desktop.streamBody = "event: snapshot\ndata: {\"conversation\":{\"id\":\"\(uuid)\"},\"permission\":\"control\"}\n\n"
    let session = try RemoteSession(computer: paired, transport: desktop)
    let transcript = RemoteTranscript()
    var order: [String] = []
    var permissionReadyAtConnect = false
    session.watch(conversationId: uuid, onSnapshot: {
        _ = transcript.apply($0)
        order.append("snapshot")
    }, onState: {
        if case .connected = $0 {
            permissionReadyAtConnect = transcript.connected && transcript.permission == .control
            order.append("connected")
        }
    })
    check(await pump(seconds: 2) { order.count == 2 },
          "a detail stream delivers its first snapshot and connected state")
    checkEqual(order, ["snapshot", "connected"], "the live snapshot precedes connected")
    check(permissionReadyAtConnect, "connected is announced only after its permission was applied")
    session.invalidate()
}

do {
    let desktop = FakeDesktop()
    let entered = DispatchSemaphore(value: 0)
    let released = DispatchSemaphore(value: 0)
    let exited = DispatchSemaphore(value: 0)
    let commandEntered = DispatchSemaphore(value: 0)
    desktop.statusEntered = entered
    desktop.statusRelease = released
    desktop.statusExited = exited
    desktop.commandEntered = commandEntered
    let session = try RemoteSession(computer: paired, transport: desktop)
    session.status { _ in }
    check(waitForSignal(entered, seconds: 5),
          "a request can occupy the serial queue")
    session.command("send", conversationId: "one") { _ in }
    session.invalidate()
    check(waitForSignal(exited, seconds: 3), "a stream change unblocks its old ordinary request")
    desktop.statusRelease = nil
    var drained = false
    session.status { _ in drained = true }
    check(await pump(seconds: 3) { drained },
          "a later request drains the queue after invalidation")
    check(!waitForSignal(commandEntered, seconds: 0),
          "an invalidated queued command never reaches the desktop")
    checkEqual(desktop.cancelCount, 0, "a stream change keeps its transport available")
    checkEqual(desktop.cancelCurrentCount, 1, "a stream change closes the old ordinary request")
} catch {
    checks += 1
    failures.append("invalidated queued command: threw \(error)")
}

do {
    let desktop = FakeDesktop()
    let entered = DispatchSemaphore(value: 0)
    let exited = DispatchSemaphore(value: 0)
    desktop.statusEntered = entered
    desktop.statusRelease = DispatchSemaphore(value: 0)
    desktop.statusExited = exited
    let session = try RemoteSession(computer: paired, transport: desktop)
    var delivered = false
    session.status { _ in delivered = true }
    check(waitForSignal(entered, seconds: 5), "an ordinary request is active before shutdown")
    session.shutdown()
    check(waitForSignal(exited, seconds: 3), "shutdown closes the active ordinary request")
    checkEqual(desktop.cancelCount, 1, "shutdown cancels the transport once")
    _ = await pump(seconds: 0.1) { delivered }
    check(!delivered, "an abandoned request cannot update the old screen")
} catch {
    checks += 1
    failures.append("session ordinary-request shutdown: threw \(error)")
}

/// A large file that waits until it is cancelled. Ordinary requests must not
/// queue behind it, and invalidating the computer must still deliver a failure
/// so AppModel can remove its private export directory.
final class BlockingDownloadDesktop: RemoteTransport {
    let entered = DispatchSemaphore(value: 0)
    let released = DispatchSemaphore(value: 0)

    func cancel() {}
    func cancelCurrentRequest() {}

    func status() throws -> RemoteStatus {
        RemoteStatus(try JSONBody.object(Data(#"{"protocol":1}"#.utf8)))
    }
    func conversations(offset: Int) throws -> RemoteListPage {
        RemoteListPage(try JSONBody.object(Data("{}".utf8)))
    }
    func conversation(id: String, before: Int64?) throws -> RemoteSnapshot {
        RemoteSnapshot(try JSONBody.object(Data("{}".utf8)))
    }
    func command(_ action: String, conversationId: String?, payload: [String: Any]) throws -> CommandResult {
        CommandResult(try JSONBody.object(Data("{}".utf8)))
    }
    func artifacts(conversationId: String, offset: Int64) throws -> RemoteArtifactPage {
        RemoteArtifactPage(try JSONBody.object(Data("{}".utf8)))
    }
    func apiKeys() throws -> [String: Any] { [:] }
    func markRead(conversationId: String, lastReplyAt: Int64) throws -> JSONObject {
        try JSONBody.object(Data("{}".utf8))
    }
    func artifact(conversationId: String, hash: String, expectedSize: Int64) throws -> Data { Data() }
    func artifact(conversationId: String, hash: String, expectedSize: Int64, to destination: URL,
                  transfer: ArtifactTransfer, progress: @escaping (Int64, Int64) -> Void) throws {
        transfer.setAbort { self.released.signal() }
        defer { transfer.clearAbort() }
        entered.signal()
        _ = released.wait(timeout: .now() + 3)
        try transfer.check()
        try Data("file".utf8).write(to: destination)
        progress(4, 4)
    }
    func stream(_ path: String) throws -> RemoteStreamHandle { FakeStream(subject: path) }
}

do {
    let desktop = BlockingDownloadDesktop()
    let session = try RemoteSession(computer: paired, transport: desktop)
    let destination = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-blocked-download-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: destination) }
    var downloadResult: Result<URL, Error>?
    let transfer = session.downloadArtifact(conversationId: "one", hash: hash64, expectedSize: 4,
                                            to: destination, progress: { _, _ in }) {
        downloadResult = $0
    }
    var started = false
    check(await pump(seconds: 3) {
        if !started { started = desktop.entered.wait(timeout: .now()) == .success }
        return started
    },
          "the artifact transfer starts on its own worker")
    var status: RemoteStatus?
    session.status { if case .success(let answer) = $0 { status = answer } }
    check(await pump(seconds: 2) { status != nil },
          "a slow artifact does not block ordinary remote requests")
    transfer.cancel()
    check(await pump(seconds: 3) { downloadResult != nil },
          "cancelling a download still delivers its completion")
    if case .failure(let error) = downloadResult {
        check(error is ArtifactTransfer.Failure, "a cancelled download is not exported")
    } else {
        check(false, "a cancelled download is not exported")
    }
    check(!FileManager.default.fileExists(atPath: destination.path),
          "a cancelled artifact never leaves an exportable file")
}

do {
    let desktop = BlockingDownloadDesktop()
    let session = try RemoteSession(computer: paired, transport: desktop)
    let destination = FileManager.default.temporaryDirectory
        .appendingPathComponent("camellia-stale-download-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: destination) }
    var downloadResult: Result<URL, Error>?
    _ = session.downloadArtifact(conversationId: "one", hash: hash64, expectedSize: 4,
                                 to: destination, progress: { _, _ in }) {
        downloadResult = $0
    }
    var started = false
    check(await pump(seconds: 3) {
        if !started { started = desktop.entered.wait(timeout: .now()) == .success }
        return started
    },
          "the artifact is in flight before switching computers")
    session.invalidate()
    check(await pump(seconds: 3) { downloadResult != nil },
          "invalidating the computer still delivers artifact cleanup completion")
    if case .failure(let error) = downloadResult {
        check(error is ArtifactTransfer.Failure, "the old computer's file cannot be exported")
    } else {
        check(false, "the old computer's file cannot be exported")
    }
}

let firstConversation = #"{"id":"\#(uuid)","title":"会话一","engine":"claude","pinned":false,"workspaceId":"w1","workspaceName":"研究","updatedAt":1720000000000,"seq":4,"lastReplyAt":0,"replyReadAt":0,"activity":"running"}"#
let secondConversation = #"{"id":"8f14e45f-ceea-467a-9e0f-3d1c8f2b7a44","title":"独立会话","engine":"codex","pinned":false,"workspaceId":null,"workspaceName":null,"updatedAt":1719999999000,"seq":2,"lastReplyAt":0,"replyReadAt":0}"#

do {
    let desktop = FakeDesktop()
    desktop.listPages["0"] = listPage([firstConversation, secondConversation].joined(separator: ","))
    let session = try RemoteSession(computer: paired, transport: desktop)

    var snapshots = 0
    var states: [RemoteStreamState] = []
    session.watch(conversationId: nil, onSnapshot: { _ in snapshots += 1 }, onState: { states.append($0) })

    check(await pump(seconds: 2) { desktop.openedStreams == 1 },
          "subscribing opens the list stream, once")
    checkEqual(desktop.lastStream?.path ?? "", "/v1/conversations/events",
               "and it is the list's stream, not a conversation's")
    check(await pump(seconds: 2) { snapshots == 1 }, "its first snapshot is delivered")
    check(await pump(seconds: 2) { states.contains(where: isConnected) },
          "a stream that delivered a snapshot reads as connected")

    // The regression. With one queue for both, this completion never arrives:
    // the stream is parked on that queue waiting for the desktop, and the fetch
    // waits behind it forever — which is what an empty conversation list with
    // no message actually was.
    var page: ConversationPage?
    session.conversations { if case .success(let value) = $0 { page = value } }
    check(await pump(seconds: 3) { page != nil },
          "a list fetch still answers while the list stream is open")

    checkEqual(desktop.offsetsAsked, [0], "it went out once, at offset 0")
    checkEqual(page?.conversations.count ?? -1, 2, "and carried every conversation the desktop listed")
    checkEqual(page?.conversations.first?.title ?? "", "会话一", "decoded in the desktop's order")
    check(page?.conversations.last != nil, "the last row the desktop listed is there")
    checkEqual(page?.conversations.last?.workspaceId, nil as String?,
               "a conversation with no workspace is decoded as one")
    checkEqual(page?.workspaces.count ?? -1, 1, "the workspace list rides on the same page")
    checkEqual(page?.workspaces.first?.name ?? "", "研究", "with its name")
    checkEqual(page?.includeUnassigned ?? false, true, "and the independent-conversation permission")
    checkEqual(page?.instanceId ?? "", "inst-1", "the instance the commands have to name")
    checkEqual(page?.cursor ?? -1, 91, "the cursor the stream compares against")
    checkEqual(page?.access.canCreate ?? false, true,
               "what this device may do is read off the list page itself, no second call")
    checkEqual(page?.availableEngines.map(\.rawValue) ?? [], ["claude", "codex"],
               "and so is the engine list")
    checkEqual(desktop.statusAsked, 0, "so `/v1/status` is not asked at all")

    // Leaving the screen has to actually take the stream down: it holds a
    // socket, and the old one must not keep answering for the new screen.
    session.invalidate()
    check(desktop.lastStream?.isCancelled ?? false, "invalidating cancels the open stream")
    check(await pump(seconds: 2) { desktop.openedStreams == 1 }, "and opens nothing else")
}

do {
    let desktop = FakeDesktop()
    let wrong = "8f14e45f-ceea-467a-9e0f-3d1c8f2b7a44"
    desktop.streamBody = "event: snapshot\ndata: {\"conversation\":{\"id\":\"\(wrong)\"},\"permission\":\"control\"}\n\n"
        + "event: snapshot\ndata: {\"conversation\":{\"id\":\"\(uuid)\"},\"permission\":\"read\"}\n\n"
    let session = try RemoteSession(computer: paired, transport: desktop)
    var delivered: [String] = []
    session.watch(conversationId: uuid, onSnapshot: {
        delivered.append($0.conversation?.id ?? "")
    }, onState: { _ in })
    check(await pump(seconds: 2) { delivered.count == 1 },
          "a detail stream delivers only snapshots for the opened conversation")
    checkEqual(delivered, [uuid], "a different conversation cannot replace the open detail")
    session.invalidate()

    desktop.snapshotBody = "{\"conversation\":{\"id\":\"\(wrong)\"},\"permission\":\"control\"}"
    var result: Result<RemoteSnapshot, Error>?
    session.snapshot(conversationId: uuid) { result = $0 }
    check(await pump(seconds: 2) { result != nil }, "a mismatched detail fetch completes with an error")
    if case .failure(let error) = result,
       let failure = error as? RemoteSession.SessionError,
       case .invalidSnapshot = failure {
        check(true, "a mismatched detail fetch is rejected")
    } else {
        check(false, "a mismatched detail fetch is rejected")
    }
    desktop.snapshotBody = "{\"conversation\":{\"id\":\"\(uuid)\"},\"permission\":\"control\"}"
    result = nil
    session.snapshot(conversationId: uuid) { result = $0 }
    check(await pump(seconds: 2) { result != nil }, "a matching detail fetch completes")
    if case .success(let snapshot) = result {
        checkEqual(snapshot.conversation?.id, uuid, "a matching detail fetch remains usable")
    } else {
        check(false, "a matching detail fetch remains usable")
    }
}

do {
    // Entry paints one page; "load more" asks for the next. Search drains the
    // tail, including lists longer than the former silent 20-page cap.
    let desktop = FakeDesktop()
    desktop.listPages["0"] = listPage(firstConversation, nextOffset: "100")
    desktop.listPages["100"] = listPage(secondConversation)
    let session = try RemoteSession(computer: paired, transport: desktop)

    var page: ConversationPage?
    session.conversations { if case .success(let value) = $0 { page = value } }
    check(await pump(seconds: 3) { page != nil }, "the first page arrives without waiting for the tail")
    checkEqual(desktop.offsetsAsked, [0], "entry fetches only page one")
    checkEqual(page?.conversations.count ?? -1, 1, "page one has its own rows")
    checkEqual(page?.nextOffset ?? -1, 100, "and exposes the next offset")
    page = nil
    session.conversations(offset: 100) { if case .success(let value) = $0 { page = value } }
    check(await pump(seconds: 3) { page != nil }, "load more fetches the next page")
    checkEqual(desktop.offsetsAsked, [0, 100], "and uses the offered offset")
    checkEqual(page?.conversations.first?.title ?? "", "独立会话", "with the second page's row")
    checkEqual(page?.nextOffset ?? 0, -1, "and knows the list is complete")
}

do {
    let desktop = FakeDesktop()
    for index in 0..<25 {
        desktop.listPages[String(index * 100)] = listPage(firstConversation,
            nextOffset: index == 24 ? "null" : String((index + 1) * 100))
    }
    let session = try RemoteSession(computer: paired, transport: desktop)
    var page: ConversationPage?
    session.conversations(minimumCount: Int.max) {
        if case .success(let value) = $0 { page = value }
    }
    check(await pump(seconds: 3) { page != nil }, "search drains a list beyond twenty pages")
    checkEqual(page?.conversations.count ?? -1, 25, "without silently truncating it")
    checkEqual(page?.nextOffset ?? 0, -1, "and reaches the final offset")
}

do {
    // A desktop that predates the list page advertising its permissions sends
    // neither `protocol` nor `engines`; both come from `/v1/status` instead,
    // which is the fallback Android's `listInfo` makes.
    let desktop = FakeDesktop()
    desktop.listPages["0"] = listPage(firstConversation, protocolVersion: nil, engines: nil)
    let session = try RemoteSession(computer: paired, transport: desktop)

    var page: ConversationPage?
    session.conversations { if case .success(let value) = $0 { page = value } }
    check(await pump(seconds: 3) { page != nil }, "an older list page is still accepted")
    checkEqual(desktop.statusAsked, 1, "and `/v1/status` is asked for what the page left out")
    checkEqual(page?.access.canCreate ?? false, true, "the permission comes from the status answer")
    checkEqual(page?.availableEngines.map(\.rawValue) ?? [], ["claude", "codex"],
               "and so does the engine list")
}

do {
    // A stream the desktop refuses with 404 means "this build is too old for
    // live events", which is a fallback to polling rather than a failure — and
    // the status has to be read off the error, not off a concrete `RemoteApi`.
    let desktop = FakeDesktop()
    desktop.streamFailure = RefusedHTTP(status: 404)
    let session = try RemoteSession(computer: paired, transport: desktop)

    var states: [RemoteStreamState] = []
    session.watch(conversationId: nil, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 3) { states.contains { if case .unsupported = $0 { return true }; return false } },
          "a 404 on the stream reads as unsupported, not as a failure")
    check(!states.contains { if case .failed = $0 { return true }; return false },
          "and it does not stop the screen")
}

do {
    // Android only falls back when the *list* event endpoint is missing at
    // open. A 404 after its first snapshot means an established stream failed.
    let desktop = FakeDesktop()
    desktop.streamFailureAfterChunk = RefusedHTTP(status: 404)
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watch(conversationId: nil, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains { if case .failed = $0 { return true }; return false } },
          "a list stream returning 404 after a snapshot is terminal")
    check(!states.contains { if case .unsupported = $0 { return true }; return false },
          "an established list stream does not enter legacy polling on 404")
    checkEqual(desktop.openedStreams, 1, "the established list stream is not retried")
    session.invalidate()
}

do {
    // Detail events have no legacy polling path: even an immediate 404 means
    // this conversation is gone or no longer visible to the paired device.
    let desktop = FakeDesktop()
    desktop.streamFailure = RefusedHTTP(status: 404)
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains { if case .failed = $0 { return true }; return false } },
          "a detail stream returning 404 is terminal")
    check(!states.contains { if case .unsupported = $0 { return true }; return false },
          "detail 404 is not mistaken for unsupported list events")
    session.invalidate()
}

do {
    // A 409 is stale command state, but not a terminal *event-stream* error.
    // Android retries every stream status except 401, 403 and 404.
    let desktop = FakeDesktop()
    desktop.failNextStream(RefusedHTTP(status: 409))
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains {
        if case .reconnecting(let delay, _) = $0 { return delay == 2 }
        return false
    } }, "a 409 event stream retries after the normal initial delay")
    check(!states.contains { if case .failed = $0 { return true }; return false },
          "a 409 event stream does not fail permanently")
    session.invalidate()
}

for status in [401, 403] {
    let desktop = FakeDesktop()
    desktop.streamFailure = RefusedHTTP(status: status)
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains { if case .failed = $0 { return true }; return false } },
          "a \(status) detail stream stops instead of retrying")
    check(!states.contains { if case .reconnecting = $0 { return true }; return false },
          "a \(status) detail stream has no retry state")
    session.invalidate()
}

do {
    let desktop = FakeDesktop()
    desktop.streamFailure = RefusedHTTP(status: 400)
    let session = try RemoteSession(computer: paired, transport: desktop)
    var states: [RemoteStreamState] = []
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { states.append($0) })
    check(await pump(seconds: 2) { states.contains {
        if case .reconnecting(let delay, _) = $0 { return delay == 2 }
        return false
    } }, "a nonfatal 400 stream response follows Android's retry rule")
    check(!states.contains { if case .failed = $0 { return true }; return false },
          "a 400 stream response is not stopped by command policy")
    session.invalidate()
}

do {
    // A 429 asks the current stream to wait 60 s. Switching screens during
    // that wait must not leave the next screen stuck behind the old queue item.
    let desktop = FakeDesktop()
    desktop.failNextStream(RefusedHTTP(status: 429))
    let session = try RemoteSession(computer: paired, transport: desktop)
    var retrying = false
    session.watch(conversationId: nil, onSnapshot: { _ in }, onState: {
        if case .reconnecting(let delay, _) = $0 { retrying = delay == 60 }
    })
    check(await pump(seconds: 2) { retrying }, "a rate-limited stream enters the 60-second backoff")
    session.watch(conversationId: uuid, onSnapshot: { _ in }, onState: { _ in })
    check(await pump(seconds: 2) { desktop.openedStreams == 1 },
          "changing screens interrupts the old backoff and opens the new stream")
    checkEqual(desktop.lastStream?.path, "/v1/conversations/\(uuid)/events",
               "the stream opened after interruption belongs to the new detail")
    session.invalidate()
}

do {
    // A gateway or proxy that writes a snapshot and closes must not cause an
    // unbounded reconnect loop. Android waits at least one second even after
    // a stream that delivered data.
    let desktop = FakeDesktop()
    desktop.streamClosesAfterChunk = true
    let session = try RemoteSession(computer: paired, transport: desktop)
    var retryDelay: TimeInterval?
    session.watch(conversationId: nil, onSnapshot: { _ in }, onState: {
        if case .reconnecting(let delay, _) = $0 { retryDelay = delay }
    })
    check(await pump(seconds: 2) { retryDelay != nil },
          "a stream closed after a snapshot enters paced reconnect")
    checkEqual(retryDelay, 1, "a successful short stream still waits one second")
    checkEqual(desktop.openedStreams, 1, "the short stream is not reopened in a tight loop")
    check(await pump(seconds: 2) { desktop.openedStreams >= 2 },
          "the short stream retries after its paced delay")
    session.invalidate()
}

// MARK: - Model labels
//
// The composer's tool row has one line for "which model, at what effort", and
// the desktop's ids do not fit in it. These are the same expectations Android
// asserts in `ModelLabelTest`; the two must agree or the same conversation shows
// a different name on each phone.

do {
    checkEqual(ModelLabel.compact("kimi k3"), "K3", "a spaced Kimi id shortens")
    checkEqual(ModelLabel.compact("kimi-k3"), "K3", "a hyphenated Kimi id shortens")
    checkEqual(ModelLabel.compact("kimi-k2.5"), "K2.5", "and keeps its version")
    checkEqual(ModelLabel.compact("gpt-6-astra"), "Astra", "a GPT codename is its own label")
    checkEqual(ModelLabel.compact("gpt-5.6-sol"), "Sol", "and so is each Sol/Terra/Luna variant")
    checkEqual(ModelLabel.compact("deepseek-v4-pro"), "V4 Pro", "a DeepSeek tier is kept")
    checkEqual(ModelLabel.compact("deepseek-r1"), "R1", "and the reasoner family is too")
    checkEqual(ModelLabel.compact("mimo-v2.6-pro"), "MiMo 2.6 Pro", "MiMo keeps its brand")
    checkEqual(ModelLabel.compact("mimo-v2.6-flash"), "MiMo 2.6 Flash", "and its tiers")

    checkEqual(ModelLabel.compact("gpt-7-sol"), "gpt-7-sol",
               "an unknown GPT is left alone rather than guessed at")
    checkEqual(ModelLabel.compact("deepseek-r1-distill-qwen-32b"), "deepseek-r1-distill-qwen-32b",
               "and so is a distillation the two must not confuse for R1")
    checkEqual(ModelLabel.compact("My custom model"), "My custom model",
               "a custom name survives untouched")
    checkEqual(ModelLabel.compact("deepseek-chat"), "DS Chat", "the chat alias has its own short form")
    checkEqual(ModelLabel.compact("deepseek-reasoner"), "DS Reasoner",
               "and so does the reasoner alias")
    checkEqual(ModelLabel.compact(""), "", "an empty name stays empty")

    checkEqual(ModelLabel.compact("kimi-k3:cloud"), "K3", "a registry tag does not hide the family")
    checkEqual(ModelLabel.compact("kimi-k2.5:latest"), "K2.5", "and neither does a version tag")
    checkEqual(ModelLabel.compact("gpt-5.6-sol:free"), "Sol", "nor on a codename")
    checkEqual(ModelLabel.compact("deepseek-r1:7b"), "R1", "nor on a reasoner")
    checkEqual(ModelLabel.compact("mimo-v2.6-pro:cloud"), "MiMo 2.6 Pro", "nor on a MiMo")
}

// MARK: - Independent encrypted local records and drafts

final class LocalPersistenceGate: SecretKeyStore {
    let base: SecretKeyStore
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var armed = false
    init(_ base: SecretKeyStore) { self.base = base }
    func arm() { lock.lock(); armed = true; lock.unlock() }
    func key() throws -> SymmetricKey {
        lock.lock(); let wait = armed; armed = false; lock.unlock()
        if wait { entered.signal(); _ = release.wait(timeout: .now() + 3) }
        return try base.key()
    }
}

do {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("camellia-split-store-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let keys = LocalPersistenceGate(FileSecretKeyStore(url: root.appendingPathComponent("key")))
    let id = "legacy-chat"
    let original: [String: Any] = ["config": ["future": "preserved", "padding": String(repeating: "c", count: 150_000)], "workspaces": [],
        "conversations": [["id": id, "order": 7, "futureField": ["flag": true],
            "messages": [["role": "user", "content": String(repeating: "history", count: 100_000)]],
            "draft": "before"]]]
    let payload = try JSONSerialization.data(withJSONObject: original)
    let sealed = try CredentialSeal.seal(payload, using: keys.key(), context: LocalChatStore.context)
    var blob = sealed.nonce; blob.append(sealed.ciphertext); blob.append(sealed.tag)
    let stateURL = root.appendingPathComponent("state")
    try blob.write(to: stateURL)
    let store = try LocalChatStore(directory: root, keys: keys)
    try store.updateDraft(id, revision: 1) { $0["draft"] = "migrated" }
    let reopened = try LocalChatStore(directory: root, keys: keys)
    checkEqual(reopened.conversation(id)?["draft"] as? String, "migrated", "legacy draft is migrated and reopens")
    checkEqual(reopened.conversation(id)?["order"] as? Int, 7, "migration preserves legacy ordering")
    checkEqual((reopened.conversation(id)?["futureField"] as? [String: Any])?["flag"] as? Bool, true,
               "migration preserves unknown conversation fields")
    checkEqual(reopened.config()["future"] as? String, "preserved", "migration preserves unknown configuration fields")
    let recordsURL = root.appendingPathComponent("records")
    let bodies = try FileManager.default.contentsOfDirectory(at: recordsURL, includingPropertiesForKeys: nil)
        .filter { $0.pathExtension == "conversation" }
    checkEqual(bodies.count, 1, "one history record is created")
    let bodyBefore = try Data(contentsOf: bodies[0])
    try store.updateDraft(id, revision: 2) { $0["draft"] = "small edit" }
    checkEqual(try Data(contentsOf: bodies[0]), bodyBefore, "a draft checkpoint leaves encrypted history untouched")
    check(store.lastWriteBytes < 16_384, "a small draft writes less than 16 KiB beside 700 KiB of history and 150 KiB of config")
    checkEqual(try store.updateDraft(id, revision: 1) { $0["draft"] = "stale" }, false,
               "a stale asynchronous draft completion is rejected")
    checkEqual(store.conversation(id)?["draft"] as? String, "small edit", "the latest draft survives a stale completion")

    let savedManifest = try Data(contentsOf: stateURL)
    let filesBefore = Set(try FileManager.default.contentsOfDirectory(atPath: recordsURL.path))
    try FileManager.default.removeItem(at: stateURL)
    try FileManager.default.createDirectory(at: stateURL, withIntermediateDirectories: true)
    var failed = false
    do { try store.updateDraft(id, revision: 3) { $0["draft"] = "must roll back" } }
    catch { failed = true }
    check(failed, "a failed manifest commit reports failure")
    checkEqual(store.conversation(id)?["draft"] as? String, "small edit", "a failed commit leaves the cached draft intact")
    checkEqual(Set(try FileManager.default.contentsOfDirectory(atPath: recordsURL.path)), filesBefore,
               "a failed commit discards only its uncommitted record versions")
    try FileManager.default.removeItem(at: stateURL)
    try savedManifest.write(to: stateURL)
    checkEqual(try LocalChatStore(directory: root, keys: keys).conversation(id)?["draft"] as? String,
               "small edit", "the last committed version still reopens after failure")

    keys.arm()
    let finished = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            try await store.perform { writer in
                check(!Thread.isMainThread, "persistence runs off the main thread")
                try writer.updateDraft(id, revision: 4) { $0["draft"] = "background" }
            }
        } catch { check(false, "background store mutation succeeds") }
        finished.signal()
    }
    check(waitForSignal(keys.entered, seconds: 3), "the writer can be held inside encryption")
    let readStarted = Date()
    checkEqual(store.conversation(id)?["draft"] as? String, "small edit", "readers see the committed cache during I/O")
    check(Date().timeIntervalSince(readStarted) < 0.1, "a slow disk/key operation does not block cached reads")
    keys.release.signal()
    check(waitForSignal(finished, seconds: 3), "the background commit completes")
    checkEqual(store.conversation(id)?["draft"] as? String, "background", "background writes publish after commit")

    for (revision, runID) in [(5, "cancelled-prepare"), (7, "cancelled-prepare-with-new-draft")] {
        try store.updateDraft(id, revision: revision) { entry in
            var rows = entry["messages"] as! [[String: Any]]
            rows.append(["role": "user", "content": "unsent"])
            rows.append(["role": "assistant", "content": "", "state": "running", "runId": runID])
            entry["messages"] = rows
            LocalChatDraft.clear(&entry)
        }
        if revision == 7 { try store.updateDraft(id, revision: 8) { $0["draft"] = "newer input" } }
        try store.rollbackPreparedSend(id, runID: runID, consumedRevision: revision,
                                       restoredRevision: revision + 1) { $0["draft"] = "restored input" }
        checkEqual((store.conversation(id)?["messages"] as? [Any])?.count, 1,
                   "cancellation during durable preparation removes only the unsent turn")
        checkEqual(store.conversation(id)?["draft"] as? String, revision == 5 ? "restored input" : "newer input",
                   "cancelled preparation restores input and respects a newer saved draft")
    }
    let originalMessages: [[String: Any]] = [["role": "user", "content": "original question"],
                                           ["role": "assistant", "content": "original answer"]]
    try store.update(id) { $0["messages"] = originalMessages }
    try store.updateDraft(id, revision: 9) { entry in
        entry["messages"] = [["role": "user", "content": "edited question"],
                             ["role": "assistant", "content": "", "state": "running", "runId": "cancelled-edit"]]
        LocalChatDraft.clear(&entry)
    }
    try store.updateDraft(id, revision: 10) { $0["draft"] = "newer draft after editing" }
    try store.rollbackPreparedSend(id, runID: "cancelled-edit", consumedRevision: 9,
                                   restoredRevision: 11, previousMessages: originalMessages) { $0["draft"] = "edited question" }
    let restored = store.conversation(id)?["messages"] as? [[String: Any]] ?? []
    check((restored as NSArray).isEqual(to: originalMessages),
          "cancelling a prepared edit restores the replaced question and answer")
    checkEqual(store.conversation(id)?["draft"] as? String, "newer draft after editing",
               "restoring replaced history does not overwrite a newer draft")
}

// MARK: - Local request memory budget

final class BudgetResolver: LocalChatAttachmentSizing {
    var encodedBytes: Int64 = 4
    var textBytes: Int64 = 4
    var opens = 0
    func base64ByteCount(_ value: String) throws -> Int64 { encodedBytes }
    func textByteCount(_ value: String) throws -> Int64 { textBytes }
    func wireBase64(_ value: String) throws -> String { opens += 1; return "AAAA" }
    func wireText(_ value: String) throws -> String { opens += 1; return "text" }
}

do {
    let resolver = BudgetResolver()
    resolver.encodedBytes = Int64(LocalChatRequestBudget.maximumBytes)
    let oversized = try LocalChatInputMessage.history([["role": "user", "content": "read", "images": ["blob"]]])
    checkThrows(LocalChatRequestError.requestTooLarge, "a large current attachment is refused before it is opened") {
        _ = try LocalChatRequestBudget.prepare(route: openAIRoute, history: oversized, thinking: "auto", using: resolver)
    }
    checkEqual(resolver.opens, 0, "request preflight never decrypts an over-budget attachment")

    let history = try LocalChatInputMessage.history([
        ["role": "user", "content": String(repeating: "old", count: 2000)],
        ["role": "assistant", "content": "old answer"],
        ["role": "user", "content": "recent"],
        ["role": "assistant", "content": "recent answer"],
        ["role": "user", "content": "current"],
    ])
    let prepared = try LocalChatRequestBudget.prepare(route: openAIRoute, history: history,
        thinking: "auto", using: resolver, maximumBytes: 4096)
    let body = try JSONSerialization.jsonObject(with: prepared.payload) as! [String: Any]
    let selected = body["messages"] as! [[String: Any]]
    checkEqual(selected.map { $0["content"] as! String }, ["recent", "recent answer", "current"],
               "budget trimming keeps complete recent turns and the current input")
    checkEqual(prepared.includedHistoryTurns, 1, "the UI is told how many previous turns were sent")
    checkEqual(prepared.omittedHistoryTurns, 1, "the UI is told that earlier history was omitted")
    check(prepared.payload.count <= 4096, "the final serialized request stays within the wire budget")

    resolver.encodedBytes = 4
    for route in [openAIRoute, anthropicRoute] {
        let pdf = try LocalChatInputMessage.history([["role": "user", "content": "read",
            "documents": [["name": "paper.pdf", "mimeType": "application/pdf", "data": "blob"]]]])
        let request = try LocalChatRequestBudget.prepare(route: route, history: pdf, thinking: "auto", using: resolver)
        let value = try JSONSerialization.jsonObject(with: request.payload) as! [String: Any]
        let messages = value["messages"] as! [[String: Any]]
        let parts = messages[0]["content"] as! [[String: Any]]
        checkEqual(parts[1]["type"] as? String, route.isAnthropic ? "document" : "file",
                   "budgeted PDF retains the provider-specific wire shape")
    }
    let escaped = try LocalChatInputMessage.history([["role": "user", "content": String(repeating: "\u{0001}", count: 1000)]])
    checkThrows(LocalChatRequestError.requestTooLarge, "JSON escaping is included in the request budget") {
        _ = try LocalChatRequestBudget.prepare(route: openAIRoute, history: escaped,
            thinking: "auto", using: resolver, maximumBytes: 4096)
    }
}

// MARK: - Connection notes
//
// The chat pages' one place a stream's state reaches the header. The mapping is
// checked here rather than in the view layer because two of its five cases are
// "say nothing", and a case that is dropped by accident is invisible until
// someone stares at a healthy connection wondering why it is labelled.

do {
    checkEqual(RemoteConnectionNote.text(for: .idle), "",
               "an idle stream has nothing to say")
    checkEqual(RemoteConnectionNote.text(for: .connected), "",
               "and neither does a healthy one")
    checkEqual(RemoteConnectionNote.text(for: .unsupported), "定时刷新",
               "a desktop too old to stream says it fell back")
    checkEqual(RemoteConnectionNote.text(for: .failed(nil)), "已断开",
               "a closed stream says so")

    // The reconnecting case carries the backoff delay, and Android counts the
    // retry down rather than only naming it. A pattern that dropped the
    // associated value (`case .reconnecting:`) still compiles, which is exactly
    // how the count goes missing without anything failing to build.
    checkEqual(RemoteConnectionNote.text(for: .reconnecting(3, nil)), "正在重连（3 秒）",
               "a reconnect counts down the wait it is about to impose")
    checkEqual(RemoteConnectionNote.text(for: .reconnecting(1.6, nil)), "正在重连（1 秒）",
               "and a fractional backoff is counted in whole seconds")
    checkEqual(RemoteConnectionNote.text(for: .reconnecting(30, NSError(domain: "t", code: 1))),
               "正在重连（30 秒）",
               "the failure it is recovering from does not change the label")
    checkEqual(RemoteConnectionNote.text(for: .reconnecting(3, nil), chinese: false),
               "Reconnecting (3 s)", "the English header keeps the retry delay")
    checkEqual(RemoteConnectionNote.text(for: .unsupported, chinese: false),
               "Periodic refresh", "the English header names the polling fallback")
}

// MARK: - Detail snapshot coalescing and ordered transitions

func coalescedFrame(_ cursor: Int64, _ changes: [String: Any] = [:]) -> RemoteSnapshot {
    RemoteSnapshot(JSONObject(dictionary: coalescedJSON(cursor, changes)))
}
func coalescedJSON(_ cursor: Int64, _ changes: [String: Any] = [:]) -> [String: Any] {
    var value: [String: Any] = ["conversation": ["id": uuid, "seq": 1], "instanceId": "coalescing", "cursor": cursor,
        "permission": "control", "messages": [["seq": 1, "role": "user", "text": "question"]],
        "live": ["runId": 1, "text": "delta \(cursor)", "userSeq": 1, "startedAt": 1],
        "queue": [], "queueVersion": 3, "nextBefore": NSNull()]
    for (key, change) in changes { value[key] = change }
    return value
}
do {
    let original = coalescedFrame(1)
    check(!SnapshotCoalescer.replaceable(original, after: nil), "the first snapshot is immediate")
    check(SnapshotCoalescer.replaceable(coalescedFrame(2), after: original), "text deltas and cursor progress can coalesce")
    let critical: [[String: Any]] = [
        ["live": NSNull()], ["permission": "read"], ["messages": NSNull()], ["instanceId": "restarted"],
        ["queueVersion": 2], ["queueVersion": 4], ["settings": ["version": "new", "editable": false]],
        ["automation": ["goal": ["id": "goal", "phase": "active", "armed": true]]],
        ["messages": [["seq": 2, "role": "user", "text": "edited"]]],
        ["live": ["runId": 2, "text": "new run", "userSeq": 1, "startedAt": 1]],
        ["live": ["runId": 1, "text": "approval", "userSeq": 1, "startedAt": 1, "pendingApprovals": 1]],
        ["conversation": ["id": uuid, "seq": 1, "title": "renamed"]], ["nextBefore": 1],
    ]
    for change in critical {
        check(!SnapshotCoalescer.replaceable(coalescedFrame(2, change), after: original), "a critical detail transition cannot replace an earlier snapshot")
    }
    check(!SnapshotCoalescer.replaceable(coalescedFrame(0), after: original), "a cursor regression preserves the previous high-water frame")
    let thought = coalescedFrame(1, ["live": ["runId": 1, "process": [["type": "thinking", "title": "reason", "status": "running", "text": "a"]]]])
    let more = coalescedFrame(2, ["live": ["runId": 1, "process": [["type": "thinking", "title": "reason", "status": "running", "text": "ab"]]]])
    let done = coalescedFrame(3, ["live": ["runId": 1, "process": [["type": "thinking", "title": "reason", "status": "done", "text": "ab"]]]])
    check(SnapshotCoalescer.replaceable(more, after: thought), "reasoning text may coalesce")
    check(!SnapshotCoalescer.replaceable(done, after: more), "a process step's terminal state is immediate")
}
do {
    var frames: [Int64] = []
    let transcript = RemoteTranscript()
    let coalescer = SnapshotCoalescer(interval: 1) { snapshot in frames.append(snapshot.cursor); transcript.apply(snapshot) }
    let worker = Task.detached {
        coalescer.offer(coalescedFrame(1))
        for cursor in 2...501 { coalescer.offer(coalescedFrame(Int64(cursor))) }
        return coalescer.offer(coalescedFrame(502, ["live": NSNull(), "messages": [["seq": 2, "role": "assistant", "text": "finished"]]]))
    }
    check(await pump(seconds: 3) { frames.last == 502 }, "a burst's final snapshot flushes without waiting for the ordinary interval")
    check(await worker.value, "the producer observes the final UI acknowledgement")
    check(frames.count <= 4 && frames.first == 1 && frames.contains(501), "five hundred ordinary snapshots create only a bounded UI backlog")
    checkEqual(transcript.messages.last?.message.text, "finished", "the transcript receives the completed history")
    coalescer.cancel()
}
do {
    let transcript = RemoteTranscript()
    var observedPartial = false
    let coalescer = SnapshotCoalescer(interval: 1) { snapshot in
        transcript.apply(snapshot)
        if snapshot.cursor == 3 {
            observedPartial = transcript.permission == .read && transcript.live?.text == "delta 2" && transcript.messages.count == 1
        }
    }
    let worker = Task.detached {
        coalescer.offer(coalescedFrame(1))
        coalescer.offer(coalescedFrame(2))
        coalescer.offer(coalescedFrame(3, ["messages": NSNull(), "live": NSNull(), "permission": "read"]))
        return coalescer.offer(coalescedFrame(4, ["live": NSNull(), "permission": "read"]))
    }
    check(await pump(seconds: 3) { transcript.cursor == 4 }, "partial and final frames are delivered in order")
    check(await worker.value && observedPartial, "an incomplete permission frame retains the preceding pending live text and history")
    coalescer.cancel()
}
do {
    let transcript = RemoteTranscript()
    let coalescer = SnapshotCoalescer(interval: 1) { transcript.apply($0) }
    func goal(_ phase: String) -> [String: Any] { ["automation": ["goal": ["id": "legacy", "phase": phase, "armed": true]]] }
    let worker = Task.detached {
        coalescer.offer(coalescedFrame(1, goal("complete")))
        coalescer.offer(coalescedFrame(2, goal("active")))
        return coalescer.offer(coalescedFrame(3, goal("complete")))
    }
    check(await pump(seconds: 3) { transcript.cursor == 3 }, "an older undated goal's transitions reach the transcript")
    check(await worker.value && transcript.showsGoal, "coalescing cannot hide the active-to-complete goal transition")
    coalescer.cancel()
}
do {
    var frames: [Int64] = []
    let coalescer = SnapshotCoalescer(interval: 0.2) { frames.append($0.cursor) }
    let worker = Task.detached { coalescer.offer(coalescedFrame(1)); return coalescer.offer(coalescedFrame(2)) }
    check(await pump(seconds: 2) { frames == [1] }, "the first frame arrives before a delayed ordinary frame")
    _ = await worker.value
    coalescer.cancel()
    try await Task.sleep(nanoseconds: 300_000_000)
    checkEqual(frames, [1], "invalidation cancels the pending timer and snapshot")
}
do {
    let desktop = FakeDesktop()
    desktop.streamBody = try (1...101).map { cursor in
        let value = coalescedJSON(Int64(cursor), cursor == 101 ? ["live": NSNull()] : [:])
        let json = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        return "event: snapshot\ndata: \(json)\n\n"
    }.joined()
    desktop.streamFailureAfterChunk = RefusedHTTP(status: 403)
    let session = try RemoteSession(computer: paired, transport: desktop)
    var events: [String] = []
    session.watch(conversationId: uuid, onSnapshot: { events.append("snapshot:\($0.cursor)") }, onState: {
        if case .connected = $0 { events.append("connected") }
        if case .failed = $0 { events.append("failed") }
    })
    check(await pump(seconds: 3) { events.last == "failed" }, "a real detail session flushes its snapshots before reporting a fatal stream failure")
    let snapshots = events.filter { $0.hasPrefix("snapshot:") }
    check(snapshots.count <= 4 && snapshots.first == "snapshot:1" && snapshots.last == "snapshot:101",
          "RemoteSession coalesces on its stream worker before the main queue")
    check(events.first == "snapshot:1" && events.contains("connected"), "connection usability follows the first applied snapshot")
    session.invalidate()
    let delivered = events.count
    try await Task.sleep(nanoseconds: 200_000_000)
    checkEqual(events.count, delivered, "invalidated detail sessions produce no late snapshot or state callbacks")
}

// MARK: - Report
if failures.isEmpty {
    print("PASS: all \(checks) protocol checks passed")
} else {
    print("FAIL: \(failures.count) of \(checks) check(s) failed")
    for failure in failures { print("  - \(failure)") }
    exit(1)
}
