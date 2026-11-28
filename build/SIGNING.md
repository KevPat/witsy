# Release signing inputs

## macOS

Witsy uses Developer ID distribution and does not embed an Apple development
provisioning profile. The removed profile expired on 2025-10-01 and was tied to
a single device, so it was not valid release material.

Kevin must configure these GitHub Actions secrets before producing a signed and
notarized macOS release:

- `BUILD_CERTIFICATE_BASE64`: a current Developer ID Application certificate
  and private key exported as a password-protected PKCS#12 file, then base64
  encoded.
- `IDENTIFY_DARWIN_CODE`: the matching `Developer ID Application: ...` identity.
- `APPLE_ID`: the Apple account used for notarization.
- `APPLE_PASSWORD`: an app-specific password. It must also be the password used
  for the PKCS#12 export consumed by the current import script.
- `APPLE_TEAM_ID`: the Developer ID team identifier.

Do not add certificates, private keys, passwords, or provisioning profiles to
the repository. If Apple changes the export-password setup, split the PKCS#12
password into its own secret before rotating the certificate.

## Windows

Windows packages are signed only when all DigiCert secrets used by the release
workflow are present. The existing x64 workflow deliberately continues with
clearly named unsigned artifacts when they are absent.
