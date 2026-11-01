#!/bin/bash
# Prepare a signed, notarized app and update feed locally. Does not publish.
set -euo pipefail
source "$(dirname "$0")/common.sh"
[[ $# -eq 0 ]] || fail "Configure release.sh with the environment variables documented in macos/README.md."
require_macos
python3 "$MACOS_DIR/scripts/configure.py" validate --release

# Require a usable local identity before doing any build or notarization work.
identities="$(security find-identity -v -p codesigning)"
[[ "$identities" == *"\"$SAKURA_SIGNING_IDENTITY\""* ]] || fail "The configured Developer ID Application identity is not available in Keychain."
unset identities
if [[ -n "${SAKURA_RELEASE_NOTES_FILE:-}" ]]; then
    [[ -f "$SAKURA_RELEASE_NOTES_FILE" ]] || fail "Release notes file does not exist."
    case "$SAKURA_RELEASE_NOTES_FILE" in
        *.md) notes_extension=md ;;
        *.html) notes_extension=html ;;
        *) fail "Release notes must be a Markdown or HTML file." ;;
    esac
fi

release_dir="${SAKURA_OUTPUT_DIR:-$MACOS_DIR/dist/releases/$SAKURA_VERSION-$SAKURA_BUILD_NUMBER}"
[[ ! -e "$release_dir" ]] || fail "Release directory already exists. Use a new build number or a fresh output path."
mkdir -p "$release_dir"
export SAKURA_OUTPUT_DIR="$(cd "$release_dir" && pwd)"
export SAKURA_ARCH="${SAKURA_ARCH:-universal}"
"$MACOS_DIR/scripts/build-app.sh"
app="$SAKURA_OUTPUT_DIR/Sakura.app"
sign_app "$app" "$SAKURA_SIGNING_IDENTITY"
"$app/Contents/MacOS/SakuraMac" --check-bundle

notary_zip="$SAKURA_OUTPUT_DIR/.notary-submission.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$notary_zip"
# Credentials remain in Keychain; profile is a reference, never a password.
printf 'Submitting to Apple for notarization…\n'
xcrun notarytool submit "$notary_zip" --keychain-profile "$SAKURA_NOTARY_PROFILE" --wait \
    --output-format json > "$SAKURA_OUTPUT_DIR/notarization.json"
python3 - "$SAKURA_OUTPUT_DIR/notarization.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as handle:
    result = json.load(handle)
if result.get("status") != "Accepted":
    raise SystemExit("Error: Apple has not accepted this notarization submission. No update archive was prepared.")
print("Apple accepted notarization.")
PY
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict "$app"
spctl --assess --type execute "$app"
rm "$notary_zip"

updates="$SAKURA_OUTPUT_DIR/.updates-staging"
mkdir -p "$updates"
archive="$updates/Sakura-$SAKURA_VERSION-$SAKURA_BUILD_NUMBER.zip"
# Sparkle signs the final archive after notarization and stapling.
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
if [[ -n "${SAKURA_RELEASE_NOTES_FILE:-}" ]]; then
    cp "$SAKURA_RELEASE_NOTES_FILE" "${archive%.zip}.$notes_extension"
fi

generator=""
case "$SAKURA_ARCH" in
    universal) tool_arch=arm64 ;;
    native) tool_arch="$(uname -m)" ;;
    *) tool_arch="$SAKURA_ARCH" ;;
esac
while IFS= read -r candidate; do
    if [[ -x "$candidate" ]]; then generator="$candidate"; break; fi
done < <(find "$MACOS_DIR/.build/package-$tool_arch/artifacts" -path '*/bin/generate_appcast' -type f)
[[ -n "$generator" ]] || fail "Cannot find Sparkle's generate_appcast tool in the resolved SwiftPM artifact."
feed="$updates/appcast.xml"
"$generator" --account "$SAKURA_SPARKLE_KEYCHAIN_ACCOUNT" \
    --download-url-prefix "${SAKURA_UPDATE_DOWNLOAD_BASE_URL%/}/" \
    --release-notes-url-prefix "${SAKURA_UPDATE_DOWNLOAD_BASE_URL%/}/" \
    --maximum-deltas 0 -o "$feed" "$updates"
swift "$MACOS_DIR/scripts/verify-update.swift" "$feed" "$archive" "$app" "$SAKURA_UPDATE_DOWNLOAD_BASE_URL"
"$(dirname "$generator")/sign_update" --account "$SAKURA_SPARKLE_KEYCHAIN_ACCOUNT" --verify "$feed"
(cd "$updates" && shasum -a 256 "$(basename "$archive")" > SHA256SUMS)
mv "$updates" "$SAKURA_OUTPUT_DIR/updates"
printf '\nRelease prepared and verified locally: %s\n' "$SAKURA_OUTPUT_DIR"
printf 'Nothing was published. Review the app and publish the contents of updates/ only after release approval.\n'
printf 'Serve appcast.xml at the exact configured SAKURA_UPDATE_FEED_URL; preserve the archive URL.\n'
