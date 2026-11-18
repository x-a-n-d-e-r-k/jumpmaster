// The stick installer (issue #138): `curl -fsSL '<publicUrl>/install/stick.sh' | sudo sh -s -- <code>`
// on a fresh Linux machine or a Mac with Docker Desktop, and the cloud-init snippet that runs the same line when a VPS is made.
// The script holds no secret: the one-time code arrives as its argument, and its first network
// call swaps it for a 30-minute install token (issue #269), so the code is spent within a second;
// every later call, the stick's volume and its enrollment use the token, and every failure after
// the swap cancels the invite. Only this server's
// address, the stick image's digest, the release signer and the pinned SHA-256s of cosign and of
// Sigstore's trusted root are baked in. The machine reaches only this server: cosign, the trusted
// root and the stick image come from here, and the image is verified fully offline (issue #167)
// against the release workflow's Sigstore bundle before `docker load`, with the same steps as the
// stick's `verifyIndexBundles` (apps/stick/src/verify.ts). What it loads is a tar it builds from
// the verified files, as the stick's `loadTar` does (apps/stick/src/fetch-image.ts, issue #168):
// a sparse index named `<registry>/jumpmaster-stick@<digest>` holding this platform alone, and no
// signature; it then tags that reference, once the engine answers it with the expected id.

/** What the script is rendered with; nothing here is a secret. */
export type StickScriptParams = {
  /** `server.publicUrl` as an origin. */
  serverUrl: string;
  /** The release's stick image this server mirrors, `<registry>/jumpmaster-stick@<digest>`. */
  image: { ref: string; digest: string } | null;
  /** The repository whose release workflow signs the images (`owner/name`). */
  signerRepository: string | null;
  /** The pinned cosign binary's SHA-256 per platform. */
  cosignSha256: { amd64: string; arm64: string };
  /** The SHA-256 of the server's copy of Sigstore's trusted root; null when it has none. */
  trustedRootSha256: string | null;
};

/** The cosign the stick image ships (images/stick/Dockerfile), served to the installer. */
export const COSIGN_VERSION = 'v3.1.4';
/** The SHA-256 of that cosign per platform, as images/stick/Dockerfile checks it. */
export const COSIGN_SHA256 = {
  amd64: 'be06b2d8da722330fa78fd7cd858a74b589b20ab314a7d901e8cefcf387c965d',
  arm64: '4ec67587bcf621c50f5309c7301b16033cd0b1b8ce3a3bf0ce945ff61cf0dacb',
} as const;

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** What the installer checks, as the stick does (apps/stick/src/verify.ts). */
export const SIGN_PREDICATE_TYPE = 'https://sigstore.dev/cosign/sign/v1';
export const BUNDLE_ARTIFACT_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
export const SIGNATURE_OF = 'dev.jumpmaster.signature.of';
export const IMAGE_INDEX_KIND = 'dev.cosignproject.cosign/imageIndex';
/** How long one cosign check may take on the machine, in seconds. */
export const COSIGN_WAIT_SECONDS = 120;
export const STICK_IMAGE_NAME = 'jumpmaster-stick';
/** Where the installer writes the code in the stick's state volume (mounted at /state). */
export const ENROLL_CODE_PATH = '/state/enroll_code';
/** How long the installer's best-effort cancel may take, in seconds (issue #269). */
export const CANCEL_WAIT_SECONDS = 5;

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** The OCI media type of an image index. */
const IMAGE_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';

/**
 * `<registry>/<name>@<digest>` of a reference, any tag dropped: the name the loaded image gets
 * (as the stick's `canonicalRef`).
 */
export function digestName(ref: string, digest: string): string {
  const at = ref.lastIndexOf('@');
  const name = at < 0 ? ref : ref.slice(0, at);
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return `${colon > slash ? name.slice(0, colon) : name}@${digest}`;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The certificate identity of `release.yml` in `repository` run for a version tag, exactly as the
 * stick pins it (apps/stick/src/verify.ts `identityRegexp`).
 */
export function identityRegexp(repository: string): string {
  return `^https://github\\.com/${escapeRe(repository)}/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$`;
}

/** The signer repository from a source URL like `https://github.com/owner/name`, if it is one. */
export function repositoryOf(sourceUrl: string | undefined): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    sourceUrl ?? '',
  );
  return m?.[1] ?? null;
}

