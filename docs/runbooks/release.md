# Release runbook

For the repository owner. A release is a version tag on `main`. Pushing it runs
`.github/workflows/release.yml`, which:

1. **guard**: refuses the tag unless it is `vX.Y.Z` or `vX.Y.Z-rc.N` and the commit it names
   (`git rev-parse "$GITHUB_SHA^{commit}"`) is on `main` (`git merge-base --is-ancestor`), and
   that commit's Images run on `main` (`.github/workflows/images.yml`, the image e2e tests this
   workflow doesn't run) passed (`scripts/release-images-green.sh`). Nothing else runs if it fails.
   Tag a commit whose Images run is green; if you tagged too early, wait for that run, then re-run
   the Release workflow for the tag (the ruleset blocks moving it).
2. **build** (`.github/workflows/release-build.yml`), natively, with no emulation: every per-arch
   job runs twice, on `ubuntu-24.04` (linux/amd64) and `ubuntu-24.04-arm` (linux/arm64).
   - `troopers` builds the trooper (the node preset), the python, go and jvm presets and the
     egress proxy, each with an SBOM, `provenance: mode=max` and the
     `org.opencontainers.image.source` label, and pushes each to `ghcr.io/<owner>` by digest. Each
     preset builds `FROM` the trooper built earlier in the same job, by that per-arch digest, so
     an arm64 preset always sits on the arm64 trooper.
   - `troopers-index` joins each image's two per-arch digests into one multi-arch index
     (`docker buildx imagetools create`, sources by digest; buildx pushes the index under the tag
     `vX.Y.Z`, a convenience only). Before pushing, `scripts/release-index.sh` checks the planned
     index lists exactly every manifest the two builds list, attestations included; after, it
     reads the index back by its digest (never through the tag). The
     **index digest** is the image's release digest: it is what is signed, locked and pulled.
   - `stick` (per arch) builds the stick with the release version, this repository as its
     trusted signer and the egress proxy's and trooper's index digests; `stick-index` joins it.
   - `apps` (per arch) then builds the server with the release's `images.lock.json` (index
     digests) baked in, the stick's included, so a release server mirrors the stick for the
     one-line installer; `apps-index` joins it the same way.
3. **sign**: signs every image by its index digest with cosign keyless, then verifies each with
   exactly the checks the stick makes (the identity flags, and every signed payload naming that
   digest). Renders `compose.yaml` from `deploy/compose.yaml.tmpl`, writes `images.lock.json` and
   `SHA256SUMS`, and signs `SHA256SUMS` (`SHA256SUMS.sigstore.json`).
4. **publish**: creates the GitHub Release with those four files. An `-rc.N` tag is a pre-release.

Only `sign` holds `id-token: write`. Only `build` and `sign` hold `packages: write`, and only
`publish` holds `contents: write`.

## What actually controls a release

A tag push runs the workflow file as it is at the tagged commit, not as it is on `main`. Anyone
who can push a `v*` tag can therefore push a branch whose `release.yml` skips `guard`, tag it, and
get a signature that every stick accepts, permanently (a signature cannot be revoked). `guard`
does not stop that; it only catches the owner tagging the wrong commit. The control is the **tag
ruleset** on `refs/tags/v*`, which must be in place before this workflow is merged to `main`.

This repository already has one: a tag ruleset targeting `refs/tags/v*` that restricts creation,
update and deletion, with only the repository admin role able to bypass it. Keep it that way:

- no account other than the owner may hold admin or maintain on the repository (on an
  organisation-owned repository both roles can edit rulesets; on a user-owned one collaborators
  have write at most), and an automation or agent account gets write only;
- don't add bypass actors to the ruleset, and don't disable it, even briefly.

A fork or a new repository must create the same ruleset before it merges this workflow.

## Owner steps

These change repository or package settings. Nobody else does them.

