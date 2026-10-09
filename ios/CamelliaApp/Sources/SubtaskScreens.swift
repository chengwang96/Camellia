import SwiftUI

func subtaskStatus(_ status: String, chinese: Bool) -> String {
    guard chinese else { return status }
    return ["ready": "就绪", "starting": "准备中", "running": "运行中", "waiting": "待处理", "completed": "已完成",
            "failed": "失败", "stopped": "已停止", "unavailable": "状态不可用"][status] ?? "状态不可用"
}

struct SubtaskTurnCard: View {
    @EnvironmentObject private var model: AppModel
    let tasks: [RemoteSubtask]
    let onOpen: (String?) -> Void
    @State private var expanded: Bool?
    private var isExpanded: Binding<Bool> {
        Binding(get: { expanded ?? tasks.contains(where: \.active) }, set: { expanded = $0 })
    }
    var body: some View {
        DisclosureGroup(isExpanded: isExpanded) {
            ForEach(Array(tasks.prefix(3)), id: \.identity) { task in
                Button { onOpen(task.identity) } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(verbatim: task.title).lineLimit(1)
                            Spacer()
                            Text(subtaskStatus(task.status, chinese: model.usesChinese)).font(.caption).foregroundColor(Palette.muted)
                        }
                        Text(verbatim: task.progress).font(.caption).lineLimit(2).foregroundColor(Palette.muted)
                    }.padding(.vertical, 8).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            Button(model.usesChinese ? "查看全部子任务" : "View all subtasks") { onOpen(nil) }
                .frame(minHeight: 44)
        } label: {
            HStack {
                Text(model.usesChinese ? "子任务 · \(tasks.count)" : "Subtasks · \(tasks.count)")
                let attention = tasks.filter(\.needsAttention).count
                if attention > 0 {
                    Text(model.usesChinese ? "待处理 \(attention)" : "Needs attention \(attention)")
                        .font(.caption).foregroundColor(Palette.accent)
                }
            }
        }
        .padding(12).background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .foregroundColor(Palette.ink)
    }
}

/// Navigation keeps the parent's transcript and composer mounted.
struct SubtaskDetailPage: View {
    @EnvironmentObject private var model: AppModel
    let userSeq: Int64
    @State private var selectedID: String?
    @State private var replies: [String: String] = [:]
    init(userSeq: Int64, selectedID: String?) {
        self.userSeq = userSeq
        _selectedID = State(initialValue: selectedID)
    }
    private var tasks: [RemoteSubtask] { model.transcript.subagents.filter { $0.userSeq == userSeq } }
    private var current: RemoteSubtask? { tasks.first { $0.identity == selectedID } }
    private var canAct: Bool { model.canDrive && !model.commandBusy && !model.hasPendingDetailOperation }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let task = current {
                    Text(verbatim: task.title).font(.title3)
                    Text(subtaskStatus(task.status, chinese: model.usesChinese)).foregroundColor(Palette.muted)
                    section(model.usesChinese ? "目标" : "Goal", task.goal)
                    section(model.usesChinese ? "最新进展" : "Latest progress", task.progress)
                    section(model.usesChinese ? "结果" : "Result", task.result)
                    if task.detailsTruncated {
                        Text(model.usesChinese ? "部分详情已缩短，可在电脑查看完整记录。" : "Some details are shortened; open the computer for the full record.").font(.caption).foregroundColor(Palette.muted)
                    }
                    if task.pendingApprovals > 0 && task.approvals.isEmpty {
                        Text(model.usesChinese ? "等待授权，请在电脑处理。" : "Approval pending; respond on the computer.").foregroundColor(Palette.accent)
                    }
                    ForEach(task.approvals) { request in
                        SubtaskApprovalForm(task: task, request: request).environmentObject(model)
                            .id(task.identity + ":" + task.turnId + ":" + request.fingerprint)
                    }
                    if task.canReply {
                        let reply = replies[task.identity] ?? ""
                        TextField(model.usesChinese ? "回复此子任务" : "Reply to this subtask", text: Binding(
                            get: { replies[task.identity] ?? "" }, set: { replies[task.identity] = $0 }))
                            .textFieldStyle(.roundedBorder)
                        Button(model.usesChinese ? "发送" : "Send") {
                            model.subtaskCommand(task, operation: "reply", extra: ["prompt": reply])
                        }.disabled(!canAct || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reply.count > 32000)
                    }
                    if task.canStop {
                        Button(model.usesChinese ? "停止此子任务" : "Stop this subtask", role: .destructive) {
                            model.subtaskCommand(task, operation: "stop")
                        }.disabled(!canAct)
                    }
                    DisclosureGroup(model.usesChinese ? "执行记录" : "Execution history") {
                        ForEach(Array(task.history.enumerated()), id: \.offset) { _, entry in
                            VStack(alignment: .leading) {
                                Text(verbatim: entry.type).font(.caption).foregroundColor(Palette.muted)
                                Text(verbatim: entry.text).font(.callout).textSelection(.enabled)
                            }.padding(.vertical, 6)
                        }
                    }
                } else {
                    ForEach(tasks, id: \.identity) { task in
                        Button { selectedID = task.identity } label: {
                            VStack(alignment: .leading) {
                                Text(verbatim: task.title)
                                Text(subtaskStatus(task.status, chinese: model.usesChinese)).font(.caption).foregroundColor(Palette.muted)
                            }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Palette.background).foregroundColor(Palette.ink)
        .navigationTitle(model.usesChinese ? "子任务" : "Subtasks")
        .navigationBarTitleDisplayMode(.inline)
    }
    @ViewBuilder private func section(_ title: String, _ value: String) -> some View {
        if !value.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.caption).foregroundColor(Palette.muted)
                Text(verbatim: value).textSelection(.enabled)
            }
        }
    }
}

private struct SubtaskApprovalForm: View {
    @EnvironmentObject private var model: AppModel
    let task: RemoteSubtask
    let request: RemoteSubtaskApproval
    @State private var answers: [String: String] = [:]
    private var blocked: Bool { !model.canDrive || model.commandBusy || model.hasPendingDetailOperation }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: request.title).font(.headline)
            Text(verbatim: request.details).font(.caption).textSelection(.enabled)
            ForEach(request.questions) { question in
                Text(verbatim: question.question)
                let binding = Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 })
                if question.isSecret { SecureField(model.usesChinese ? "回答" : "Answer", text: binding) }
                else { TextField(question.options.joined(separator: " / "), text: binding) }
            }
            if request.supported {
                HStack {
                    Button(model.usesChinese ? "拒绝" : "Deny") { respond(false) }.disabled(blocked)
                    Button(model.usesChinese ? "提交" : "Submit") { respond(true) }
                        .disabled(blocked || request.questions.contains { (answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                }
            } else { Text(model.usesChinese ? "此请求需要在电脑处理。" : "Respond on the computer.") }
        }.padding(14).background(Palette.surface).clipShape(RoundedRectangle(cornerRadius: 12))
    }
    private func respond(_ allow: Bool) {
        var extra: [String: Any] = ["approvalId": request.id, "fingerprint": request.fingerprint, "allow": allow]
        if allow && !request.questions.isEmpty {
            var input: [String: Any] = [:]
            for question in request.questions {
                let value = answers[question.id] ?? ""
                input[question.id] = question.multiSelect ? value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } as Any : value
            }
            extra["input"] = input
        }
        model.subtaskCommand(task, operation: "approve", extra: extra)
    }
}
