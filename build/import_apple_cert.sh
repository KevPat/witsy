#!/usr/bin/env sh

# Export "Developer ID Application" certificate from Keychain Access
# and save it as "certificate.p12" file in the repository root folder
# use APPLE_PASSWORD to protect the certificate

KEYCHAIN_PATH="$RUNNER_TEMP/build.keychain-db"
CERTIFICATE_PATH="$RUNNER_TEMP/certificate.p12"

# the decoded certificate must not stay on disk, whichever way the script ends
cleanup() {
  rm -f "$CERTIFICATE_PATH"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# list signing certificates
security find-identity -v -p codesigning

# recreate the certificate from the secure environment variable
echo "$BUILD_CERTIFICATE_BASE64" | base64 --decode -o "$CERTIFICATE_PATH"

# create a keychain
security create-keychain -p "$APPLE_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$APPLE_PASSWORD" "$KEYCHAIN_PATH"

# import the certificate into the keychain
security import "$CERTIFICATE_PATH" -P "$APPLE_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple: -k "$APPLE_PASSWORD" "$KEYCHAIN_PATH"
security list-keychain -d user -s "$KEYCHAIN_PATH"

# list signing certificates again
security find-identity -v -p codesigning

# remove the certificate (the trap above covers every other way out)
rm -f "$CERTIFICATE_PATH"