| When | Step |
|---|---|
| Once, before this workflow reaches `main` | The **tag ruleset** (above): Settings → Rules → Rulesets → New tag ruleset. Target `refs/tags/v*`. Restrict creations, updates and deletions. Bypass: the admin role only. This repository already has it. |
| Once, before the first tag | Settings → Actions → General: allow GitHub Actions, and under "Workflow permissions" keep the default read-only `GITHUB_TOKEN`. The workflow asks for `packages: write`, `id-token: write` and `contents: write` per job, which a repository workflow may do. If an organisation policy blocks `id-token: write` (OIDC), allow it. |
| First pre-release | Push `v0.4.0-rc.1` (below). |
| After the first push | For each package (server, stick, egress, trooper, and the python, go and jvm presets): Packages → the package → Package settings → **Change visibility → Public**. Check "Repository source" shows this repository: the `org.opencontainers.image.source` label links it. If a package isn't linked, use "Connect repository". |
| Always | **Never delete untagged versions** of the `jumpmaster-*` packages, by hand or with a cleanup action, and never attach a retention policy to them. Only each release's index carries a tag; the per-arch manifests (and their attestations) it points at are untagged versions. Deleting them breaks `docker pull name@<index digest>` on every stick for that release, and it can't be repaired without a new release. |
| Every release after that | Push the version tag. |

## Dry run

Actions → Release → Run workflow, on any branch. `guard`, `build`, `sign` and `publish` are
skipped; `dryrun` runs the same builds (`workflow_dispatch` never logs in to GHCR, signs or
publishes). The images are built exactly as for a release and pushed to a registry that lives only
inside the job, so the presets still build `FROM` the trooper by digest. `dryrun` holds only
`packages: read`, so even a modified branch's dry run cannot push to GHCR. Expected: `dryrun`'s
`troopers` and `apps` green, nothing on GHCR.

## Cutting a release

First, check nothing was released behind your back. Both must show only what you created:

```sh
git ls-remote --tags origin 'v*'
gh api "/users/x-a-n-d-e-r-k/packages?package_type=container" --jq '.[].name'
```

The first release must find no `v*` tag and no `jumpmaster-*` package at all. If either shows a
tag or package you didn't create, stop and treat the signing identity as burned: a signature made
from it cannot be withdrawn, and every stick trusting it would run whatever was signed. Rotate the
identity ("If the workflow path or the repository moves", below: rename the workflow file and
release a stick that trusts only the new one), find out who held tag or admin rights, and delete
the stray tag and packages.

Then, from a clean checkout of `main` that includes the commit you want:

```sh
git fetch origin
git tag v0.4.0-rc.1 origin/main        # or a commit on main
git push origin v0.4.0-rc.1
```

A final release is the same with `vX.Y.Z`. Tags other than these two shapes don't trigger the
workflow, and `guard` refuses any that slip through. Don't move or reuse a tag: the ruleset blocks
it, and every image is addressed by digest anyway.

## Checking a release

From a machine that is not logged in to GHCR (`docker logout ghcr.io` first):

