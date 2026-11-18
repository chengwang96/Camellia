import SwiftUI

/// The two state strips that sit directly above the composer.
///
/// Both are drawn from the conversation snapshot the desktop already sends with
/// every reply, so neither needs a request of its own — which is why they are
/// here rather than behind a button. They are pinned above the composer instead
/// of scrolled with the transcript because everything on them is actionable:
/// a pause, a resume, a removal.
///
/// Android puts the same two bars in the same place, and its own comment says so
/// ("Goal and scheduled-task state sits directly above the composer").
struct RemoteStatusBars: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 6) {
            if model.isArchivedConversation {
                ArchivedConversationCard()
            } else {
                if model.transcript.showsGoal, let goal = model.transcript.automation?.goal {
                    GoalCard(goal: goal)
                }
                let tasks = model.transcript.automation?.tasks ?? []
                if !tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.usesChinese ? "定时任务 · \(tasks.count)"
                             : "Scheduled · \(tasks.count)")
                            .font(.caption2)
                            .foregroundColor(Palette.muted)
                            .padding(.horizontal, 12)
                        ForEach(tasks) { task in TaskCard(task: task) }
                    }
                }
                if !model.transcript.queue.isEmpty {
                    QueueCard(entries: model.transcript.queue)
                }
            }
        }
    }
}

/// A conversation the computer archived while this phone was reading it.
///
/// The desktop keeps the transcript readable and sends a read permission, so
/// the detail page must not look like lost access. It says what happened and
/// offers the one command that is still meaningful here: restore. Restoring is
/// a normal archive command against this conversation's own sequence.
private struct ArchivedConversationCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("已在电脑归档")
                    .font(.caption.weight(.medium))
                    .foregroundColor(Palette.ink)
                Text("聊天记录仍保留，这里是只读状态。")
                    .font(.caption2)
                    .foregroundColor(Palette.muted)
            }
            Spacer(minLength: 8)
            if model.transcript.canRestoreArchived {
                Button("恢复会话") { model.restoreOpenConversation() }
                    .font(.caption.weight(.medium))
                    .buttonStyle(.plain)
                    .foregroundColor(Palette.accent)
                    .frame(minHeight: 40)
                    .padding(.horizontal, 10)
                    .background(Capsule(style: .continuous).fill(Palette.background))
                    .disabled(model.commandBusy || model.hasPendingDetailOperation)
                    .accessibilityLabel("恢复这个归档会话")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
        .padding(.horizontal, 8)
    }
}

