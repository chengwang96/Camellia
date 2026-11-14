package app.camellia.mobile;

import android.animation.ObjectAnimator;
import android.animation.StateListAnimator;
import android.os.Build;
import android.view.View;

/** Shared low-elevation and pressed-depth treatment for button-like surfaces. */
final class SurfaceElevation {
    private SurfaceElevation() {}

    static void apply(View view, int elevationDp) {
        float density = view.getResources().getDisplayMetrics().density;
        int pressedDepth = Math.max(1, Math.round(density));
        view.setElevation(elevationDp * density);
        if (Build.VERSION.SDK_INT >= 28) {
            view.setOutlineAmbientShadowColor(0x16000000);
            view.setOutlineSpotShadowColor(0x24000000);
        }
        StateListAnimator states = new StateListAnimator();
        ObjectAnimator pressed = ObjectAnimator.ofFloat(view, "translationZ", -pressedDepth);
        pressed.setDuration(90);
        ObjectAnimator resting = ObjectAnimator.ofFloat(view, "translationZ", 0f);
        resting.setDuration(140);
        states.addState(new int[]{android.R.attr.state_pressed, android.R.attr.state_enabled}, pressed);
        states.addState(new int[]{}, resting);
        view.setStateListAnimator(states);
    }
}