1. The release lists `compose.yaml`, `images.lock.json`, `SHA256SUMS` and
   `SHA256SUMS.sigstore.json`. Verify the files and each image with the commands in
   [SECURITY.md](../../SECURITY.md#verifying-a-release).
2. Anonymous pulls work for every image in `images.lock.json`:
   `docker pull ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest>`. A `denied` or
   `unauthorized` answer means the package is still private.
3. The SBOM and provenance are attached:
   `docker buildx imagetools inspect ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest> --format '{{ json .SBOM }}'`
   (and `.Provenance`).
4. Each image index lists both `linux/amd64` and `linux/arm64`:
   `docker buildx imagetools inspect ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@sha256:<digest>`.
5. Once, as a negative rehearsal: create an rc tag on a commit that is not on `main` (a scratch
   branch), push it, and confirm `guard` fails and nothing is built. Then delete the tag
   (`git push origin :refs/tags/<tag>`, which the ruleset lets only an admin do).

### After the first tag: the stick rehearsals

These need a published, signed release, so they wait for `v0.4.0-rc.1`. First, before anything
else and before any fresh-agent install rehearsal, start the release exactly as a user does:

```sh
deploy/smoke.sh --release v0.4.0-rc.1
```

It downloads the release's `compose.yaml` (checked against `SHA256SUMS`), runs `init` in the
release's server image, and starts the server and a `signed`-policy stick with the template's empty
`JM_ALLOWED_IMAGES` and the release's egress digest, with dummy tokens: the stick must advertise
`image-verify-v1` and the doctor's `stick.image-policy` and `config.secret-files` must pass.
`JM_SMOKE_ONLINE=1` also requires GitHub's 401 for the dummy token. The same run works before a
tag against images built locally under one registry name (`deploy/smoke.sh --release
<images.lock.json>`, the lock giving the registry and each image's local digest, with the server
built with that lock as `IMAGES_LOCK`); it can't check signatures, which only a published release
carries. The smoke runs no drop, so image verification during a drop (cosign on the trooper and
proxy, then the pull by digest) is covered by rehearsal 1 below, not by the smoke.

Then run these with the release's stick image on a test host, against a zone with
`requireSignedImages: true`, and record the stick log lines in the release notes:

1. A released preset runs: the stick logs `image-verified` with `"via":"cosign"` for the trooper
   (a released preset from `images.lock.json`) and the proxy, the drop completes, and
   `/state/verified.json` now lists their digests.
2. An unsigned local image is refused (`image not verified: …: no signatures found`) and is never
   pulled; pinned by digest in `JM_ALLOWED_IMAGES` it runs (`"via":"pinned"`).
3. With a cold cache and Sigstore unreachable: stop the stick, delete `/state/verified.json`, block
   `tuf-repo-cdn.sigstore.dev`, `rekor.sigstore.dev` and `fulcio.sigstore.dev` from the stick (a
   host firewall rule, or an unreachable `HTTPS_PROXY` for the stick), start it, run a drop: it
   fails with `image not verified`, nothing is created.
4. With a warm cache and Sigstore unreachable: same block, but keep the `verified.json` from step 1: the same
   drop runs (`"via":"cache"`).
5. Repeat step 1 on an arm64 host (Apple silicon) and an amd64 host.

## The signing identity

The stick, `SECURITY.md` and the workflow's own check all verify this, for this repository:

- certificate identity, matched as an anchored regexp:
  `^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$`
- OIDC issuer: `https://token.actions.githubusercontent.com`
- workflow trigger: `push`
- workflow repository: `x-a-n-d-e-r-k/jumpmaster`

A signature from any other workflow file, branch, trigger or repository does not verify.

### If the workflow path or the repository moves

The identity names the workflow file and the repository, so renaming `release.yml`, moving it, or
transferring or renaming the repository changes what a new release is signed as. Sticks verify
with the identity built into their image, so:

1. Release a stick built with the new identity (the stick image takes the repository as the
   `RELEASE_REPOSITORY` build argument; a path change also needs the code's identity changed).
2. Old sticks keep accepting only the old identity until the operator upgrades them, so publish
   that stick before any image that only the new identity signs, and tell operators to upgrade.

## After the first release

The preset Dockerfiles default `ARG BASE` to the plain Node image, a placeholder that their own
build check refuses. Once a trooper is published, record it in `images/published.json`
(`version`, `registry` such as `ghcr.io/x-a-n-d-e-r-k`, and `images` with the
`jumpmaster-trooper` digest) and set each preset's `ARG BASE` default to
`<registry>/jumpmaster-trooper@<digest>`, in one pull request. `images/images.test.ts` fails if the
two disagree.

## Images, the lock and `JM_DEV_IMAGES`

A zone names its image with `image` (any reference, but a digest under signed images) or a
`preset` (`node`, `python`, `go`, `jvm`). The server resolves a preset through the image lock at
`/app/images.lock.json`, which only a release-built server image has: it maps each image name to
the release's index digest under the release's registry, so a preset zone runs
`ghcr.io/<owner>/jumpmaster-trooper-<preset>@sha256:…`.

- Without a lock (a server run from a checkout, or an image built without `IMAGES_LOCK`), a preset
  zone is a config error unless it sets `image`, or the server runs with `JM_DEV_IMAGES=1`. That
  flag resolves presets to locally built `jumpmaster-trooper[-<preset>]:dev` tags, for development
  only: a tag is mutable, and a zone that requires signed images refuses it.
- With a lock that lacks the preset's image, `JM_DEV_IMAGES=1` does not help: the zone must set
  `image`, or the server must come from a release whose lock has it.
- The release's `images.lock.json` asset is the same map plus the server and stick images.

## What a stick needs to verify images

The stick image runs the `signed` image policy (`JM_IMAGE_POLICY=signed`). Before it creates any
container for a drop it verifies the trooper, the egress proxy and every service image, then
pulls each by digest: a digest the operator pinned in `JM_ALLOWED_IMAGES` passes as it is, and
anything else must carry a cosign signature with the identity above, checked against the
registry, so an unsigned image is never downloaded. A tag never runs. A pin is a name and a
digest: `ghcr.io/o/x:v1@sha256:…` and `ghcr.io/o/x@sha256:…` are the same pin, but the same
digest under another name is not (the refusal says so). A
verified digest is cached for 7 days in `/state/verified.json` (root-only, `0600`; a file that
doesn't parse or has another owner or mode is ignored), so a short Sigstore outage doesn't stop
images it already verified. Each image is logged once per drop as
`{"event":"image-verified","ref":…,"via":"cosign"|"pinned"|"cache"}`.

At startup under `signed` the stick refuses to run, with the reason, when:

- its cosign isn't the pinned version (the image ships it; nothing to install);
- a `JM_ALLOWED_IMAGES`, `JM_TROOPER_IMAGE` or `JM_EGRESS_IMAGE` value is not a digest
  reference (`name@sha256:<64 hex>`);
- `SIGSTORE_*`, `COSIGN_*` or `TUF_MIRROR` is set (they would change what cosign trusts; cosign
  gets only `PATH`, `HOME`, `TMPDIR`, `TUF_ROOT`, the CA-store variables and proxy variables);
- it has no trusted signer (an image built without `RELEASE_REPOSITORY`). A fork sets
  `JM_TRUSTED_SIGNER_REPOSITORY=<owner/name>` to trust its own release workflow; the stick logs
  the override at start.

Only then does it advertise `image-verify-v1`, which the server requires before it leases a drop
from a zone with `requireSignedImages`. To run unsigned local images instead, set
`JM_IMAGE_POLICY=allowlist` (M3's behaviour: `JM_ALLOWED_IMAGES` names each image exactly, tags
allowed); such a stick never gets a signed zone's drops.

The stick's own outbound traffic (not restricted by Jumpmaster; allow it if the host filters):

- `ghcr.io` and `pkg-containers.githubusercontent.com`: image pulls;
- `tuf-repo-cdn.sigstore.dev`: the Sigstore trust root (kept under `/state/sigstore`);
- `rekor.sigstore.dev` and `fulcio.sigstore.dev`: the transparency log and the CA;
- the Jumpmaster server.

A stick with `JM_IMAGE_SOURCE=server` (below) needs only the last, and no Sigstore access at all:
it fetches images from its server and verifies them fully offline against the trusted root its
image ships (`/app/sigstore/trusted_root.json`, issue #167). So does the stick installer.

The egress capability check (`egress-v1`) runs short-lived probe containers on the host network,
from the stick's own image, as `nobody`, with no capabilities, to prove a drop can't reach the
host. Under `signed`, the proxy image it starts is first verified and then pulled by digest, so the
release stick image carries its release's proxy digest in `JM_EGRESS_IMAGE`.

### Moving an existing zone onto the stick image

A zone that runs a locally built trooper (an image with a tag, such as one built `FROM` the
trooper for a project's toolchain) does not run on the stick image as it is: the signed policy
refuses tags. Either push that image to a registry and pin its digest in `JM_ALLOWED_IMAGES`
(and use the same digest reference as the zone's `image`), build it `FROM` a released preset and
pin it the same way, or keep that zone's stick on `JM_IMAGE_POLICY=allowlist` and leave the zone's
`requireSignedImages` unset. A service image (a database, say) is not signed by this workflow:
pin it by digest.

## Sticks that fetch from the server

A new stick can get the release images from the Jumpmaster server instead of from GHCR, so the
machine needs no registry access and no credential, and the GHCR packages can stay private. This
is the server half (issue #140); the stick half that fetches from it (issue #141) is below.

**The server is a cache, not a trust anchor.** It mirrors each image together with the cosign
signature artifacts of its index digest, and the stick verifies those signatures offline against
the pinned release identity (above) before it loads anything. A compromised server can't make a
stick run an unsigned image; that claim holds only because the stick verifies.

What the server mirrors:

- **Which images:** the ones the release lock names, read from the server image's
  `/app/images.lock.json` or the file `JM_IMAGES_LOCK` names. That is the stick image, the
  trooper and each preset, and the egress proxy; not the server's own image, and no service
  image (those stay on Docker Hub, pinned by digest).
- **What of each:** the multi-arch index, then for `linux/amd64` and `linux/arm64` (those the index
  lists) the platform manifest, its config and its layers; and the signatures the release
  workflow's cosign wrote for the index digest: OCI 1.1 referrers (the referrers API, or GHCR's
  `sha256-<hex>` fallback tag) and the legacy `sha256-<hex>.sig` tag. An image with no signature
  is not mirrored: a stick could not verify it.
- **Where:** `<dataDir>/images/blobs/sha256/<hex>`, with `<dataDir>/images/index.json` recording
  each image's state. Every blob's SHA-256 is checked as it arrives; a mismatch deletes the partial
  file and fails the image.
- **When:** in the background at start, and when the lock file changes (an upgrade). A failed
  image is retried with backoff (30 s, 2 min, 10 min, 30 min, then hourly) and its last error is
  kept. The mirror fetches only the digests the lock names: it never resolves a tag (the
  signature tags are derived from a lock digest) and never asks the registry what is newer. New
  images arrive only with a new lock, when the server is upgraded to a new release.

The registry: anonymous access first, which serves public packages. If the registry refuses it
(private packages), set the optional `registryReadToken` credential (Settings, Credentials, the
file `registry_read_token` in the secrets directory, or `JM_REGISTRY_READ_TOKEN`): a GitHub token
with `read:packages`. The server exchanges it at the registry's own token service (never at another
host) for a pull token. Both are scrubbed from every log line, and neither is written to the image
store or shown on a page.

What a stick gets: `GET /api/sticks/images/<name>@sha256:<index digest>/oci.tar?platform=linux/amd64`,
with its stick token, exactly as it leases (anonymous: the same `401`). The answer is an OCI image
layout tar with `Content-Length` and `ETag: "<platform manifest digest>"`:

- `oci-layout`;
- `index.json`, laid out as cosign's local OCI layout reads it (entries found by their `kind`
  annotation):
  - the platform manifest, annotated `org.opencontainers.image.ref.name` and
    `io.containerd.image.name` with the original `<registry>/<name>@<index digest>` and
    `dev.jumpmaster.image.index` with the index digest: the only named entry, the image a stick
    loads;
  - the signed multi-arch index, `kind: dev.cosignproject.cosign/imageIndex`: the bytes the
    signatures name (the index's digest, not the platform manifest's);
  - a legacy `sha256-<hex>.sig` signature image, `kind: dev.cosignproject.cosign/sigs`;
  - each OCI 1.1 signature referrer (a sigstore bundle, what cosign v3 writes by default) with its
    `artifactType` and no `kind`: the stick and the installer verify the image from these blobs
    (step 3 below);
  - every signature entry annotated `dev.jumpmaster.signature.of` with the index digest, and none
    with a reference name;
- `manifest.json`, naming exactly the platform image (config and layers) for `docker load` on
  Docker's classic image store, which reads that file rather than `index.json`;
- the blobs: the platform manifest, its config and layers, the multi-arch index, and each
  signature manifest with its blobs.

Only images the current or the previous lock names are served, so sticks still on the previous
release keep working through an upgrade; any other digest is `404 { error: 'not in the image
lock' }`. An image not yet complete is `404 { error: 'not mirrored', state }` with `state` one of
`pending`, `fetching` or `failed: <reason>`; a platform the image does not have is `404`.

The sticks page has an **Images** card listing each image with its platforms, size and state, and
the doctor's `server.image-mirror` says the same: `info` with no lock (a checkout has nothing to
mirror), `pass` when every image is complete, `warn` naming each failure.

### The stick's half (issue #141)

`JM_IMAGE_SOURCE=server|registry` says where a stick gets an image it doesn't have. Unset, it is
`server` once the server announces `image-mirror-v1` on a lease answer (`x-jumpmaster-features`;
a server announces it once it has an image lock), else `registry`, as before. The installer sets
`JM_IMAGE_SOURCE=server`. Unset, the checks a stick runs at startup, before its first lease, use
the registry; with `server` set it enrolls first, so even the egress proxy comes from the server.
The stick's own image comes from the installer, never from the stick.

In `server` mode, wherever a stick pulled a digest before (a drop's trooper, proxy and service
images, its own trooper image, the egress check's proxy), for one it doesn't have:

1. It downloads the layout for its own platform (`linux/amd64` or `linux/arm64`) with its stick
   token into a temporary directory under its state directory (`/state/image-fetch`), extracting
   as it reads. It refuses, before writing anything outside that directory: a link entry (symlink
   or hard link), an absolute or `..` path, any name an image layout doesn't have, a duplicate,
   and more than 8 GB. Every blob must hash to its name. Progress (bytes done of total) goes to
   the server at most every 2 seconds on a lease call with no free slot; `/sticks` shows
   `fetching <image> X/Y MB` beside the stick.
2. It binds the layout to the digest it asked for: that digest's blob is the multi-arch index, and
   the index's entry for its platform is the manifest it loads.
3. Under `signed`, fully offline (issue #167):
   - the layout's `index.json` must name the image index for the digest asked for, and that blob
     must hash to it;
   - every entry annotated `dev.jumpmaster.signature.of` with that digest and the artifactType
     `application/vnd.dev.sigstore.bundle.v0.3+json` is a manifest whose single layer is the
     Sigstore bundle, each hash-checked;
   - `cosign verify-blob-attestation --bundle <bundle> --type https://sigstore.dev/cosign/sign/v1
     --trusted-root /app/sigstore/trusted_root.json --offline` with the pinned identity above
     checks each bundle on the index blob, with `HOME` and `TUF_ROOT` an empty temporary
     directory, so no cache and no TUF fetch can stand in for the pinned root. One bundle that
     verifies is enough.

   Nothing asks the registry or Sigstore. No bundle, a hash that doesn't match, a cosign error or
   a timeout refuses, naming cosign's last error line. A failure deletes
   the directory, refuses the drop with `image not verified: …` and logs
   `{"event":"image-verify-failed","ref":…,"via":"server"}`. A digest the operator pinned, or one in
   `/state/verified.json`, needs no signature; a success is recorded there. Under `allowlist` the
   image must be in `JM_ALLOWED_IMAGES`, as ever.
4. It runs `docker load` on a tar it builds from the files it checked (the platform image alone,
   no signature artifact). The engine must report the manifest's config digest as the loaded id
   (the containerd image store reports the manifest digest, which is bound the same way); any
   other id is removed and the drop refused. The image is then found by its digest reference.
   Naming an image by digest needs Docker's containerd image store (the default on new Docker
   installs): the engine API refuses to tag by digest, so the name comes from the layout's
   `io.containerd.image.name` annotation; on the classic store the drop is refused with that
   reason.
5. The temporary directory is deleted, whatever happened.

A `404 not mirrored` is no failure: the drop waits, logged as
`{"event":"drop-waiting","reason":"image <ref> not yet mirrored on the server (<state>)"}`. The stick
posts no result and sends no heartbeat, so the lease lapses and the drop is leased again later.
A stick in `server` mode never falls back to the registry, and never loads anything unverified.

The trusted root is Sigstore's public-good root, committed as `images/sigstore/trusted_root.json`
and copied into the stick and server images. It is not refreshed on its own: when Sigstore rotates
its keys, a release updates the file. `COSIGN_BIN=<a cosign v3.1.4> npm test` runs the real
cosign on the rc.2 fixtures under `apps/stick/src/fixtures/rc2-stick`
(`apps/stick/src/verify-real-cosign.test.ts`, and the stick/installer parity table in
`apps/server/src/install/stick-sh.test.ts`); without `COSIGN_BIN` those tests are skipped. By
hand:

```
cosign verify-blob-attestation --bundle bundle.json --type https://sigstore.dev/cosign/sign/v1 \
  --trusted-root images/sigstore/trusted_root.json --offline <identity flags> index.json
```

Collection (issue #426): images of neither the current nor the previous lock leave the index, and
at the end of a mirror pass in which no image is pending or fetching, every blob under
`<dataDir>/images/blobs` that no record in the index names is deleted (a blob a kept image shares
stays). It logs `{"event":"image-mirror-collect","removed":n,"bytes":b}`; a blob it cannot delete
is logged and the rest still go. The doctor's `server.image-mirror` names the store's size. Old
release images in the host's Docker are the operator's to remove: see
[Upgrading the server](operate.md#upgrading-the-server).
