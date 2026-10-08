import Foundation
import SwiftUI

final class MarkdownCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}

/// One worker for the whole app, one latest pending version per visible owner,
/// and at most 32 pending owners. The next job starts after the UI acknowledges
/// the previous result, so parsing cannot accumulate main-queue deliveries.
@MainActor
final class MarkdownRenderScheduler {
    static let shared = MarkdownRenderScheduler()
    private struct Job: Sendable {
        let owner: UUID
        let revision: Int
        let text: String
        let final: Bool
        let cancellation = MarkdownCancellation()
        let deliver: @MainActor @Sendable (MarkdownDocument, Int) -> Void
    }
    private let worker = DispatchQueue(label: "app.camellia.markdown", qos: .userInitiated)
    private let cache = MarkdownDocumentCache()
    private let parse: @Sendable (String, MarkdownCancellation) -> MarkdownDocument
    private var pending: [UUID: Job] = [:]
    private var order: [UUID] = []
    private var running: Job?
    var pendingCount: Int { pending.count }
    var runningCount: Int { running == nil ? 0 : 1 }

    init(parse: @escaping @Sendable (String, MarkdownCancellation) -> MarkdownDocument = {
        text, cancellation in MarkdownParser.parse(text, isCancelled: { cancellation.isCancelled })
    }) { self.parse = parse }

    func request(owner: UUID, revision: Int, text: String, final: Bool,
                 deliver: @escaping @MainActor @Sendable (MarkdownDocument, Int) -> Void) {
        let job = Job(owner: owner, revision: revision, text: text, final: final, deliver: deliver)
        pending[owner] = job
        order.removeAll { $0 == owner }
        if final { order.insert(owner, at: 0) } else { order.append(owner) }
        if final, running?.owner == owner { running?.cancellation.cancel() }
        if pending.count > 32, let oldest = order.last, let evicted = pending.removeValue(forKey: oldest) {
            order.removeAll { $0 == oldest }
            evicted.deliver(MarkdownDocument(blocks: [], truncated: true, source: evicted.text), evicted.revision)
        }
        startNext()
    }

    func cancel(owner: UUID) {
        pending.removeValue(forKey: owner)
        order.removeAll { $0 == owner }
        if running?.owner == owner { running?.cancellation.cancel() }
    }

    private func startNext() {
        guard running == nil, !order.isEmpty else { return }
        let owner = order.removeFirst()
        guard let job = pending.removeValue(forKey: owner) else { return }
        running = job
        let parse = parse, cache = cache
        worker.async { [weak self] in
            let document: MarkdownDocument
            if job.final, let cached = cache.document(for: job.text) { document = cached }
            else { document = parse(job.text, job.cancellation) }
            if job.final, !job.cancellation.isCancelled { cache.insert(document) }
            Task { @MainActor in
                guard let self else { return }
                if !job.cancellation.isCancelled { job.deliver(document, job.revision) }
                self.running = nil
                self.startNext()
            }
        }
    }
}

@MainActor
final class MarkdownRenderModel: ObservableObject {
    @Published private(set) var document: MarkdownDocument?
    private let owner = UUID()
    private let scheduler: MarkdownRenderScheduler
    private var revision = 0
    private var appliedRevision = 0

    init(scheduler: MarkdownRenderScheduler? = nil) { self.scheduler = scheduler ?? .shared }

    func update(_ text: String, streaming: Bool) {
        revision += 1
        scheduler.request(owner: owner, revision: revision, text: text, final: !streaming) { [weak self] document, version in
            guard let self, version >= self.appliedRevision else { return }
            self.appliedRevision = version
            self.document = document
        }
    }

    func cancel() { scheduler.cancel(owner: owner) }
}

/// Source text remains readable while its first background parse is pending.
struct AsyncMarkdownView: View {
    let text: String
    var streaming = false
    @StateObject private var model = MarkdownRenderModel()

    var body: some View {
        MarkdownView(document: model.document ?? MarkdownDocument(blocks: [], truncated: true, source: text))
            .onAppear { model.update(text, streaming: streaming) }
            .onChange(of: text) { model.update($0, streaming: streaming) }
            .onChange(of: streaming) { model.update(text, streaming: $0) }
            .onDisappear { model.cancel() }
    }
}
