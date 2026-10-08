import SwiftUI
import UIKit

struct LogSection: View {
    @ObservedObject private var log = DiagnosticsLog.shared

    var body: some View {
        // NavigationView, for the same reason as in GatewaySection: no pushing
        // here, and NavigationStack would cost iOS 16 as the minimum.
        NavigationView {
            Group {
                if log.lines.isEmpty {
                    Text("还没有记录。")
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(log.lines) { line in
                                row(line)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                    }
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("日志")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Button("复制") { UIPasteboard.general.string = log.transcript() }
                }
                ToolbarItem(placement: .automatic) {
                    Button("清空") { log.clear() }
                }
            }
        }
    }

    private func row(_ line: DiagnosticsLog.Line) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(Self.formatter.string(from: line.at))
                .font(.system(.caption2, design: .monospaced))
                .foregroundColor(.secondary)
            Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(tint(for: line.level))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func tint(for level: DiagnosticsLog.Line.Level) -> Color {
        switch level {
        case .plain: return .primary
        case .good: return .green
        case .bad: return .red
        }
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
