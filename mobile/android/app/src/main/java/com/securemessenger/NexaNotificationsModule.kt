package com.securemessenger

import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

class NexaNotificationsModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private var lastTokenRequest = 0L
    override fun getName() = "NexaNotifications"
    init {
        NexaNotifications.onTokenChanged = {
            runCatching {
                if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("NexaPushTokenChanged", null)
            }
        }
        NexaNotifications.onNotificationOpened = {
            runCatching {
                if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("NexaNotificationOpened", null)
            }
        }
    }
    override fun invalidate() {
        NexaNotifications.onTokenChanged = null
        NexaNotifications.onNotificationOpened = null
        super.invalidate()
    }
    @ReactMethod fun addListener(event: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    @ReactMethod fun setAccount(uid: String?, promise: Promise) { NexaNotifications.setAccount(context,uid); promise.resolve(null) }
    @ReactMethod fun getRegistration(promise: Promise) {
        val configured = FirebaseApp.getApps(context).isNotEmpty()
        val services = GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
        val allowed = NexaNotifications.allowed(context)
        if (configured && services && allowed && System.currentTimeMillis()-lastTokenRequest > 60000) {
            lastTokenRequest = System.currentTimeMillis()
            runCatching {
                FirebaseMessaging.getInstance().isAutoInitEnabled = true
                FirebaseMessaging.getInstance().token.addOnSuccessListener { NexaNotifications.setToken(context,it) }
            }
        }
        promise.resolve(Arguments.createMap().apply {
            putString("installationId", NexaNotifications.installation(context))
            putString("token", NexaNotifications.token(context))
            putBoolean("configured", configured); putBoolean("googleServices", services); putBoolean("enabled",allowed)
        })
    }
    @ReactMethod fun showMessage(uid: String, conversation: String, message: String, sender: String, avatar: String?, count: Double) {
        NexaNotifications.message(context,uid,conversation,message,sender,avatar,count.toInt())
    }
    @ReactMethod fun consumeOpen(uid: String, promise: Promise) { promise.resolve(NexaNotifications.consumeOpen(context,uid)) }
    @ReactMethod fun openSettings() {
        if (android.os.Build.VERSION.SDK_INT < 26) {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:"+context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE,context.packageName); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }
}
