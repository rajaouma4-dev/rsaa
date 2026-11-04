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
    private Bundle options;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        options=arguments;
        rotateToken = arguments != null && "true".equals(arguments.getString("rotate_token"));
        start();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            SharedPreferences prefs = getTargetContext().getSharedPreferences("nexa_notifications", 0);
            if (options!=null && "true".equals(options.getString("render_preview"))) {
                String avatar=null;
                if (options.getString("avatar_file")!=null) {
                    byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(options.getString("avatar_file")));
                    avatar="data:image/jpeg;base64,"+android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP);
                }
                boolean rendered=NexaNotifications.INSTANCE.message(getTargetContext(),prefs.getString("uid",""),
                    "qa-layout-preview","qa-layout-"+System.currentTimeMillis(),
                    options.getString("preview_name","Abdur Rahman Mohammed Abdullah Al Mamun Chowdhury"),avatar,2);
                result.putString("rendered",Boolean.toString(rendered));
            }
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
            registration.put("receipt_key",prefs.getString("receipt_key",""));
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
