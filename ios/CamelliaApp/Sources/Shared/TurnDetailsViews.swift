import SwiftUI

struct TurnCompletionLabel: View {
    let details: TurnDetails
    var body: some View {
        HStack(spacing: 6) {
            Text("已完成")
            if details.duration != nil {
                Text("·")
                Text("耗时") + Text(verbatim: " " + details.elapsed)
            }
        }
        .font(.system(size: Palette.textBody))
        .foregroundColor(Palette.faint)
        .frame(minHeight: 48)
    }
}

struct TurnUsageButton: View {
    let details: TurnDetails
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            HStack(spacing: 4) {
                Text("用量")
                Text(verbatim: compact(details.total) + " tok")
            }
            .font(.system(size: Palette.textSmall))
            .foregroundColor(Palette.faint)
            .padding(.horizontal, 6)
            .frame(minHeight: 48)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("本轮用量")
        .accessibilityIdentifier("turnUsage")
        .sheet(isPresented: $showing) {
            TurnUsageSheet(details: details)
        }
    }

    private func compact(_ value: Int64) -> String {
        if value < 1000 { return "\(value)" }
        let amount = Double(value) / (value < 1_000_000 ? 1000 : 1_000_000)
        let format = NumberFormatter(); format.locale = Locale(identifier: "en_US"); format.maximumFractionDigits = 1
        return (format.string(from: NSNumber(value: amount)) ?? "\(amount)") + (value < 1_000_000 ? "K" : "M")
    }
}

private struct TurnUsageSheet: View {
    let details: TurnDetails
    @Environment(\.presentationMode) private var presentation

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("本轮用量").font(.system(size: Palette.textTitle, weight: .medium))
                Spacer()
                Text(verbatim: TurnDetails.tokens(details.total))
                    .font(.system(size: Palette.textRow)).monospacedDigit()
            }
            .accessibilityAddTraits(.isHeader)
            Rectangle().fill(Palette.divider).frame(height: 1)
            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    if !details.model.isEmpty { row("模型", details.model) }
                    if let hit = details.cacheHit { row("缓存命中率", String(format: "%.1f%%", locale: Locale(identifier: "en_US"), hit)) }
                    if let input = details.input { row("未缓存输入", TurnDetails.tokens(input)) }
                    if let read = details.cacheRead { row("缓存读取", TurnDetails.tokens(read)) }
                    if let write = details.cacheWrite { row("缓存写入", TurnDetails.tokens(write)) }
                    if let output = details.output { row("输出", TurnDetails.tokens(output)) }
                    if let cost = details.cost { row("费用", String(format: "$%.4f", locale: Locale(identifier: "en_US"), cost)) }
                }
            }
            Button("关闭") { presentation.wrappedValue.dismiss() }
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundColor(Palette.ink)
        }
        .foregroundColor(Palette.ink)
        .padding(20)
        .background(Palette.grouped.ignoresSafeArea())
        .accessibilityIdentifier("turnUsagePanel")
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 20) {
            if title == "模型" {
                Text(LocalizedStringKey(title)).foregroundColor(Palette.faint)
                    .frame(width: 48, alignment: .leading)
            } else {
                Text(LocalizedStringKey(title)).foregroundColor(Palette.faint)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text(verbatim: value).foregroundColor(Palette.secondary)
                .multilineTextAlignment(.trailing).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .font(.system(size: Palette.textNote)).monospacedDigit()
    }
}
