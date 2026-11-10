#!/bin/sh
# Regenerates the synthetic test photos in tests/fixtures/ (needs ImageMagick
# and exiftool). Each image is drawn upright with a red square at the top left
# and a green square at the bottom right, so orientation is unambiguous. The
# "orient-N" files are then stored rotated, with EXIF orientation tag N, so a
# decoder that applies the tag shows them upright again.
set -eu
cd "$(dirname "$0")/../tests/fixtures"
FONT=${FONT:-/System/Library/Fonts/Supplemental/Arial.ttf}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

draw() { # name width height colour label
  magick -size "$2x$3" "gradient:$4-#202020" \
    -fill '#e02020' -draw "rectangle 0,0 59,59" \
    -fill '#20c040' -draw "rectangle $(($2 - 60)),$(($3 - 60)) $(($2 - 1)),$(($3 - 1))" \
    -font "$FONT" -fill white -gravity center -pointsize 28 -annotate 0 "$5" \
    -quality 85 "$1"
}

draw landscape.jpg 400 300 '#3060c0' 'LANDSCAPE 400x300'
draw portrait.jpg 300 400 '#a05020' 'PORTRAIT 300x400'
draw square.jpg 300 300 '#608020' 'SQUARE 300x300'

# Upright 300x400 shown after a 90 degree clockwise turn: stored 400x300.
draw $tmp/up-portrait.jpg 300 400 '#8030a0' 'ORIENT 6 shows 300x400'
magick $tmp/up-portrait.jpg -rotate -90 -quality 90 orient-6.jpg
exiftool -q -overwrite_original -n -Orientation=6 orient-6.jpg

draw $tmp/up-portrait8.jpg 300 400 '#a03060' 'ORIENT 8 shows 300x400'
magick $tmp/up-portrait8.jpg -rotate 90 -quality 90 orient-8.jpg
exiftool -q -overwrite_original -n -Orientation=8 orient-8.jpg

draw $tmp/up-land3.jpg 400 300 '#308080' 'ORIENT 3 shows 400x300'
magick $tmp/up-land3.jpg -rotate 180 -quality 90 orient-3.jpg
exiftool -q -overwrite_original -n -Orientation=3 orient-3.jpg

# Files the browser cannot decode.
printf 'This is not an image.\n' > not-an-image.txt
{ printf '\000\000\000\030ftypheic'; head -c 2048 /dev/zero; } > fake.heic
