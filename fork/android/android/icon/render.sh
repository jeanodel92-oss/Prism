#!/usr/bin/env bash
# Draws the launcher icon's layers (res/mipmap-*/ic_launcher_{foreground,background}.png) and the store icon
# (fastlane/metadata/android/en-US/images/icon.png) from the SVGs beside this script. The PNGs are versioned: run this
# after changing an SVG, with Fedora's ImageMagick (librsvg inside; prepare.sh of the window has the same note).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RES="$HERE/../res"
ROOT="$(cd "$HERE/../../../.." && pwd)"
declare -A sizes=([mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432)
for density in "${!sizes[@]}"; do
	size=${sizes[$density]}
	for layer in foreground background; do
		magick -background none -density 1200 "$HERE/ic_launcher_$layer.svg" -resize "${size}x$size" -strip \
			"PNG32:$RES/mipmap-$density/ic_launcher_$layer.png"
	done
done
# The store's icon: both layers, square, cropped to the middle 84 of
# the 108 dp, a little more than the 72 dp a launcher shows.
magick -background none -density 1200 "$HERE/ic_launcher_background.svg" -resize 658x658 \
	\( -background none -density 1200 "$HERE/ic_launcher_foreground.svg" -resize 658x658 \) \
	-composite -gravity center -crop 512x512+0+0 +repage -strip PNG32:"$ROOT/fastlane/metadata/android/en-US/images/icon.png"
