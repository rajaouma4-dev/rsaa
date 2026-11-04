package com.securemessenger;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.SharedPreferences;
import android.os.Bundle;
import org.json.JSONObject;

/** Test APK only. Runs under Android instrumentation, never exported by the app. */
public final class NotificationTestRunner extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            SharedPreferences prefs = getTargetContext().getSharedPreferences("nexa_notifications", 0);
            JSONObject registration = new JSONObject();
            registration.put("token", prefs.getString("token", ""));
            registration.put("uid", prefs.getString("uid", ""));
            registration.put("installation_id", prefs.getString("installation", ""));
            registration.put("recent", new org.json.JSONArray(prefs.getString("recent", "[]")));
            // Caller captures stdout privately; never put tokens in Logcat.
            result.putString("registration", registration.toString());
            finish(Activity.RESULT_OK, result);
        } catch (Exception error) {
            result.putString("error", error.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
