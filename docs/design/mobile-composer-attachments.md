# Mobile composer attachment clipping

## Fix

The supplied Android screenshot shows pending photo thumbnails drawing beyond the
right edge of the composer. Both local and remote conversations used a horizontal
scroll view, but their composer parents disabled child clipping to leave room for
floating shadows. In hardware rendering, the scroll view's display list could
therefore draw outside its viewport.

`ChatComposer` now enables child and padding clipping on the composer itself. The
outer dock still allows the composer's shadow. Local and remote chat share this
fix; attachment sizing, limits, scrolling and draft persistence are unchanged.

The iOS local and remote trays use SwiftUI horizontal scroll views with their
default clipping. No iOS source change or runtime acceptance is claimed here.

## Verification on 2026-11-16

`ComposerAttachmentOverflowTest` uses the actual local and remote conversation
screens, rendered through the emulator's hardware-accelerated Android view path.
Distinct photo pixels are counted inside and outside the attachment viewport.
The original implementation failed in both modes with five photos: 5,184 escaped
pixels in local chat and 12,478 in remote chat at the 360dp profile.

After the fix, both modes passed at these tall-screen emulator configurations:

| Logical width | Physical viewport | Font scale | Appearance / language |
| --- | --- | --- | --- |
| 360dp | 1080 x 2400, 480dpi | 1.0 | Light / Chinese |
| 393dp | 1179 x 2620, 480dpi | 1.0 | Light / Chinese |
| 412dp | 1236 x 2748, 480dpi | 1.3 | Dark / English |
| 320dp stress case | 960 x 2134, 480dpi | 1.3 | Dark / English |

All eight focused test invocations passed. Each checks five and twenty photos at
the beginning, middle and end of the row; fixed composer width and row height;
the fully reachable last photo; a real keyboard and touch swipe; removal of the
last photo; and hiding the empty attachment row. Every captured position must
contain photo pixels inside the viewport and zero outside it.

All 277 JVM tests passed. Lint reported zero errors and 22 warnings. Six other
existing composer, input, image and style test cases passed. The existing
`ComposerConsistencyTest.testBothModesRenderTheSameComposerElements` still reports
a one-pixel status text height/baseline difference (60/44 versus 61/45 pixels).
The identical failure was reproduced with the clipping fix removed; it is not
introduced by this change and was not waived or changed.

Evidence logs and screenshots are under `build/composer-overflow-qa/`. These are
emulator results, not physical-device or iOS validation.

## Release

Version 1.1.2, build 158, is signed for ARM64 at
`dist/composer-overflow-build158/Camellia-Android-1.1.2-arm64-v8a.apk`.
Size: 22,433,185 bytes. SHA-256:
`c13d14e3a7008678cae59775a98200e4b13327b80c212dcb9d2224e25d987f93`.
The signature matches the existing HP release certificate. Version, ARM64-only
content, non-debuggable manifest and native-library alignment were verified.
The release uses the current Android working tree and the unchanged Tailnet
library; the Tailnet rebuild was skipped.
