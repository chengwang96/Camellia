import Foundation
import ImageIO
import SwiftUI
import UIKit

@MainActor
final class InlineImageCache {
    private let images = NSCache<NSString, UIImage>()
    init() { images.totalCostLimit = 48 * 1024 * 1024 }
    func image(_ key: String) -> UIImage? { images.object(forKey: key as NSString) }
    func insert(_ image: UIImage, key: String) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(image, forKey: key as NSString, cost: cost)
    }
}

@MainActor
final class InlineImageRequest {
    fileprivate var cancelled = false
    fileprivate var transfer: ArtifactTransfer?
    fileprivate var webSession: URLSession?
    func cancel() {
        cancelled = true
        transfer?.cancel()
        webSession?.invalidateAndCancel()
    }
}

@MainActor
struct InlineImageLoader {
    let session: RemoteSession
    let conversationId: String
    let seq: Int64
    let cache: InlineImageCache

    func load(_ reference: String, completion: @escaping (UIImage?) -> Void) -> InlineImageRequest {
        let request = InlineImageRequest()
        let key = "\(session.computer.address):\(conversationId):\(seq):\(reference)"
        if let cached = cache.image(key) { completion(cached); return request }
        guard InlineImageReference.isSupported(reference) else { completion(nil); return request }
        if let url = InlineImageReference.remoteURL(reference) {
            let receiver = InlineWebReceiver { [weak request] data in
                guard let request, !request.cancelled else { return }
                let image = data.flatMap(InlineImageDecoder.decode)
                if let image { cache.insert(image, key: key) }
                completion(image)
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.urlCache = nil
            let session = URLSession(configuration: configuration, delegate: receiver, delegateQueue: nil)
            request.webSession = session
            var webRequest = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
            webRequest.setValue("image/*", forHTTPHeaderField: "Accept")
            session.dataTask(with: webRequest).resume()
            session.finishTasksAndInvalidate()
            return request
        }
        guard seq > 0 else { completion(nil); return request }
        session.artifacts(conversationId: conversationId, selection: ArtifactSelection(seq: seq, reference: reference)) { result in
            guard !request.cancelled, case .success(let page) = result,
                  let artifact = page.items.first(where: {
                      InlineImageReference.isSupported($0.name) && $0.size >= 0 && $0.size <= InlineImageReference.maximumBytes
                          && $0.id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
                  }) else { completion(nil); return }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("camellia-inline-\(UUID().uuidString)", isDirectory: true)
            do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
            catch { completion(nil); return }
            let destination = folder.appendingPathComponent("image")
            request.transfer = session.downloadArtifact(conversationId: conversationId, hash: artifact.id,
                expectedSize: artifact.size, to: destination, progress: { _, _ in }) { result in
                defer { try? FileManager.default.removeItem(at: folder) }
                guard !request.cancelled, case .success(let file) = result,
                      let data = try? Data(contentsOf: file), Int64(data.count) <= InlineImageReference.maximumBytes
                else { completion(nil); return }
                let image = InlineImageDecoder.decode(data)
                if let image { cache.insert(image, key: key) }
                completion(image)
            }
        }
        return request
    }
}

private enum InlineImageDecoder {
    static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

private final class InlineWebReceiver: NSObject, URLSessionDataDelegate {
    private let completion: (Data?) -> Void
    private var bytes = Data()
    private var failed = false
    private var finished = false

    init(completion: @escaping (Data?) -> Void) { self.completion = completion }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let remote = response.url.flatMap { InlineImageReference.remoteURL($0.absoluteString) }
        if status != 200 || remote == nil || response.expectedContentLength > InlineImageReference.maximumBytes {
            failed = true; completionHandler(.cancel); finish(nil)
        } else {
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        if Int64(bytes.count + data.count) > InlineImageReference.maximumBytes {
            failed = true; dataTask.cancel(); finish(nil)
        } else {
            bytes.append(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error == nil && !failed ? bytes : nil)
    }

    private func finish(_ data: Data?) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async { self.completion(data) }
    }
}

private struct InlineImageLoaderKey: EnvironmentKey {
    static var defaultValue: InlineImageLoader? { nil }
}

extension EnvironmentValues {
    var inlineImageLoader: InlineImageLoader? {
        get { self[InlineImageLoaderKey.self] }
        set { self[InlineImageLoaderKey.self] = newValue }
    }
}

@MainActor
final class InlineImageModel: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var failed = false
    private var request: InlineImageRequest?
    private var reference = ""

    func load(_ reference: String, loader: InlineImageLoader?) {
        guard reference != self.reference else { return }
        cancel()
        self.reference = reference
        failed = loader == nil || !InlineImageReference.isSupported(reference)
        guard let loader, !failed else { return }
        request = loader.load(reference) { [weak self] image in
            guard let self, self.reference == reference else { return }
            self.image = image
            self.failed = image == nil
            self.request = nil
        }
    }

    func cancel() {
        request?.cancel()
        request = nil
        reference = ""
        image = nil
        failed = false
    }
}

struct InlineImageView: View {
    let alt: [MarkdownInline]
    let destination: String
    @Environment(\.inlineImageLoader) private var loader
    @StateObject private var model = InlineImageModel()
    @State private var expanded = false

    private var altText: String {
        let value = alt.map(\.plainText).joined()
        return value.isEmpty ? ArtifactReferences.name(of: destination) : value
    }

    var body: some View {
        Group {
            if let image = model.image {
                Button { expanded = true } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 480)
                        .accessibilityLabel(Text(altText))
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $expanded) {
                    ZStack {
                        Color.black.ignoresSafeArea()
                        Image(uiImage: image).resizable().scaledToFit().ignoresSafeArea()
                        VStack {
                            HStack {
                                Spacer()
                                Button("关闭") { expanded = false }
                                    .padding(16)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Capsule())
                            }
                            Spacer()
                        }
                        .padding(12)
                    }
                }
            } else {
                Text("[\(altText)]")
                    .font(.body)
                    .foregroundColor(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { model.load(destination, loader: loader) }
        .onChange(of: destination) { model.load($0, loader: loader) }
        .onDisappear { model.cancel() }
    }
}
