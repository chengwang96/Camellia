import SwiftUI
import UIKit

/// The colour a file kind is drawn in, matching the Android palette.
extension ArtifactKind {
    var color: Color {
        switch tint {
        case "pdf": return Color(red: 0.93, green: 0.33, blue: 0.38)
        case "spreadsheet": return Color(red: 0.16, green: 0.53, blue: 0.36)
        case "presentation": return Color(red: 0.78, green: 0.42, blue: 0.19)
        case "package": return Color(red: 0.23, green: 0.44, blue: 0.83)
        default: return Palette.accent
        }
    }
}

/// The files an answer talks about, listed under the answer.
///
/// Only ever shown for a finished assistant message. A live reply is still
/// naming files it has not finished writing, and a list that fills in as the
/// reply streams would be a list of paths that do not exist yet.
struct ArtifactCard: View {
    let names: [String]
    let onOpen: () -> Void

    @Environment(\.locale) private var locale

    @State private var expanded = false

    /// Beyond this the list folds away, because a reply that mentions thirty
    /// paths is a reply whose list is longer than the answer.
    private static let visibleLimit = 4

    var body: some View {
        let ordered = ArtifactReferences.sorted(names)
        let shown = expanded ? ordered : Array(ordered.prefix(Self.visibleLimit))

        VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, name in
                if index > 0 { Divider().padding(.leading, 60) }
                row(name)
            }
            if ordered.count > Self.visibleLimit {
                Divider().padding(.leading, 60)
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                } label: {
                    Text(expanded ? "收起文件" : "显示另外 \(ordered.count - Self.visibleLimit) 个文件")
                        .font(.footnote)
                        .foregroundColor(Palette.muted)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(RoundedRectangle(cornerRadius: Palette.trackRadius, style: .continuous).fill(Palette.background))
        .overlay(RoundedRectangle(cornerRadius: Palette.trackRadius, style: .continuous).stroke(Palette.separator, lineWidth: 1))
    }

    private func row(_ name: String) -> some View {
        let kind = ArtifactReferences.kind(of: name)
        let ext = ArtifactReferences.fileExtension(of: name)
        return Button(action: onOpen) {
            HStack(spacing: 10) {
                Text(ext)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(kind.color)
                    .frame(width: 38, height: 48)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous).fill(Palette.surface))
                VStack(alignment: .leading, spacing: 4) {
                    Text(name)
                        .font(.subheadline)
                        .foregroundColor(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    (Text(LocalizedStringKey(kind.label)) + Text(verbatim: " · \(ext)"))
                        .font(.caption2)
                        .foregroundColor(Palette.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 8)
                Text("查看")
                    .font(.footnote)
                    .foregroundColor(Palette.ink)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(Palette.separator, lineWidth: 1))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(locale.identifier.lowercased().hasPrefix("zh")
            ? "查看会话产物：\(name)" : "View conversation artifact: \(name)")
    }
}

/// One file on its way out of the app.
struct ArtifactExport: Identifiable {
    let id = UUID()
    let url: URL
}

/// Hands the temporary file to Files without loading its bytes into memory.
private struct ArtifactFilePicker: UIViewControllerRepresentable {
    let url: URL
    let onFinish: () -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onFinish: () -> Void
        init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onFinish() }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            onFinish()
        }
    }
}

/// The conversation's files, with a way to take one away.
///
/// The list is the desktop's, not the phone's: it contains what this
/// conversation referenced and that still exists, including files produced in
/// another directory. So an empty list is an answer, and the screen says why
/// rather than looking broken.
struct ArtifactSheetView: View {
    @EnvironmentObject private var model: AppModel
    let onClose: () -> Void

