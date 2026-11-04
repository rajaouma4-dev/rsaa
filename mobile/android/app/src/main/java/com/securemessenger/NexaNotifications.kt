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
import android.graphics.BitmapShader
import android.graphics.Shader
import android.graphics.Matrix
import android.widget.RemoteViews
import android.util.Base64
import android.os.Build
import android.os.Bundle
import android.media.AudioAttributes
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import java.util.UUID
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/** Native so an FCM wakeup can display without a running React Native engine. */
object NexaNotifications {
    const val CHANNEL = "nexa_messages_bubble_v2"
    const val QUIET_CHANNEL = "nexa_messages_quiet_v2"
    private const val LEGACY_CHANNEL = "nexa_messages_v1"
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

    fun soundEnabled(context: Context): Boolean = prefs(context).getBoolean("sound_enabled",true)
    fun channel(context: Context): String = if(soundEnabled(context)) CHANNEL else QUIET_CHANNEL
    fun soundUri(context: Context): Uri = Uri.parse("android.resource://${context.packageName}/raw/moonlit_bubble")
    fun setSoundEnabled(context: Context, enabled: Boolean) {
        createChannel(context)
        prefs(context).edit().putBoolean("sound_enabled",enabled).commit()
        onTokenChanged?.invoke() // Re-register this installation's selected channel immediately.
    }
    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager=context.getSystemService(NotificationManager::class.java)
            val legacy=manager.getNotificationChannel(LEGACY_CHANNEL)
            if(!prefs(context).contains("sound_enabled")) {
                prefs(context).edit().putBoolean("sound_enabled",legacy==null || legacy.sound!=null).commit()
            }
            // Preserve an existing channel block/importance during migration.
            // Sound/quiet are separate immutable Android channels; toggling never
            // deletes channels or changes a user's system sound preferences.
            val importance=legacy?.importance ?: NotificationManager.IMPORTANCE_HIGH
            for((id,name) in listOf(CHANNEL to "Messages · Moonlit Bubble",QUIET_CHANNEL to "Messages · Sound off")) {
                val item=NotificationChannel(id,name,importance).apply {
                    description="Private message alerts"
                    enableVibration(legacy?.shouldVibrate() ?: true)
                    lockscreenVisibility=android.app.Notification.VISIBILITY_PRIVATE
                    setSound(if(id==CHANNEL) soundUri(context) else null,
                        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                }
                manager.createNotificationChannel(item)
            }
        }
    }

    fun allowed(context: Context): Boolean {
        createChannel(context)
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 26 || context.getSystemService(NotificationManager::class.java)
            .getNotificationChannel(channel(context))?.importance != NotificationManager.IMPORTANCE_NONE
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

    @Synchronized fun receiptKey(context: Context): String {
        val p=prefs(context)
        if (p.getString("server","").isNullOrEmpty()) return ""
        return p.getString("receipt_key",null) ?: (UUID.randomUUID().toString()+UUID.randomUUID().toString()).replace("-","").also {
            p.edit().putString("receipt_key",it).commit()
        }
    }

    @Synchronized fun message(context: Context, uid: String, conversation: String, message: String,
        senderName: String = "Nexa Chat", avatar: String? = null, unread: Int = 1): Boolean {
        val p = prefs(context)
        if (uid.isEmpty() || p.getString("uid", null) != uid || conversation.isEmpty() || message.isEmpty()) return false
        val existing = runCatching { JSONArray(p.getString("recent", "[]")) }.getOrDefault(JSONArray())
        val ids = (0 until existing.length()).map { existing.getString(it) }.toMutableList()
        val seen=ids.contains(message)
        if (seen && (foreground || avatar==null || context.getSystemService(NotificationManager::class.java).activeNotifications.none { it.tag=="nexa:$conversation" })) return true
        // Remember foreground deliveries too, so a delayed push cannot alert later.
        if (!seen) ids.add(message)
        if (foreground) {
            p.edit().putString("recent", JSONArray(ids.takeLast(512)).toString()).commit();return true
        }
        // A blocked alert was not rendered. Do not acknowledge it or deduplicate
        // it away if permission is enabled before the server retries.
        if (!allowed(context)) return false
        val name = senderName.filterNot { it.isISOControl() }.take(80).ifBlank { "Nexa Chat" }
        val count = maxOf(p.getInt("count:$conversation",0), unread.coerceIn(1,9999))
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
        val icon=senderIcon(name,avatar)
        fun layout(resource: Int)=RemoteViews(context.packageName,resource).apply {
            setImageViewBitmap(R.id.sender_avatar,icon)
            setTextViewText(R.id.sender_name,name)
            setContentDescription(R.id.sender_name,name)
            setTextViewText(R.id.sender_count,text)
        }
        val notification = NotificationCompat.Builder(context, channel(context))
            .setSmallIcon(R.drawable.ic_message_notification)
            .setColor(Color.rgb(182,158,255))
            .setContentTitle(name)
            .setContentText(text)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(layout(R.layout.notification_sender_small))
            .setCustomBigContentView(layout(R.layout.notification_sender_expanded))
            .setCustomHeadsUpContentView(layout(R.layout.notification_sender_expanded))
            .setNumber(count)
            .setOnlyAlertOnce(seen)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_VIBRATE or NotificationCompat.DEFAULT_LIGHTS)
            .setSound(if(soundEnabled(context)) soundUri(context) else null)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(GROUP)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify("nexa:$conversation", 0, notification)
            p.edit().putInt("count:$conversation",count).putString("recent",JSONArray(ids.takeLast(512)).toString()).commit()
            runCatching { updateSummary(context) }
            return true
        }
        catch (_: Exception) { return false /* Server fallback remains pending. */ }
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
                    BitmapFactory.decodeByteArray(bytes,0,bytes.size)?.let { source ->
                        val result=Bitmap.createBitmap(96,96,Bitmap.Config.ARGB_8888)
                        val scale=maxOf(96f/source.width,96f/source.height)
                        val matrix=Matrix().apply {setScale(scale,scale);postTranslate((96-source.width*scale)/2,(96-source.height*scale)/2)}
                        val shader=BitmapShader(source,Shader.TileMode.CLAMP,Shader.TileMode.CLAMP).apply {setLocalMatrix(matrix)}
                        Canvas(result).drawCircle(48f,48f,48f,Paint(Paint.ANTI_ALIAS_FLAG).apply {this.shader=shader})
                        return result
                    }
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

    /** Runs on Firebase's background worker; bounded I/O, no React engine needed. */
    fun receive(context: Context, data: Map<String,String>) {
        val uid=data["recipient_uid"] ?: return
        val conversation=data["conversation_id"] ?: return
        val id=data["message_id"] ?: return
        val p=prefs(context)
        if (p.getString("uid",null)!=uid) return
        // Render before any network I/O. FCM gives this callback a short window;
        // slow avatar downloads must never delay the actual message alert.
        val sender=data["sender_name"] ?: "Nexa Chat"
        val unread=data["unread_count"]?.toIntOrNull() ?: 1
        val handled=message(context,uid,conversation,id,sender,null,unread)
        val base=p.getString("server","") ?: ""
        val version=data["avatar_version"] ?: ""
        val avatar=if (handled && !foreground && base.startsWith("https://") && version.matches(Regex("[a-f0-9]{64}"))) {
            runCatching {
                val connection=URL("$base/notification-avatar/$version.jpg").openConnection() as HttpsURLConnection
                try {
                    connection.connectTimeout=1500;connection.readTimeout=1500;connection.instanceFollowRedirects=false
                    check(connection.responseCode==200)
                    val output=java.io.ByteArrayOutputStream()
                    connection.inputStream.use { input ->
                        val buffer=ByteArray(4096)
                        while (true) {val n=input.read(buffer);if(n<0)break;check(output.size()+n<=16000);output.write(buffer,0,n)}
                    }
                    "data:image/jpeg;base64,"+Base64.encodeToString(output.toByteArray(),Base64.NO_WRAP)
                } finally {connection.disconnect()}
            }.getOrNull()
        } else null
        if (avatar!=null) message(context,uid,conversation,id,sender,avatar,unread)
        if (handled && data["native_renderer"]=="1" && base.startsWith("https://")) {
            runCatching {
                val bytes=JSONObject().put("uid",uid).put("installation_id",installation(context))
                    .put("message_id",id).put("receipt_key",receiptKey(context)).toString().toByteArray(Charsets.UTF_8)
                val connection=URL("$base/notification-receipt").openConnection() as HttpsURLConnection
                try {
                    connection.requestMethod="POST";connection.connectTimeout=1500;connection.readTimeout=1500
                    connection.instanceFollowRedirects=false;connection.doOutput=true
                    connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use {it.write(bytes)};connection.responseCode
                } finally {connection.disconnect()}
            }
        }
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
        val summary=NotificationCompat.Builder(context,channel(context)).setSmallIcon(R.drawable.ic_message_notification)
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
