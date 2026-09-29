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

        // Quick quiz app links load straight into the matching hash route.
        // Only non-link launches are treated as .pharmaexam package imports.
        if (routeFragmentFromIntent(intent) == null) {
            handleIncomingFileIntent(intent)
        }

        webView.loadUrl(launchUrlFromIntent(intent))
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent?.let {
            if (!handleIncomingAppLinkIntent(it)) {
                handleIncomingFileIntent(it)
            }
        }
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

    private fun launchUrlFromIntent(intent: Intent?): String {
        val fragment = intent?.let { routeFragmentFromIntent(it) } ?: "#/"
        return "file:///android_asset/dist/index.html$fragment"
    }

    private fun routeFragmentFromIntent(intent: Intent): String? {
        val uri = intent.data ?: return null
        return routeFragmentFromUri(uri)
    }

    private fun routeFragmentFromUri(uri: Uri): String? {
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme == "pharmatrack") {
            val query = uri.encodedQuery?.let { "?$it" } ?: ""
            val route = when (uri.host) {
                "quick-quiz" -> "/quick-quiz$query"
                "q" -> "/q${uri.encodedPath ?: ""}$query"
                "open" -> uri.getQueryParameter("route")?.takeIf { it.isNotBlank() } ?: "/"
                else -> {
                    val path = uri.encodedPath ?: return null
                    "$path$query"
                }
            }
            return "#${if (route.startsWith("/")) route else "/$route"}"
        }

        if ((scheme == "https" || scheme == "http") && uri.host == "pharmatrack-web.pages.dev") {
            val fragment = uri.encodedFragment ?: return null
            return "#${if (fragment.startsWith("/")) fragment else "/$fragment"}"
        }

        return null
    }

    private fun handleIncomingAppLinkIntent(intent: Intent): Boolean {
        val fragment = routeFragmentFromIntent(intent) ?: return false
        webView.loadUrl("file:///android_asset/dist/index.html$fragment")
        return true
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
