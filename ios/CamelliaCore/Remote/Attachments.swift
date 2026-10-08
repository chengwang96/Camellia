import Foundation

/// The numbers both chat modes share.
///
/// Ported from `ChatAttachments.java` field for field. They are the desktop's
/// limits, not the phone's: the phone checks them so the refusal is about the
/// file the person is looking at rather than a round trip, and the desktop
/// checks them again because it is the authority.
public enum AttachmentLimits {
    public static let maxCount = 20
    public static let imageMaxBytes = 4 * 1024 * 1024
    /// Longest side after compression. Images are scaled down to this before
    /// the JPEG quality is walked, so a photo is never refused for being large.
    public static let imageMaxSide = 3072
    public static let documentMaxBytes = 10 * 1024 * 1024
    /// Only remote mode has a transfer budget; local chat has no desktop to
    /// feed.
    public static let remoteMaxBytes: Int64 = 32 * 1024 * 1024

    /// What a desktop that predates the expanded limits accepts. Kept because
    /// the phone still has to talk to one, and refusing to guess would mean
    /// offering a send the desktop then rejects.
    public static let legacyRemoteCount = 9
    public static let legacyRemoteBytes: Int64 = 8 * 1024 * 1024
    public static let legacyImageBytes = 1024 * 1024
}

/// Why an attachment was refused, in the words the person sees.
public enum AttachmentError: Error, Equatable, LocalizedError {
    case tooMany(count: Int)
    case imageTooBig
    case documentTooBig
    case remoteTotalTooBig
    case remoteTooMany(count: Int)
    case remoteLegacyTotalTooBig
    case documentsUnsupported
    case legacyImageTooBig
    case missing
    case storageUnavailable
    case unreadableImage
    case imageTooLargeAfterCompression

    public var errorDescription: String? {
        switch self {
        case .tooMany(let count):
            return "每条消息最多 \(count) 个附件 / Up to \(count) attachments per message"
        case .imageTooBig:
            return "图片压缩后不能超过 4 MiB / Compressed image exceeds 4 MiB"
        case .documentTooBig:
            return "单个文档不能超过 10 MiB / Document exceeds 10 MiB"
        case .remoteTotalTooBig:
            return "远程附件合计不能超过 32 MiB / Remote attachments exceed 32 MiB total"
        case .remoteTooMany(let count):
            return "当前电脑最多 \(count) 个附件，更新电脑端可提高限额 / This desktop supports \(count) attachments; update it for higher limits"
        case .remoteLegacyTotalTooBig:
            return "当前电脑附件合计最多 8 MiB，更新电脑端可提高至 32 MiB / This desktop supports 8 MiB total; update it for 32 MiB"
        case .documentsUnsupported:
            return "发送文档需要更新并重启电脑端 / Update and restart the desktop to send documents"
        case .legacyImageTooBig:
            return "当前电脑每张图片最多 1 MiB，更新电脑端可提高限额 / This desktop supports 1 MiB per image; update it for higher limits"
        case .missing:
            return "附件已丢失，请重新添加 / Attachment is missing; select it again"
        case .storageUnavailable:
            return "附件不可用，请重新添加 / Attachment unavailable; select it again"
        case .unreadableImage:
            return "Unreadable image"
        case .imageTooLargeAfterCompression:
            return "Image too large"
        }
    }
}

/// One file on its way to the desktop.
///
/// `data` is deliberately not always base64. A file the person just picked is
/// kept encrypted on disk and travels as a `camellia-blob:` reference until the
/// moment it is sent; only a draft resumed from saved state carries raw base64.
/// `AttachmentStore` is what knows the difference, which is why nothing here
/// touches the bytes.
public struct RemoteAttachment: Sendable, Equatable {
    public let name: String
    public let data: String
    public let isImage: Bool

    public init(name: String, data: String, isImage: Bool) {
        self.name = name
        self.data = data
        self.isImage = isImage
    }

    public init?(_ json: JSONObject) {
        let reference = json.text("data")
        guard !reference.isEmpty else { return nil }
        self.init(name: json.text("name"), data: reference, isImage: json.bool("isImage"))
    }

    public var json: [String: Any] {
        ["name": name, "data": data, "isImage": isImage]
    }
}

/// The rules the composer enforces before a send.
///
/// A pure function of the selection and the desktop's advertised capabilities,
/// so the whole thing is checkable on a host — which matters because these are
/// the rules that decide whether a send is offered at all, and the Android
/// client states them in the same three shapes (`validate`, `remoteCount`,
/// `validateRemote`).
public enum AttachmentRules {
    /// The one-line note under the attach sheet.
    public static func limits(remote: Bool) -> String {
        "最多 20 个附件 · 图片 4 MiB/张 · 文档 10 MiB/个" + (remote ? " · 合计 32 MiB" : "")
    }

