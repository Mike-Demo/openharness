#!/usr/bin/env bash
# Publish the Windows pty payload that install.ps1 lays down in %USERPROFILE%\.harness\runtime\pty\<version>\.
# The payload is harness-pty.exe, harness-launch.exe, harness.exe (the `harness` command) and the ConPTY pair
# (conpty.dll, OpenConsole.exe). This script
# publishes:
#   - one zip per architecture, files at its root, under harness/pty/<version>/. These are immutable, like every
#     versioned artifact here: the CDN keeps the first bytes it saw.
#   - the `pty` key of a manifest. That is STAGING by default (harness/staging/pty/metadata.json), which the
#     staging install.ps1 reads.
# The production manifest (harness/pty/metadata.json) is the owner's step, once the staging E2E passes:
#   METADATA_PATH=harness/pty/metadata.json bash cli/scripts/publish-pty-payload.sh <version> <x64 dir> <arm64 dir>
# DRY_RUN=1 DRY_RUN_OUT=<dir> builds and checks the zips, writes them and the manifest into <dir>, and touches no bucket.
set -euo pipefail

VERSION="${1:-}"
X64_DIR="${2:-}"
ARM64_DIR="${3:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ -z "$X64_DIR" ] || [ -z "$ARM64_DIR" ]; then
  echo "usage: $0 <X.Y.Z> <win32-x64 payload dir> <win32-arm64 payload dir>" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
METADATA_PATH="${METADATA_PATH:-harness/staging/pty/metadata.json}"
DRY_RUN="${DRY_RUN:-0}"
[[ "$METADATA_PATH" =~ ^harness/[a-z0-9/_.-]+\.json$ ]] || { echo "error: METADATA_PATH '$METADATA_PATH' is not a manifest under harness/" >&2; exit 2; }
# The payload, as install.ps1 ($HarnessPtyFiles) checks it.
FILES=(harness-pty.exe harness-launch.exe harness.exe conpty.dll OpenConsole.exe)

for command in node python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf '{}' > "$WORK/entries.json"

for pair in "win32-x64=$X64_DIR" "win32-arm64=$ARM64_DIR"; do
  key="${pair%%=*}"
  dir="${pair#*=}"
  for file in "${FILES[@]}"; do
    [ -f "$dir/$file" ] || { echo "error: the $key payload in $dir has no $file" >&2; exit 1; }
  done
  zip="harness-pty-${VERSION}-${key}.zip"
  # Python's zipfile: the files at the zip's root, whatever OS this runs on (GNU tar cannot write zip).
  ( cd "$dir" && python3 -m zipfile -c "$WORK/$zip" "${FILES[@]}" )
  object="harness/pty/${VERSION}/${zip}"
  url="${CDN_ASSET_BASE_URL%/}/${object}"
  sha="$(sha256_of "$WORK/$zip")"
  size="$(wc -c < "$WORK/$zip" | tr -d ' ')"
  if [ "$DRY_RUN" != 1 ]; then
    if gcloud storage ls "gs://${GCS_BUCKET}/${object}" >/dev/null 2>&1; then
      echo "error: gs://${GCS_BUCKET}/${object} already exists. Versioned artifacts are immutable (the CDN keeps the first bytes); release a new version." >&2
      exit 1
    fi
    echo ">> uploading $zip ($size bytes)"
    gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$WORK/$zip" "gs://${GCS_BUCKET}/${object}"
  fi
  node "$ROOT/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "$key" "$VERSION" "$url" "$sha" "$size"
done

if [ "$DRY_RUN" = 1 ]; then
  printf '{}' > "$WORK/metadata.json"
elif ! gcloud storage cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" 2>/dev/null; then
  echo "   (no existing ${METADATA_PATH}: creating it)"
  printf '{}' > "$WORK/metadata.json"
fi
node "$ROOT/scripts/lib/runtimeManifest.mjs" platforms "$WORK/metadata.json" "$WORK/metadata.next.json" pty "$WORK/entries.json"

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the zips and the manifest}"
  mkdir -p "$out"
  cp "$WORK"/harness-pty-*.zip "$out/"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: zips and manifest in $out"
  exit 0
fi
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> published the pty payload $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
