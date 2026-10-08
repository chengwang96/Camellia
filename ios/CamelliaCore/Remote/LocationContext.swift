import Foundation

/// Whether a question is worth asking for a location for, and the text that
/// goes into the prompt when the answer is yes.
///
/// Ported from Android's `LocationConsent`, whose two load-bearing parts are
/// exactly these: the relevance test, which decides whether a permission prompt
/// appears at all, and the appended text, which is what the desktop's model
/// actually reads. Both are pure, so both are checked without a device — the
/// dialog and the CoreLocation call around them cannot be, and are the parts
/// that fail visibly.
///
/// The text is deliberately hedged. A 2 km figure is not an address, and a model
/// handed one and asked about the weather will answer as though it has live
/// data; the note says not to, in both languages, because the desktop's model
/// may be either.
public enum LocationContext {
    /// How stale a fix may be before it is not worth sending.
    ///
    /// Android's limit, and it is about meaning rather than precision: a phone
    /// carried across a city in two minutes makes an older fix a statement about
    /// somewhere the person no longer is.
    public static let maximumAge: TimeInterval = 120

    /// The floor on the uncertainty this client states.
    ///
    /// A coarse fix can report a hundred metres of accuracy and still be wrong
    /// by kilometres, because the platform's number describes the radio, not the
    /// address. Android never claims better than 2 km and neither does this.
    public static let accuracyFloor: Double = 2000

    /// What is appended when no location was collected.
    ///
    /// Sent as well as said, and that is the point: a question the client judged
    /// location-related but the person declined is one a model will otherwise
    /// guess at, and a guess about where somebody is reads as a fact.
    public static let unavailable = "\n\n[本次未提供设备位置 / Device location was not provided for this request. "
        + "Do not guess the user's location; ask for a city or area if needed.]"

    /// The blocks that turn a question into something other than a question
    /// about where the person is.
    ///
    /// Checked before the location patterns, so "don't use my location" is not
    /// read as "my location": the opt-out has to win, or the client would ask
    /// for the very thing the person just refused.
    private static let refusals = [
        "不要定位",
        "不使用.{0,4}位置",
        "不用.{0,4}定位",
        "不获取.{0,4}位置",
        "不要.{0,4}位置",
        "do not (use|access|share).{0,20}location",
        "don't (use|access|share).{0,20}location",
        "without.{0,10}location",
    ]

    /// Questions that name the person's own position.
    private static let mentions = [
        "我在哪",
        "我的位置",
        "我现在.{0,6}(位置|哪里|哪儿)",
        "我所在",
        "当前位置",
        "附近.{0,20}(推荐|餐厅|饭店|医院|药店|咖啡|酒店|停车|加油|天气|有什么|哪里)",
        "周边.{0,12}(推荐|餐厅|医院|酒店)",
        "这里.{0,12}(天气|气温|下雨)",
        "near me",
        "my (current )?location",
        "where am i",
        "weather (here|at my location)",
    ]

    /// Questions about the weather that do not name a place, and are therefore
    /// about the place the person is standing.
    private static let placeless = [
        "^(?:请|帮我|请帮我)?(?:搜一搜|搜一下|搜索|查一查|查一下|查询|看看)?(?:最近)?(?:今天|今日|最近|近期|这几天|近几天).{0,8}(天气|气温|下雨).*$",
        "^(?:please )?(?:search |check )?(?:today'?s weather|weather today|current weather).*$",
    ]

    /// Whether asking for a location would help this prompt.
    public static func isRelevant(_ prompt: String) -> Bool {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // A pasted document, a code block or a request to translate something is
        // someone else's words. Asking for the reader's location because a
        // quotation mentions "near me" would be reading the wrong sentence.
        if text.contains("```") { return false }
        if matches(text, "(?s).*(翻译|引用|translate|quoted).*") { return false }
        if refusals.contains(where: { matches(text, "(?s).*\($0).*") }) { return false }
        if mentions.contains(where: { matches(text, "(?s).*\($0).*") }) { return true }
        return placeless.contains { matches(text, "(?s)\($0)") }
    }

    /// The note for a collected fix, or nil if the fix is not usable.
    ///
    /// Every rejection here is a way a location can be wrong rather than merely
    /// imprecise: a placeholder coordinate, a value the platform fabricated, a
    /// negative accuracy — all of which Android refuses on the same grounds, and
    /// all of which are better answered with "no location" than with a number.
    public static func approximate(latitude: Double, longitude: Double,
                                   accuracy: Double, age: TimeInterval) -> String? {
        guard latitude.isFinite, longitude.isFinite, accuracy.isFinite else { return nil }
        guard abs(latitude) <= 90, abs(longitude) <= 180, accuracy >= 0 else { return nil }
        guard age >= 0, age <= maximumAge else { return nil }
        let uncertainty = max(accuracyFloor, accuracy)
        return String(
            format: "\n\n[本次经用户同意提供的大致设备位置 / Approximate device location shared with consent for this request]\n"
                + "Latitude: %.2f; longitude: %.2f; uncertainty: at least %.0f m.\n"
                + "仅用于回答本次位置相关问题，不是精确地址；不可据此声称获得实时天气或商家数据。 / "
                + "Use only for this location-related question, not as an exact address or proof of live weather/business data.",
            locale: Locale(identifier: "en_US_POSIX"),
            latitude, longitude, uncertainty)
    }

    /// The note to append for a fix, or the "not provided" note when there is
    /// nothing usable — which is what a caller always appends.
    public static func note(latitude: Double, longitude: Double,
                            accuracy: Double, age: TimeInterval) -> String {
        approximate(latitude: latitude, longitude: longitude, accuracy: accuracy, age: age) ?? unavailable
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression]) != nil
    }
}
