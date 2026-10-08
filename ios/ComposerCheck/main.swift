import Foundation
import SwiftUI
import UIKit

private enum ComposerCheck {
    static func run() -> Never {
        var submissions = 0
        var failures: [String] = []
        let sendField = ComposerField(
            text: .constant("draft"), height: .constant(0), focus: .constant(false),
            sendOnReturn: true, maxUTF16Length: 16_000,
            onSubmit: { submissions += 1 })
        let sendCoordinator = sendField.makeCoordinator()
        let textView = MeasuredTextView()
        textView.text = "draft"
        let range = NSRange(location: 5, length: 0)

        func expect(_ condition: Bool, _ name: String) {
            if !condition { failures.append(name) }
        }

        expect(!sendCoordinator.textView(textView, shouldChangeTextIn: range,
                                         replacementText: "\n"), "return sends")
        expect(submissions == 1, "return calls submit once")

        expect(sendCoordinator.textView(textView, shouldChangeTextIn: range,
                                        replacementText: "first\nsecond\n"),
               "multiline paste remains text")
        expect(submissions == 1, "multiline paste never submits")

        textView.isPasting = true
        expect(sendCoordinator.textView(textView, shouldChangeTextIn: range,
                                        replacementText: "\n"), "single pasted newline remains text")
        expect(submissions == 1, "single pasted newline never submits")
        textView.isPasting = false

        let buttonField = ComposerField(
            text: .constant("draft"), height: .constant(0), focus: .constant(false),
            sendOnReturn: false, maxUTF16Length: 16_000,
            onSubmit: { submissions += 1 })
        expect(buttonField.makeCoordinator().textView(textView, shouldChangeTextIn: range,
                                                      replacementText: "\n"),
               "button-only mode inserts newline")
        expect(submissions == 1, "button-only mode never submits")

        expect(ComposerField.limited("abc🐱z", to: 4) == "abc",
               "restored draft does not split a surrogate pair")
        expect(ComposerField.limited("abc🐱z", to: 5) == "abc🐱",
               "restored draft counts UTF-16 units")

        let fullField = ComposerField(
            text: .constant("abcd"), height: .constant(0), focus: .constant(false),
            sendOnReturn: false, maxUTF16Length: 4, onSubmit: {})
        let fullView = MeasuredTextView()
        fullView.text = "abcd"
        expect(!fullField.makeCoordinator().textView(
            fullView, shouldChangeTextIn: NSRange(location: 2, length: 0),
            replacementText: "Z"), "full draft rejects insertion")
        expect(fullView.text == "abcd", "full draft preserves its tail")

        let partialField = ComposerField(
            text: .constant("abcd"), height: .constant(0), focus: .constant(false),
            sendOnReturn: false, maxUTF16Length: 5, onSubmit: {})
        let partialView = MeasuredTextView()
        partialView.text = "abcd"
        expect(!partialField.makeCoordinator().textView(
            partialView, shouldChangeTextIn: NSRange(location: 2, length: 0),
            replacementText: "XY"), "overflowing insertion is shortened")
        expect(partialView.text == "abXcd", "partial insertion preserves the tail")
        expect(partialView.selectedRange.location == 3, "caret follows accepted text")

        let emojiView = MeasuredTextView()
        emojiView.text = "abcd"
        expect(!partialField.makeCoordinator().textView(
            emojiView, shouldChangeTextIn: NSRange(location: 2, length: 0),
            replacementText: "🐱"), "surrogate pair does not half-insert")
        expect(emojiView.text == "abcd", "surrogate rejection preserves the draft")

        let verdict = failures.isEmpty ? "PASS" : "FAIL"
        NSLog("[composer-check] verdict=%@ failures=%@", verdict,
              failures.isEmpty ? "none" : failures.joined(separator: ", "))
        exit(failures.isEmpty ? 0 : 1)
    }
}

private final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = UIViewController()
        window?.makeKeyAndVisible()
        DispatchQueue.main.async { ComposerCheck.run() }
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil,
                  NSStringFromClass(AppDelegate.self))
