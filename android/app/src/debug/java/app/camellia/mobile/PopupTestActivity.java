package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;

/** A stable window for popup tests while power saver changes the system theme. */
public final class PopupTestActivity extends Activity {
    @Override protected void attachBaseContext(Context context) {
        super.attachBaseContext(context);
        Configuration override = new Configuration();
        override.uiMode = Configuration.UI_MODE_TYPE_NORMAL | Configuration.UI_MODE_NIGHT_NO;
        applyOverrideConfiguration(override);
    }
}
