import AVFoundation
import SwiftUI
import UIKit

/// Whether the camera can be used.
public enum CameraAccess: Equatable, Sendable {
    case notDetermined
    case granted
    case denied
    case restricted

    public init(_ status: AVAuthorizationStatus) {
        switch status {
        case .notDetermined: self = .notDetermined
        case .authorized: self = .granted
        case .denied: self = .denied
        case .restricted: self = .restricted
        @unknown default: self = .denied
        }
    }
}

/// Reads the pairing QR code the desktop shows.
///
/// Android hands the camera to ZXing inside a dedicated activity; iOS has QR
/// reading in AVFoundation, which is less code and no dependency. The scanner
/// itself stays deliberately narrow — it delivers the first code it reads and
/// then stops, because the payload is a one-time pairing code and re-reading the
/// same QR after a submission has gone in would restart a flow that is already
/// waiting on the desktop.
public final class QRCodeScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    public enum Failure: LocalizedError {
        case noCamera
        case cannotUseCamera(Error)
        case denied

        public var errorDescription: String? {
            switch self {
            case .noCamera:
                return "这台设备没有可用的相机。"
            case .cannotUseCamera(let error):
                return "无法打开相机：\(error.localizedDescription)"
            case .denied:
                return "相机权限已被拒绝，请在系统设置中允许后重试。"
            }
        }
    }

    /// The session the preview layer is attached to.
    public let session = AVCaptureSession()

    private let queue = DispatchQueue(label: "app.camellia.mobile.qr")
    private var handler: ((String) -> Void)?
    private var delivered = false
    private var configured = false

    public override init() { super.init() }

    // MARK: - Permission

    public static func access() -> CameraAccess {
        CameraAccess(AVCaptureDevice.authorizationStatus(for: .video))
    }

    public static func requestAccess(_ reply: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            reply(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video, completionHandler: reply)
        default:
            reply(false)
        }
    }

    // MARK: - Running

    /// Wires the camera up. Called once, before the session is started.
    public func configure() throws {
        guard !configured else { return }
        guard let device = AVCaptureDevice.default(for: .video) else { throw Failure.noCamera }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw Failure.cannotUseCamera(error)
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input) else { throw Failure.noCamera }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { throw Failure.noCamera }
        session.addOutput(output)
        // QR only. Reading every barcode type would also fire on any EAN or
        // Code128 the camera happens to see while the user aims at the screen.
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: queue)
        configured = true
    }

    /// Starts the camera. Safe to call more than once; the session ignores a
    /// start while it is already running.
    public func start() {
        queue.async { [weak self] in
            guard let self, self.configured, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    public func stop() {
        // The start may still be queued when the page disappears. Check the
        // running state on the same queue, after that start, not on the caller.
        queue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    /// Delivers the first code read. Replaces any handler set before it.
    public func onCode(_ handler: @escaping (String) -> Void) {
        queue.async {
            self.handler = handler
            self.delivered = false
        }
    }

    // MARK: - AVCaptureMetadataOutputObjectsDelegate

    public func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !delivered else { return }
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue, !value.isEmpty else { return }
        delivered = true
        let handler = self.handler
        DispatchQueue.main.async {
            handler?(value)
        }
    }
}

/// The view the camera draws into.
///
/// Its layer *is* the preview layer rather than holding one, so the session's
/// frames land without a subview that has to be kept in sync with the bounds.
public final class QRPreviewView: UIView {
    public override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    public var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

public struct QRCodeScannerView: UIViewRepresentable {
    public let scanner: QRCodeScanner

    public init(scanner: QRCodeScanner) {
        self.scanner = scanner
    }

    public func makeUIView(context: Context) -> QRPreviewView {
        let view = QRPreviewView()
        view.preview.videoGravity = .resizeAspectFill
        view.preview.session = scanner.session
        return view
    }

    public func updateUIView(_ uiView: QRPreviewView, context: Context) {}
}
