#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/common.sh"

architecture="${SAKURA_ARCH:-native}"
if [[ "${1:-}" == --help ]]; then
    printf 'Usage: %s [--arch native|arm64|x86_64|universal]\n' "$0"
    exit 0
fi
if [[ $# -gt 0 ]]; then
    [[ $# -eq 2 && "$1" == --arch ]] || fail "Use --help for build options."
    architecture="$2"
fi
require_macos
python3 "$MACOS_DIR/scripts/configure.py" validate
case "$architecture" in
    native) architectures=("$(uname -m)") ;;
    arm64|x86_64) architectures=("$architecture") ;;
    universal) architectures=(arm64 x86_64) ;;
    *) fail "Architecture must be native, arm64, x86_64 or universal." ;;
esac

output_dir="${SAKURA_OUTPUT_DIR:-$MACOS_DIR/dist}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
stage="$(mktemp -d "$output_dir/.sakura-build.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app="$stage/Sakura.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
binaries=()
first_bin=""
first_scratch=""
for arch in "${architectures[@]}"; do
    scratch="$MACOS_DIR/.build/package-$arch"
    printf 'Building Sakura for %s…\n' "$arch"
    swift build --package-path "$MACOS_DIR" --scratch-path "$scratch" --configuration release --product SakuraMac --arch "$arch"
    bin="$(swift build --package-path "$MACOS_DIR" --scratch-path "$scratch" --configuration release --arch "$arch" --show-bin-path)"
    binaries+=("$bin/SakuraMac")
    if [[ -z "$first_bin" ]]; then first_bin="$bin"; first_scratch="$scratch"; fi
done
if [[ ${#binaries[@]} -eq 1 ]]; then
    ditto "${binaries[0]}" "$app/Contents/MacOS/SakuraMac"
else
    lipo -create "${binaries[@]}" -output "$app/Contents/MacOS/SakuraMac"
fi
chmod 755 "$app/Contents/MacOS/SakuraMac"
verify_architectures() {
    local binary="$1" expected
    for expected in "${architectures[@]}"; do
        lipo -verify_arch "$expected" "$binary" || return 1
    done
}
verify_architectures "$app/Contents/MacOS/SakuraMac"

# SwiftPM's binary-artifact path contains a version-dependent XCFramework slice.
# Select a framework that actually contains every requested architecture.
framework=""
while IFS= read -r candidate; do
    if verify_architectures "$candidate/Sparkle" 2>/dev/null; then
        framework="$candidate"
        break
    fi
done < <(find "$first_scratch/artifacts" -type d -name Sparkle.framework)
[[ -n "$framework" ]] || fail "SwiftPM did not provide a matching Sparkle.framework."
ditto "$framework" "$app/Contents/Frameworks/Sparkle.framework"
sparkle_license="$(dirname "$(dirname "$(dirname "$framework")")")/LICENSE"
[[ -f "$sparkle_license" ]] || fail "Sparkle's distribution license was not found."
ditto "$sparkle_license" "$app/Contents/Resources/Sparkle-LICENSE.txt"
while IFS= read -r -d '' resource; do
    ditto "$resource" "$app/Contents/Resources/$(basename "$resource")"
done < <(find "$first_bin" -maxdepth 1 -type d \( -name '*.bundle' -o -name '*.resources' \) -print0)

python3 "$MACOS_DIR/scripts/configure.py" configure "$MACOS_DIR/Config/Info.plist" "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist" >/dev/null
iconset="$stage/Sakura.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$REPO_DIR/sakura-mobile/assets/images/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    retina=$((size * 2))
    sips -z "$retina" "$retina" "$REPO_DIR/sakura-mobile/assets/images/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Sakura.icns"

sign_app "$app" -
# Execute the actual packaged image before touching the existing installation.
# This catches dyld/framework loading failures that codesign --verify cannot.
# Cross-only builds require host execution support; universal builds run natively.
if ! "$app/Contents/MacOS/SakuraMac" --check-bundle; then
    fail "The packaged app failed its bundle smoke check. For cross-architecture builds, use --arch universal or install the required host execution support."
fi
destination="$output_dir/Sakura.app"
if [[ -e "$destination" ]]; then
    # Only replace a previous Sakura package, never an arbitrary directory.
    [[ -f "$destination/Contents/Info.plist" ]] || fail "Output path exists and is not an application bundle."
    identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist")"
    [[ "$identifier" == com.sakura.mac ]] || fail "Output path belongs to another application."
    rm -rf "$destination"
fi
mv "$app" "$destination"
printf 'Built local application: %s\n' "$destination"
printf 'This ad-hoc build is for local testing. Use scripts/release.sh for distributable updates.\n'
