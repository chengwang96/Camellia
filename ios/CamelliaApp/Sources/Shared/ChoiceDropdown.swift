import SwiftUI
import UIKit

struct ChoiceDropdownRequest: Identifiable {
    let id = UUID()
    let anchor: String
    let title: String
    let labels: [String]
    let selected: Int
    var searchable = false
    var localizeLabels = false
    let choose: (Int) -> Void
}

private struct ChoiceDropdownAnchors: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

extension View {
    func choiceDropdownAnchor(_ id: String) -> some View {
        anchorPreference(key: ChoiceDropdownAnchors.self, value: .bounds) { [id: $0] }
    }
    func choiceDropdownHost(_ request: Binding<ChoiceDropdownRequest?>) -> some View {
        modifier(ChoiceDropdownHost(request: request))
    }
}

private struct ChoiceDropdownHost: ViewModifier {
    @Binding var request: ChoiceDropdownRequest?
    func body(content: Content) -> some View {
        content.overlayPreferenceValue(ChoiceDropdownAnchors.self) { anchors in
            GeometryReader { geometry in
                if let request, let anchor = anchors[request.anchor] {
                    ChoiceDropdownMenu(request: request, anchor: geometry[anchor], size: geometry.size,
                                       dismiss: { self.request = nil }).id(request.id)
                }
            }
        }.onDisappear { request = nil }
    }
}

private struct ChoiceDropdownMenu: View {
    let request: ChoiceDropdownRequest
    let anchor: CGRect
    let size: CGSize
    let dismiss: () -> Void
    @State private var query = ""
    private var matches: [Int] {
        request.labels.indices.filter { query.trimmingCharacters(in: .whitespaces).isEmpty || request.labels[$0].localizedCaseInsensitiveContains(query.trimmingCharacters(in: .whitespaces)) }
    }
    var body: some View {
        let labelWidth = request.labels.map { ($0 as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: Palette.textRowStrong)]).width }.max() ?? 0
        let width = min(max(180, labelWidth + 68), min(340, max(1, size.width - 24)))
        let left = max(12, min(anchor.maxX - width, size.width - width - 12))
        let belowTop = anchor.maxY + 6
        let belowSpace = max(0, size.height - belowTop - 8), aboveSpace = max(0, anchor.minY - 14)
        let below = belowSpace >= 160 || belowSpace >= aboveSpace
        let limit = max(1, min(420, below ? belowSpace : aboveSpace))
        let searchHeight: CGFloat = request.searchable ? 50 : 0
        let height = min(limit, 12 + searchHeight + CGFloat(max(1, matches.count)) * 54)
        let top = below ? belowTop : anchor.minY - height - 6
        ZStack(alignment: .topLeading) {
            PopupDismissArea(dismiss: dismiss)
            VStack(spacing: 0) {
                if request.searchable {
                    TextField("搜索", text: $query)
                        .font(.system(size: Palette.textBody)).foregroundColor(Palette.ink)
                        .textInputAutocapitalization(.never).disableAutocorrection(true)
                        .padding(.horizontal, 12).frame(height: 44)
                        .background(RoundedRectangle(cornerRadius: Palette.settingsControlRadius).fill(Palette.field))
                        .overlay(RoundedRectangle(cornerRadius: Palette.settingsControlRadius).strokeBorder(Palette.fieldBorder, lineWidth: 1))
                        .padding(.bottom, 6).accessibilityIdentifier("dropdownSearch")
                }
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        if matches.isEmpty {
                            Text("没有匹配项").font(.system(size: Palette.textNote)).foregroundColor(Palette.secondary).frame(maxWidth: .infinity, minHeight: 54)
                        }
                        ForEach(matches, id: \.self) { index in
                            Button {
                                dismiss()
                                if index != request.selected { request.choose(index) }
                            } label: {
                                HStack(spacing: 10) {
                                    label(index).font(.system(size: Palette.textRowStrong, weight: .medium)).lineLimit(1)
                                    Spacer(minLength: 0)
                                    if index == request.selected { MobileLineIcon(name: "check", size: 22).foregroundColor(Palette.accent) }
                                }.foregroundColor(Palette.ink).padding(.horizontal, 14).frame(height: 54)
                                    .background(RoundedRectangle(cornerRadius: Palette.settingsControlRadius).fill(index == request.selected ? Palette.controlFill : Color.clear))
                                    .contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("dropdownChoice:\(index)")
                                .accessibilityAddTraits(index == request.selected ? .isSelected : [])
                                .help(label(index))
                        }
                    }
                }
            }.padding(6).frame(width: width, height: height)
                .background(PopupGlassSurface())
                .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous))
                .shadow(color: .black.opacity(0.2), radius: 8, y: 5)
                .padding(.leading, left).padding(.top, top)
                .accessibilityIdentifier("choiceDropdown")
        }
    }
    private func label(_ index: Int) -> Text {
        request.localizeLabels ? Text(LocalizedStringKey(request.labels[index])) : Text(verbatim: request.labels[index])
    }
}
