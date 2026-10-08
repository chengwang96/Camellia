import Foundation
import UIKit
import Tailnet

/// The S1 acceptance run, executed inside a real iOS process.
///
/// `gomobile` producing an xcframework only proves the Go code compiles for
/// `ios/arm64`. It says nothing about whether tsnet's userspace stack actually
/// starts under the iOS sandbox, which is the one part of the design that could
/// not be settled from the desktop. This app settles it: it boots the node for
/// real and reports what the bridge answers.
///
/// Exit codes: 0 the node started, 1 the node did not start.
enum Smoke {
    private static let tag = "[camellia-smoke] "

    static func note(_ text: String) {
        let line = tag + text + "\n"
        FileHandle.standardOutput.write(Data(line.utf8))
        NSLog("%@", line.trimmingCharacters(in: .newlines))
    }

    static func run() -> Never {
        let started = Date()
        note("begin pid=\(ProcessInfo.processInfo.processIdentifier)")

        let environment = ProcessInfo.processInfo.environment
        let requested = environment["CAMELLIA_INJECT_INTERFACES"] == "1"
        note("injectsInterfaces=\(EmbeddedNetwork.shared.injectsInterfaces) requested=\(requested)")

        // The Keychain is unreachable from an unsigned bundle, and a bundle that
        // claims the entitlement without a provisioning profile will not launch.
        // The harness therefore swaps in a file-backed store; everything else it
        // exercises is the shipping code path. See FileNodeStateStore.
        EmbeddedNetwork.shared.makeStore = { FileNodeStateStore() }

        // Deleting the app does not clear a Keychain item, so a clean run has to
        // say so explicitly. It also exercises `forget()`.
        if environment["CAMELLIA_SMOKE_RESET"] == "1" {
            do {
                try EmbeddedNetwork.shared.forget()
                note("reset=ok")
            } catch {
                note("reset-failed=\(error.localizedDescription)")
            }
        }

        // getifaddrs inside the sandbox. Informational: it tells us whether an
        // interface list can be produced at all, which is what the escape hatch
        // would need.
        do {
            let snapshot = try InterfaceSnapshot().encode()
            note("interfaces=\(snapshot)")
        } catch {
            note("interfaces-error=\(error.localizedDescription)")
        }

        EmbeddedNetwork.shared.start()

        do {
            _ = try EmbeddedNetwork.shared.currentNode()
        } catch let failure as EmbeddedNetwork.Failure {
            note("node-start-failed code=\(failure.code.rawValue)")
            note("node-start-failed detail=\(failure.detail ?? "-")")
            note("verdict=FAIL node did not start")
            exit(1)
        } catch {
            note("node-start-failed untyped=\(error.localizedDescription)")
            note("verdict=FAIL node did not start")
            exit(1)
        }
        note("node-started in \(String(format: "%.2f", Date().timeIntervalSince(started)))s")

        // The end-of-stream contract, checked before anything is dialled.
        //
        // gomobile collapses a zero-length []byte to NULL on the Objective-C
        // side, and `ReadChunk` returns exactly that at every EOF, so the Swift
        // reader meets this on every stream it finishes. It is checked first
        // because a crash here would be indistinguishable from a crash later.
        endOfStream()

        guard var status = try? EmbeddedNetwork.shared.status() else {
            note("status-unreadable")
            note("verdict=FAIL node started but reported no state")
            exit(1)
        }
        note("status state=\(status.state) loginUrl=\(status.loginUrl.isEmpty ? "-" : "present")")

        // A node that is signed in already can be dialled straight away.
        if status.state == "Running" {
            note("sign-in=already-signed-in")
            probe()
            note("verdict=PASS node running")
            exit(0)
        }

        // Otherwise drive the sign-in far enough to prove the control plane was
        // reached and handed back a real authorisation URL. Completing the
        // sign-in is interactive and belongs to the person holding the phone.
        do {
            try EmbeddedNetwork.shared.login()
            note("login-requested")
        } catch {
            note("login-failed \(error.localizedDescription)")
        }

        // Hold the node open while the sign-in is still actionable. The URL is
        // only useful while this process is alive to poll for its result, so
        // exiting as soon as the URL is printed would leave nothing to complete
        // the sign-in against.
        //
        // There is no early exit for "no URL yet": the control plane takes a
        // variable amount of time to answer, so a short cut-off would turn a
        // slow but healthy sign-in into a failure. A heartbeat reports progress
        // instead, and CAMELLIA_SMOKE_LOGIN_WAIT bounds the wait.
        let wait = Double(environment["CAMELLIA_SMOKE_LOGIN_WAIT"] ?? "") ?? 120
        let deadline = Date().addingTimeInterval(wait)
        let loginStarted = Date()
        var announced = false
        var heartbeat = Date().addingTimeInterval(10)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 2)
            guard let current = try? EmbeddedNetwork.shared.status() else { continue }
            status = current
            if !announced, let url = EmbeddedNetwork.loginURL(current.loginUrl) {
                announced = true
                note("login-url=\(url.absoluteString)")
                note("login-open xcrun simctl openurl booted \(url.absoluteString)")
                note("login-wait the node stays up for \(Int(wait))s; sign in to finish")
            }
            if current.state == "Running" { break }
            if Date() >= heartbeat {
                heartbeat = Date().addingTimeInterval(10)
                let elapsed = Int(Date().timeIntervalSince(loginStarted))
                note("login-waiting state=\(current.state) elapsed=\(elapsed)s")
            }
        }

        if !status.loginUrl.isEmpty, EmbeddedNetwork.loginURL(status.loginUrl) == nil {
            note("login-url-rejected=\(status.loginUrl)")
        }
        if !announced { note("login-url=none") }
        note("final state=\(status.state)")

        if status.state == "Running" {
            probe()
            note("verdict=PASS node signed in")
            exit(0)
        }
        if status.state == "NeedsLogin" || !status.loginUrl.isEmpty {
            note("verdict=PASS node reached the control plane and wants a sign-in")
            exit(0)
        }
        note("verdict=FAIL unexpected state \(status.state)")
        exit(1)
    }

    /// Proves that the end of a stream arrives as an end, not as a failure.
    ///
    /// `bridge.go` answers `ReadChunk` with a zero-length slice once the body is
    /// drained, gomobile's `fromSlice` collapses every zero-length slice to
    /// NULL, and Swift's import of the method cannot represent NULL — so the end
    /// of a stream surfaces as a thrown error unless the caller checks
    /// `Finished()`. `nextChunk` does that check; this confirms it.
    private static func endOfStream() {
        do {
            let node = try EmbeddedNetwork.shared.currentNode()
            // A response that was prepared but never executed has no body, so
            // the bridge takes the same "nothing to read" branch it takes at EOF.
            let response = try node.prepare(
                "GET", target: "http://100.100.100.100:43127/v1/status", token: "", payload: ""
            )
            defer { response.close() }
            if let chunk = try response.nextChunk() {
                note("eof=fail unexpected \(chunk.count) bytes on an unexecuted response")
                return
            }
            guard response.finished() else {
                note("eof=fail ended without the bridge reporting it finished")
                return
            }
            note("eof=clean-end")
        } catch {
            note("eof=fail \(describe(error))")
        }
    }

    private static func describe(_ error: Error) -> String {
        (error as NSError).userInfo[NSLocalizedDescriptionKey] as? String ?? error.localizedDescription
    }

    /// Dials the desktop gateway when a target was supplied.
    ///
    /// `SIMCTL_CHILD_CAMELLIA_SMOKE_TARGET` and `..._TOKEN` reach the app
    /// through `simctl`. Without them this is skipped: reaching a desktop needs
    /// two nodes in the same tailnet, which is a step for the operator.
    private static func probe() {
        let environment = ProcessInfo.processInfo.environment
        guard let target = environment["CAMELLIA_SMOKE_TARGET"], !target.isEmpty else {
            note("probe=skipped (no CAMELLIA_SMOKE_TARGET)")
            return
        }
        let token = environment["CAMELLIA_SMOKE_TOKEN"] ?? ""
        note("probe target=\(target)")
        do {
            let node = try EmbeddedNetwork.shared.currentNode()
            let response = try node.open("GET", target: target, token: token, payload: "")
            defer { response.close() }
            let body = try response.readAll(limit: 1 << 20)
            note("probe status=\(response.statusCode()) contentType=\(response.contentType()) bytes=\(body.count)")
            note("probe body=\(String(decoding: body.prefix(2000), as: UTF8.self))")
        } catch {
            // A CAMELLIA_* code here is a pass for the bridge: the request went
            // out and came back classified rather than crashing.
            let message = describe(error)
            let code = ConnectionFailureCode.parse(message).map(\.rawValue) ?? "none"
            note("probe code=\(code) message=\(message)")
        }
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = UIViewController()
        window?.makeKeyAndVisible()
        DispatchQueue.global(qos: .userInitiated).async { Smoke.run() }
        return true
    }
}

UIApplicationMain(
    CommandLine.argc,
    CommandLine.unsafeArgv,
    nil,
    NSStringFromClass(AppDelegate.self)
)
