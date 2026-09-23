# Color assets and algorithm provenance

Derived from spektrafilm by Andrea Volpato.
Source: https://github.com/andreavolpato/spektrafilm
Reference revision: 6cd00c8d4f30b5b550f50f4bbd3753c9f2a48507 (fixed development snapshot).

Model-derived lookup tables, film parameters and shared-table calibration data are licensed CC BY-SA 4.0. The complete upstream license is in SPEKTRAFILM_LICENSE.txt. Keep attribution, change notices and the license with redistributed or modified data. Processing a user photograph does not by itself incorporate these tables into that photograph.

Filmify modifications (2026-09-23): browser/WebGL2 adaptation; 20 film stocks and 118 film/print or direct-scan combinations; per-film raw tables and density curves; shared print tables with quadratic density pretransforms; a Velvia-based direct-scan table with cubic pretransforms; RGB16 values packed losslessly into paired RGB8 PNG pixels. The registries presets-mobile.js, presets-prints.js and presets-scans.js describe the shipped tables. manifest.json retains source metadata from earlier baking stages.

The mobile runtime implements tiled scatter, a lower-resolution linear additive halation field, spatial DIR with tiled short-range convolution and a lower-resolution long-tail field, calibrated density grain, scanner unsharp masking and a statistical print-glare approximation. Lens diffusion uses a bounded field with GPU FFT and CPU fallback. The application currently disables auto-exposure and defaults to CineBloom 1/8 diffusion. These approximations are not complete upstream parity or real-film-match certification. See docs/public-build.md, docs/public-runtime-status.md and docs/shared-lut-design.md for the current build and model boundaries.

The upstream simulator code is GPLv3. The native metering/resampling, film optics, DIR, grain and scanner algorithm adaptations are derived from that source; its code license is supplied in SPEKTRAFILM_CODE_LICENSE.txt. Filmify code is distributed under GPL-3.0-only (root LICENSE). The Python simulator remains a development dependency and is not bundled in the browser.

Libre Baskerville caption fonts are distributed under SIL OFL 1.1; their copyright and license are supplied in minitool/assets/caption-font-OFL.txt and embedded in the packaged page. Film stock and manufacturer names are trademarks of their respective owners and identify reference models only; no affiliation or endorsement is implied.

Interface artwork and the project-owned negative-preview LUT are separate from the spektrafilm-derived model tables. Their source and review status are recorded in ../docs/public-assets.md.
