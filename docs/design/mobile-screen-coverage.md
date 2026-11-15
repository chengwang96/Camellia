# Modern phone screen coverage

Verified against manufacturer pages on 2026-11-15. Primary phone QA uses current tall screens instead of the earlier 480 x 960 (18:9) emulator. The default local AVD is `CamelliaModernPhone2026`, 1080 x 2400 at an emulator density of 480.

| Geometry reference | Display pixels, portrait | Approximate ratio | Source |
| --- | --- | --- | --- |
| Galaxy S26 (2026), 6.3 in | 1080 x 2340 | 19.5:9 | [Samsung](https://www.samsung.com/be_fr/support/mobile-devices/comparison-specs-s26-series/) |
| Galaxy S26+/Ultra (2026), 6.7/6.9 in | 1440 x 3120 | 19.5:9 | [Samsung](https://www.samsung.com/be_fr/support/mobile-devices/comparison-specs-s26-series/) |
| iPhone 17 Pro (2025), 6.3 in | 1206 x 2622 | 19.57:9 | [Apple](https://support.apple.com/zh-hk/125090) |
| HUAWEI Pura 80 Pro+ (2025), 6.8 in | 1276 x 2848 | 20.09:9 | [Huawei](https://consumer.huawei.com/cn/phones/pura80-pro-plus/specs/) |
| Supplied screenshot aspect ratio | 1080 x 2400 test profile | 20:9 | Supplied image is 1382 x 3072; its size does not identify the physical device. |

These are geometry references, not claims of testing physical devices or their OEM operating systems. The Apple geometry profile runs the Android app in an emulator and is not an iOS runtime check. Emulator densities are deliberate test settings, not manufacturer-reported default UI densities. Physical PPI and Android logical density are different quantities.

## Runtime layout

Settings subpages keep the header fixed and opaque. Their clipped body viewport extends to the actual window bottom. The 20dp reading clearance and current system bottom inset are internal scroll padding with `clipToPadding(false)`, rather than an opaque footer outside the scrolling area. The last note can scroll completely above the gesture area, while content crossing the bottom does not end at a blank strip.

On Android 11+, system-bar and display-cutout insets come from `WindowInsets.Type`; keyboard resizing stays with the window instead of being counted again as a large bottom footer. Earlier releases use stable system insets. Persistent save failures and Retry retain separate bottom clearance. Destination-page navigation retains its independent floating-material layout.

No model-name or physical-resolution branches are used in application layout. Android measures the actual available width and height in dp, with real system insets and the user's font scale.

## Repeatable checks

Profiles live in `android/test-devices/modern-phones-2025-2026.json`.

```powershell
./scripts/check-android-modern-screens.ps1 -Serial emulator-5596
```

Build and install the current debug and instrumentation APKs first. The script requires a disposable emulator. It checks five tall-screen geometries, font scales 1.0/1.3, gesture/three-button navigation and Chinese-light/English-dark appearances. Checks cover the complete last note, bottom inset clearance, a pixel probe through the former opaque-footer region and screenshot collection. UI operations wait for the local settings writer, including asynchronous save-before-close.

`capture-android-workbench.ps1` also defaults to modern 20:9 viewports at 360/393/412dp widths. Short or narrow windows remain optional stress cases rather than the primary visual target.

## Build 148 results

On 2026-11-15, all 20 matrix runs passed: five geometries × two font scales × two navigation modes. Each run checked Chinese/light and English/dark, giving 40 presentations. The final explanatory note was completely visible after scrolling, and the pixel probe confirmed content crossed the former opaque footer. The 20:9 and Pura 80 Pro+ profiles at 1.3 font scale were also inspected visually. All 18 existing settings/navigation regression tests passed, including provider editing/import, fixed-header pixels, feedback overlays and stable destination geometry. Matrix results and screenshots are under `build/modern-settings-qa/matrix/`; regression output is `build/modern-settings-qa/settings-regressions.log`.

The signed ARM64 release is `dist/modern-settings-build148/Camellia-Android-1.1.2-arm64-v8a.apk`. All 172 production-source/configuration files match its separate build snapshot. Lint has 0 errors and 23 warnings; release signature, ABI, non-debuggable manifest and native alignment checks passed. These are emulator results, not physical-device or OEM/iOS runtime acceptance.
