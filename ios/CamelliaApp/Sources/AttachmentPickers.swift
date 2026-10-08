import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Picks images out of the photo library.
///
/// `PHPickerViewController` rather than `UIImagePickerController` because it
/// runs out of process: the picker never gets access to the whole library, only
/// to what was chosen, and the app needs no photo-library permission at all.
/// That is also why it is preferred over SwiftUI's `PhotosPicker`, which does
/// not exist before iOS 16 and this ships to iOS 15.
struct PhotoPicker: UIViewControllerRepresentable {
    /// How many images the desktop will take in one message.
    let limit: Int
    let onPicked: ([AttachmentImage.Encoded]) -> Void
    let onCancel: () -> Void
    let onFailure: () -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = max(1, limit)
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let parent: PhotoPicker

        init(_ parent: PhotoPicker) { self.parent = parent }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !results.isEmpty else {
                parent.onCancel()
                return
            }
            load(results, at: 0, encoded: [])
        }

        private func load(_ results: [PHPickerResult], at index: Int,
                          encoded: [AttachmentImage.Encoded]) {
            guard index < results.count else {
                DispatchQueue.main.async { self.parent.onPicked(encoded) }
                return
            }
            let provider = results[index].itemProvider
            guard let type = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .image) == true
            }) else {
                DispatchQueue.main.async { self.parent.onFailure() }
                return
            }
            // A file representation is valid only during this callback. Decode
            // a bounded thumbnail there, then retain only the JPEG bytes. Doing
            // one at a time preserves selection order without keeping twenty
            // full-resolution UIImages alive at once.
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                do {
                    guard let url else { throw AttachmentError.unreadableImage }
                    let image = try PickedFile(name: url.lastPathComponent, url: url).loadImage()
                    let result = try AttachmentImage.encode(image)
                    self.load(results, at: index + 1, encoded: encoded + [result])
                } catch {
                    DispatchQueue.main.async { self.parent.onFailure() }
                }
            }
        }
    }
}

/// Takes a photo to attach.
///
/// The only place `UIImagePickerController` is still the right answer: there is
/// no SwiftUI camera, and this is the one source that has to be in process. The
/// photo goes straight into the attachment store, so nothing is written to the
/// library and no photo-library add permission is needed for it.
struct CameraPicker: UIViewControllerRepresentable {
    let onPicked: (UIImage) -> Void
    let onCancel: () -> Void

    /// A simulator, and a device without a camera, has to be told so rather
    /// than presented a controller that shows nothing.
    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onPicked(image)
            } else {
                parent.onCancel()
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}

/// A file the person chose to attach, including images chosen from Files.
struct PickedFile {
    let name: String
    let url: URL

    var isImage: Bool {
        if let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType,
           type.conforms(to: .image) { return true }
        return UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true
    }

    func readData() throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try ChatDocument.readFile(at: url, limit: AttachmentLimits.documentMaxBytes)
    }

    func loadImage() throws -> UIImage {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: AttachmentLimits.imageMaxSide,
              ] as CFDictionary) else { throw AttachmentError.unreadableImage }
        return UIImage(cgImage: image)
    }
}

/// Picks files from the Files app.
///
/// `asCopy: true` asks the picker for a temporary copy inside this app's
/// container. The bytes are sealed into the attachment store; no provider URL
/// is retained in the chat draft.
struct DocumentPicker: UIViewControllerRepresentable {
    let onPicked: ([PickedFile]) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let controller = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        controller.allowsMultipleSelection = true
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        private let parent: DocumentPicker

        init(_ parent: DocumentPicker) { self.parent = parent }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            parent.onPicked(urls.map { PickedFile(name: $0.lastPathComponent, url: $0) })
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            parent.onCancel()
        }
    }
}
