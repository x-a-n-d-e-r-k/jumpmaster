// The stick installer (issue #138): `curl -fsSL <publicUrl>/install/stick.sh | sudo sh -s -- <code>`
// on a fresh Linux machine, and the cloud-init snippet that runs the same line when a VPS is made.
// The script holds no secret: the one-time code arrives as its argument, and only this server's
// address, the stick image's digest, the release signer and cosign's pinned SHA-256s are baked in.
// The machine reaches only this server: cosign and the stick image come from here, and the image
// is verified offline against the release workflow's signature before `docker load`.

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
};

/** The cosign the stick image ships (images/stick/Dockerfile), served to the installer. */
export const COSIGN_VERSION = 'v3.1.4';
/** The SHA-256 of that cosign per platform, as images/stick/Dockerfile checks it. */
export const COSIGN_SHA256 = {
  amd64: 'be06b2d8da722330fa78fd7cd858a74b589b20ab314a7d901e8cefcf387c965d',
  arm64: '4ec67587bcf621c50f5309c7301b16033cd0b1b8ce3a3bf0ce945ff61cf0dacb',
} as const;

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const STICK_IMAGE_NAME = 'jumpmaster-stick';
/** Where the installer writes the code in the stick's state volume (mounted at /state). */
export const ENROLL_CODE_PATH = '/state/enroll_code';

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
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

