package com.pharmatrack.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the kiosk navigation allowlist. These run on the build
 * host (no emulator needed) via :app:test — they guard the boundary that
 * keeps a secure examination inside the kiosk and the LAN examination
 * authority.
 */
class KioskNetworkPolicyTest {

    @Test
    fun allowsLoopbackAndEmulatorHosts() {
        assertTrue(KioskNetworkPolicy.isHostAllowed("localhost"))
        assertTrue(KioskNetworkPolicy.isHostAllowed("127.0.0.1"))
        assertTrue(KioskNetworkPolicy.isHostAllowed("10.0.2.2"))
        // WebViewAssetLoader's fixed domain (local asset serving).
        assertTrue(KioskNetworkPolicy.isHostAllowed("pharmatrack.appassets.androidplatform.net"))
    }

    @Test
    fun allowsPrivateLanRangesWhereTheExamServerRuns() {
        assertTrue(KioskNetworkPolicy.isHostAllowed("192.168.1.20"))
        assertTrue(KioskNetworkPolicy.isHostAllowed("10.42.0.7"))
        assertTrue(KioskNetworkPolicy.isHostAllowed("172.20.14.3"))
    }

    @Test
    fun rejectsPublicHostsAndOddCases() {
        assertFalse(KioskNetworkPolicy.isHostAllowed("example.com"))
        assertFalse(KioskNetworkPolicy.isHostAllowed("evil.test.10.0.2.2"))
        assertFalse(KioskNetworkPolicy.isHostAllowed("192.168.evil.test"))
        assertFalse(KioskNetworkPolicy.isHostAllowed(" "))
        assertFalse(KioskNetworkPolicy.isHostAllowed(""))
    }

    @Test
    fun honorsSessionSpecificHostsAndCase() {
        assertTrue(KioskNetworkPolicy.isHostAllowed("ExamServer.LAN", extraAllowed = setOf("examserver.lan")))
        assertFalse(KioskNetworkPolicy.isHostAllowed("other.host"))
    }
}
