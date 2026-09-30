import groovy.json.JsonSlurper
import org.gradle.api.GradleException
import java.util.Locale

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repositoryRoot = rootProject.projectDir.parentFile.canonicalFile
val packageJson = repositoryRoot.resolve("package.json")
val parsedPackage = try {
    @Suppress("UNCHECKED_CAST")
    JsonSlurper().parse(packageJson) as Map<String, Any?>
} catch (_: Exception) {
    emptyMap()
}
val pharmaVersionName = (parsedPackage["version"] as? String)?.takeIf { it.isNotBlank() } ?: "1.0.0"
val versionParts = Regex("\\d+").findAll(pharmaVersionName).map { it.value.toInt() }.toList()
val pharmaVersionCode = maxOf(
    2,
    when {
        versionParts.size >= 3 -> versionParts[0] * 10_000 + versionParts[1] * 100 + versionParts[2]
        versionParts.size >= 2 -> versionParts[0] * 10_000 + versionParts[1] * 100
        versionParts.size == 1 -> versionParts[0]
        else -> 1
    },
)

// Production Android releases must be signed with the same private keystore on
// every version. That is what allows Android to install vNext over vPrevious.
// The keystore is injected by GitHub Actions/local environment and is never
// committed to git. A debug-signed release can only be produced by explicit
// local opt-in for testing; CI never enables it.
val releaseKeystore = layout.projectDirectory.file("release-keystore.p12").asFile
val hasReleaseKeystore = releaseKeystore.exists()
val androidKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD").orEmpty()
val androidKeyAlias = System.getenv("ANDROID_KEY_ALIAS").orEmpty().ifBlank { "pharmatrack" }
val configuredAndroidKeyPassword = System.getenv("ANDROID_KEY_PASSWORD").orEmpty()
// keytool-created PKCS12 keystores use the store password as the private-key
// password. Using the store password here prevents a stale/wrong key-password
// secret from breaking update-compatible release signing. The workflow still
// requires ANDROID_KEY_PASSWORD so existing secret setup remains explicit.
val androidKeyPassword = androidKeystorePassword
val allowDebugSigning = (
    (project.findProperty("pharmaAllowDebugSigning") ?: System.getenv("PHARMA_ALLOW_DEBUG_SIGNING") ?: "false")
        .toString()
        .lowercase(Locale.US)
) in setOf("1", "true", "yes")

android {
    namespace = "com.pharmatrack.app"
    compileSdk = 35

    signingConfigs {
        create("release") {
            if (hasReleaseKeystore) {
                storeFile = releaseKeystore
                storePassword = androidKeystorePassword
                keyAlias = androidKeyAlias
                keyPassword = androidKeyPassword
                storeType = "PKCS12"
            }
        }
    }

    defaultConfig {
        applicationId = "com.pharmatrack.app"
        minSdk = 26
        targetSdk = 35
        versionCode = pharmaVersionCode
        versionName = pharmaVersionName
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isDebuggable = true
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            } else if (allowDebugSigning) {
                logger.warn("WARNING: release APK is DEBUG-signed for local testing only. Never distribute this build.")
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/pharmatrack-web-assets"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

val syncPharmaTrackWebAssets by tasks.registering(Sync::class) {
    val webDist = repositoryRoot.resolve("dist")
    from(webDist)
    into(layout.buildDirectory.dir("generated/pharmatrack-web-assets/dist"))
    doFirst {
        if (!webDist.resolve("index.html").isFile) {
            throw GradleException(
                "Missing web build at ${webDist.resolve("index.html")}. " +
                    "Run `npm run build` before building the Android APK.",
            )
        }
    }
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(syncPharmaTrackWebAssets)
}

tasks.matching { task ->
    task.name in setOf("packageRelease", "assembleRelease", "bundleRelease", "validateSigningRelease")
}.configureEach {
    doFirst {
        if (!hasReleaseKeystore && !allowDebugSigning) {
            throw GradleException(
                "Production Android release signing is REQUIRED but android/app/release-keystore.p12 was not found.\n" +
                    "In CI, set ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, " +
                    "and ANDROID_KEY_PASSWORD.\n" +
                    "For a local-only test release, run: ./gradlew assembleRelease -PpharmaAllowDebugSigning=true\n" +
                    "A debug-signed production APK will not be built by default.",
            )
        }
        if (hasReleaseKeystore) {
            val missingSigningEnv = listOf(
                "ANDROID_KEYSTORE_PASSWORD" to androidKeystorePassword,
                "ANDROID_KEY_ALIAS" to androidKeyAlias,
                "ANDROID_KEY_PASSWORD" to configuredAndroidKeyPassword,
            ).filter { it.second.isBlank() }.joinToString { it.first }
            if (missingSigningEnv.isNotBlank()) {
                throw GradleException(
                    "Android release keystore exists, but Gradle did not receive signing env vars: $missingSigningEnv. " +
                        "Pass ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD to ./gradlew assembleRelease.",
                )
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.12.1")
}
