package app.camellia.mobile;

import android.app.Application;

public final class CamelliaApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        DisplayRefreshRate.install(this);
    }
}
