# test/ocr-v193 — OCR-derived tests

Mirrors `src/ocr-v193`. Each file preserves the pinned OCR v1.9.3
`Test*` name in a comment and in the reference manifest so omissions are
searchable. No paid/network model calls. Pi interactions use the scripted
transcript seam (`src/ocr-v193/pi-adapter`).

## Porting rule

These tests drive day-to-day implementation and regression debugging. They do
not replace the recovery plan's acceptance gates; black-box positive and
negative fixtures remain required before a behavior family can be called
verified:

1. Start with the corresponding test in
   `../open-code-review` at commit
   `c35ddd7223f2b5540ce03aa43c9a25ef643fca27`.
2. Preserve its setup, behavior, and assertion strength.
3. Adapt only Go/runtime seams, using typed local fakes instead of Pi or
   network calls.
4. Record any weakened assertion in the manifest; do not silently broaden it.
5. Add or update the installed-process black-box positive and negative
   fixtures required by the active recovery-plan gate.

The black-box verifiers are acceptance evidence, not the place to rediscover
the review engine's internal behavior.