/** The line the owner pastes on the machine. */
export const installLine = (serverUrl: string, code: string): string =>
  `curl -fsSL ${serverUrl}/install/stick.sh | sudo sh -s -- ${code}`;

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
  const ready =
    p.image !== null && p.signerRepository !== null && REPOSITORY.test(p.signerRepository);
  const why =
    p.image === null
      ? 'this server mirrors no release stick image (it runs from a checkout, or the release has no image lock): see docs/runbooks/install.md to add a stick another way'
      : 'this server does not know which repository signs its release images: set JM_TRUSTED_SIGNER_REPOSITORY=<owner/name> on the server';
  const repo = ready ? (p.signerRepository as string) : '';
  return `#!/bin/sh
# Jumpmaster stick installer, served by ${p.serverUrl} (issue #138). It holds no secret: the
# one-time enrollment code is its argument. As root on Linux (x86_64 or aarch64):
#   curl -fsSL ${p.serverUrl}/install/stick.sh | sudo sh -s -- <code>       install and enroll
#   curl -fsSL ${p.serverUrl}/install/stick.sh | sudo sh -s -- --uninstall  remove it
# Add --yes to install Docker with get.docker.com without asking.
set -eu

JM_SERVER_URL=${shq(p.serverUrl)}
STICK_REF=${shq(p.image?.ref ?? '')}
STICK_DIGEST=${shq(p.image?.digest ?? '')}
SIGNER_REPOSITORY=${shq(repo)}
IDENTITY_REGEXP=${shq(ready ? identityRegexp(repo) : '')}
OIDC_ISSUER=${shq(GITHUB_ISSUER)}
COSIGN_SHA256_AMD64=${shq(p.cosignSha256.amd64)}
COSIGN_SHA256_ARM64=${shq(p.cosignSha256.arm64)}
NOT_READY=${shq(ready ? '' : why)}
CONTAINER=jm-stick
VOLUME=jm-stick
LOCAL_IMAGE=${STICK_IMAGE_NAME}:installed
CODE_PATH=${ENROLL_CODE_PATH}
WAIT_SECONDS=\${JM_INSTALL_WAIT:-60}
TTY=\${JM_INSTALL_TTY:-/dev/tty}

say() { printf '%s\\n' "$*"; }
die() { printf 'jumpmaster: %s\\n' "$*" >&2; exit 1; }

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
[ "$os" = Linux ] || die "a stick installs on Linux only, not $os (on macOS, see docs/runbooks/install.md for a source install)"
case $arch in
  x86_64 | amd64) PLATFORM=linux/amd64; COSIGN_SHA256=$COSIGN_SHA256_AMD64 ;;
  aarch64 | arm64) PLATFORM=linux/arm64; COSIGN_SHA256=$COSIGN_SHA256_ARM64 ;;
  *) die "a stick runs on x86_64 or aarch64, not $arch" ;;
esac
[ "$(id -u)" = 0 ] || die "run it as root: curl -fsSL $JM_SERVER_URL/install/stick.sh | sudo sh -s -- <code>"

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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' INT TERM

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

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  die "a stick is already installed here (container $CONTAINER): run this with --uninstall first"
fi

# The code goes in a header file, never on a command line another user could read.
umask 077
printf 'Authorization: Bearer %s\\n' "$CODE" >"$TMP/auth"
fetch() {
  curl -fsSL -H "@$TMP/auth" -o "$2" "$JM_SERVER_URL$1"
}

say "Downloading cosign $PLATFORM from $JM_SERVER_URL"
fetch "/install/cosign?platform=$PLATFORM" "$TMP/cosign" ||
  die "could not download cosign from $JM_SERVER_URL: is the code unused and less than 24 hours old?"
got=$(sha256sum "$TMP/cosign" | cut -d ' ' -f 1)
[ "$got" = "$COSIGN_SHA256" ] || die "the cosign the server sent is not the pinned ${COSIGN_VERSION} (sha256 $got)"
chmod 0700 "$TMP/cosign"

say "Downloading the stick image for $PLATFORM"
fetch "/install/stick-image.tar?platform=$PLATFORM" "$TMP/stick.tar" ||
  die "could not download the stick image from $JM_SERVER_URL: is the code unused and less than 24 hours old?"
mkdir "$TMP/layout"
tar -xf "$TMP/stick.tar" -C "$TMP/layout" || die "the stick image download is not a tar"

say "Verifying its signature offline"
if ! verified=$(HOME="$TMP" TUF_ROOT="$TMP/sigstore" "$TMP/cosign" verify --local-image --offline \\
  --insecure-ignore-tlog=false \\
  --certificate-identity-regexp "$IDENTITY_REGEXP" \\
  --certificate-oidc-issuer "$OIDC_ISSUER" \\
  --certificate-github-workflow-trigger push \\
  --certificate-github-workflow-repository "$SIGNER_REPOSITORY" \\
  --output json -- "$TMP/layout" 2>"$TMP/cosign.err"); then
  die "the stick image is not signed by $SIGNER_REPOSITORY's release workflow: $(tail -n 1 "$TMP/cosign.err")"
fi
digests=$(printf '%s' "$verified" | grep -o '"docker-manifest-digest": *"[^"]*"' | sed 's/.*"\\(sha256:[0-9a-f]*\\)"$/\\1/' || true)
[ -n "$digests" ] || die "cosign named no signed digest"
for d in $digests; do
  [ "$d" = "$STICK_DIGEST" ] || die "cosign verified $d, not $STICK_DIGEST"
done

loaded=$(docker load -i "$TMP/stick.tar") || die "docker load failed"
image=$(printf '%s\\n' "$loaded" | sed -n 's/^Loaded image ID: //p; s/^Loaded image: //p' | head -n 1)
[ -n "$image" ] || die "docker load named no image"
docker tag "$image" "$LOCAL_IMAGE" || die "could not tag the stick image"

docker volume create "$VOLUME" >/dev/null || die "could not create the volume $VOLUME"
mount=$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME")
[ -d "$mount" ] || die "the volume $VOLUME has no directory on this host ($mount)"
code_file="$mount/$(basename "$CODE_PATH")"
printf '%s\\n' "$CODE" >"$code_file"
chmod 0600 "$code_file"

docker run -d --name "$CONTAINER" --restart unless-stopped --read-only --tmpfs /tmp \\
  -v /var/run/docker.sock:/var/run/docker.sock -v "$VOLUME:/state" \\
  -e "JM_SERVER_URL=$JM_SERVER_URL" -e "JM_ENROLL_CODE_FILE=$CODE_PATH" \\
  -e JM_IMAGE_SOURCE=server -e JM_IMAGE_POLICY=signed \\
  "$LOCAL_IMAGE" >/dev/null || { rm -f "$code_file"; die "docker run failed"; }

say "Waiting for the stick to enroll"
i=0
while [ "$i" -lt "$WAIT_SECONDS" ]; do
  logs=$(docker logs "$CONTAINER" 2>&1 || true)
  name=$(printf '%s\\n' "$logs" | sed -n 's/^enrolled as \\(.*\\) (.*)$/\\1/p' | head -n 1)
  if [ -n "$name" ]; then
    rm -f "$code_file"
    say "Enrolled as $name. Back to your browser."
    exit 0
  fi
  failed=$(printf '%s\\n' "$logs" | grep 'enroll failed' | head -n 1 || true)
  if [ -n "$failed" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -f "$code_file"
    die "the stick could not enroll ($failed): make a new code on the sticks page"
  fi
  sleep 1
  i=$((i + 1))
done
die "the stick did not enroll within $WAIT_SECONDS seconds: see docker logs $CONTAINER"
`;
}
