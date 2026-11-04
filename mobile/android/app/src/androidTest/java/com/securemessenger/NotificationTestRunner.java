package com.securemessenger;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.SharedPreferences;
import android.os.Bundle;
import org.json.JSONObject;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.android.gms.tasks.Tasks;
import java.util.concurrent.TimeUnit;

/** Test APK only. Runs under Android instrumentation, never exported by the app. */
public final class NotificationTestRunner extends Instrumentation {
    private boolean rotateToken;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        rotateToken = arguments != null && "true".equals(arguments.getString("rotate_token"));
        start();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            SharedPreferences prefs = getTargetContext().getSharedPreferences("nexa_notifications", 0);
            // Explicit QA recovery only; never rotate a production token on every boot.
            if (rotateToken) {
                FirebaseMessaging messaging = FirebaseMessaging.getInstance();
                Tasks.await(messaging.deleteToken(), 25, TimeUnit.SECONDS);
                String token = Tasks.await(messaging.getToken(), 25, TimeUnit.SECONDS);
                prefs.edit().putString("token", token).commit();
            }
            JSONObject registration = new JSONObject();
            registration.put("token", prefs.getString("token", ""));
            registration.put("uid", prefs.getString("uid", ""));
            registration.put("installation_id", prefs.getString("installation", ""));
            registration.put("recent", new org.json.JSONArray(prefs.getString("recent", "[]")));
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                registration.put("delegation_enabled", "com.google.android.gms".equals(
                    getTargetContext().getSystemService(android.app.NotificationManager.class).getNotificationDelegate()));
            }
            // Caller captures stdout privately; never put tokens in Logcat.
            result.putString("registration", registration.toString());
            finish(Activity.RESULT_OK, result);
        } catch (Exception error) {
            result.putString("error", error.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
