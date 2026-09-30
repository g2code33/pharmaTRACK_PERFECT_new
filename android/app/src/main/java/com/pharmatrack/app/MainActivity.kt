package com.pharmatrack.app

import android.app.admin.DevicePolicyManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import java.io.InputStream

/**
 * Main Activity hosting the PharmaTRACK Android application.
 *
 * The app is packaged as a first-class Android WebView shell, not as a browser
 * shortcut. Assets are served through WebViewAssetLoader on an HTTPS app origin
 * so localStorage, IndexedDB, crypto, route chunks and app links behave like a
 * normal installed app across Android phones, tablets and foldables.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "PharmaTRACKMainActivity"
        private const val APP_ASSET_DOMAIN = "pharmatrack.appassets.androidplatform.net"
        private const val APP_ORIGIN = "https://$APP_ASSET_DOMAIN"
    }

    private lateinit var webView: WebView
    private lateinit var kioskBridge: PharmaTRACKKioskBridge
    private lateinit var assetLoader: WebViewAssetLoader
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        filePathCallback?.onReceiveValue(uris ?: emptyArray<Uri>())
        filePathCallback = null
    }

    fun getWebView(): WebView? = if (::webView.isInitialized) webView else null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        configureSystemBarsForApp()

        kioskBridge = PharmaTRACKKioskBridge(this)
        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_ASSET_DOMAIN)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        webView.id = View.generateViewId()
        setContentView(webView)

        configureWebView()
        configureBackButton()

        // Quick quiz app links load straight into the matching hash route.
        // Only non-link launches are treated as .pharmaexam package imports.
        if (routeFragmentFromIntent(intent) == null) {
            handleIncomingFileIntent(intent)
        }

        webView.loadUrl(launchUrlFromIntent(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!handleIncomingAppLinkIntent(intent)) {
            handleIncomingFileIntent(intent)
        }
    }

    private fun configureSystemBarsForApp() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.statusBarColor = Color.WHITE
        window.navigationBarColor = Color.WHITE
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = true
        controller.isAppearanceLightNavigationBars = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER
            }
        }
    }

    private fun configureWebView() {
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.loadsImagesAutomatically = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = false
        settings.textZoom = 100
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }

        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.overScrollMode = WebView.OVER_SCROLL_IF_CONTENT_SCROLLS
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        // Add JavaScript Interface matching the PharmaTRACKAndroidKiosk contract.
        webView.addJavascriptInterface(kioskBridge, "PharmaTRACKAndroidKiosk")
        webView.webViewClient = KioskWebViewClient(kioskBridge, assetLoader)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: WebChromeClient.FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = try {
                    params?.createIntent() ?: defaultFileChooserIntent()
                } catch (_: Exception) {
                    defaultFileChooserIntent()
                }
                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (error: ActivityNotFoundException) {
                    Log.e(TAG, "No Android file picker is available: ${error.message}")
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    false
                }
            }
        }
    }

    private fun defaultFileChooserIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }

    private fun configureBackButton() {
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
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                if (enabled) {
                    WindowCompat.setDecorFitsSystemWindows(window, false)
                    controller.hide(WindowInsetsCompat.Type.systemBars())
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars())
                    configureSystemBarsForApp()
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
        return "$APP_ORIGIN/dist/index.html$fragment"
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
        webView.loadUrl("$APP_ORIGIN/dist/index.html$fragment")
        return true
    }

    private fun extraStreamUri(intent: Intent): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        }
    }

    private fun handleIncomingFileIntent(intent: Intent) {
        val action = intent.action
        val uri: Uri? = intent.data ?: extraStreamUri(intent)
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
