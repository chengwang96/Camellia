import Foundation

public struct RemoteSubtaskQuestion: Sendable, Hashable, Identifiable {
    public let id: String
    public let question: String
    public let options: [String]
    public let multiSelect: Bool
    public let isSecret: Bool
    public init(_ json: JSONObject) {
        id = json.text("id"); question = json.text("question")
        options = json.objects("options").map { $0.text("label") }
        multiSelect = json.bool("multiSelect"); isSecret = json.bool("isSecret")
    }
}
public struct RemoteSubtaskApproval: Sendable, Hashable, Identifiable {
    public let id: String
    public let fingerprint: String
    public let title: String
    public let details: String
    public let supported: Bool
    public let questions: [RemoteSubtaskQuestion]
    public init(_ json: JSONObject) {
        id = json.text("requestId"); fingerprint = json.text("fingerprint")
        title = json.text("toolName"); details = json.text("details")
        supported = json.bool("responseSupported", fallback: json.bool("actionable"))
        questions = json.objects("questions").map(RemoteSubtaskQuestion.init)
    }
}
/// Child identity and initiating turn are retained across every snapshot.
public struct RemoteSubtask: Sendable, Hashable, Identifiable {
    public let id: String
    public let engine: String
    public let userSeq: Int64
    public let title: String
    public let status: String
    public let goal: String
    public let progress: String
    public let result: String
    public let turnId: String
    public let canReply: Bool
    public let canStop: Bool
    public let pendingApprovals: Int64
    public let detailsTruncated: Bool
    public let history: [RemoteProcessEntry]
    public let approvals: [RemoteSubtaskApproval]
    public var identity: String { engine + ":" + id }
    public var active: Bool { ["starting", "running", "waiting"].contains(status) }
    public var needsAttention: Bool { status == "waiting" || pendingApprovals > 0 || !approvals.isEmpty }
    public init(_ json: JSONObject) {
        id = json.text("id"); engine = json.text("engine"); userSeq = json.long("userSeq")
        title = json.text("title"); status = json.text("status"); goal = json.text("goal")
        progress = json.text("progress"); result = json.text("result"); turnId = json.text("turnId")
        canReply = json.bool("canReply"); canStop = json.bool("canStop"); pendingApprovals = json.long("pendingApprovals")
        detailsTruncated = json.bool("detailsTruncated")
        history = json.objects("history").map(RemoteProcessEntry.init)
        approvals = json.objects("approvals").map(RemoteSubtaskApproval.init)
    }
    public func command(operation: String, instanceId: String) -> [String: Any] {
        ["instanceId": instanceId, "taskId": id, "engine": engine, "operation": operation, "expectedTurnId": turnId]
    }
}
