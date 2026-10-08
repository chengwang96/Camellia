import SwiftUI
import UIKit

/// The message field, with the insets Android's `ComposerInput` carries and none
/// of its own.
///
/// It reports how tall it wants to be instead of being asked. SwiftUI hands a
/// `UIViewRepresentable` the height of the space it is in and the view fills it —
/// a text view asked for its size hands back the proposal, and turning scrolling
/// off does not change that — so an empty composer grew to the four-line ceiling
/// beside Android's one-line floor. What the view *can* do is lay its own text
/// out and say how many lines it came to, which is the arithmetic Android's
/// `EditText` does under `maxLines 4`.
struct ComposerField: UIViewRepresentable {
    @Binding var text: String
    /// How tall the text comes to, in whole lines, reported back as it changes.
    @Binding var height: CGFloat
    /// Focus is driven from outside, because tapping the send button is not the
    /// only thing that asks for the keyboard: a conversation that opens asking
    /// to be written in does too.
    var focus: Binding<Bool>
    /// The Android composer labels its default Return action as Send. Handle
    /// that action here, not by inspecting the resulting draft: pasted text
    /// may also end in a newline and must never submit a message.
    var sendOnReturn: Bool
    /// Android's `InputFilter.LengthFilter` counts UTF-16 code units and
    /// limits the replacement at the caret, rather than clipping the draft's
    /// tail after every edit.
    var maxUTF16Length: Int
    var onSubmit: () -> Void

    static let font = UIFont.systemFont(ofSize: 16)

    /// Where the field starts: Android's `minHeight dp(48)` less the 12 points
    /// of its own insets, so an empty bar measures 48 either side of the pair.
    static let floorHeight: CGFloat = 24

    /// Where it stops growing: Android's `setMaxLines(4)`.
    static var fourLines: CGFloat { (font.lineHeight * 4).rounded(.up) }

    /// `setText` is filtered on Android too, so callers use this for drafts
    /// restored or filled by edit mode without going through the text view.
    static func limited(_ value: String, to maximum: Int) -> String {
        let source = value as NSString
        guard source.length > maximum else { return value }
        return source.substring(to:wholeScalarEnd(in: source, at: maximum))
    }

    private static func wholeScalarEnd(in source: NSString, at offset: Int) -> Int {
        guard offset > 0 else { return 0 }
        let last = source.character(at: offset - 1)
        return (0xD800...0xDBFF).contains(last) ? offset - 1 : offset
    }

    func makeUIView(context: Context) -> UITextView {
        let view = MeasuredTextView()
        view.delegate = context.coordinator
        view.onMeasure = { [weak coordinator = context.coordinator] wanted in
            coordinator?.report(wanted)
        }
        view.font = Self.font
        view.textColor = Palette.inkUI
        // Transparent, like the `EditText`: the bar behind it is what is drawn,
        // and the field is the 12/12/8/12 inset inside it.
        view.backgroundColor = .clear
        view.isScrollEnabled = false
        // Android turns the bar off too; a draft is measured in lines, and a
        // scrollbar beside two of them is noise.
        view.showsVerticalScrollIndicator = false
        view.clipsToBounds = true
        // Both of UIKit's own insets go, so the SwiftUI padding is the whole of
        // the spacing and the first line starts exactly where Android's does.
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.returnKeyType = sendOnReturn ? .send : .default
        // A text view would rather be as wide as its text; it is the bar that
        // decides the width.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        let keyType: UIReturnKeyType = sendOnReturn ? .send : .default
        if view.returnKeyType != keyType {
            view.returnKeyType = keyType
            if view.isFirstResponder { view.reloadInputViews() }
        }
        // Assigning `text` resets the selection to the end, so it is only done
        // when the two actually differ — otherwise every keystroke would move
        // the caret out from under an edit in the middle of a line. The
        // differences that do arrive include a draft cut back to the length
        // limit. A Send Return is refused by the delegate before insertion.
        if view.text != text {
            view.text = text
            (view as? MeasuredTextView)?.measure()
        }
        // Past four lines the field keeps the four and scrolls inside them,
        // which is what Android's `maxLines 4` does. Scrolling is safe here only
        // because the frame is computed from the line count rather than from
        // anything the view says about itself: a scroll view offered the height
        // it wants would be offered nothing at all.
        if let measured = view as? MeasuredTextView {
            view.isScrollEnabled = measured.measuredHeight > Self.fourLines
        }
        if focus.wrappedValue, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !focus.wrappedValue, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerField

        init(_ parent: ComposerField) { self.parent = parent }

        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange,
                      replacementText replacement: String) -> Bool {
            let pasting = (view as? MeasuredTextView)?.isPasting ?? false
            if parent.sendOnReturn, replacement == "\n", !pasting {
                parent.onSubmit()
                return false
            }

            let available = parent.maxUTF16Length - (view.textStorage.length - range.length)
            let incoming = replacement as NSString
            guard incoming.length > available else { return true }
            guard available > 0 else { return false }
            let length = ComposerField.wholeScalarEnd(in: incoming, at: available)
            guard length > 0 else { return false }
            view.textStorage.replaceCharacters(in: range, with: incoming.substring(to: length))
            view.selectedRange = NSRange(location: range.location + length, length: 0)
            textViewDidChange(view)
            return false
        }

        func textViewDidChange(_ view: UITextView) {
            (view as? MeasuredTextView)?.measure()
            if parent.text != view.text { parent.text = view.text }
        }

        func textViewDidBeginEditing(_ view: UITextView) {
            if !parent.focus.wrappedValue { parent.focus.wrappedValue = true }
        }

        func textViewDidEndEditing(_ view: UITextView) {
            if parent.focus.wrappedValue { parent.focus.wrappedValue = false }
        }

        /// Hands a new height up, one whole line at a time.
        ///
        /// The write is deferred because it can be asked for from inside a
        /// layout pass, and changing state during one is what SwiftUI warns
        /// about. Whole lines rather than the exact height, because Android's
        /// bar grows a line at a time too.
        func report(_ wanted: CGFloat) {
            let lines = max(1, Int((wanted / ComposerField.font.lineHeight).rounded(.up)))
            let height = CGFloat(lines) * ComposerField.font.lineHeight
            guard abs(height - parent.height) > 0.5 else { return }
            DispatchQueue.main.async { [parent] in parent.height = height }
        }
    }
}

/// A text view that says how tall its text comes to.
///
/// It measures whenever either of the two things the answer depends on changes:
/// the text, and the width it has to fit into.
final class MeasuredTextView: UITextView {
    var onMeasure: ((CGFloat) -> Void)?
    var isPasting = false
    /// The height the text last came to, so the field can be told whether it
    /// still fits inside the four lines.
    private(set) var measuredHeight: CGFloat = 0
    private var measuredWidth: CGFloat = 0

    override func paste(_ sender: Any?) {
        isPasting = true
        defer { isPasting = false }
        super.paste(sender)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width > 0, abs(bounds.width - measuredWidth) > 0.5 {
            measuredWidth = bounds.width
            measure()
        }
    }

    func measure() {
        let font = self.font ?? ComposerField.font
        if bounds.width > 0 {
            let box = ((text ?? "") as NSString).boundingRect(
                with: CGSize(width: bounds.width, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: font],
                context: nil)
            measuredHeight = box.height
        } else {
            // Nothing is known about the wrap yet, and one line is what an empty
            // draft comes to anyway.
            measuredHeight = font.lineHeight
        }
        onMeasure?(measuredHeight)
    }
}
