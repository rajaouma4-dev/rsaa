package com.securemessenger

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class NexaMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { NexaNotifications.setToken(this, token) }
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] != "new_message") return
        NexaNotifications.receive(this,data)
    }
}