    /// What a desktop that advertises the expanded capability offers instead.
    public static func legacyLimits(files: Bool) -> String {
        files
            ? "当前电脑最多 9 个附件 · 合计 8 MiB；更新电脑端可提高限额。"
            : "更新并重启电脑端后，可发送文档及最多 20 个附件。"
    }

    /// How many attachments one message may carry on this desktop.
    ///
    /// Three tiers, exactly as Android computes them: the expanded capability
    /// means the full twenty, either older attachment capability means the
    /// legacy nine, and a desktop that only takes a single image means one.
    public static func remoteCount(expanded: Bool, files: Bool, multiImage: Bool) -> Int {
        expanded ? AttachmentLimits.maxCount : (files || multiImage ? AttachmentLimits.legacyRemoteCount : 1)
    }

    /// Checks a selection against the absolute limits, before any desktop
    /// capability is considered.
    public static func validate(_ attachments: [RemoteAttachment], sizes: [String: Int64]) throws {
        guard attachments.count <= AttachmentLimits.maxCount else {
            throw AttachmentError.tooMany(count: AttachmentLimits.maxCount)
        }
        for attachment in attachments {
            guard let size = sizes[attachment.data] else { throw AttachmentError.missing }
            if attachment.isImage {
                guard size <= Int64(AttachmentLimits.imageMaxBytes) else { throw AttachmentError.imageTooBig }
            } else {
                guard size <= Int64(AttachmentLimits.documentMaxBytes) else { throw AttachmentError.documentTooBig }
            }
        }
    }

    /// Checks a selection against what this particular desktop will take.
    ///
    /// The fallback path is not decoration. A desktop too old to advertise
    /// `attachments` still accepts images, but only one per message and only up
    /// to a megabyte each, and only a client that says so can turn that into a
    /// sentence the person understands instead of a silent rejection.
    public static func validateRemote(_ attachments: [RemoteAttachment], sizes: [String: Int64],
                                      expanded: Bool, files: Bool, multiImage: Bool) throws {
        try validate(attachments, sizes: sizes)
        // validate established that every attachment has a size in this
        // immutable map; a missing entry cannot silently become zero bytes.
        let total = attachments.reduce(Int64(0)) { $0 + sizes[$1.data]! }
        guard total <= AttachmentLimits.remoteMaxBytes else { throw AttachmentError.remoteTotalTooBig }
        if expanded { return }
        let count = remoteCount(expanded: false, files: files, multiImage: multiImage)
        guard attachments.count <= count else { throw AttachmentError.remoteTooMany(count: count) }

        if files {
            guard total <= AttachmentLimits.legacyRemoteBytes else { throw AttachmentError.remoteLegacyTotalTooBig }
        } else {
            guard !attachments.contains(where: { !$0.isImage }) else { throw AttachmentError.documentsUnsupported }
            for attachment in attachments where sizes[attachment.data]! > Int64(AttachmentLimits.legacyImageBytes) {
                throw AttachmentError.legacyImageTooBig
            }
        }
    }

    /// The wire shape: images first, named the way the desktop expects, then
    /// documents under the names they arrived with.
    public static func payload(_ attachments: [RemoteAttachment]) -> [[String: Any]] {
        var files: [[String: Any]] = []
        var imageIndex = 0
        for attachment in attachments where attachment.isImage {
            imageIndex += 1
            files.append(RemoteAttachment(name: "mobile-image-\(imageIndex).jpg",
                                          data: attachment.data, isImage: true).json)
        }
        for attachment in attachments where !attachment.isImage {
            files.append(attachment.json)
        }
        return files
    }

    /// Rebuilds a selection from a saved draft.
    ///
    /// Three generations of shape are accepted, because a draft written by an
    /// older build is still a draft the person expects to find: `attachments`
    /// is the current one, `images` the one before it, and `image` the one
    /// before that.
    public static func restore(_ payload: JSONObject) -> [RemoteAttachment] {
        let files = payload.objects("attachments")
        if !files.isEmpty {
            return files.compactMap(RemoteAttachment.init)
        }
        let legacy = payload.strings("images")
        if !legacy.isEmpty {
            return legacy.enumerated().map {
                RemoteAttachment(name: "mobile-image-\($0.offset + 1).jpg", data: $0.element, isImage: true)
            }
        }
        let single = payload.string("image")
        if let single, !single.isEmpty {
            return [RemoteAttachment(name: "mobile-image-1.jpg", data: single, isImage: true)]
        }
        return []
    }

    /// Whether the legacy single-image field should be used instead of the
    /// attachment list, which is how a desktop too old for `attachments` is
    /// still sent its one image.
    public static func legacyField(for attachments: [RemoteAttachment]) -> (key: String, value: Any)? {
        guard !attachments.isEmpty else { return nil }
        if attachments.count == 1, let only = attachments.first, only.isImage {
            return ("image", only.data)
        }
        if attachments.allSatisfy({ $0.isImage }) {
            return ("images", attachments.map(\.data))
        }
        return nil
    }
}