/** `s` as one single-quoted shell word. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The line the owner pastes on the machine: the script's URL is one single-quoted word. */
export const installLine = (serverUrl: string, code: string): string =>
  `curl -fsSL ${shq(`${serverUrl}/install/stick.sh`)} | sudo sh -s -- ${code}`;

/** The placeholder the owner replaces with an auth key from the Tailscale admin console. */
export const TS_AUTHKEY_PLACEHOLDER = 'TS_AUTHKEY';

/**
 * A `#cloud-config` that joins the tailnet, installs Docker when the image has none, then runs
 * the installer line. Each command is a JSON string, which YAML reads as a double-quoted scalar.
 */
export function cloudInit(serverUrl: string, code: string): string {
  const cmds = [
    'curl -fsSL https://tailscale.com/install.sh | sh',
    `tailscale up --authkey=${TS_AUTHKEY_PLACEHOLDER}`,
    'command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh',
    installLine(serverUrl, code),
  ];
  return [
    '#cloud-config',
    `# Replace ${TS_AUTHKEY_PLACEHOLDER} with an auth key from your Tailscale admin console.`,
    'runcmd:',
    ...cmds.map((c) => `  - ${JSON.stringify(c)}`),
    '',
  ].join('\n');
}

/** The installer, for this server and its mirrored stick image. POSIX sh, run as root. */
export function stickScript(p: StickScriptParams): string {
  const signed = p.signerRepository !== null && REPOSITORY.test(p.signerRepository);
  const ready = p.image !== null && signed && p.trustedRootSha256 !== null;
  const why =
    p.image === null
      ? 'this server mirrors no release stick image (it runs from a checkout, or the release has no image lock): see docs/runbooks/install.md to add a stick another way'
      : !signed
        ? 'this server does not know which repository signs its release images: set JM_TRUSTED_SIGNER_REPOSITORY=<owner/name> on the server'
        : 'this server has no Sigstore trusted root to send (the server image ships it at /app/sigstore/trusted_root.json): use a release server image';
  const repo = ready ? (p.signerRepository as string) : '';
  return `#!/bin/sh
# Jumpmaster stick installer, served by ${p.serverUrl} (issue #138). It holds no secret: the
# one-time enrollment code is its argument. As root on Linux (x86_64 or aarch64):
#   curl -fsSL ${p.serverUrl}/install/stick.sh | sudo sh -s -- <code>       install and enroll
#   curl -fsSL ${p.serverUrl}/install/stick.sh | sudo sh -s -- --uninstall  remove it
# Add --yes to install Docker with get.docker.com without asking.
# The code appears on the pasted line (and so in ps, shell history and sudo's log) only until
# the exchange, which is the first network call: it swaps the code for an install token, and the
# code works nowhere after. The token goes only through a header file and stdin, never argv, and
# every failure after the exchange cancels the invite (issue #269).
set -eu

JM_SERVER_URL=${shq(p.serverUrl)}
STICK_REF=${shq(p.image?.ref ?? '')}
STICK_DIGEST=${shq(p.image?.digest ?? '')}
STICK_NAME=${shq(p.image ? digestName(p.image.ref, p.image.digest) : '')}
INDEX_MEDIA_TYPE=${shq(IMAGE_INDEX_MEDIA_TYPE)}
SIGNER_REPOSITORY=${shq(repo)}
IDENTITY_REGEXP=${shq(ready ? identityRegexp(repo) : '')}
OIDC_ISSUER=${shq(GITHUB_ISSUER)}
COSIGN_SHA256_AMD64=${shq(p.cosignSha256.amd64)}
COSIGN_SHA256_ARM64=${shq(p.cosignSha256.arm64)}
TRUSTED_ROOT_SHA256=${shq(p.trustedRootSha256 ?? '')}
SIGN_PREDICATE_TYPE=${shq(SIGN_PREDICATE_TYPE)}
BUNDLE_ARTIFACT_TYPE=${shq(BUNDLE_ARTIFACT_TYPE)}
SIGNATURE_OF=${shq(SIGNATURE_OF)}
IMAGE_INDEX_KIND=${shq(IMAGE_INDEX_KIND)}
NOT_READY=${shq(ready ? '' : why)}
CONTAINER=jm-stick
VOLUME=jm-stick
LOCAL_IMAGE=${STICK_IMAGE_NAME}:installed
CODE_PATH=${ENROLL_CODE_PATH}
WAIT_SECONDS=\${JM_INSTALL_WAIT:-60}
TTY=\${JM_INSTALL_TTY:-/dev/tty}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}
COSIGN_WAIT=\${JM_INSTALL_COSIGN_TIMEOUT:-${COSIGN_WAIT_SECONDS}}

say() { printf '%s\\n' "$*"; }
INSTALL_TOKEN=
# After the exchange, every failure cancels the invite first (best effort, ${CANCEL_WAIT_SECONDS} s), so its
# token stops working; it never reports success.
die() {
  printf 'jumpmaster: %s\\n' "$*" >&2
  if [ -n "$INSTALL_TOKEN" ]; then
    INSTALL_TOKEN=
    curl -fsS -m ${CANCEL_WAIT_SECONDS} -X POST -H "@$TMP/auth" -o /dev/null "$JM_SERVER_URL/install/cancel" 2>/dev/null ||
      printf 'jumpmaster: %s\\n' "the invite may still be pending: press Cancel on the sticks page" >&2
  fi
  exit 1
}

# The descriptors of an OCI JSON document (an image layout's index.json, an image index, a
# manifest), one per line: the key of the list holding it, its digest and artifactType, its
# signature-of and kind annotations, and its platform's os and architecture, "-" for none. sed and a brace count, no jq: every file it picks is hash-checked
# after, and only cosign decides what is signed.
descriptors() {
  tr -d ' \\t\\r\\n' <"$1" | sed 's/[{}]/\\
&\\
/g; s/,"/\\
"/g' | {
    depth=0 key=- parent=- sub=- d=- at=- of=- kind=- os=- pa=-
    while IFS= read -r t; do
      case $t in
        '{')
          depth=$((depth + 1))
          if [ "$depth" = 2 ]; then parent=$key sub=- d=- at=- of=- kind=- os=- pa=-; fi
          ;;
        '}')
          if [ "$depth" = 2 ]; then
            printf '%s %s %s %s %s %s %s\\n' "$parent" "$d" "$at" "$of" "$kind" "$os" "$pa"
          fi
          depth=$((depth - 1))
          ;;
        '"'*)
          name=\${t#\\"}
          name=\${name%%\\"*}
          value=\${t#*\\":}
          case $value in
            '' | '[')
              if [ "$depth" = 1 ]; then key=$name; fi
              if [ "$depth" = 2 ]; then sub=$name; fi
              ;;
            '"'*)
              v=\${value#\\"}
              v=\${v%%\\"*}
              v=\${v:--}
              case $depth:$name in
                2:digest) d=$v ;;
                2:artifactType) at=$v ;;
                3:"$SIGNATURE_OF") of=$v ;;
                3:kind) kind=$v ;;
              esac
              if [ "$depth:$sub" = 3:platform ]; then
                case $name in
                  os) os=$v ;;
                  architecture) pa=$v ;;
                esac
              fi
              ;;
          esac
          ;;
      esac
    done
  }
}

# The path of blob $1 in the layout, if it is there and its content hashes to its name.
blob() {
  case $1 in sha256:*) ;; *) return 1 ;; esac
  h=\${1#sha256:}
  case $h in '' | *[!0-9a-f]*) return 1 ;; esac
  [ \${#h} = 64 ] || return 1
  [ -f "$LAYOUT/blobs/sha256/$h" ] || return 1
  [ "$(sha256 "$LAYOUT/blobs/sha256/$h")" = "$h" ] || return 1
  printf '%s' "$LAYOUT/blobs/sha256/$h"
}

YES=0
UNINSTALL=0
CODE=
for arg in "$@"; do
  case $arg in
    --yes | -y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    jm_enroll_*) CODE=$arg ;;
    *) die "unknown argument $arg: pass the enrollment code (jm_enroll_...), --yes or --uninstall" ;;
  esac
done

os=$(uname -s)
arch=$(uname -m)
case $os in
  Linux | Darwin) ;;
  *) die "a stick installs on Linux or macOS (Docker Desktop) only, not $os" ;;
esac
case $arch in
  x86_64 | amd64) PLATFORM=linux/amd64; COSIGN_SHA256=$COSIGN_SHA256_AMD64 ;;
  aarch64 | arm64) PLATFORM=linux/arm64; COSIGN_SHA256=$COSIGN_SHA256_ARM64 ;;
  *) die "a stick runs on x86_64 or aarch64, not $arch" ;;
esac
[ "$os" = Darwin ] || [ "$(id -u)" = 0 ] || die "run it as root: curl -fsSL $JM_SERVER_URL/install/stick.sh | sudo sh -s -- <code>"

if [ "$UNINSTALL" = 1 ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is not installed: there is no stick to remove"
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  say "Removed the stick container $CONTAINER and its state volume $VOLUME. Remove the stick on the sticks page too."
  exit 0
fi

[ -n "$CODE" ] || die "no enrollment code: copy the whole line from Add a stick on the sticks page"
[ -z "$NOT_READY" ] || die "$NOT_READY"

TMP=$(mktemp -d "\${TMPDIR:-/tmp}/tmp.XXXXXXXXXX")
trap 'rm -rf "$TMP"' EXIT
trap 'die "interrupted"' INT TERM

# What fails without the network fails before the exchange, so the code is not spent.
if [ "$os" = Darwin ] && ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed: install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/), start it, and paste the line again"
fi
if command -v docker >/dev/null 2>&1 && docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  die "a stick is already installed here (container $CONTAINER): run this with --uninstall first"
fi

# The exchange: the code, from a header file, for an install token. From here on only the token
# is used, also from a header file, never on a command line another user could read.
umask 077
printf 'Authorization: Bearer %s\\n' "$CODE" >"$TMP/auth"
CODE=
status=$(curl -sS -X POST -H "@$TMP/auth" -o "$TMP/exchange" -w '%{http_code}' "$JM_SERVER_URL/install/exchange") || status=
: >"$TMP/auth"
token=
if [ "$status" = 200 ]; then
  token=$(sed -n 's/.*"token":"\\(jm_install_[A-Za-z0-9_-]*\\)".*/\\1/p' "$TMP/exchange" 2>/dev/null | head -n 1)
fi
if [ -z "$token" ]; then
  why=$(sed -n 's/.*"error":"\\([^"]*\\)".*/\\1/p' "$TMP/exchange" 2>/dev/null | head -n 1)
  die "the server did not accept the code (\${why:-could not reach $JM_SERVER_URL}): make a new one on the sticks page if it was used, cancelled or is out of date"
fi
printf 'Authorization: Bearer %s\\n' "$token" >"$TMP/auth"
INSTALL_TOKEN=$token
token=
if ! command -v docker >/dev/null 2>&1; then
  answer=n
  if [ "$YES" = 1 ]; then
    answer=y
  elif [ -t 0 ]; then
    printf 'Install Docker with get.docker.com? [y/N] '
    read -r answer || answer=n
  elif (: <"$TTY") 2>/dev/null; then
    printf 'Install Docker with get.docker.com? [y/N] '
    read -r answer <"$TTY" || answer=n
  else
    die "Docker is not installed. Install it (https://docs.docker.com/engine/install/) and paste the line again, or add --yes before the code to install it with get.docker.com"
  fi
  case $answer in
    y | Y | yes | YES) ;;
    *) die "Docker is needed. Install it (https://docs.docker.com/engine/install/) and paste the line again" ;;
  esac
  curl -fsSL https://get.docker.com -o "$TMP/get-docker.sh" || die "could not download get.docker.com"
  sh "$TMP/get-docker.sh" || die "installing Docker failed"
fi

fetch() {
  curl -fsSL -H "@$TMP/auth" -o "$2" "$JM_SERVER_URL$1"
}

say "Downloading cosign $PLATFORM from $JM_SERVER_URL"
fetch "/install/cosign?platform=$PLATFORM" "$TMP/cosign" ||
  die "could not download cosign from $JM_SERVER_URL: the install token works for 30 minutes"
got=$(sha256 "$TMP/cosign")
[ "$got" = "$COSIGN_SHA256" ] || die "the cosign the server sent is not the pinned ${COSIGN_VERSION} (sha256 $got)"
chmod 0700 "$TMP/cosign"
# On macOS the pinned Linux cosign can't run on the host: it runs in Docker Desktop's VM, as a
# one-file image with no network, the work directory mounted at the same path.
COSIGN_IMAGE=jm-install-cosign:$$
if [ "$os" = Darwin ]; then
  tar -cf - -C "$TMP" cosign | docker import - "$COSIGN_IMAGE" >/dev/null || die "could not load cosign into Docker"
fi

say "Downloading Sigstore's trusted root from $JM_SERVER_URL"
fetch "/install/trusted-root.json" "$TMP/trusted_root.json" ||
  die "could not download the trusted root from $JM_SERVER_URL: the install token works for 30 minutes"
got=$(sha256 "$TMP/trusted_root.json")
[ "$got" = "$TRUSTED_ROOT_SHA256" ] || die "the trusted root the server sent is not the pinned one (sha256 $got)"

say "Downloading the stick image for $PLATFORM"
fetch "/install/stick-image.tar?platform=$PLATFORM" "$TMP/stick.tar" ||
  die "could not download the stick image from $JM_SERVER_URL: the install token works for 30 minutes"
mkdir "$TMP/layout"
tar -xf "$TMP/stick.tar" -C "$TMP/layout" || die "the stick image download is not a tar"

say "Verifying its signature offline"
# The signed multi-arch index, its bytes hashing to the digest this server pins; every Sigstore
# bundle the layout says signs it, each the one layer of its manifest, hash-checked; then cosign
# on the index bytes with only the pinned trusted root, in an empty HOME (no TUF, no network).
LAYOUT="$TMP/layout"
[ -f "$LAYOUT/index.json" ] || die "the stick image download has no index.json"
descriptors "$LAYOUT/index.json" >"$TMP/entries" || die "the stick image download's index.json does not parse"
index=
: >"$TMP/bundles"
while read -r parent d at of kind _; do
  [ "$parent" = manifests ] || continue
  if [ "$d" = "$STICK_DIGEST" ] && [ "$kind" = "$IMAGE_INDEX_KIND" ]; then index=$d; fi
  if [ "$of" = "$STICK_DIGEST" ] && [ "$at" = "$BUNDLE_ARTIFACT_TYPE" ]; then
    printf '%s\\n' "$d" >>"$TMP/bundles"
  fi
done <"$TMP/entries"
[ -n "$index" ] || die "the stick image download has no image index $STICK_DIGEST"
index_blob=$(blob "$STICK_DIGEST") || die "the image index blob in the download does not hash to $STICK_DIGEST"
[ -s "$TMP/bundles" ] || die "the stick image download has no Sigstore bundle signing $STICK_DIGEST"
: >"$TMP/bundle-files"
while read -r d; do
  m=$(blob "$d") || die "the signature manifest $d in the download does not hash to its digest"
  descriptors "$m" >"$TMP/layers" || die "the signature manifest $d does not parse"
  n=$(grep -c '^layers ' "$TMP/layers" || true)
  [ "$n" = 1 ] || die "the signature manifest $d does not hold exactly one layer"
  layer=$(sed -n 's/^layers \\([^ ]*\\) .*/\\1/p' "$TMP/layers")
  b=$(blob "$layer") || die "the Sigstore bundle $layer in the download does not hash to its digest"
  printf '%s\\n' "$b" >>"$TMP/bundle-files"
done <"$TMP/bundles"
TIMEOUT=
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout $COSIGN_WAIT"; fi
verified=0
why=
while read -r b; do
  home=$(mktemp -d "$TMP/cosign-home.XXXXXX")
  rc=0
  if [ "$os" = Darwin ]; then
    # Docker Desktop reads shared files as the user running it, not as root: under sudo, the
    # work directory (0700) goes to that user, or the container can't open it.
    if [ "$(id -u)" = 0 ] && [ -n "\${SUDO_UID:-}" ]; then
      chown -R "$SUDO_UID:\${SUDO_GID:-$SUDO_UID}" "$TMP" || die "could not hand $TMP to the user Docker Desktop runs as"
    fi
    set -- docker run --rm --network none -v "$TMP:$TMP" -e "HOME=$home" -e "TUF_ROOT=$home" "$COSIGN_IMAGE" /cosign
  else
    set -- "$TMP/cosign"
  fi
  HOME="$home" TUF_ROOT="$home" $TIMEOUT "$@" verify-blob-attestation \\
    --bundle "$b" --type "$SIGN_PREDICATE_TYPE" \\
    --trusted-root "$TMP/trusted_root.json" --offline \\
    --certificate-identity-regexp "$IDENTITY_REGEXP" \\
    --certificate-oidc-issuer "$OIDC_ISSUER" \\
    --certificate-github-workflow-trigger push \\
    --certificate-github-workflow-repository "$SIGNER_REPOSITORY" \\
    "$index_blob" </dev/null >/dev/null 2>"$TMP/cosign.err" || rc=$?
  rm -rf "$home"
  if [ "$rc" = 0 ]; then
    verified=1
    break
  fi
  if [ "$rc" = 124 ] && [ -n "$TIMEOUT" ]; then
    why="cosign timed out after \${COSIGN_WAIT}s"
  else
    line=$(grep '^Error:' "$TMP/cosign.err" | tail -n 1 | sed 's/^Error: *//')
    [ -n "$line" ] || line=$(tail -n 1 "$TMP/cosign.err")
    why="cosign exit $rc: $line"
  fi
done <"$TMP/bundle-files"
if [ "$os" = Darwin ]; then docker image rm "$COSIGN_IMAGE" >/dev/null 2>&1 || true; fi
[ "$verified" = 1 ] || die "the stick image is not signed by $SIGNER_REPOSITORY's release workflow: $why"

say "Signed by $SIGNER_REPOSITORY's release workflow"

# What docker load gets (issue #168), built from the verified files as the stick builds it: the
# signed index alone in index.json, named by its digest reference (Docker's containerd image
# store then resolves that reference to it), with only this platform's manifest, config and
# layers, each hash-checked; manifest.json lists the same image for the classic store. No
# signature and no other platform is loaded.
descriptors "$index_blob" >"$TMP/platforms" || die "the stick image index does not parse"
manifest=
while read -r parent d at of kind os pa; do
  if [ "$parent" = manifests ] && [ "$os/$pa" = "$PLATFORM" ]; then
    manifest=$d
    break
  fi
done <"$TMP/platforms"
[ -n "$manifest" ] || die "the stick image index has no $PLATFORM image"
manifest_blob=$(blob "$manifest") || die "the stick image download has no $PLATFORM image (its manifest $manifest is missing or does not hash to its digest)"
descriptors "$manifest_blob" >"$TMP/parts" || die "the stick image's $PLATFORM manifest does not parse"
config=$(sed -n 's/^config \\([^ ]*\\) .*/\\1/p' "$TMP/parts" | head -n 1)
[ -n "$config" ] || die "the stick image's $PLATFORM manifest has no config"
LOAD="$TMP/load"
mkdir -p "$LOAD/blobs/sha256"
put() {
  b=$(blob "$1") || die "the stick image's $2 $1 in the download does not hash to its digest"
  dest="$LOAD/blobs/sha256/\${1#sha256:}"
  [ -e "$dest" ] || ln "$b" "$dest" 2>/dev/null || cp "$b" "$dest" || die "could not stage $1"
}
put "$STICK_DIGEST" index
put "$manifest" manifest
put "$config" config
layers=
for layer in $(sed -n 's/^layers \\([^ ]*\\) .*/\\1/p' "$TMP/parts"); do
  put "$layer" layer
  layers="$layers\${layers:+,}$(printf '"blobs/sha256/%s"' "\${layer#sha256:}")"
done
size=$(($(wc -c <"$index_blob")))
printf '%s' '{"imageLayoutVersion":"1.0.0"}' >"$LOAD/oci-layout"
printf '{"schemaVersion":2,"mediaType":"%s","manifests":[{"mediaType":"%s","digest":"%s","size":%s,"annotations":{"io.containerd.image.name":"%s","org.opencontainers.image.ref.name":"%s"}}]}' \
  "$INDEX_MEDIA_TYPE" "$INDEX_MEDIA_TYPE" "$STICK_DIGEST" "$size" "$STICK_NAME" "$STICK_NAME" >"$LOAD/index.json"
printf '[{"Config":"blobs/sha256/%s","RepoTags":[],"Layers":[%s]}]' "\${config#sha256:}" "$layers" >"$LOAD/manifest.json"
tar -cf "$TMP/load.tar" -C "$LOAD" oci-layout index.json manifest.json blobs || die "could not build the image tar to load"

docker load -i "$TMP/load.tar" >"$TMP/loaded" || die "docker load failed"
# The containerd store answers the reference with the index digest; the classic store, if it
# answers it at all, with this platform's config digest. Anything else is removed, never kept.
id=$(docker image inspect -f '{{.Id}}' "$STICK_NAME" 2>/dev/null) || id=
if [ "$id" != "$STICK_DIGEST" ] && [ "$id" != "$config" ]; then
  docker image rm -f "$STICK_NAME" >/dev/null 2>&1 || true
  sed -n 's/^Loaded image ID: //p; s/^Loaded image: //p' "$TMP/loaded" | while read -r x; do
    docker image rm -f "$x" >/dev/null 2>&1 || true
  done
  die "the engine did not load the stick image as $STICK_NAME (it answers \${id:-no image}): loading an image by digest needs Docker's containerd image store"
fi
docker tag "$STICK_NAME" "$LOCAL_IMAGE" || die "could not tag the stick image"

docker volume create "$VOLUME" >/dev/null || die "could not create the volume $VOLUME"
mount=$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME" 2>/dev/null || true)
code_file=
if [ -n "$mount" ] && [ -d "$mount" ]; then
  code_file="$mount/$(basename "$CODE_PATH")"
  printf '%s\\n' "$INSTALL_TOKEN" >"$code_file"
  chmod 0600 "$code_file"
else
  # The volume lives in a VM (Docker Desktop) or under another user (rootless Docker): a container
  # writes the token, read from stdin, never on a command line.
  printf '%s\\n' "$INSTALL_TOKEN" | docker run --rm -i --network none --entrypoint sh -v "$VOLUME:/state" "$LOCAL_IMAGE" \\
    -c "umask 077 && cat >$CODE_PATH" || die "could not write the enrollment code into the volume $VOLUME"
fi
forget_code() {
  if [ -n "$code_file" ]; then
    rm -f "$code_file"
  else
    docker run --rm --network none --entrypoint rm -v "$VOLUME:/state" "$LOCAL_IMAGE" -f "$CODE_PATH" >/dev/null 2>&1 || true
  fi
}

docker run -d --name "$CONTAINER" --restart unless-stopped --read-only --tmpfs /tmp \\
  -v /var/run/docker.sock:/var/run/docker.sock -v "$VOLUME:/state" \\
  -e "JM_SERVER_URL=$JM_SERVER_URL" -e "JM_ENROLL_CODE_FILE=$CODE_PATH" \\
  -e JM_IMAGE_SOURCE=server -e JM_IMAGE_POLICY=signed \\
  "$LOCAL_IMAGE" >/dev/null || { forget_code; die "docker run failed"; }

say "Waiting for the stick to enroll"
i=0
while [ "$i" -lt "$WAIT_SECONDS" ]; do
  logs=$(docker logs "$CONTAINER" 2>&1 || true)
  name=$(printf '%s\\n' "$logs" | sed -n 's/^enrolled as \\(.*\\) (.*)$/\\1/p' | head -n 1)
  if [ -n "$name" ]; then
    forget_code
    say "Enrolled as $name. Back to your browser."
    exit 0
  fi
  failed=$(printf '%s\\n' "$logs" | grep 'enroll failed' | head -n 1 || true)
  if [ -n "$failed" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    forget_code
    die "the stick could not enroll ($failed): make a new code on the sticks page"
  fi
  sleep 1
  i=$((i + 1))
done
die "the stick did not enroll within $WAIT_SECONDS seconds: see docker logs $CONTAINER, run this with --uninstall, and make a new code on the sticks page"
`;
}
