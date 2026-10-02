import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Android APK build and signing', () => {
  it('has npm commands for Android debug and release APK builds', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['android:debug']).toContain('./gradlew assembleDebug');
    expect(pkg.scripts['android:release']).toContain('./gradlew assembleRelease');
    expect(pkg.scripts['android:bundle']).toContain('./gradlew bundleRelease');
  });

  it('derives Android versionName/versionCode from the app version so updates can install', () => {
    const gradle = read('android/app/build.gradle.kts');
    expect(gradle).toContain('repositoryRoot.resolve("package.json")');
    expect(gradle).toContain('versionCode = pharmaVersionCode');
    expect(gradle).toContain('versionName = pharmaVersionName');
    expect(gradle).toContain('buildConfig = true');
    expect(gradle).toMatch(
      /versionParts\[0\] \* 10_000 \+ versionParts\[1\] \* 100 \+ versionParts\[2\]/,
    );
  });

  it('fails closed for release signing and never commits the keystore', () => {
    const gradle = read('android/app/build.gradle.kts');
    const ignore = read('.gitignore');
    expect(gradle).toContain('release-keystore.p12');
    expect(gradle).toContain('ANDROID_KEYSTORE_PASSWORD');
    expect(gradle).toContain('ANDROID_KEY_ALIAS');
    expect(gradle).toContain('ANDROID_KEY_PASSWORD');
    expect(gradle).toContain(
      'Android release keystore exists, but Gradle did not receive signing env vars',
    );
    expect(gradle).toContain('Production Android release signing is REQUIRED');
    expect(gradle).toContain('pharmaAllowDebugSigning');
    expect(ignore).toContain('android/app/release-keystore.p12');
    expect(ignore).toContain('android/app/*.jks');
  });

  it('packages the built web app under android_asset/dist', () => {
    const gradle = read('android/app/build.gradle.kts');
    const main = read('android/app/src/main/java/com/pharmatrack/app/MainActivity.kt');
    expect(gradle).toContain('syncPharmaTrackWebAssets');
    expect(gradle).toContain('generated/pharmatrack-web-assets/dist');
    expect(main).toContain('/dist/index.html');
  });

  it('uses an HTTPS app-asset origin and native file picker for Android WebView friendliness', () => {
    const main = read('android/app/src/main/java/com/pharmatrack/app/MainActivity.kt');
    const client = read('android/app/src/main/java/com/pharmatrack/app/KioskWebViewClient.kt');
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const styles = read('android/app/src/main/res/values/styles.xml');
    const pwa = read('src/pwa.ts');
    expect(main).toContain('WebViewAssetLoader');
    expect(main).toContain('https://$APP_ASSET_DOMAIN');
    expect(main).toContain('onShowFileChooser');
    expect(main).toContain('override fun onNewIntent(intent: Intent)');
    expect(main).toContain('emptyArray<Uri>()');
    expect(main).toContain('Uri::class.java');
    expect(main).toContain('settings.textZoom = 100');
    expect(client).toContain('assetLoader.shouldInterceptRequest');
    expect(manifest).toContain('android:hardwareAccelerated="true"');
    expect(manifest).toContain('android:resizeableActivity="true"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(styles).not.toContain('android:windowFullscreen">true');
    // The APK is served by WebViewAssetLoader, so no service worker may own
    // these pages. The gate now covers every packaged shell, not only Android.
    expect(pwa).toContain('!isNativeShell()');
    expect(main).toContain('setServiceWorkerClient');
  });

  it('publishes a verified release-signed APK in the GitHub release workflow', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toContain('Prepare Android release signing key');
    expect(workflow).toContain('Build Android release APK (signed)');
    expect(workflow).toContain('ANDROID_KEYSTORE_BASE64');
    expect(workflow).toMatch(
      /Build Android release APK \(signed\)[\s\S]*ANDROID_KEYSTORE_PASSWORD/,
    );
    expect(workflow).toMatch(/Build Android release APK \(signed\)[\s\S]*ANDROID_KEY_ALIAS/);
    expect(workflow).toMatch(/Build Android release APK \(signed\)[\s\S]*ANDROID_KEY_PASSWORD/);
    expect(workflow).toContain('EXPECTED_ANDROID_CERT_SHA256');
    expect(workflow).toContain('keytool -list -v');
    expect(workflow).toContain('Invalid ANDROID_KEYSTORE_BASE64');
    expect(workflow).toContain('PHARMA_ANDROID_SKIP_GRADLE_SIGNING');
    expect(workflow).toContain('apksigner sign');
    expect(workflow).toContain('ANDROID_KEY_PASSWORD ANDROID_KEYSTORE_PASSWORD');
    expect(workflow).toContain('Android Gradle build failed');
    expect(workflow).toContain('android-gradle-failure-log');
    expect(workflow).toContain('apksigner verify --print-certs');
    expect(workflow).toContain('The Android APK is debug-signed. Refusing to publish it.');
    expect(workflow).toContain('aapt2 dump badging');
    expect(workflow).toContain('PharmaTRACK-${{ needs.build-windows.outputs.version }}.apk');
  });

  it('attaches release assets with the GitHub CLI so a reused tag cannot fail the build', () => {
    const workflow = read('.github/workflows/release.yml');
    // softprops/action-gh-release PATCHes the release before uploading, which
    // GitHub refuses with "Resource not accessible by integration" as soon as
    // the tag already has an older published release.
    expect(workflow).not.toMatch(/uses:\s*softprops\/action-gh-release/);
    expect(workflow).toMatch(/Force Upload release assets[\s\S]*gh release upload "\$TAG" latest\.json "\$APK_NAME" --clobber/);
    expect(workflow).toMatch(/Force Upload release assets[\s\S]*gh release edit "\$TAG" --draft=false --latest/);
    expect(workflow).toContain('Release asset missing');
    expect(workflow).toContain('Release asset not attached');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });
});
