import Foundation

/// Gesture decisions are independent of UIKit, so cancellation and edge jitter
/// can be checked without synthesising touches or waiting for an animation.
public enum PageBackGesture {
    public static func progress(translation: Double, width: Double) -> Double {
        guard width > 0 else { return 0 }
        return min(1, max(0, translation / width))
    }

    public static func shouldFinish(translation: Double, width: Double, velocity: Double) -> Bool {
        guard width > 0, translation >= 12, velocity > -150 else { return false }
        return progress(translation: translation, width: width) >= 0.35 || velocity >= 700
    }
}
