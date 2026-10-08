import SwiftUI

/// Let iOS own long-press recognition and dismissal alongside NavigationLink.
struct ConversationActionsMenu: View {
    let pinned: Bool
    let rename: () -> Void
    let select: () -> Void
    let pin: () -> Void
    let archive: () -> Void
    let delete: () -> Void

    var body: some View {
        Group {
            Button(action: rename) { Label("重命名", systemImage: "pencil") }
            Button(action: select) { Label("多选", systemImage: "checkmark.circle") }
            Button(action: pin) { Label(pinned ? "取消置顶" : "置顶", systemImage: "pin") }
            Button(action: archive) { Label("归档会话", systemImage: "archivebox") }
            Button(role: .destructive, action: delete) { Label("删除", systemImage: "trash") }
        }
    }
}
