package com.pharmatrack.app

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Enforces external navigation restrictions and boundary isolation during
 * active secure examinations.
 */
class KioskWebViewClient(private val bridge: PharmaTRACKKioskBridge) : WebViewClient() {
    companion object {
        private const val TAG = "KioskWebViewClient"
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
            // Block all non-http/https intents (e.g. tel:, mailto:, market:, intent:, chrome:)
            if (scheme != "http" && scheme != "https" && scheme != "file") {
                Log.w(TAG, "Blocked external intent scheme during secure exam: $uri")
                notifyExternalLinkBlocked(view, uri.toString())
                return true
            }

            // Only allow same-origin or configured local examination endpoints
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
        view?.post {
            view.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('pharmatrack:external-link-blocked', { detail: 'Blocked external URL: $url' }));",
                null
            )
        }
    }
}
