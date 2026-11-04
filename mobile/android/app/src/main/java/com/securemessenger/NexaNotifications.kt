package com.securemessenger

import android.app.Activity
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Base64
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import java.util.UUID
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/** Native so an FCM wakeup can display without a running React Native engine. */
object NexaNotifications {
    const val CHANNEL = "nexa_messages_v1"
    private const val GROUP = "nexa-messages"
    @Volatile var foreground = false
        private set
    var onTokenChanged: (() -> Unit)? = null
    var onNotificationOpened: (() -> Unit)? = null
    private fun prefs(context: Context) = context.getSharedPreferences("nexa_notifications", Context.MODE_PRIVATE)

    fun initialize(application: Application) {
        createChannel(application)
        // Let Play services display an alert without starting our process on
        // Android 10+. Explicitly enable it for existing installs as well.
        if (Build.VERSION.SDK_INT >= 29 && FirebaseApp.getApps(application).isNotEmpty()) {
            runCatching { FirebaseMessaging.getInstance().setNotificationDelegationEnabled(true) }
        }
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            private var started = 0
            override fun onActivityStarted(activity: Activity) {
                started++
                foreground = true
                clearVisible(application)
            }
            override fun onActivityStopped(activity: Activity) { started = (started - 1).coerceAtLeast(0); foreground = started > 0 }
            override fun onActivityCreated(activity: Activity, state: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New private messages when Nexa Chat is in the background"
                enableVibration(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            }
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    fun allowed(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 26 || context.getSystemService(NotificationManager::class.java)
            .getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    @Synchronized fun installation(context: Context): String {
        val p = prefs(context)
        return p.getString("installation", null) ?: UUID.randomUUID().toString().also { p.edit().putString("installation", it).commit() }
    }

    @Synchronized fun setAccount(context: Context, uid: String?) {
        val p = prefs(context)
        if (p.getString("uid", null) != uid) {
            p.edit().putString("uid", uid).remove("recent").remove("open_conversation").remove("open_uid").commit()
            clearVisible(context)
        }
    }
    fun token(context: Context): String = prefs(context).getString("token", "") ?: ""
    fun setToken(context: Context, token: String) { prefs(context).edit().putString("token", token).apply(); onTokenChanged?.invoke() }

    @Synchronized fun message(context: Context, uid: String, conversation: String, message: String,
        senderName: String = "Nexa Chat", avatar: String? = null, unread: Int = 1) {
        val p = prefs(context)
        if (uid.isEmpty() || p.getString("uid", null) != uid || conversation.isEmpty() || message.isEmpty()) return
        val existing = runCatching { JSONArray(p.getString("recent", "[]")) }.getOrDefault(JSONArray())
        val ids = (0 until existing.length()).map { existing.getString(it) }.toMutableList()
        if (ids.contains(message)) return
        // Remember foreground deliveries too, so a delayed push cannot alert later.
        ids.add(message)
        p.edit().putString("recent", JSONArray(ids.takeLast(512)).toString()).commit()
        if (foreground || !allowed(context)) return
        val name = senderName.filterNot { it.isISOControl() }.take(80).ifBlank { "Nexa Chat" }
        val count = maxOf((p.getInt("count:$conversation",0) + 1).coerceAtMost(9999), unread.coerceIn(1,9999))
        p.edit().putInt("count:$conversation",count).apply()
        val text = if (count == 1) "1 new message" else "$count new messages"
        createChannel(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            action = "com.securemessenger.OPEN_MESSAGE"
            data = android.net.Uri.Builder().scheme("nexa").authority("conversation").appendPath(conversation).build()
            putExtra("notification_uid", uid)
            putExtra("notification_conversation", conversation)
        }
        val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_message_notification)
            .setColor(Color.rgb(182,158,255))
            .setContentTitle(name)
            .setContentText(text)
            .setLargeIcon(senderIcon(name,avatar))
            .setNumber(count)
            .setSubText("Nexa Chat")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(GROUP)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify("nexa:$conversation", 0, notification)
            updateSummary(context)
        }
        catch (_: SecurityException) { /* Permission may be revoked between check and post. */ }
    }

    fun clearVisible(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag?.startsWith("nexa:") == true }.forEach { manager.cancel(it.tag, it.id) }
        val p=prefs(context); val edit=p.edit()
        p.all.keys.filter { it.startsWith("count:") }.forEach { edit.remove(it) };edit.apply()
    }

    private fun senderIcon(name: String, avatar: String?): Bitmap {
        if (avatar?.startsWith("data:image/jpeg;base64,") == true && avatar.length <= 21400) {
            runCatching {
                val bytes=Base64.decode(avatar.substringAfter(','),Base64.DEFAULT)
                val options=BitmapFactory.Options().apply { inJustDecodeBounds=true }
                BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
                if (options.outWidth in 1..512 && options.outHeight in 1..512) {
                    BitmapFactory.decodeByteArray(bytes,0,bytes.size)?.let { return Bitmap.createScaledBitmap(it,96,96,true) }
                }
            }
        }
        val bitmap=Bitmap.createBitmap(96,96,Bitmap.Config.ARGB_8888)
        val canvas=Canvas(bitmap);val paint=Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color=Color.rgb(92,68,160);canvas.drawCircle(48f,48f,48f,paint)
        paint.color=Color.WHITE;paint.textSize=44f;paint.textAlign=Paint.Align.CENTER
        canvas.drawText(name.take(1).uppercase(),48f,48f-(paint.ascent()+paint.descent())/2,paint)
        return bitmap
    }

    private fun updateSummary(context: Context) {
        val manager=context.getSystemService(NotificationManager::class.java)
        val children=manager.activeNotifications.filter { it.tag?.startsWith("nexa:")==true && it.tag!="nexa:summary" }
        if (children.size < 2) { manager.cancel("nexa:summary",0);return }
        val total=children.sumOf { it.notification.number.coerceAtLeast(1) }
        val style=NotificationCompat.InboxStyle()
        children.take(7).forEach { item -> style.addLine("${item.notification.extras.getCharSequence("android.title")} · ${item.notification.number.coerceAtLeast(1)} messages") }
        val intent=Intent(context,MainActivity::class.java).apply { flags=Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP }
        val open=PendingIntent.getActivity(context,1,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val summary=NotificationCompat.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_message_notification)
            .setContentTitle("${children.size} people").setContentText("$total new messages").setStyle(style)
            .setGroup(GROUP).setGroupSummary(true).setSilent(true).setNumber(total)
            .setContentIntent(open).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        manager.notify("nexa:summary",0,summary)
    }
    fun captureOpen(context: Context, intent: Intent?) {
        val uid = intent?.getStringExtra("notification_uid") ?: return
        val conversation = intent.getStringExtra("notification_conversation") ?: return
        if (prefs(context).getString("uid", null) != uid) return
        prefs(context).edit().putString("open_uid",uid).putString("open_conversation",conversation).commit()
        intent.removeExtra("notification_uid")
        intent.removeExtra("notification_conversation")
        onNotificationOpened?.invoke()
    }
    @Synchronized fun consumeOpen(context: Context, uid: String): String? {
        val p = prefs(context)
        if (p.getString("open_uid", null) != uid) return null
        val conversation = p.getString("open_conversation", null)
        p.edit().remove("open_uid").remove("open_conversation").commit()
        return conversation
    }
}
