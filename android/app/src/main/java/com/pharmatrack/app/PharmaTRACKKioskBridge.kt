package com.pharmatrack.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Native JavaScript Interface exposed to the web application as `window.PharmaTRACKAndroidKiosk`.
 * Implements real Android lock-task, fullscreen immersive, screen-capture blocking,
 * and package delivery controls.
 */
class PharmaTRACKKioskBridge(private val activity: MainActivity) {
    companion object {
        private const val TAG = "PharmaTRACKKioskBridge"
    }

    private var lockTaskActive = false
    private var externalIntentsRestricted = false
    private var screenCaptureBlocked = false
    private var pendingPharmaExamBytes: ByteArray? = null
    private val allowedHosts = mutableSetOf("localhost", "127.0.0.1", "10.0.2.2")

    fun isExternalIntentsRestricted(): Boolean = externalIntentsRestricted
    fun isSecureExamActive(): Boolean = lockTaskActive

    fun isHostAllowed(host: String): Boolean {
        if (allowedHosts.contains(host)) return true
        if (host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.")) {
            return true
        }
        return false
    }

    fun setPendingPharmaExam(bytes: ByteArray) {
        this.pendingPharmaExamBytes = bytes
        // If webview is already running, push to web handler
        Handler(Looper.getMainLooper()).post {
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            activity.getWebView()?.evaluateJavascript(
                "if (window.PharmaTRACKAndroidKiosk && window.PharmaTRACKAndroidKiosk._dispatchLaunch) { window.PharmaTRACKAndroidKiosk._dispatchLaunch('$base64'); }",
                null
            )
        }
    }

    @JavascriptInterface
    fun enterLockTask(): Boolean {
        Log.i(TAG, "Native enterLockTask requested.")
        val success = activity.enterLockTaskMode()
        if (success) {
            lockTaskActive = true
            externalIntentsRestricted = true
            setScreenCaptureBlocked(true)
            setImmersiveMode(true)
        }
        return success
    }

    @JavascriptInterface
    fun exitLockTask(): Boolean {
        Log.i(TAG, "Native exitLockTask requested.")
        val success = activity.exitLockTaskMode()
        if (success) {
            lockTaskActive = false
            externalIntentsRestricted = false
            setScreenCaptureBlocked(false)
            setImmersiveMode(false)
        }
        return success
    }

    @JavascriptInterface
    fun setImmersiveMode(enabled: Boolean): Boolean {
        Log.i(TAG, "setImmersiveMode: $enabled")
        return activity.setImmersiveStickyMode(enabled)
    }

    @JavascriptInterface
    fun setScreenCaptureBlocked(blocked: Boolean): Boolean {
        Log.i(TAG, "setScreenCaptureBlocked: $blocked")
        screenCaptureBlocked = blocked
        return activity.setScreenCaptureBlocked(blocked)
    }

    @JavascriptInterface
    fun restrictExternalIntents(restricted: Boolean): Boolean {
        Log.i(TAG, "restrictExternalIntents: $restricted")
        externalIntentsRestricted = restricted
        return true
    }

    @JavascriptInterface
    fun getPendingPharmaExam(): String? {
        val bytes = pendingPharmaExamBytes ?: return null
        pendingPharmaExamBytes = null
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun capabilityStatus(): String {
        val json = JSONObject()
        json.put("android-lock-task", true)
        json.put("screen-capture-restriction", true)
        json.put("screen-recording-restriction", true)
        json.put("immersive-window", true)
        json.put("browser-navigation-block", true)
        json.put("external-link-block", true)
        json.put("pharmaexam-file-association", true)
        json.put("focus-monitoring", true)
        json.put("os-app-switch-restriction", true)
        json.put("mobile-home-gesture-restriction", true)
        return json.toString()
    }
}
