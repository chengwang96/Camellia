package app.camellia.mobile;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;

/** Desktop-aligned light/dark tokens shared by native chat and settings.
 * Settings keep their own semantic names, while card/control radii stay
 * separate from the larger touch popups and bottom sheets.
 */
final class Palette {

    // ── Colour: chat pages ────────────────────────────────────────────────
    /** The page behind a chat list or transcript. */
    final int background;
    /** A raised block on a chat page: the user's own bubble, a group card. */
    final int surface;
    /** Primary text. */
    final int ink;
    /** Secondary, tertiary and placeholder text, respectively. */
    final int muted, faint, caption;
    final int userBubble, cardBorder, controlFill, selectedBorder, progressTrack;
    /** The hairline around a floating bar, and the dock's own edge. */
    final int separator;

    // ── Colour: settings, computers, pairing ──────────────────────────────
    /** The page behind a settings group. */
    final int grouped;
    /** A card on such a page. */
    final int card;
    /** Secondary text there. */
    final int secondary;
    /** The line between two rows of one group. */
    final int divider;
    /** A field's own fill, and the error text. */
    final int field;
    /** A field's outline. */
    final int fieldBorder;
    /** Destructive actions. */
    final int error;
    /** Readable status text; the brighter ONLINE dot is too light for small labels. */
    final int success, warning;

    /** Business accent shared with desktop. */
    final int accent;

    // ── Colour: the back button's own pair ────────────────────────────────
    /**
     * The raised disc, and its outline.
     *
     * <p>Not the field hairline above: this rings a raised button rather than a
     * field, and in both appearances it is a shade off the disc rather than the
     * value a divider would use.
     */
    final int raisedFace, raisedEdge;

    /** Whether these values are the dark set, for the few sites that ask. */
    final boolean dark;

    // ── Corner radii ───────────────────────────────────────────────────────
    /** A bubble or a card: {@code ChatStyle.rounded()}. */
    static final int RADIUS_CARD = 12;
    static final int RADIUS_USER_BUBBLE = 18;
    static final int RADIUS_SETTINGS_CARD = 16;
    static final int RADIUS_SETTINGS_CONTROL = 10;
    /** A floating bar or a search field: {@code ChatStyle.capsule()}. */
    static final int RADIUS_CAPSULE = 28;
    /** A settings card, a popup panel, a computer row's card. */
    static final int RADIUS_GROUP = 26;
    /** A bottom sheet's own panel. */
    static final int RADIUS_SHEET = 30;
    /** An input field, a computer row, a choice row's mask. */
    static final int RADIUS_FIELD = 18;
    /** A code block inside rendered Markdown. */
    static final int RADIUS_CODE = 8;
    /** A switch's track, and the grip on a sheet. */
    static final int RADIUS_TRACK = 14;
    static final int RADIUS_GRIP = 3;
    /**
     * A dialog's action button.
     *
     * <p>20 on a 52dp-tall button, so it reads as a rounded rectangle rather than
     * a pill — {@link #RADIUS_CAPSULE} at 28 would be a pill, and this one is not
     * meant to be. Same number as {@link #RADIUS_HOME_CARD} by coincidence of
     * when each was written, not because they are the same thing.
     */
    static final int RADIUS_DIALOG_ACTION = 20;
    /** The home screen's cards. */
    static final int RADIUS_HOME_CARD = 20;
    /** The hairline around a card on the home screen. */
    static final int RADIUS_HOME_EDGE = 20;

    /**
     * How far the reader's own bubble is inset from the trailing edge.
     *
     * <p>Not a radius. It is the width the bubble is allowed to reach, and it is
     * the same number on both sides so a short reply and a long one start and
     * end in the same place.
     */
    static final int BUBBLE_INSET = 44;

