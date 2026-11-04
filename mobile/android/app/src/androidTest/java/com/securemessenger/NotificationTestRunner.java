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
    private String delegateBeforeApplicationStart;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        options=arguments;
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            delegateBeforeApplicationStart=getTargetContext().getSystemService(android.app.NotificationManager.class).getNotificationDelegate();
        }
        rotateToken = arguments != null && "true".equals(arguments.getString("rotate_token"));
        start();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            SharedPreferences prefs = getTargetContext().getSharedPreferences("nexa_notifications", 0);
            if (options!=null && "true".equals(options.getString("test_sound_channels"))) {
                NexaNotifications.INSTANCE.createChannel(getTargetContext());
                boolean original=NexaNotifications.INSTANCE.soundEnabled(getTargetContext());
                try {
                    NexaNotifications.INSTANCE.setSoundEnabled(getTargetContext(),true);
                    android.app.NotificationManager manager=getTargetContext().getSystemService(android.app.NotificationManager.class);
                    if(android.os.Build.VERSION.SDK_INT>=26) {
                        result.putString("bubble_sound",String.valueOf(manager.getNotificationChannel(NexaNotifications.CHANNEL).getSound()));
                        NexaNotifications.INSTANCE.setSoundEnabled(getTargetContext(),false);
                        result.putString("quiet_sound",String.valueOf(manager.getNotificationChannel(NexaNotifications.QUIET_CHANNEL).getSound()));
                        result.putString("quiet_selected",NexaNotifications.INSTANCE.channel(getTargetContext()));
                    }
                    android.media.MediaMetadataRetriever media=new android.media.MediaMetadataRetriever();
                    try {media.setDataSource(getTargetContext(),NexaNotifications.INSTANCE.soundUri(getTargetContext()));result.putString("sound_duration_ms",media.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION));}
                    finally {media.release();}
                } finally {NexaNotifications.INSTANCE.setSoundEnabled(getTargetContext(),original);}
                result.putString("sound_preference_restored",Boolean.toString(NexaNotifications.INSTANCE.soundEnabled(getTargetContext())==original));
            }
            if (options!=null && "true".equals(options.getString("inspect_delegation"))) {
                Thread.sleep(2500);
                result.putString("delegate_before_application_start",String.valueOf(delegateBeforeApplicationStart));
                if (android.os.Build.VERSION.SDK_INT >= 29) result.putString("delegate_after_initialization",String.valueOf(getTargetContext().getSystemService(android.app.NotificationManager.class).getNotificationDelegate()));
                result.putString("notifications_enabled",Boolean.toString(NexaNotifications.INSTANCE.allowed(getTargetContext())));
                String storedToken=prefs.getString("token","");
                String sdkToken=Tasks.await(FirebaseMessaging.getInstance().getToken(),25,TimeUnit.SECONDS);
                result.putString("sdk_token_matches_stored",Boolean.toString(storedToken.equals(sdkToken)));
            }
            if (options!=null && options.getString("probe_id")!=null) {
                String id=options.getString("probe_id");
                boolean handled=NexaNotifications.INSTANCE.message(getTargetContext(),prefs.getString("uid",""),
                    "qa-permission-retry",id,"QA permission retry",null,1);
                result.putString("probe_handled",Boolean.toString(handled));
                result.putString("probe_remembered",Boolean.toString(prefs.getString("recent","[]").contains(id)));
            }
            if (options!=null && "true".equals(options.getString("test_duplicate_count"))) {
                byte[] bytes=java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(options.getString("avatar_file")));
                String avatar="data:image/jpeg;base64,"+android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP);
                String id="qa-duplicate-"+System.currentTimeMillis(),conv=id;
                String uid=prefs.getString("uid","");
                NexaNotifications.INSTANCE.message(getTargetContext(),uid,conv,id,"QA count",avatar,1);
                Thread.sleep(500); // Android commits notify() asynchronously.
                NexaNotifications.INSTANCE.message(getTargetContext(),uid,conv,id,"QA count",avatar,2);
                Thread.sleep(200);
                android.app.NotificationManager manager=getTargetContext().getSystemService(android.app.NotificationManager.class);
                int count=-1;
                for (android.service.notification.StatusBarNotification item:manager.getActiveNotifications()) {
                    if (("nexa:"+conv).equals(item.getTag())) count=item.getNotification().number;
                }
                result.putString("duplicate_count",Integer.toString(count));
                manager.cancel("nexa:"+conv,0);
            }
            if (options!=null && "true".equals(options.getString("test_foreground_alert"))) {
                getTargetContext().startActivity(new android.content.Intent(getTargetContext(),MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
                Thread.sleep(2500);
                if (!NexaNotifications.INSTANCE.getForeground()) throw new IllegalStateException("Activity not visible");
                android.app.NotificationManager manager=getTargetContext().getSystemService(android.app.NotificationManager.class);
                int icon=getTargetContext().getResources().getIdentifier("ic_message_notification","drawable",getTargetContext().getPackageName());
                manager.notify("nexa:qa-delayed-foreground",0,new android.app.Notification.Builder(getTargetContext(),NexaNotifications.INSTANCE.channel(getTargetContext())).setSmallIcon(icon).setContentTitle("QA delayed alert").setContentText("Test count only").build());
                Thread.sleep(1800);
                int count=0;
                for (android.service.notification.StatusBarNotification item:manager.getActiveNotifications()) {
                    if ("nexa:qa-delayed-foreground".equals(item.getTag())) count++;
                }
                result.putString("foreground_alert_count",Integer.toString(count));
                manager.cancel("nexa:qa-delayed-foreground",0);
            }
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
