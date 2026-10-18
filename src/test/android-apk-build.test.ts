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

  it('publishes a verified release-signed APK in the release pipeline', () => {
    const release = read('.github/workflows/release.yml');
    const android = read('.github/workflows/android-build.yml');

    // The release workflow calls the shared Android workflow in release mode
    // with the repo's signing secrets — the signed pipeline is what ships.
    expect(release).toMatch(
      /uses: \.\/\.github\/workflows\/android-build\.yml[\s\S]*build-mode: release[\s\S]*secrets: inherit/,
    );

    // Release mode fails closed when signing secrets are missing and never
    // accepts a keystore that does not match the published certificate.
    expect(android).toContain('Prepare Android release signing key');
    expect(android).toContain('ANDROID_KEYSTORE_BASE64');
    expect(android).toMatch(
      /Prepare Android release signing key[\s\S]*ANDROID_KEYSTORE_PASSWORD/,
    );
    expect(android).toMatch(/Prepare Android release signing key[\s\S]*ANDROID_KEY_ALIAS/);
    expect(android).toMatch(/Prepare Android release signing key[\s\S]*ANDROID_KEY_PASSWORD/);
    expect(android).toContain('EXPECTED_ANDROID_CERT_SHA256');
    expect(android).toContain('keytool -list -v');
    expect(android).toContain('Invalid ANDROID_KEYSTORE_BASE64');

    // Gradle signing is skipped so the APK is signed explicitly afterwards,
    // with an apksigner key-password fallback and a debug-certificate veto.
    expect(android).toContain('PHARMA_ANDROID_SKIP_GRADLE_SIGNING');
    expect(android).toMatch(/Build unsigned Android release \(APK \+ AAB\)[\s\S]*apksigner sign/);
    expect(android).toContain('ANDROID_KEY_PASSWORD ANDROID_KEYSTORE_PASSWORD');
    expect(android).toContain('Android Gradle build failed');
    expect(android).toContain('android-gradle-failure-log');
    expect(android).toContain('apksigner verify --print-certs');
    expect(android).toContain('The release APK is debug-signed. Refusing to package it.');
    expect(android).toContain('aapt2 dump badging');

    // The packaging job fails when the versioned APK/AAB are not there.
    expect(release).toMatch(
      /Verify all expected release artifacts[\s\S]*PharmaTRACK-\$VERSION-android\.apk/,
    );
    expect(release).toMatch(
      /Verify all expected release artifacts[\s\S]*PharmaTRACK-\$VERSION-android\.aab/,
    );
  });

  it('attaches release assets with the GitHub CLI so a reused tag cannot fail the build', () => {
    const workflow = read('.github/workflows/release.yml');
    // softprops/action-gh-release PATCHes the release before uploading, which
    // GitHub refuses with "Resource not accessible by integration" as soon as
    // the tag already has an older published release.
    expect(workflow).not.toMatch(/uses:\s*softprops\/action-gh-release/);
    expect(workflow).toMatch(/gh release upload "\$TAG"[\s\S]*latest\.json[\s\S]*--clobber/);
    expect(workflow).toMatch(/gh release edit "\$TAG" --draft=false --latest/);
    expect(workflow).toContain('Release asset missing');
    expect(workflow).toContain('Release asset not attached');
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    // Final verification re-reads the release and fails when an expected
    // asset is not actually attached to it.
    expect(workflow).toMatch(/gh release view "\$TAG" --json assets/);
  });
});
