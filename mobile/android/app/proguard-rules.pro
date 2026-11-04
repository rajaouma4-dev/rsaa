# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
-keep class com.facebook.react.** { *; }
-keep class com.facebook.jni.** { *; }
-keepattributes *Annotation*
# The separately signed QA runner verifies the rendered notification layout.
-keep class com.securemessenger.NexaNotifications { *; }
# The separately signed release instrumentation APK uses these public APIs to
# verify/repair a test device's registration. Keep its release ABI stable.
-keep,includedescriptorclasses class com.google.firebase.messaging.FirebaseMessaging {
    public static com.google.firebase.messaging.FirebaseMessaging getInstance();
    public com.google.android.gms.tasks.Task deleteToken();
    public com.google.android.gms.tasks.Task getToken();
}
-keep,includedescriptorclasses class com.google.android.gms.tasks.Tasks {
    public static *** await(...);
}