    // ── Type scale (sp) ───────────────────────────────────────────────────
    /** A timestamp, a status, a badge. */
    static final int TEXT_TINY = 11;
    /** Secondary text: note lines, a group label, a field's error. */
    static final int TEXT_SMALL = 12;
    static final int TEXT_NOTE = 13;
    /** Body text at rest: a row's description, a sheet's note. */
    static final int TEXT_BODY = 14;
    /** An input's own text, and error details. */
    static final int TEXT_INPUT = 15;
    /** A row's title, a computer's name, a bubble's action. */
    static final int TEXT_ROW = 16;
    /** A row's title in the settings vocabulary. */
    static final int TEXT_ROW_STRONG = 17;
    /** A dialog's item. */
    static final int TEXT_DIALOG = 18;
    /**
     * A card's own title, on the home screen.
     *
     * <p>One step below {@link #TEXT_TITLE} and deliberately so: the card sits
     * inside the page rather than being the page, and at 20 it would read as a
     * second heading. It is not an alias of anything above it — 19 appears
     * nowhere else in the app.
     */
    static final int TEXT_CARD = 19;
    /** A page or sheet heading. */
    static final int TEXT_TITLE = 20;
    /** An empty state's heading. */
    static final int TEXT_DISPLAY = 21;
    /**
     * A selection tick.
     *
     * <p>Larger than {@link #TEXT_DISPLAY} on purpose: it is a glyph rather than
     * words, and it has to stay legible next to a 17sp row title at a glance.
     */
    static final int TEXT_TICK = 22;
    /** The home screen's headline. */
    static final int TEXT_HERO = 28;

    // ── Ripple ─────────────────────────────────────────────────────────────
    /** On a floating bar or a line button over the page. */
    static final int RIPPLE_ON_PAGE = 0x224176e6;
    /** On a settings row, which sits on a card rather than the page. */
    static final int RIPPLE_ON_CARD = 0x184176e6;
    /** On a card of the home screen, whose own outline is already faint. */
    static final int RIPPLE_HOME_CARD = 0x144176e6;
    /** On a filled accent button, in either appearance. */
    static final int RIPPLE_ON_ACCENT_LIGHT = 0x33ffffff;
    /** The back button's own press. */
    static final int RIPPLE_BACK_LIGHT = 0x14000000;
    static final int RIPPLE_BACK_DARK = 0x33ffffff;

    // ── Status colours ─────────────────────────────────────────────────────
    /** A computer row's presence dot when it is reachable. */
    static final int ONLINE = 0xFF27B56D;
    /** A permission level's highlight, where a stricter one is worth marking. */
    static final int PERMISSION_STRICT = 0xC28A35;

    // ── Switch track ───────────────────────────────────────────────────────
    /** The track's off state: a light grey by day, a darker one at night. */
    final int trackOff;

    private Palette(boolean dark) {
        this.dark = dark;
        background = color(dark, "#151517", "#FFFFFF");
        surface = color(dark, "#232324", "#F5F6F7");
        ink = color(dark, "#F9FAFB", "#0F1115");
        muted = color(dark, "#CFD3D6", "#61666B");
        faint = color(dark, "#ADB2B8", "#81858C");
        caption = color(dark, "#81858C", "#ADB2B8");
        userBubble = color(dark, "#283142", "#EDF3FE");
        cardBorder = color(dark, "#424448", "#D6D6D8");
        controlFill = color(dark, "#292A2D", "#F5F6F7");
        selectedBorder = color(dark, "#737981", "#ADB2B8");
        progressTrack = color(dark, "#353638", "#EBEEF2");
        separator = color(dark, "#3B3B40", "#ECEEF1");

        grouped = background;
        card = color(dark, "#232324", "#FFFFFF");
        secondary = muted;
        divider = color(dark, "#37373C", "#ECECEE");
        field = controlFill;
        fieldBorder = cardBorder;
        error = color(dark, "#FF969A", "#B8323B");
        success = color(dark, "#7DDDA5", "#187644");
        warning = color(dark, "#EAC56D", "#8A5A12");

        accent = color(dark, "#679EFE", "#4176E6");

        raisedFace = color(dark, "#29292D", "#FFFFFF");
        raisedEdge = color(dark, "#3A3A40", "#F3F3F5");

        trackOff = color(dark, "#54575D", "#D9DCE0");
    }

    /** The home screen's card outline, which has no name of its own. */
    int homeCardEdge() { return color(dark, "#34363A", "#E6E8EB"); }

    /** The back button's press, which follows the appearance. */
    int backRipple() { return dark ? RIPPLE_BACK_DARK : RIPPLE_BACK_LIGHT; }

    static Palette of(Context context) {
        boolean dark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        return new Palette(dark);
    }

    private static int color(boolean dark, String darkValue, String lightValue) {
        return Color.parseColor(dark ? darkValue : lightValue);
    }
}
