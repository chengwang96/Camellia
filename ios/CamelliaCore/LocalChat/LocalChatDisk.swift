import CryptoKit
import Foundation

/// Immutable record versions are committed by replacing one encrypted manifest.
/// A draft checkpoint writes its small draft and the manifest, not message history.
final class LocalChatDisk {
    private struct Record {
        let body: [String: Any]
        let draft: [String: Any]
        let bodyFile: String
        let draftFile: String
        let bodyBytes: Int
        let draftBytes: Int
        let bodyReferences: Set<String>
        let draftReferences: Set<String>
        var references: Set<String> { bodyReferences.union(draftReferences) }
    }

    private struct Metadata {
        let value: [String: Any]
        let file: String
        let bytes: Int
        let references: Set<String>
    }
    private var metadataRecord: Metadata?

    private static let draftKeys: Set<String> = ["draft", "draftEditIndex", "draftImages", "draftDocuments"]
    private let directory: URL
    private let recordsURL: URL
    private let stateURL: URL
    private let keys: SecretKeyStore
    private var records: [String: Record] = [:]
    private var legacy = false

    init(directory: URL, keys: SecretKeyStore) {
        self.directory = directory
        recordsURL = directory.appendingPathComponent("records", isDirectory: true)
        stateURL = directory.appendingPathComponent("state")
        self.keys = keys
    }

