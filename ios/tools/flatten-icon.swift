// Composites an icon over its own background, so the result has no alpha.
//
// iOS draws an app icon as an opaque square and fills any transparent pixel
// with black. The shared artwork is a rounded square sitting inside a
// transparent canvas — correct for launchers that composite their own
// background, and a thick black ring around the icon on the Home Screen. The
// transparent margin is filled with the artwork's own background colour and the
// alpha channel is dropped.
//
// The colour is sampled from just inside the artwork's edge rather than written
// down here, so the icon follows the artwork. It comes out within a few units
// of the `launcher_background` the Android adaptive icon uses (#E6EDF6), which
// is the point: the same logo should read the same on both phones.
//
//   flatten-icon <input.png> <output.png>
//
// Prints one line naming what it did and exits non-zero if the icon could not
// be rewritten, so a build can fall back to the unflattened file rather than
// fail.
//
// What was tried and rejected, so it is not tried again:
//
//   * Growing the margin outwards from the artwork's edge, one ring at a time,
//     so the background gradient would continue seamlessly. Two things go
//     wrong. The artwork carries stray saturated colour in its nearly
//     transparent fringe — real, and invisible at alpha 1 — and un-premultiplying
//     it magnifies that speck to full strength; the growth then paints it across
//     the whole margin as a fan of streaks. Reading the fringe as "unknown"
//     instead fixes the streaks but not the second problem: the artwork's edge
//     is a soft ~25 px falloff, so its colour varies pixel to pixel, and growing
//     outwards from a varying source draws visible rays in every corner. A flat
//     colour, matched to the Android background, is what the other platforms
//     put under this logo anyway.
//
//   * Scaling the artwork so the rounded square fills the canvas, which removes
//     the margin entirely. It also throws away the padding the artwork was
//     drawn with, and iOS is not the only launcher that matters.

import CoreGraphics
import Foundation
import ImageIO

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: flatten-icon <input.png> <output.png>\n".utf8))
    exit(2)
}

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write(Data("cannot read \(arguments[1])\n".utf8))
    exit(1)
}

let width = image.width
let height = image.height
guard width > 0, height > 0 else {
    FileHandle.standardError.write(Data("\(arguments[1]) has no pixels\n".utf8))
    exit(1)
}
let colorSpace = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
let bytesPerRow = width * 4

// Read the artwork once so its background can be sampled, through a context
// CoreGraphics owns.
//
// Not a Swift array handed over as `&buffer`: that pointer is only valid for
// the length of the call, so every read afterwards is undefined — and the
// failure is not a crash, it is a plausible-looking mess. `data: nil` lets
// CoreGraphics allocate, and `readable.data` stays valid for as long as the
// context does.
guard let readable = CGContext(data: nil,
                               width: width,
                               height: height,
                               bitsPerComponent: 8,
                               bytesPerRow: 0,
                               space: colorSpace,
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write(Data("cannot allocate a \(width)x\(height) bitmap\n".utf8))
    exit(1)
}
readable.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
guard let buffer = readable.data else {
    FileHandle.standardError.write(Data("the readable bitmap has no storage\n".utf8))
    exit(1)
}
let sourceBytesPerRow = readable.bytesPerRow
let pixels = buffer.bindMemory(to: UInt8.self, capacity: sourceBytesPerRow * height)

// Four points a little inside each edge: close enough to be inside the rounded
// square at its widest part, far enough in to miss the anti-aliased border.
let probes: [(Double, Double)] = [(0.5, 0.09), (0.09, 0.5), (0.91, 0.5), (0.5, 0.91)]
var total = (red: 0, green: 0, blue: 0)
var sampled = 0
for (across, up) in probes {
    let x = min(width - 1, max(0, Int(Double(width) * across)))
    let y = min(height - 1, max(0, Int(Double(height) * up)))
    let offset = y * sourceBytesPerRow + x * 4
    guard pixels[offset + 3] > 200 else { continue }
    total.red += Int(pixels[offset])
    total.green += Int(pixels[offset + 1])
    total.blue += Int(pixels[offset + 2])
    sampled += 1
}

let background: CGColor
if sampled > 0 {
    let scale = 1 / (CGFloat(sampled) * 255)
    background = CGColor(colorSpace: colorSpace,
                         components: [CGFloat(total.red) * scale,
                                      CGFloat(total.green) * scale,
                                      CGFloat(total.blue) * scale,
                                      1]) ?? CGColor(gray: 1, alpha: 1)
} else {
    // Nothing opaque to sample: a white square still beats black corners.
    background = CGColor(colorSpace: colorSpace, components: [1, 1, 1, 1]) ?? CGColor(gray: 1, alpha: 1)
}

// `noneSkipLast` is RGB with no alpha channel at all, which is what the Home
// Screen wants; keeping an alpha channel is what lets the ring come back.
//
// `data: nil` again, for the same reason as the read — and here it also means
// the compositing is CoreGraphics's: the artwork's soft edge blends into the
// fill properly instead of being pasted over it at full strength.
guard let flattened = CGContext(data: nil,
                                width: width,
                                height: height,
                                bitsPerComponent: 8,
                                bytesPerRow: bytesPerRow,
                                space: colorSpace,
                                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    FileHandle.standardError.write(Data("cannot allocate the flattened bitmap\n".utf8))
    exit(1)
}
flattened.setFillColor(background)
flattened.fill(CGRect(x: 0, y: 0, width: width, height: height))
flattened.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

guard let result = flattened.makeImage() else {
    FileHandle.standardError.write(Data("cannot build the flattened image\n".utf8))
    exit(1)
}

let components = background.components ?? [1, 1, 1, 1]
let hex = components.prefix(3).map { String(format: "%02X", Int(($0 * 255).rounded())) }.joined()

guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: arguments[2]) as CFURL,
                                                        "public.png" as CFString, 1, nil) else {
    FileHandle.standardError.write(Data("cannot write \(arguments[2])\n".utf8))
    exit(1)
}
CGImageDestinationAddImage(destination, result, nil)
guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write(Data("cannot finalise \(arguments[2])\n".utf8))
    exit(1)
}

print("flattened \(arguments[1]) -> \(arguments[2]) (\(width)x\(height) opaque, background #\(hex))")
