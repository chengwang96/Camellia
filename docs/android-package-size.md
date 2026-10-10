# Android package size

The signed Windows release script exports separate ARM64 and x86_64 APKs. The
default `dist/Camellia-Android-1.0.1.apk` is identical to the ARM64 export. These
are standalone APKs; install the one matching the device. Debug builds remain
universal so existing development and instrumentation commands keep working.
Direct Gradle builds enable splitting with `-PcamelliaSplitApks=true`; the
release script supplies this property automatically. Use `-Abis arm64-v8a` for
only the phone package, or `-Abis x86_64` for only the emulator package.

## Changes

- Release enables R8 optimization and resource shrinking. Tailnet's AAR supplies
  consumer keep rules for its exported Go/JNI classes. App rules retain native
  callback members implementing `tailnet.Storage` and `tailnet.Upload`.
- The shared brand image is generated at 256 x 256 instead of copying the
  desktop's 1024 x 1024 asset. The largest Android use is 52 dp; launcher vectors
  and the desktop source asset are unchanged. A decoded ARGB bitmap needs
  256 KiB rather than 4 MiB before any drawing allocation.
- Each packaging task removes only its own APK output directory before writing
  a new signed archive. Compilation, resource, and native dependency caches
  remain incremental. This prevents discarded payloads from accumulating in
  updated APK ZIPs. The output directory is checked before deletion.
- Native libraries remain stored and aligned for loading directly from the
  APK. Go builds already use `-s -w`; no redundant stripping step is added.
- The export script checks the selected ABI outputs, signature consistency, the release
  manifest, native alignment, and unused ZIP space. Each export includes a
  `.sha256` checksum and `.size.json` audit. Its R8 mapping is saved with the
  version code for crash symbolication.

## Measurement

Build 82, measured on 2026-10-07 with the same source, Tailnet AAR and signing key:

| Package | Bytes | MiB |
| --- | ---: | ---: |
| Universal baseline, no R8 or shrinking, desktop-size icon | 46,673,566 | 44.51 |
| Optimized ARM64 | 21,935,188 | 20.92 |
| Optimized x86_64 | 23,485,873 | 22.40 |

The ARM64 package is 53.0% smaller than the same-source baseline. Compressed DEX
payload falls from 1,748,014 to 562,500 bytes; compressed resources fall from
869,199 to 62,167 bytes. Licenses are retained. Both optimized APKs contain zero
unreferenced bytes after accounting for ZIP headers, descriptors and signing
blocks. The original build 81 release was 46,567,470 bytes; it remains a separate
upgrade fixture rather than the comparison baseline.

## Reproduce

```powershell
# Signed optimized APKs plus the Release-only instrumentation APK.
.\scripts\build-android-release.ps1 -ReleaseTests

# Same-source universal baseline; keep it away from distributable exports.
.\scripts\build-android-release.ps1 -SkipTailnet -SizeBaseline `
  -OutputDirectory .\dist\test-results\android-apk-size-baseline

.\scripts\measure-android-apk.ps1 -Path .\dist\Camellia-Android-1.0.1.apk
```

`-SizeBaseline` disables R8, resource shrinking and icon resizing for measurement.
It requires an explicit output directory. Normal builds must not use this flag.
`-SkipTailnet` reuses the already-built AAR; rebuild it after changing Go code.

Release-only instrumentation lives in `app/src/releaseTest/` and exercises
components and public UI without private field names or app-wide test keep
rules. Its runner is
`app.camellia.mobile.release.test/android.test.InstrumentationTestRunner`.
Run `ReleaseSmokeTest#testSeedUpgradeFixture` on a fresh old signed installation,
install the new matching-ABI APK with `adb install -r`, then run
`#testUpgradePreservesEncryptedDataAndMarkdown`. Do not run the seed method again
after migration. Select the remaining network, Office and QR methods explicitly.
The QR case starts the real camera preview, locates its SDK camera object by
type, and feeds a standard NV21 fixture into the production preview callback.
It uses the preview's actual dimensions and exercises the optimized ZXing
decoder and pairing-payload validation. No original app field names are kept
for the test. The fixture is packaged only in the test APK. This avoids the
emulator imagefile renderer's clipped frames; real camera capture still needs
physical-device verification.

The upgrade fixture checks the original Keystore-encrypted token, settings,
history and draft, migration into encrypted SQLite, removal of the verified old
duplicate, and reopening the chat. Native network initialization checks actual
app `Storage` callbacks, including encrypted writes. Office import uses a
read-only test content provider packaged only in the instrumentation APK.

Runtime verification uses the optimized x86_64 package on a disposable emulator.
ARM64 signatures, ABI contents and alignment are checked statically; physical
ARM64 execution and signed-in Tailnet pairing still need a device.

Build 82 verification completed on 2026-10-08: 172 unit tests and Go tests
passed; Lint had zero errors and four warnings. All four optimized Release
instrumentation cases passed after seeding the previous build 81 and upgrading
without clearing app data. Two consecutive fresh Debug packages had identical
SHA-256 hashes, a size of 46,451,174 bytes, and zero unreferenced ZIP bytes.
The local audit, checksums, raw test results and failed emulator imagefile
experiments are recorded in `dist/test-results/android-package-size-20261008-summary.json`
and `dist/test-results/android-apk-size-before/`.
