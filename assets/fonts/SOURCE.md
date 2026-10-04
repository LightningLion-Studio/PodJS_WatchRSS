# WatchRSS font sources

`watch_sans.ttf` is copied unchanged from Android WatchRSS
`app/src/main/res/font/watch_sans.ttf` (OPPO Sans 4.0 Regular). The Android
application theme references this file for normal, medium and semibold text.
It remains the default PodJS UI regular resource. Reader preset typography
uses the separate resources below so changing it does not replace other
screens' theme font.

The current bold resource is `reader_default_bold.ttf`, the OWW242 reader
profile assembled by `scripts/build-reader-bold-font.py`. Its Roboto Bold and
OPlusSans3 inputs, selected variation axis, preserved fallback coverage and
output hash are recorded in `reader-default-bold-provenance.json`. It is a
device-specific profile, not a universal Android font selection rule.

The older Noto subset files remain as earlier development artifacts and are
not selected by `pod.config.json`. Their accompanying Noto license applies to
those files, not to the copied watch fonts. Atlas rasterization, subpixel
positioning and scaled glyph geometry still require native visual validation.


`reader_default_regular.ttf` is the OWW242 reader profile built by
`scripts/build-reader-regular-font.py`: Roboto Regular takes precedence, with
OPlusSans3 at wght=550 for remaining CJK coverage and the original watch font
for compatibility characters. The current device fonts.xml selects those
weights; `reader-default-regular-provenance.json` records inputs and output.
The production Compose probe measures the same sample widths with its
resolved face and Typeface.DEFAULT; object equality is not used as proof of
font identity. The profile remains device-specific.

Application slots 33–36 use this regular face at 12/14/16/18 logical pixels;
slot 37 uses the existing bold profile at the exact default title size 21.7.
Their v4 atlases retain physical-pixel-rounded advances as fractional logical
values. Default UI slots continue using v3. Of twelve captured body/title
width samples, ten match exactly and both `A short line` samples differ by
one physical pixel. Per-codepoint widths do not model shaping or pair
kerning. Full-frame pixel comparisons remain nonidentical.
