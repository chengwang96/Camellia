# Settings switch touch feedback

Verified on 2026-11-16 for Android 1.1.2 build 150.

## Reproduction and cause

A real tap on a notification switch left an offset semicircular highlight above its right edge after release. The original `SettingsToggle` overrode `onMeasure` without calling `Switch.onMeasure`, painted its own track/thumb in `onDraw`, and retained the framework background ripple. Consequently, the visible control and the framework ripple hotspot used different geometry. The hand-painted thumb also used only `isChecked()`, bypassing the native thumb movement, and abruptly shrank on press.

Before the fix, the touch regression captured the displaced halo 500ms after release and failed the outside-track pixel check. A separate functional check found that clicking the label could change a disabled switch.

## Shared control behavior

`SettingsToggle` now supplies stateful track and thumb drawables to the native Switch. Native measurement, layout, thumb animation, dragging, cancellation and accessibility operate on those same drawables. The visible track remains 48×28dp with a minimum 52×48dp touch target. Pressing changes the tone inside the track and thumb without resizing the thumb or adding an external ripple. Keyboard focus has an accent outline on the track.

`SettingsStyle.toggle` forwards the row's pressed state to its switch and activates it through `performClick`. Disabled controls ignore label clicks; the row suppresses its separate sound so the switch supplies one click feedback. A scroll gesture cancels the press without changing the preference.

This covers notifications, reading preferences, haptics, background connection, provider enablement and provider-key switches through their shared factory. The reported displaced Android ripple does not apply to the separate SwiftUI button-based toggle implementation; iOS source was inspected but no iOS runtime check was performed.

## Verification

The API 35 Android emulator used a modern 20:9 viewport, 1080×2400 at logical density 480. The focused feedback and bottom-clearance checks passed with font scales 1.0/1.3 and both gesture/three-button navigation. Light and dark appearances cover checked and unchecked switches. Actual screenshots showed no changed pixels outside the track on press or after release. A screenshot taken during a real drag confirmed the visible thumb moved before the pointer was released.

The passing classes contain 32 distinct UI scenarios:

- `SettingsFeedbackTest`: 3 cases covering contained press/release pixels, thumb dragging, pointer cancellation, disabled label clicks, whole-row feedback and scroll cancellation.
- `SettingsTest`: 17 existing settings cases, including provider/key editing, persistence, header clipping and feedback overlays.
- `ModernSettingsLayoutTest`: 1 case covering both appearances, complete last-note visibility and content crossing the former opaque footer.
- `ChatEmptyStateTest`: 11 cases covering the retained build 149 session-filter fix.

Across the initial checks, three extra font/navigation combinations and the final integrated source, 47 test invocations passed. Logs, pixel/drag measurements and screenshots are in `build/settings-feedback-qa/`; `verification.json` records the final package checksum and coverage. Compilation and lint passed with 0 errors and 23 warnings.

The signed ARM64 package retains build 149's session-filter changes and the earlier settings-bottom/navigation fixes. Its 172 production-source/configuration files match the workspace after text line-ending normalization. The persistent HP signature, ABI, non-debuggable manifest and native-library alignment checks passed. Tailnet was reused unchanged. Physical-device and iOS runtime validation remain outside these results.
