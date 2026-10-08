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

    var body: some View {
        HStack(spacing: 10) {
            Text(LocalizedStringKey(label))
                .font(.caption2)
                .foregroundColor(Palette.muted)
                .lineLimit(1)
            Text(task.instruction)
                .font(.caption)
                .foregroundColor(Palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if task.intervalMinutes > 0 {
                Text(model.usesChinese ? "每 \(task.intervalMinutes) 分钟"
                     : "every \(task.intervalMinutes) min")
                    .font(.caption2)
                    .foregroundColor(Palette.muted)
            }
            if task.isRunning || task.isPaused {
                Button(task.isPaused ? "恢复" : "暂停") {
                    model.controlTask(task.id, pause: task.isRunning)
                }
                .font(.caption2.weight(.medium))
                .buttonStyle(.plain)
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(minHeight: 40)
                .background(Capsule(style: .continuous).fill(Palette.background))
                .accessibilityLabel(model.usesChinese
                    ? "\(task.isPaused ? "恢复" : "暂停")任务：\(task.instruction)"
                    : "\(task.isPaused ? "Resume" : "Pause") task: \(task.instruction)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
        .padding(.horizontal, 8)
    }

    private var label: String {
        switch task.status {
        case "running": return "检查中"
        case "paused": return "已暂停"
        case "complete": return "已完成"
        default: return "等待"
        }
    }
}

/// Messages composed while the desktop was busy, waiting their turn.
private struct QueueCard: View {
    let entries: [RemoteQueueEntry]
    @EnvironmentObject private var model: AppModel
    /// The entry whose failure text is being read, if any.
    @State private var reading: RemoteQueueEntry?

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
            .frame(maxHeight: entries.count > 3 ? 200 : nil)
        }
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
        .padding(.horizontal, 8)
        .alert(item: $reading) { entry in
            Alert(title: Text("队列已暂停"),
                  message: Text(entry.error),
                  dismissButton: .default(Text("知道了")))
        }
    }

    private func row(index: Int, entry: RemoteQueueEntry) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(index + 1). \(entry.text)")
                    .font(.subheadline)
                    .foregroundColor(Palette.ink)
                    .lineLimit(2)
                Text(detail(entry))
                    .font(.caption2)
                    .foregroundColor(entry.isFailed ? .red : Palette.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { if !entry.error.isEmpty { reading = entry } }
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
        return text
    }
}
