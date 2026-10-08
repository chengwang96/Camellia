import SwiftUI

/// A one-shot location consent, as a sheet draws it and a model holds it.
///
/// Shared by both chats because both ask the same question — Android's
/// `LocationConsent` is used from `MainActivity` and `LocalChatActivity` alike,
/// with only the destination differing — and because the shape of the answer has
/// to be the same in both or one of them will drift into asking differently.
///
/// The two states are one type rather than two screens: the second dialog
/// Android shows while the fix is being acquired is the first one with a
/// different title, and the same two ways out have to stay available through it,
/// because a fix can take the full ten seconds.
struct LocationConsent: Identifiable, Equatable {
    let id = UUID()
    /// Who receives the location, named for the person to weigh.
    let destination: String
    /// Set once the fetch has begun.
    var requesting = false
}

/// The sheet itself.
///
/// Deliberately not a `confirmationDialog`: the text is the point, and a
/// confirmation dialog truncates a title to one line and gives no room to say
/// who the location goes to or that it may be retained. Android shows a full
/// dialog with a title, three paragraphs and three buttons; this is that.
struct LocationConsentSheet: View {
    @Environment(\.locale) private var locale
    let consent: LocationConsent
    let onAllow: () -> Void
    let onSkip: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(consent.requesting
                 ? (isChinese ? "正在获取大致位置…" : "Getting approximate location…")
                 : (isChinese ? "本次回答使用大致位置？" : "Use approximate location for this answer?"))
                .font(.headline)
                .foregroundColor(Palette.ink)

            ScrollView {
                Text(message)
                    .font(.callout)
                    .foregroundColor(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            VStack(spacing: 10) {
                if !consent.requesting {
                    Button(action: onAllow) {
                        Text("允许本次").frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                }
                Button(action: onSkip) {
                    Text("不提供位置，继续").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                Button(action: onCancel) {
                    Text("取消发送").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundColor(Palette.accent)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.background)
    }

    /// What the person is agreeing to, in the order they need it.
    ///
    /// The destination comes before the consequences because it is the thing
    /// being decided: a location is not sensitive in the abstract, it is
    /// sensitive as a statement about who else gets to hold it.
    private var message: String {
        if !isChinese {
            if consent.requesting {
                return "Waiting up to 10 seconds; no cached location will be read.\n\nSent to: \(consent.destination)"
            }
            return "This question may need your current location. Only if you agree, the system will request an approximate location once (about 2 km precision), without background tracking.\n\nSent to: \(consent.destination)\n\nThe app will not locate you again automatically. The recipient may retain the location, and the answer or later chat context may include it."
        }
        if consent.requesting {
            return "最多等待 10 秒；不会读取历史缓存位置。\n\n发送至：\(consent.destination)"
        }
        return "此问题可能需要当前位置。仅在你同意后向系统申请一次大致位置（约 2 公里精度），"
            + "单次获取，不后台追踪。\n\n发送至：\(consent.destination)"
            + "\n\n不会自动再次定位。接收方可能保存位置，回答及后续会话上下文也可能包含它。"
    }

    private var isChinese: Bool { locale.identifier.lowercased().hasPrefix("zh") }
}