    func load() throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return [:] }
        let data = try Data(contentsOf: stateURL)
        if data.isEmpty { return [:] }
        let value = try open(data, context: LocalChatStore.context)
        guard let version = value["storageVersion"] as? Int else { legacy = true; return value }
        guard version == 2 else { throw LocalChatStoreError.storageUnavailable }
        let loaded = try readManifest(value)
        records = loaded.records
        metadataRecord = loaded.metadata
        // Crash leftovers may be removed only when the committed store is readable.
        // Preserved damaged stores can still refer to older record versions.
        let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
        if let names, !names.contains(where: { $0.hasPrefix("state.corrupt-") }) {
            let retained = Set(records.values.flatMap { [$0.bodyFile, $0.draftFile] } + [loaded.metadata.file])
            for file in (try? FileManager.default.contentsOfDirectory(at: recordsURL, includingPropertiesForKeys: nil)) ?? []
                where validFile(file.lastPathComponent) && !retained.contains(file.lastPathComponent) {
                try? FileManager.default.removeItem(at: file)
            }
        }
        return loaded.state
    }

    func commit(_ state: [String: Any], changed: Set<String>? = nil) throws -> (references: Set<String>, bytes: Int) {
        var metadata = state
        metadata.removeValue(forKey: "conversations")
        let conversations = state["conversations"] as? [[String: Any]] ?? []
        var next: [String: Record] = [:]
        var entries: [[String: Any]] = []
        var created: [URL] = []
        var total = 32
        var written = 0
        var retained = Set<String>()
        do {
            let nextMetadata: Metadata
            if let old = metadataRecord, !old.file.isEmpty,
               changed?.isEmpty == false || (old.value as NSDictionary).isEqual(to: metadata) {
                nextMetadata = old
            } else {
                let payload = try encode(metadata)
                guard payload.count <= LocalChatStore.maximumBytes else { throw LocalChatStoreError.storageFull }
                let name = UUID().uuidString.lowercased() + ".metadata"
                let target = recordsURL.appendingPathComponent(name)
                created.append(target)
                try seal(payload, to: target, context: "camellia.localchat.v2.metadata")
                nextMetadata = Metadata(value: metadata, file: name, bytes: payload.count,
                                        references: AttachmentStore.references(in: metadata))
                written += payload.count + 28
            }
            total += nextMetadata.bytes
            retained.formUnion(nextMetadata.references)
            for conversation in conversations {
                guard let id = conversation["id"] as? String, next[id] == nil else {
                    throw LocalChatStoreError.corruptState
                }
                let record: Record
                if let old = records[id], let changed, !changed.contains(id) {
                    record = old
                } else {
                    let body = conversation.filter { !Self.draftKeys.contains($0.key) }
                    let draft = conversation.filter { Self.draftKeys.contains($0.key) }
                    let old = records[id]
                    let bodyUnchanged = old.map { ($0.body as NSDictionary).isEqual(to: body) } ?? false
                    let draftUnchanged = old.map { ($0.draft as NSDictionary).isEqual(to: draft) } ?? false
                    var bodyFile = old?.bodyFile ?? ""
                    var draftFile = old?.draftFile ?? ""
                    var bodyBytes = old?.bodyBytes ?? 0
                    var draftBytes = old?.draftBytes ?? 0
                    if !bodyUnchanged {
                        let payload = try encode(body)
                        guard total + payload.count <= LocalChatStore.maximumBytes else { throw LocalChatStoreError.storageFull }
                        bodyFile = UUID().uuidString.lowercased() + ".conversation"
                        let target = recordsURL.appendingPathComponent(bodyFile)
                        created.append(target)
                        try seal(payload, to: target, context: "camellia.localchat.v2.conversation")
                        bodyBytes = payload.count
                        written += payload.count + 28
                    }
                    if !draftUnchanged {
                        let payload = try encode(draft)
                        guard total + bodyBytes + payload.count <= LocalChatStore.maximumBytes else { throw LocalChatStoreError.storageFull }
                        draftFile = UUID().uuidString.lowercased() + ".draft"
                        let target = recordsURL.appendingPathComponent(draftFile)
                        created.append(target)
                        try seal(payload, to: target, context: "camellia.localchat.v2.draft")
                        draftBytes = payload.count
                        written += payload.count + 28
                    }
                    record = Record(body: body, draft: draft, bodyFile: bodyFile, draftFile: draftFile,
                                    bodyBytes: bodyBytes, draftBytes: draftBytes,
                                    bodyReferences: bodyUnchanged ? old!.bodyReferences : AttachmentStore.references(in: body),
                                    draftReferences: draftUnchanged ? old!.draftReferences : AttachmentStore.references(in: draft))
                }
                total += record.bodyBytes + record.draftBytes + 1
                guard total <= LocalChatStore.maximumBytes else { throw LocalChatStoreError.storageFull }
                next[id] = record
                retained.formUnion(record.references)
                entries.append(["id": id, "body": record.bodyFile, "draft": record.draftFile,
                                "bodyBytes": record.bodyBytes, "draftBytes": record.draftBytes])
            }
            let manifest: [String: Any] = ["storageVersion": 2, "metadata": nextMetadata.file, "records": entries]
            let payload = try encode(manifest)
            guard payload.count <= LocalChatStore.maximumBytes else { throw LocalChatStoreError.storageFull }
            if legacy {
                let verified = try readManifest(manifest).state
                guard (verified as NSDictionary).isEqual(to: state) else { throw LocalChatStoreError.corruptState }
            }
            try seal(payload, to: stateURL, context: LocalChatStore.context)
            written += payload.count + 28
            let oldFiles = Set(records.values.flatMap { [$0.bodyFile, $0.draftFile] } + [metadataRecord?.file ?? ""])
            let nextFiles = Set(next.values.flatMap { [$0.bodyFile, $0.draftFile] } + [nextMetadata.file])
            records = next
            metadataRecord = nextMetadata
            legacy = false
            for name in oldFiles.subtracting(nextFiles) where !name.isEmpty {
                try? FileManager.default.removeItem(at: recordsURL.appendingPathComponent(name))
            }
            return (retained, written)
        } catch {
            for target in created { try? FileManager.default.removeItem(at: target) }
            throw error
        }
    }

    private func readManifest(_ value: [String: Any]) throws -> (state: [String: Any], records: [String: Record], metadata: Metadata) {
        let metadata: Metadata
        if let name = value["metadata"] as? String, validFile(name) {
            let data = try open(Data(contentsOf: recordsURL.appendingPathComponent(name)), context: "camellia.localchat.v2.metadata")
            metadata = Metadata(value: data, file: name, bytes: try encode(data).count,
                                references: AttachmentStore.references(in: data))
        } else if let data = value["metadata"] as? [String: Any] {
            metadata = Metadata(value: data, file: "", bytes: try encode(data).count,
                                references: AttachmentStore.references(in: data))
        } else { throw LocalChatStoreError.corruptState }
        guard let entries = value["records"] as? [[String: Any]] else { throw LocalChatStoreError.corruptState }
        var state = metadata.value
        var loaded: [String: Record] = [:]
        var conversations: [[String: Any]] = []
        for entry in entries {
            guard let id = entry["id"] as? String, loaded[id] == nil,
                  let bodyFile = entry["body"] as? String, validFile(bodyFile),
                  let draftFile = entry["draft"] as? String, validFile(draftFile) else {
                throw LocalChatStoreError.corruptState
            }
            let body = try open(Data(contentsOf: recordsURL.appendingPathComponent(bodyFile)), context: "camellia.localchat.v2.conversation")
            let draft = try open(Data(contentsOf: recordsURL.appendingPathComponent(draftFile)), context: "camellia.localchat.v2.draft")
            guard body["id"] as? String == id, draft.keys.allSatisfy(Self.draftKeys.contains) else {
                throw LocalChatStoreError.corruptState
            }
            var conversation = body
            for (key, value) in draft { conversation[key] = value }
            conversations.append(conversation)
            loaded[id] = Record(body: body, draft: draft, bodyFile: bodyFile, draftFile: draftFile,
                                bodyBytes: try encode(body).count, draftBytes: try encode(draft).count,
                                bodyReferences: AttachmentStore.references(in: body),
                                draftReferences: AttachmentStore.references(in: draft))
        }
        state["conversations"] = conversations
        guard try encode(state).count <= LocalChatStore.maximumBytes else { throw LocalChatStoreError.corruptState }
        return (state, loaded, metadata)
    }

    private func validFile(_ name: String) -> Bool {
        let url = URL(fileURLWithPath: name)
        return ["conversation", "draft", "metadata"].contains(url.pathExtension)
            && name == url.lastPathComponent && UUID(uuidString: url.deletingPathExtension().lastPathComponent) != nil
    }

    private func encode(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    }

    private func seal(_ payload: Data, to target: URL, context: String) throws {
        let sealed = try CredentialSeal.seal(payload, using: keys.key(), context: context)
        var blob = sealed.nonce
        blob.append(sealed.ciphertext)
        blob.append(sealed.tag)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try blob.write(to: target, options: .atomic)
        try? (target as NSURL).setResourceValue(URLFileProtection.complete, forKey: .fileProtectionKey)
    }

    private func open(_ data: Data, context: String) throws -> [String: Any] {
        guard data.count > 28, data.count <= LocalChatStore.maximumBytes + 28 else { throw LocalChatStoreError.corruptState }
        let envelope = SealedCredential(nonce: Data(data.prefix(12)), ciphertext: Data(data.dropFirst(12).dropLast(16)), tag: Data(data.suffix(16)))
        let payload: Data
        do { payload = try CredentialSeal.open(envelope, using: keys.key(), context: context) }
        catch { throw LocalChatStoreError.storageUnavailable }
        guard let value = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { throw LocalChatStoreError.corruptState }
        return value
    }
}
