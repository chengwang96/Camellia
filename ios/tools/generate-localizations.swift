import Foundation

// The Android tr(Chinese, English) calls are the product's English copy. Keep
// the iOS catalog generated from that source instead of translating the same
// labels by hand in a second client. iOS-only wording lives in the overrides.
guard CommandLine.arguments.count == 2 else {
    fputs("usage: swift generate-localizations.swift REPOSITORY_ROOT\n", stderr)
    exit(2)
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let javaRoot = root.appendingPathComponent("android/app/src/main/java/app/camellia/mobile")
let output = root.appendingPathComponent("ios/CamelliaApp/Resources/en.lproj/Localizable.strings")
let overrides = root.appendingPathComponent("ios/CamelliaApp/Resources/en-overrides.strings")
let pattern = try NSRegularExpression(pattern: #"\btr\(\s*"((?:\\.|[^"\\])*)"\s*,\s*"((?:\\.|[^"\\])*)"\s*\)"#)

func decoded(_ literal: String) -> String? {
    let source = "[\"" + literal + "\"]"
    guard let data = source.data(using: .utf8),
          let array = try? JSONSerialization.jsonObject(with: data) as? [String] else { return nil }
    return array.first
}

func escaped(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
}

var translations: [String: String] = [:]
var conflicts: [String] = []
var conflictKeys: Set<String> = []
guard let sourceFiles = FileManager.default.enumerator(at: javaRoot,
    includingPropertiesForKeys: nil) else {
    fputs("Android source directory not found: \(javaRoot.path)\n", stderr)
    exit(2)
}
let files = sourceFiles.allObjects.compactMap { $0 as? URL }
    .filter { $0.pathExtension == "java" }
for file in files {
    let source = try String(contentsOf: file, encoding: .utf8)
    let range = NSRange(source.startIndex..<source.endIndex, in: source)
    for match in pattern.matches(in: source, range: range) {
        guard let keyRange = Range(match.range(at: 1), in: source),
              let valueRange = Range(match.range(at: 2), in: source),
              let key = decoded(String(source[keyRange])),
              let value = decoded(String(source[valueRange])) else { continue }
        if let existing = translations[key], existing != value {
            conflicts.append("\(key): \(existing) / \(value)")
            conflictKeys.insert(key)
        } else {
            translations[key] = value
        }
    }
}
// Keep the hand-maintained supplement in normal .strings syntax. Parse only
// quoted pairs; JSON string decoding handles escaping exactly once.
let overrideSource = try String(contentsOf: overrides, encoding: .utf8)
let overridePattern = try NSRegularExpression(pattern:
    #""((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"\s*;"#)
var overrideValues: [String: String] = [:]
let overrideRange = NSRange(overrideSource.startIndex..<overrideSource.endIndex, in: overrideSource)
for match in overridePattern.matches(in: overrideSource, range: overrideRange) {
    guard let keyRange = Range(match.range(at: 1), in: overrideSource),
          let valueRange = Range(match.range(at: 2), in: overrideSource),
          let key = decoded(String(overrideSource[keyRange])),
          let value = decoded(String(overrideSource[valueRange])) else { continue }
    if overrideValues.updateValue(value, forKey: key) != nil {
        fputs("Duplicate English override: \(key)\n", stderr)
        exit(1)
    }
}
let unresolved = conflictKeys.subtracting(overrideValues.keys)
if !unresolved.isEmpty {
    let details = conflicts.filter { line in unresolved.contains(String(line.prefix(while: { $0 != ":" }))) }
    fputs("Conflicting Android translations:\n" + details.sorted().joined(separator: "\n") + "\n", stderr)
    exit(1)
}
translations.merge(overrideValues) { _, override in override }
let lines = translations.keys.sorted().map { key in
    "\"\(escaped(key))\" = \"\(escaped(translations[key]!))\";"
}
try FileManager.default.createDirectory(at: output.deletingLastPathComponent(),
                                         withIntermediateDirectories: true)
try ("// Generated from Android tr() calls and en-overrides.strings.\n" +
     lines.joined(separator: "\n") + "\n")
    .write(to: output, atomically: true, encoding: .utf8)
print("Generated \(translations.count) English strings")
