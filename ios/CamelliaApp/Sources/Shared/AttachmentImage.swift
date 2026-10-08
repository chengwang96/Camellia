import UIKit

/// Compresses a picked image the way the desktop expects to receive it.
///
/// Ported from `ChatImage.java`. The picker performs the Android-style sampling
/// step before this encoder receives a Photos or Files image. The
/// rules that reach the wire are the same and they are the ones that matter:
/// the longest side is capped at 3072, the JPEG quality is walked down from 90
/// in fives until the result fits in 4 MiB, and a 384-pixel thumbnail is
/// written alongside so the composer can show a tray without holding a
/// four-megabyte photo per attachment in memory.
///
/// Camera images arrive from UIKit as an already-decoded UIImage; Photos and
/// Files are downsampled through ImageIO before this function to avoid decoding
/// several full-resolution photos at once.
enum AttachmentImage {
    /// What a compressed image and its thumbnail come back as.
    struct Encoded {
        let data: Data
        let preview: Data
    }

    static func encode(_ image: UIImage, maxSide: Int = AttachmentLimits.imageMaxSide,
                       maxBytes: Int = AttachmentLimits.imageMaxBytes) throws -> Encoded {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0, image.cgImage != nil || image.ciImage != nil else {
            throw AttachmentError.unreadableImage
        }

        let scaled = longest > CGFloat(maxSide) ? resize(image, longestSide: CGFloat(maxSide)) : image

        // Walk the quality down until it fits, keeping the last attempt so a
        // photo that never fits is refused for its size rather than for a nil
        // encode — the message the person sees should be about the file.
        var jpeg = Data()
        for quality in stride(from: 90, through: 60, by: -5) {
            jpeg = scaled.jpegData(compressionQuality: CGFloat(quality) / 100) ?? Data()
            if jpeg.count <= maxBytes { break }
        }
        guard !jpeg.isEmpty else { throw AttachmentError.unreadableImage }
        guard jpeg.count <= maxBytes else { throw AttachmentError.imageTooLargeAfterCompression }

        // 384 on the longest side at quality 82: Android's preview settings, and
        // small enough that a tray of twenty stays cheap.
        let preview = resize(scaled, longestSide: 384).jpegData(compressionQuality: 0.82) ?? Data()
        return Encoded(data: jpeg, preview: preview)
    }

    /// Draws `image` into a box whose longest side is `longestSide`, never
    /// enlarging it.
    private static func resize(_ image: UIImage, longestSide: CGFloat) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest > longestSide, longest > 0 else { return image }
        let scale = longestSide / longest
        let size = CGSize(width: max(1, (image.size.width * scale).rounded()),
                          height: max(1, (image.size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat.default()
        // The size above is already in pixels — `UIImage.size` for a picked
        // photo is its pixel count — so the renderer must not scale it again.
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
