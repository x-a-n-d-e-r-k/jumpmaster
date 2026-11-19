# Test certificates (issue #270)

Self-signed P-256 certificates made with `openssl req -x509`, for the stick's version-floor tests.
They are never verified as signatures: a fake cosign accepts them, and the test checks that the stick
still refuses because the certificate names no release tag.

- `no-san.crt`: no subjectAltName at all.
- `branch-san.crt`: one URI SAN, the release workflow on a branch ref
  (`https://github.com/x-a-n-d-e-r-k/jumpmaster/.github/workflows/release.yml@refs/heads/main`).
- `release-v0.5.1.crt`, `release-v0.6.0.crt`, `release-v0.6.1.crt`: one URI SAN each, the release
  workflow on that tag (issue #430: the stick upgrade's exact-tag tests).
