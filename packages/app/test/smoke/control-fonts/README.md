# Linux type-proof control

These are test fixtures, never product assets. App smoke run 41972625803 on Tyler
rendered many native fallback glyphs as empty squares. A platform name alone does
not define a font environment, so Linux now compares a separately owned control
instead of comparing a sparse host's fonts with another host's snapshot. Native
fallback screenshots and Chromium's selected fonts remain attached as evidence;
they are not silently corrected or treated as a glyph-coverage pass.
The native toggle's width assertion runs without the control. Only Linux fallback
snapshot comparisons explicitly enable it. Successful runs retain native PNGs and
the font report under `test-results/app-smoke/`, plus the HTML report and its
attachments under the workflow's repo-root `playwright-report/` upload path.

The control aliases are `Orca Proof Sans`, `Orca Proof Mono` and `Orca Proof
Supplement`. They apply only in the smoke spec's explicit control mode. The dev
page's real fallback toggle, design tokens and product fonts are unchanged.
Bundled screenshots retain their existing baselines. Windows/macOS retain their
native fallback baselines. Linux control baselines have distinct names and must
be captured on Tyler, visually reviewed, and deliberately committed before the
new comparison can pass. No screenshot tolerance is increased.

DejaVu Sans/Mono 2.37 come from Debian `fonts-dejavu-core` 2.37-8. Their regular
and bold faces provide text, box drawing and twenty of the twenty-two declared
glyphs. The two remaining glyphs, U+23F8 and U+2442, come from the independently
pinned Noto Sans Symbols2 2.003 file in Debian `fonts-noto-core` 20201225-2. This
supplement contains only those two glyphs. It is not the product's subset, and no
product file is referenced or copied by the control. The manifest records source
and output SHA-256 values; the upstream license notices are included beside it.

`LICENSE-DejaVu.txt` is extracted from the pinned `DejaVuSans.ttf` copyright and
license records (OpenType name IDs 0 and 13), preserving the complete Bitstream
and Arev/Tavmjong Bah notices. Only trailing whitespace is normalized. The Debian
package copyright file alone is insufficient: it omits the Arev notice present
in both Sans source fonts. The subset retains copyright metadata but drops the
license record, so the complete accompanying notice must remain with the files.

To rebuild, place the five upstream TTFs named in `manifest.json` in a directory
and run `node tools/font-build/build-proof-control.js /path/to/ttfs`. Unexpected
source bytes are refused. The build uses the existing locked font-build tooling;
tests consume committed WOFF2s without fetching or installing fonts. Tests parse
the actual fonts to verify glyph coverage and independence from product subsets.
Chromium's font report must show only the control's custom fonts for every large,
sans and mono glyph sample; an accidental host-font dependency fails the proof.
