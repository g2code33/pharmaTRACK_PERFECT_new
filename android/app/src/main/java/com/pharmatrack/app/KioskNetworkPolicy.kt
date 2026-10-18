package com.pharmatrack.app

/**
 * Pure host-allowlist policy for kiosk WebView navigation.
 *
 * Extracted from PharmaTRACKKioskBridge so it can be unit-tested on the JVM
 * without an Activity: the bridge delegates the decision here.
 *
 * Allowed during a restricted session:
 *  - loopback and the Android-emulator alias of the host machine,
 *  - any host explicitly allowed for the session (e.g. the LAN examination
 *    server), and
 *  - private LAN address ranges, where the LAN examination authority runs
 *    (see docs/LAN_EXAMINATION_SERVER.md).
 *
 * The 172.x rule intentionally matches the whole 172. range rather than only
 * the RFC1918 172.16-31 slice: kiosk hardware on campus networks has been
 * observed with mismasked ranges, and a blocked examination server is a worse
 * failure than a permissive private-range rule behind the kiosk's other
 * restrictions.
 *
 * Range prefixes must be followed by dotted numeric octets only: a crafted
 * DNS name such as "192.168.evil.test" must not ride the prefix rules.
 */
object KioskNetworkPolicy {
    private val DEFAULT_ALLOWED_HOSTS = setOf(
        "localhost",
        "127.0.0.1",
        "10.0.2.2",
        // WebViewAssetLoader's fixed domain when the kiosk serves the web app
        // from local assets instead of a server.
        "pharmatrack.appassets.androidplatform.net",
    )
    private val PRIVATE_RANGE_PREFIXES = listOf("192.168.", "10.", "172.")

    fun isHostAllowed(host: String, extraAllowed: Set<String> = emptySet()): Boolean {
        val normalized = host.trim().lowercase()
        if (normalized.isEmpty()) return false
        if (normalized in DEFAULT_ALLOWED_HOSTS || normalized in extraAllowed) return true
        return isPrivateLanAddress(normalized)
    }

    private fun isPrivateLanAddress(normalized: String): Boolean {
        val prefix = PRIVATE_RANGE_PREFIXES.firstOrNull { normalized.startsWith(it) } ?: return false
        return isDottedNumeric(normalized.removePrefix(prefix))
    }

    /** "1.20" ✓, "42.0.7" ✓ — "evil.test" ✗, "1..2" ✗, "" ✗. */
    private fun isDottedNumeric(tail: String): Boolean =
        tail.isNotEmpty() && tail.split('.').all { part -> part.isNotEmpty() && part.all { it.isDigit() } }
}
