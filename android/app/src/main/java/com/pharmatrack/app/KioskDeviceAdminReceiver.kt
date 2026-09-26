package com.pharmatrack.app

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Device administrator receiver that enables PharmaTRACK to operate as a
 * dedicated device owner or lock-task authority for secure academic examinations.
 */
class KioskDeviceAdminReceiver : DeviceAdminReceiver() {
    companion object {
        private const val TAG = "PharmaTRACKDeviceAdmin"
    }

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i(TAG, "PharmaTRACK Device Administrator enabled.")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.w(TAG, "PharmaTRACK Device Administrator disabled.")
    }

    override fun onLockTaskModeEntering(context: Context, intent: Intent, pkg: String) {
        super.onLockTaskModeEntering(context, intent, pkg)
        Log.i(TAG, "Lock-task mode entered for package: $pkg")
    }

    override fun onLockTaskModeExiting(context: Context, intent: Intent) {
        super.onLockTaskModeExiting(context, intent)
        Log.i(TAG, "Lock-task mode exited.")
    }
}
