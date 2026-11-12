import AVKit
import SwiftUI

@MainActor
final class InlineVideoRequest {
    fileprivate var cancelled = false
    fileprivate var transfer: ArtifactTransfer?
    fileprivate var folder: URL?

    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        transfer?.cancel()
        transfer = nil
        removeFiles()
    }

    fileprivate func removeFiles() {
        if let folder { try? FileManager.default.removeItem(at: folder) }
        folder = nil
    }
}

extension InlineImageLoader {
    func loadVideo(_ reference: String, completion: @escaping (Result<URL, Error>) -> Void) -> InlineVideoRequest {
        let request = InlineVideoRequest()
        guard InlineImageReference.isVideo(reference) else {
            completion(.failure(InlineVideoFailure.unavailable))
            return request
        }
        if let url = InlineImageReference.remoteURL(reference) {
            completion(.success(url))
            return request
        }
        guard seq > 0 else {
            completion(.failure(InlineVideoFailure.unavailable))
            return request
        }
        session.artifacts(conversationId: conversationId, selection: ArtifactSelection(seq: seq, reference: reference)) { result in
            guard !request.cancelled else { return }
            guard case .success(let page) = result,
                  let artifact = page.items.first(where: {
                      InlineImageReference.isVideo($0.name) && $0.size >= 0
                          && $0.size <= InlineImageReference.maximumVideoBytes
                          && $0.id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                  })
            else {
                completion(.failure(InlineVideoFailure.unavailable))
                return
            }
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("camellia-inline-video-\(UUID().uuidString)", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            } catch {
                completion(.failure(error))
                return
            }
            request.folder = folder
            let suffix = (artifact.name as NSString).pathExtension.lowercased()
            let destination = folder.appendingPathComponent("video" + (suffix.isEmpty ? "" : ".\(suffix)"))
            request.transfer = session.downloadArtifact(conversationId: conversationId, hash: artifact.id,
                expectedSize: artifact.size, to: destination, progress: { _, _ in }) { result in
                request.transfer = nil
                guard !request.cancelled else { return }
                switch result {
                case .success(let file):
                    completion(.success(file))
                case .failure(let error):
                    request.removeFiles()
                    completion(.failure(error))
                }
            }
        }
        return request
    }
}

private enum InlineVideoFailure: Error {
    case unavailable
}

@MainActor
final class InlineVideoModel: ObservableObject {
    @Published private(set) var player: AVPlayer?
    @Published private(set) var loading = false
    @Published private(set) var failed = false
    private var request: InlineVideoRequest?
    private var loader: InlineImageLoader?
    private var reference = ""

    func prepare(_ reference: String, loader: InlineImageLoader?) {
        guard reference != self.reference else { return }
        cancel()
        self.reference = reference
        self.loader = loader
        failed = loader == nil || !InlineImageReference.isVideo(reference)
    }

    func start() {
        guard player == nil, !loading, !reference.isEmpty else { return }
        guard let loader else {
            failed = true
            return
        }
        failed = false
        loading = true
        let selected = reference
        request = loader.loadVideo(reference) { [weak self] result in
            guard let self, self.reference == selected else { return }
            self.loading = false
            switch result {
            case .success(let url):
                let player = AVPlayer(url: url)
                player.actionAtItemEnd = .pause
                self.player = player
                player.play()
            case .failure:
                self.failed = true
            }
        }
    }

    func cancel() {
        player?.pause()
        player = nil
        request?.cancel()
        request = nil
        loading = false
        failed = false
        reference = ""
        loader = nil
    }
}

struct InlineVideoView: View {
    let alt: [MarkdownInline]
    let destination: String
    @Environment(\.inlineImageLoader) private var loader
    @StateObject private var model = InlineVideoModel()

    private var altText: String {
        let value = alt.map(\.plainText).joined()
        return value.isEmpty ? ArtifactReferences.name(of: destination) : value
    }

    var body: some View {
        Group {
            if let player = model.player {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity, maxHeight: 480)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel(Text(altText))
            } else {
                Button(action: { model.start() }) {
                    VStack(spacing: 10) {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 44))
                            .foregroundColor(Palette.accent)
                        Text(altText)
                            .font(.headline)
                            .foregroundColor(Palette.ink)
                            .multilineTextAlignment(.center)
                        if model.loading {
                            ProgressView().progressViewStyle(.circular)
                            Text(LocalizedStringKey("正在下载视频…"))
                                .font(.caption)
                                .foregroundColor(Palette.muted)
                        } else {
                            Text(LocalizedStringKey(model.failed ? "无法播放视频，点按重试" : "播放视频"))
                                .font(.caption)
                                .foregroundColor(Palette.muted)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 180)
                    .padding(18)
                    .background(Palette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.cardBorder, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(model.loading)
                .accessibilityLabel(Text(LocalizedStringKey("播放视频")) + Text(verbatim: " · \(altText)"))
            }
        }
        .onAppear { model.prepare(destination, loader: loader) }
        .onChange(of: destination) { model.prepare($0, loader: loader) }
        .onDisappear { model.cancel() }
    }
}
