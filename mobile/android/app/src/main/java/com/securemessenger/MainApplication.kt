package com.securemessenger

import android.app.Application
import android.os.Build
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.oney.WebRTCModule.WebRTCModuleOptions

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(NexaMediaPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    val rtcOptions = WebRTCModuleOptions.getInstance()
    rtcOptions.enableMediaProjectionService = true
    // Some x86 Android virtual clocks regress by sub-millisecond intervals.
    // Keep the established bitrate controller on these devices instead of the
    // newer RateUtilizationTracker path, which aborts on timestamp regression.
    if (Build.SUPPORTED_ABIS.any { it == "x86" || it == "x86_64" }) {
      rtcOptions.fieldTrials = "WebRTC-BitrateAdjusterUseNewfangledHeadroomAdjustment/Disabled/"
    }
    loadReactNative(this)
  }
}
