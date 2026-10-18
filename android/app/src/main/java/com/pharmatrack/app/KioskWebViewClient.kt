package com.pharmatrack.app

import android.net.Uri
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * Serves the packaged web app from Android assets and enforces external
 * navigation restrictions during secure examinations.
 */
class KioskWebViewClient(
    private val bridge: PharmaTRACKKioskBridge,
    private val assetLoader: WebViewAssetLoader,
) : WebViewClient() {
    companion object {
        private const val TAG = "KioskWebViewClient"
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?,
    ): WebResourceResponse? {
        val url = request?.url ?: return super.shouldInterceptRequest(view, request)
        return assetLoader.shouldInterceptRequest(url) ?: super.shouldInterceptRequest(view, request)
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val url = request?.url ?: return false
        return shouldBlockNavigation(view, url)
    }

    @Deprecated("Deprecated in Java")
    override fun shouldOverrideUrlLoading(view: WebView?, urlStr: String?): Boolean {
        if (urlStr == null) return false
        val uri = Uri.parse(urlStr)
        return shouldBlockNavigation(view, uri)
    }

    private fun shouldBlockNavigation(view: WebView?, uri: Uri): Boolean {
        if (bridge.isExternalIntentsRestricted()) {
            val scheme = uri.scheme?.lowercase()
            // Block all non-http/https/local asset intents (e.g. tel:, mailto:,
            // market:, intent:, chrome:) during secure exams.
            if (scheme != "http" && scheme != "https") {
                Log.w(TAG, "Blocked external intent scheme during secure exam: $uri")
                notifyExternalLinkBlocked(view, uri.toString())
                return true
            }

            // Only allow same-origin or configured local examination endpoints.
            val host = uri.host?.lowercase() ?: ""
            if (!bridge.isHostAllowed(host)) {
                Log.w(TAG, "Blocked external host navigation during secure exam: $host")
                notifyExternalLinkBlocked(view, uri.toString())
                return true
            }
        }
        return false
    }

    private fun notifyExternalLinkBlocked(view: WebView?, url: String) {
        val safeUrl = JSONObjectEscaper.escape(url)
        view?.post {
            view.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('pharmatrack:external-link-blocked', { detail: 'Blocked external URL: $safeUrl' }));",
                null
            )
        }
    }
}

private object JSONObjectEscaper {
    fun escape(value: String): String = value
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
}