/// A goal the desktop is working towards on its own.
private struct GoalCard: View {
    let goal: RemoteGoal
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            Text(LocalizedStringKey(label))
                .font(.caption)
                .foregroundColor(goal.isRunning ? Palette.accent : Palette.muted)
                .lineLimit(1)
            Text(goal.objective)
                .font(.subheadline)
                .foregroundColor(Palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if goal.roundsStarted > 0 {
                Text("\(goal.roundsStarted)")
                    .font(.caption2)
                    .foregroundColor(Palette.muted)
            }
            // Only the live phases are actionable: a completed goal is the
            // desktop's business, and a blocked one resumes from the same
            // control as a paused one.
            if goal.phase == "active" || goal.phase == "blocked" {
                Button(goal.isRunning ? "暂停" : "恢复") {
                    model.controlGoal(goal.isRunning)
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.plain)
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(minHeight: 40)
                .background(Capsule(style: .continuous).fill(Palette.surface))
                .accessibilityLabel(model.usesChinese
                    ? "\(goal.isRunning ? "暂停" : "恢复")目标：\(goal.objective)"
                    : "\(goal.isRunning ? "Pause" : "Resume") goal: \(goal.objective)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
        .padding(.horizontal, 8)
    }

    private var label: String {
        if goal.isComplete { return "目标已完成" }
        if goal.isBlocked { return "目标受阻" }
        return goal.isRunning ? "目标进行中" : "目标已暂停"
    }
}

/// One scheduled task the desktop will run again on an interval.
private struct TaskCard: View {
    let task: RemoteTask
    @EnvironmentObject private var model: AppModel
    @State private var showDetails = false

    var body: some View {
        HStack(spacing: 10) {
            Text(LocalizedStringKey(label))
                .font(.caption2)
                .foregroundColor(Palette.muted)
                .lineLimit(1)
            Button { showDetails = true } label: {
                Text(verbatim: task.instruction)
                    .font(.caption)
                    .foregroundColor(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityHint(model.usesChinese ? "查看任务详情" : "View task details")
            Spacer(minLength: 8)
            if task.intervalMinutes > 0 || task.scheduleType != "interval" {
                Text(task.scheduleType == "daily" ? (model.usesChinese ? "每天 \(task.dailyTime)" : "Daily \(task.dailyTime)") : task.scheduleLabel(chinese: model.usesChinese))
                    .font(.caption2)
                    .foregroundColor(Palette.muted)
            }
            if task.canPause || task.isPaused {
                Button(task.isPaused ? "恢复" : "暂停") {
                    model.controlTask(task.id, pause: task.canPause)
                }
                .font(.caption2.weight(.medium))
                .buttonStyle(.plain)
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(minHeight: 44)
                .background(Capsule(style: .continuous).fill(Palette.background))
                .accessibilityLabel(model.usesChinese
                    ? "\(task.isPaused ? "恢复" : "暂停")任务：\(task.instruction)"
                    : "\(task.isPaused ? "Resume" : "Pause") task: \(task.instruction)")
                .disabled(task.stopping || !model.canDrive || model.commandBusy || model.hasPendingDetailOperation)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
        .padding(.horizontal, 8)
        .sheet(isPresented: $showDetails) {
            ScheduledTaskDetails(original: task).environmentObject(model)
        }
    }

    private var label: String {
        if task.stopping { return model.usesChinese ? "停止中" : "Stopping" }
        switch task.status {
        case "running": return "检查中"
        case "paused": return "已暂停"
        case "complete": return "已完成"
        case "cancelled": return model.usesChinese ? "已取消" : "Cancelled"
        default: return "等待"
        }
    }
}

private struct ScheduledTaskDetails: View {
    let original: RemoteTask
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingCancel = false
    private var task: RemoteTask {
        model.transcript.automation?.tasks.first(where: { $0.id == original.id }) ?? original
    }
    private var canControl: Bool { !task.stopping && model.canDrive && !model.commandBusy && !model.hasPendingDetailOperation }
    private func date(_ at: Int64) -> String {
        Date(timeIntervalSince1970: Double(at) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(model.usesChinese
                         ? ["scheduled": "等待检查", "running": "正在检查", "paused": "已暂停", "complete": "已完成", "cancelled": "已取消"][task.status] ?? task.status
                         : task.status.capitalized)
                        .font(.subheadline.weight(.medium))
                    HStack(spacing: 20) {
                        if task.canPause || task.isPaused {
                            Button(model.usesChinese ? (task.isPaused ? "恢复" : "暂停") : (task.isPaused ? "Resume" : "Pause")) {
                                model.controlTask(task.id, pause: task.canPause)
                            }.frame(minHeight: 44).disabled(!canControl)
                        }
                        if task.canCancel {
                            Button(model.usesChinese ? "取消任务" : "Cancel task", role: .destructive) { confirmingCancel = true }
                                .frame(minHeight: 44).disabled(!canControl)
                        }
                    }
                    Text(verbatim: task.instruction).textSelection(.enabled)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(task.scheduleLabel(chinese: model.usesChinese))
                        if task.maxRuns > 0 {
                            Text(model.usesChinese
                                 ? "\(task.runs)/\(task.maxRuns) 次检查 · \(task.repairs)/\(task.maxRepairs) 次恢复"
                                 : "\(task.runs)/\(task.maxRuns) checks · \(task.repairs)/\(task.maxRepairs) recoveries")
                        }
                        if task.nextRunAt > 0 {
                            Text((model.usesChinese ? "下次检查：" : "Next check: ") + date(task.nextRunAt))
                        }
                        if task.expiresAt > 0 {
                            Text((model.usesChinese ? "截止时间：" : "Deadline: ") + date(task.expiresAt))
                        }
                    }.font(.caption).foregroundColor(Palette.muted)
                    let notice = model.usesChinese ? task.noticeZh : task.notice
                    if !notice.isEmpty { Text(verbatim: notice).textSelection(.enabled) }
                    if !task.lastResult.isEmpty { Text(verbatim: task.lastResult).textSelection(.enabled) }
                    if !task.history.isEmpty {
                        DisclosureGroup(model.usesChinese ? "最近记录" : "Recent checks") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(task.history.reversed().enumerated()), id: \.offset) { _, entry in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(date(entry.at)).font(.caption).foregroundColor(Palette.muted)
                                        Text(verbatim: entry.message).textSelection(.enabled)
                                    }
                                }
                            }.padding(.top, 8)
                        }
                    }
                }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
            .background(Palette.background)
            .navigationTitle(model.usesChinese ? "定时任务" : "Scheduled task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(model.usesChinese ? "关闭" : "Close") { dismiss() } } }
            .confirmationDialog(model.usesChinese ? "取消任务？" : "Cancel task?", isPresented: $confirmingCancel, titleVisibility: .visible) {
                Button(model.usesChinese ? "取消任务" : "Cancel task", role: .destructive) {
                    model.controlTask(task.id, operation: "cancel")
                }
            } message: {
                Text(model.usesChinese ? "停止定时检查，保留记录。正在运行的实验不会停止。"
                     : "Stops scheduled checks and keeps their history. The experiment keeps running.")
            }
        }
        .navigationViewStyle(.stack)
    }
}

/// Messages composed while the desktop was busy, waiting their turn.
private struct QueueCard: View {
    let entries: [RemoteQueueEntry]
    @EnvironmentObject private var model: AppModel
    /// The entry whose failure text is being read, if any.
    @State private var reading: RemoteQueueEntry?
    @State private var editing: RemoteQueueEntry?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(model.usesChinese ? "待发送 · \(entries.count)"
                     : "Queued · \(entries.count)")
                    .font(.caption)
                    .foregroundColor(Palette.muted)
                Spacer(minLength: 8)
                // A queue stops itself when a turn fails or the phone's access
                // changes; saying why and offering the way on is the whole
                // reason this bar is visible.
                if entries.contains(where: { $0.isPaused || $0.isFailed }) {
                    Button("继续队列") { model.resumeQueue() }
                        .font(.caption.weight(.medium))
                        .buttonStyle(.plain)
                        .foregroundColor(Palette.accent)
                        .disabled(!canChangeQueue)
                        .accessibilityLabel("继续队列")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            // Tall queues scroll inside the bar rather than pushing the
            // transcript off screen — the same shape Android caps at 200dp.
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        row(index: index, entry: entry)
                    }
                }
            }
            .frame(maxHeight: 200)
        }
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
        .padding(.horizontal, 8)
        .alert(item: $reading) { entry in
            Alert(title: Text("队列已暂停"),
                  message: Text(entry.error),
                  dismissButton: .default(Text("知道了")))
        }
        .sheet(item: $editing) { entry in
            QueueEditor(entry: entry)
        }
    }

    private func row(index: Int, entry: RemoteQueueEntry) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(index + 1). \(entry.text)")
                        .font(.subheadline)
                        .foregroundColor(Palette.ink)
                        .lineLimit(2)
                    Text(detail(entry))
                        .font(.caption2)
                        .foregroundColor(entry.isFailed ? .red : Palette.muted)
                }
                .contentShape(Rectangle())
                .onTapGesture { if !entry.error.isEmpty { reading = entry } }
                HStack(spacing: 16) {
                    Button { editing = entry } label: {
                        Text(model.usesChinese ? "重新编辑" : "Edit").frame(minHeight: 44)
                    }
                        .disabled(!canChangeQueue || entry.isStarting)
                    Button { model.steerQueued(entry) } label: {
                        Text(model.usesChinese ? "插队" : "Send now").frame(minHeight: 44)
                    }
                        .disabled(!canChangeQueue || entry.isStarting || !model.canSteerQueued)
                        .accessibilityLabel(model.usesChinese ? "插队到当前回复" : "Send as an instruction to the current reply")
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.plain)
                .foregroundColor(Palette.accent)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                model.removeQueued(entry.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            // A message already being handed to the engine cannot be pulled
            // back; the desktop refuses it, so the button does not pretend.
            .disabled(!canChangeQueue || entry.isStarting)
            .accessibilityLabel(model.usesChinese
                ? "移出队列：\(entry.text)" : "Remove from queue: \(entry.text)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var canChangeQueue: Bool {
        model.canDrive && !model.commandBusy && !model.hasPendingDetailOperation
    }

    private func detail(_ entry: RemoteQueueEntry) -> String {
        var text: String
        if entry.isStarting {
            text = model.usesChinese ? "正在发送" : "Sending"
        } else if entry.isFailed {
            text = model.usesChinese ? "发送失败 · 请检查后继续"
                 : "Failed · review before resuming"
        } else if entry.isPaused {
            text = model.usesChinese ? "已暂停" : "Paused"
        } else {
            text = model.usesChinese ? "等待当前任务结束"
                 : "Waiting for the current task to finish"
        }
        if entry.attachmentCount > 0 {
            text += model.usesChinese ? " · 附件 \(entry.attachmentCount)"
                  : " · \(entry.attachmentCount) attachments"
        }
        let source = entry.source == "desktop"
            ? (model.usesChinese ? "电脑" : "Computer") : (model.usesChinese ? "手机" : "Mobile")
        return source + " · " + text
    }
}

private struct QueueEditor: View {
    let entry: RemoteQueueEntry
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var prompt: String

    init(entry: RemoteQueueEntry) {
        self.entry = entry
        _prompt = State(initialValue: entry.text)
    }

    var body: some View {
        NavigationView {
            VStack(alignment: .leading, spacing: 12) {
                Text(model.usesChinese ? "保存后保留消息原来的设备归属、排队位置和附件。"
                     : "Saving keeps this message's source, queue position and attachments.")
                    .font(.caption)
                    .foregroundColor(Palette.muted)
                TextEditor(text: $prompt)
                    .font(.body)
                    .accessibilityLabel(model.usesChinese ? "排队消息" : "Queued message")
            }
            .padding()
            .navigationTitle(model.usesChinese ? "重新编辑" : "Edit queued message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.usesChinese ? "取消" : "Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.usesChinese ? "保存" : "Save") {
                        model.editQueued(entry, prompt: prompt) { dismiss() }
                    }
                    .disabled(!model.canDrive || model.commandBusy || model.hasPendingDetailOperation
                        || ComposerText.androidTrim(prompt).isEmpty || prompt.utf16.count > 16_000)
                }
            }
        }
    }
}
