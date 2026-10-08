import SwiftUI
import UIKit

/// The same start page Android presents: two equal choices, followed by the
/// settings entry. Readiness changes the remote action line, not the shape of
/// the page, so neither half of the product disappears while it is set up.
struct HomeView: View {
    let onLocalChat: () -> Void
    let onRemoteControl: () -> Void
    let onSettings: () -> Void
    let onMobileAccess: () -> Void

    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                brand

                Text("开始工作")
                    .font(.system(size: Palette.textHero))
                    .foregroundColor(Palette.ink)
                    .padding(.top, 30)
                    .padding(.bottom, 6)

                Text("选择一种方式，继续你的工作。")
                    .font(.system(size: Palette.textBody))
                    .foregroundColor(Palette.muted)
                    .padding(.bottom, 18)

                homeCard(
                    title: "本地聊天",
                    detail: isPad ? "平板直连 API，在本地工作区中继续会话。"
                                  : "手机直连 API，在本地工作区中继续会话。",
                    actionTitle: "进入本地聊天",
                    systemImage: isPad ? "ipad" : "iphone",
                    enabled: true,
                    busy: false,
                    action: onLocalChat)

                homeCard(
                    title: "远程控制",
                    detail: "连接你的电脑，查看会话并继续远程工作。",
                    actionTitle: remoteAction,
                    systemImage: "desktopcomputer",
                    enabled: model.remoteReady,
                    busy: model.remoteEntryState == .connecting,
                    action: onRemoteControl)

                if model.remoteEntryState == .offline || model.remoteEntryState == .failed {
                    Button("重试连接", action: model.retryRemoteEntry)
                        .font(.system(size: Palette.textInput, weight: .medium))
                        .foregroundColor(Palette.accent)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .buttonStyle(.plain)
                        .padding(.bottom, 16)
                }

                if model.remoteEntryState == .signIn || model.remoteEntryState == .timedOut {
                    Button("前往手机访问", action: onMobileAccess)
                        .font(.system(size: Palette.textInput, weight: .medium))
                        .foregroundColor(Palette.accent)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .buttonStyle(.plain)
                        .padding(.bottom, 16)
                }

                settingsEntry
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Palette.background.ignoresSafeArea())
    }

    private var brand: some View {
        HStack(spacing: 12) {
            if let image = appIcon {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 32, height: 32)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            Text("Camellia")
                .font(.system(size: Palette.textTitle, weight: .semibold))
                .foregroundColor(Palette.ink)
        }
        .frame(minHeight: 48)
    }

    private var appIcon: UIImage? {
        let names = ["AppIcon60x60@3x", "AppIcon60x60@2x", "AppIcon60x60"]
        for name in names {
            if let path = Bundle.main.path(forResource: name, ofType: "png"),
               let image = UIImage(contentsOfFile: path) {
                return image
            }
        }
        return nil
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private var remoteAction: String {
        switch model.remoteEntryState {
        case .ready: return "进入远程控制"
        case .connecting: return "正在连接网络…"
        case .offline: return "网络已断开，等待联网"
        case .signIn: return "请先在「设置 → 手机访问」登录或授权设备"
        case .timedOut: return "连接超时，请重试或在「设置 → 手机访问」检查"
        case .failed: return "网络初始化失败，请重试"
        }
    }

    private func homeCard(title: String, detail: String, actionTitle: String,
                          systemImage: String, enabled: Bool, busy: Bool,
                          action: @escaping () -> Void) -> some View {
        Button(action: { if enabled { action() } }) {
            VStack(alignment: .leading, spacing: 0) {
                Image(systemName: systemImage)
                    .font(.system(size: Palette.textTitle, weight: .medium))
                    .foregroundColor(Palette.accent)
                    .frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
                        .fill(Palette.surface))

                Text(LocalizedStringKey(title))
                    .font(.system(size: Palette.textCard, weight: .medium))
                    .foregroundColor(Palette.ink)
                    .padding(.top, 10)
                    .padding(.bottom, 4)

                Text(LocalizedStringKey(detail))
                    .font(.system(size: Palette.textNote))
                    .foregroundColor(Palette.muted)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    Text(LocalizedStringKey(actionTitle))
                        .font(.system(size: Palette.textInput))
                        .foregroundColor(enabled ? Palette.accent : Palette.muted)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    if busy {
                        ProgressView().progressViewStyle(.circular)
                    } else if enabled {
                        Text("↗")
                            .font(.system(size: Palette.textDisplay))
                            .foregroundColor(Palette.accent)
                    }
                }
                .padding(.top, 10)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Palette.homeRadius, style: .continuous)
                .fill(Palette.background))
            .overlay(RoundedRectangle(cornerRadius: Palette.homeRadius, style: .continuous)
                .stroke(Palette.homeCardEdge, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .allowsHitTesting(enabled)
        .padding(.bottom, 16)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(enabled ? .isButton : [])
    }

    private var settingsEntry: some View {
        Button(action: onSettings) {
            HStack(spacing: 14) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.muted)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text("设置")
                        .font(.system(size: Palette.textRow))
                        .foregroundColor(Palette.ink)
                    Text("供应商与 Key、通用、已归档、手机访问")
                        .font(.system(size: Palette.textSmall))
                        .foregroundColor(Palette.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .layoutPriority(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.muted)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Palette.homeRadius, style: .continuous)
                .fill(Palette.surface))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}