    @State private var export: ArtifactExport?
    @State private var exportFolder: URL?
    @State private var downloading: String?
    @State private var downloadTransfer: ArtifactTransfer?
    @State private var downloadedBytes: Int64 = 0
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: Palette.gripRadius, style: .continuous)
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 12)
            HStack {
                RoundBackButton(action: onClose)
                Text("会话产物")
                    .font(.system(size: Palette.textTitle, weight: .medium))
                    .foregroundColor(Palette.ink)
                    .frame(maxWidth: .infinity)
                    .accessibilityAddTraits(.isHeader)
                Color.clear.frame(width: 48, height: 1)
            }
            .padding(.top, 4)
            .padding(.bottom, 16)
            Text("电脑上的成果，随身带走。")
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 18)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let failure {
                        StatusLine(text: failure, tone: .bad)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 12)
                    }
                    status
                    ForEach(model.artifacts) { artifact in
                        row(artifact)
                            .padding(.bottom, 14)
                    }
                    if model.artifactsError != nil {
                        action("重试", primary: false) {
                            model.loadArtifacts(more: model.artifactsMore)
                        }
                    } else if model.artifactsMore {
                        action("加载更多", primary: false) { model.loadArtifacts(more: true) }
                            .disabled(model.artifactsLoading)
                            .opacity(model.artifactsLoading ? 0.45 : 1)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            action("完成", primary: false, action: onClose)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
        .onAppear { model.beginArtifactSheet() }
        .onDisappear {
            model.endArtifactSheet()
            downloadTransfer?.cancel()
        }
        .sheet(item: $export, onDismiss: {
            if let exportFolder { try? FileManager.default.removeItem(at: exportFolder) }
            exportFolder = nil
        }) { item in
            ArtifactFilePicker(url: item.url) { export = nil }
        }
    }

    @ViewBuilder
    private var status: some View {
        if model.artifacts.isEmpty, model.artifactsLoading {
            HStack(spacing: 8) {
                ProgressView()
                Text("正在读取产物…")
            }
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 10)
        } else if let error = model.artifactsError {
            StatusLine(text: error, tone: .bad)
                .padding(.horizontal, 8)
                .padding(.vertical, 10)
        } else if model.artifacts.isEmpty {
            Text("未找到可下载文件。只显示此会话引用且仍存在的产物（含在其他目录中生成的文件）；若刚生成，请关闭后重新打开，或更新并重启电脑端。")
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 10)
        } else {
            Text("下载过程中请保持面板打开并让应用停留前台；完成后选择保存位置。")
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 10)
        }
    }

    private func row(_ artifact: RemoteArtifact) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(artifact.ext.uppercased())  ·  \(Self.size(artifact.size))")
                .font(.system(size: Palette.textSmall))
                .foregroundColor(Palette.secondary)
            Text(artifact.name)
                .font(.system(size: Palette.textRowStrong, weight: .medium))
                .foregroundColor(Palette.ink)
                .lineLimit(2)
                .truncationMode(.middle)
                .padding(.top, 8)
                .padding(.bottom, 16)
            if downloading == artifact.id {
                ProgressView(value: Double(downloadedBytes), total: Double(max(artifact.size, 1)))
                    .tint(Palette.ink)
                HStack {
                    Text("\(Self.size(downloadedBytes)) / \(Self.size(artifact.size))")
                        .font(.system(size: Palette.textNote))
                        .foregroundColor(Palette.secondary)
                    Spacer()
                    Button("取消") { downloadTransfer?.cancel() }
                        .font(.system(size: Palette.textNote))
                        .buttonStyle(.plain)
                }
                .padding(.top, 10)
            } else {
                action(UIDevice.current.userInterfaceIdiom == .pad ? "下载到平板" : "下载到手机",
                       primary: true) { download(artifact) }
                    .disabled(downloading != nil || export != nil)
                    .opacity(downloading != nil || export != nil ? 0.45 : 1)
                    .accessibilityLabel(model.usesChinese
                        ? "\(artifact.name) · \(UIDevice.current.userInterfaceIdiom == .pad ? "下载到平板" : "下载到手机")"
                        : "\(artifact.name) · Download to this device")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
            .fill(Palette.card))
    }

    private func action(_ title: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textRow, weight: .medium))
                .foregroundColor(primary ? Palette.card : Palette.ink)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius, style: .continuous)
                    .fill(primary ? Palette.ink : Palette.card))
        }
        .buttonStyle(.plain)
    }

    private func download(_ artifact: RemoteArtifact) {
        guard downloading == nil, export == nil else { return }
        downloading = artifact.id
        downloadedBytes = 0
        failure = nil
        downloadTransfer = model.downloadArtifact(artifact, filename: Self.sanitized(artifact.name),
                                                  progress: { received, _ in downloadedBytes = received }) { result in
            downloading = nil
            downloadTransfer = nil
            switch result {
            case .success(let url):
                exportFolder = url.deletingLastPathComponent()
                export = ArtifactExport(url: url)
            case .failure(let error):
                if !(error is ArtifactTransfer.Failure) { failure = AppModel.describe(error) }
            }
        }
    }

    /// A file name that is safe to hand to the system picker.
    ///
    /// Slashes would turn a name into a path, and control characters would
    /// turn it into something the picker refuses; both become an underscore,
    /// which is what Android does.
    private static func sanitized(_ name: String) -> String {
        let stripped = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let safe = stripped.map { character -> Character in
            guard character != "/", character != "\\",
                  character.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
            else { return "_" }
            return character
        }
        let result = String(safe)
        return result.isEmpty || result == "." || result == ".." ? "artifact" : result
    }

    private static func size(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}
