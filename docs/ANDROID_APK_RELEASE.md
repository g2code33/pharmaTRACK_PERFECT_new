# PharmaTRACK Android APK release signing

PharmaTRACK now has a real Android APK build path under `android/`.

## Build commands

```bash
npm run android:debug
npm run android:release
npm run android:bundle
```

`android:release` is intentionally fail-closed: it will not build a production APK unless the release keystore is present.

## Required signing secrets

Android updates only install over the previous APK when every version is signed with the same certificate. Do not generate a new key for every release.

Configure these GitHub repository secrets:

- `ANDROID_KEYSTORE_BASE64` — base64 of the PKCS#12 keystore file
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release workflow decodes the keystore to `android/app/release-keystore.p12`, builds the APK, verifies that it is not debug-signed, checks the APK version, and uploads `PharmaTRACK-<version>.apk` to the GitHub Release.

## Local release test only

For a local-only test release that must never be distributed:

```bash
npm run build
cd android
./gradlew assembleRelease -PpharmaAllowDebugSigning=true
```

That opt-in uses the Android debug certificate. It is useful for checking layout on a phone, but it will not update over a production-signed APK.

## Quick Quiz APK-first validation

Shared Quick Quiz links are normal web links so they remain shareable in WhatsApp, email, SMS, and browsers. On Android, the web landing route immediately tries an Android `intent://` URL that targets `com.pharmatrack.app`; if the APK is installed, Android opens PharmaTRACK first. If it is not installed, Chrome falls back to the same web quiz page.

To make `https://pharmatrack-web.pages.dev/#/q/...` open the APK directly before the browser is shown, publish Android App Links verification for the release signing certificate:

1. Build the signed release APK in GitHub.
2. Get the SHA-256 fingerprint of the release certificate from the workflow's `apksigner verify --print-certs` output, or locally with:

   ```bash
   keytool -list -v -storetype PKCS12 -keystore pharmatrack-release.p12 -alias pharmatrack
   ```

3. Add `/.well-known/assetlinks.json` on `pharmatrack-web.pages.dev` with this shape:

   ```json
   [
     {
       "relation": ["delegate_permission/common.handle_all_urls"],
       "target": {
         "namespace": "android_app",
         "package_name": "com.pharmatrack.app",
         "sha256_cert_fingerprints": ["PASTE:THE:RELEASE:SHA256:FINGERPRINT:HERE"]
       }
     }
   ]
   ```

4. Install the signed APK, then tap a Quick Quiz link from Chrome, Gmail, WhatsApp, or Messages. Expected result: PharmaTRACK opens to the exact `/q/<code>` or `/quick-quiz?p=...` quiz. If the APK is removed, the same link stays on the web fallback.

## Keystore safety

`android/app/release-keystore.p12`, `*.jks`, and `*.keystore` are ignored by git. Never commit signing keys.
