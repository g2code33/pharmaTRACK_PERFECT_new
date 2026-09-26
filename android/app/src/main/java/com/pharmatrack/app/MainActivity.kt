package com.pharmatrack.app

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.InputStream

/**
 * Main Activity hosting the PharmaTRACK examination kiosk.
 * Coordinates system UI flags, device owner / lock-task policies, hardware back-button
 * interception, and intent-based package imports.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "PharmaTRACKMainActivity"
    }

    private lateinit var webView: WebView
    private lateinit var kioskBridge: PharmaTRACKKioskBridge

    fun getWebView(): WebView? = if (::webView.isInitialized) webView else null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialize Kiosk Bridge
        kioskBridge = PharmaTRACKKioskBridge(this)

        // Setup WebView
        webView = WebView(this)
        setContentView(webView)

        configureWebView()

        // Handle hardware back-button
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (kioskBridge.isSecureExamActive()) {
                    Log.w(TAG, "Hardware back button blocked during active examination.")
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('pharmatrack:back-blocked', { detail: 'Hardware back button is disabled during secure examination.' }));",
                        null
                    )
                } else if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // Process startup intent for .pharmaexam files
        handleIncomingFileIntent(intent)

        // Load entrypoint
        val launchUrl = "file:///android_asset/dist/index.html"
        webView.loadUrl(launchUrl)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent?.let { handleIncomingFileIntent(it) }
    }

    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Add JavaScript Interface matching the PharmaTRACKAndroidKiosk contract
        webView.addJavascriptInterface(kioskBridge, "PharmaTRACKAndroidKiosk")
        webView.webViewClient = KioskWebViewClient(kioskBridge)
    }

    /**
     * Enters Android Lock-Task mode (screen pinning / dedicated kiosk mode).
     */
    fun enterLockTaskMode(): Boolean {
        return try {
            val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val adminComponent = ComponentName(this, KioskDeviceAdminReceiver::class.java)
            if (dpm.isDeviceOwnerApp(packageName) || dpm.isProfileOwnerApp(packageName)) {
                dpm.setLockTaskPackages(adminComponent, arrayOf(packageName))
            }
            startLockTask()
            Log.i(TAG, "Lock-task mode activated.")
            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to enter lock-task mode: ${e.message}")
            false
        }
    }

    /**
     * Exits Android Lock-Task mode upon authorized exam submission.
     */
    fun exitLockTaskMode(): Boolean {
        return try {
            stopLockTask()
            Log.i(TAG, "Lock-task mode deactivated.")
            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to exit lock-task mode: ${e.message}")
            false
        }
    }

    /**
     * Toggles WindowManager.LayoutParams.FLAG_SECURE to block screen captures
     * and operating system screen recording.
     */
    fun setScreenCaptureBlocked(blocked: Boolean): Boolean {
        return try {
            runOnUiThread {
                if (blocked) {
                    window.setFlags(
                        WindowManager.LayoutParams.FLAG_SECURE,
                        WindowManager.LayoutParams.FLAG_SECURE
                    )
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to toggle FLAG_SECURE: ${e.message}")
            false
        }
    }

    /**
     * Configures sticky immersive fullscreen, hiding status and navigation bars.
     */
    fun setImmersiveStickyMode(enabled: Boolean): Boolean {
        return try {
            runOnUiThread {
                WindowCompat.setDecorFitsSystemWindows(window, false)
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                if (enabled) {
                    controller.hide(WindowInsetsCompat.Type.systemBars())
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars())
                }
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to toggle immersive sticky mode: ${e.message}")
            false
        }
    }

    private fun handleIncomingFileIntent(intent: Intent) {
        val action = intent.action
        val uri: Uri? = intent.data ?: intent.getParcelableExtra(Intent.EXTRA_STREAM)
        if ((Intent.ACTION_VIEW == action || Intent.ACTION_SEND == action) && uri != null) {
            try {
                contentResolver.openInputStream(uri)?.use { stream: InputStream ->
                    val bytes = stream.readBytes()
                    if (bytes.size <= 50 * 1024 * 1024) {
                        kioskBridge.setPendingPharmaExam(bytes)
                        Log.i(TAG, "Loaded .pharmaexam package from intent (${bytes.size} bytes).")
                    } else {
                        Log.e(TAG, "Package exceeds 50MB limit.")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Could not read package from intent URI: ${e.message}")
            }
        }
    }
}
