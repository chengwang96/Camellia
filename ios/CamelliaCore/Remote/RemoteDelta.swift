import Foundation

enum RemoteDelta {
    static func merge(previous: JSONObject?, patch: JSONObject) throws -> JSONObject {
        guard patch.bool("delta") else { return patch }
        guard let previous else { throw RemoteSession.SessionError.invalidSnapshot }
        var merged = previous.raw
        for (key, value) in patch.raw where key != "delta" { merged[key] = value }
        if let update = patch.object("live") {
            var live = update.raw
            if let before = previous.object("live"),
               before.long("runId") == update.long("runId"),
               !update.has("process"), before.has("process") {
                live["process"] = before.raw["process"]
            }
            if update.has("textDelta") {
                guard let before = previous.object("live"),
                      before.long("runId") == update.long("runId"),
                      before.long("eventSeq") == update.long("baseEventSeq"),
                      before.text("text").utf16.count == update.int("textBaseLength") else {
                    throw RemoteSession.SessionError.invalidSnapshot
                }
                live["text"] = before.text("text") + update.text("textDelta")
                live.removeValue(forKey: "textDelta")
                live.removeValue(forKey: "textBaseLength")
                live.removeValue(forKey: "baseEventSeq")
            }
            merged["live"] = live
        }
        merged.removeValue(forKey: "delta")
        return JSONObject(dictionary: merged)
    }
}
