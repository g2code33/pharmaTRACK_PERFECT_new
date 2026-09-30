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

## Keystore safety

`android/app/release-keystore.p12`, `*.jks`, and `*.keystore` are ignored by git. Never commit signing keys.
