# v0.4.0-rc.2 stick signature fixtures

These are real artifacts from the v0.4.0-rc.2 release, captured on 2026-11-16 during the stick install rehearsal (#153):

- `index.json`: the multi-arch index of `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick`. Its sha256 is
  `fe7ce13397db0abea97769ccbcedc17ebfd6d2c12cf9f10851102cd06aa94d55`, the index digest the release
  signs.
- `bundle-manifest.json`: the OCI 1.1 referrer manifest the release's cosign wrote for that
  digest (`artifactType: application/vnd.dev.sigstore.bundle.v0.3+json`).
- `bundle.json`: its single layer, a Sigstore bundle v0.3 holding a DSSE envelope. The in-toto
  statement's subject is the index digest, and its predicate type is
  `https://sigstore.dev/cosign/sign/v1`.
- `trusted_root.json`: Sigstore's public-good trusted root, as cosign v3.1.4 fetched it from TUF on that
  date.
- `cosign-verify-local-image.stdout`: what `cosign verify --local-image --offline` printed for
  the server's layout of this image: one payload whose `docker-manifest-digest` is **empty**. A
  bundle-only signature carries no simple-signing payload, so a digest check on this output can never pass.

What was observed with cosign v3.1.4, with Sigstore unreachable and an empty HOME:

    cosign verify-blob-attestation --bundle bundle.json --type https://sigstore.dev/cosign/sign/v1 \
      --trusted-root trusted_root.json --offline \
      --certificate-identity-regexp '<release identity>' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-github-workflow-trigger push \
      --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster index.json
    -> Verified OK
    (index.json with one byte appended)  -> provided artifact digests do not match digests in statement
    (another identity regexp)            -> no matching CertificateIdentity found
