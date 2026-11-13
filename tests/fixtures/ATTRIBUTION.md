# Test fixture attribution

Files under `tests/fixtures/downloaded/` are fetched by `node scripts/fetch-fixtures.mjs`
(pinned by URL and sha256) and are not committed. Their sources and licenses:

| File | Source | License |
| --- | --- | --- |
| `librispeech-voices-sp0307-sg0042.wav` | LibriSpeech ASR corpus (Panayotov, Chen, Povey, Khudanpur, 2015; openslr.org/12), speaker 307, as redistributed in the VOiCES corpus source set (Lab41 / SRI International) and hosted by the PyTorch project at `download.pytorch.org/torchaudio/tutorial-assets/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav`. 3.4 s, 16 kHz mono WAV. Spoken text: "I had that curiosity beside me at this moment." | CC BY 4.0 (LibriSpeech and VOiCES are both CC BY 4.0). The underlying LibriVox recording is public domain. |
| `canon-eos-5d-mark-iii-14bit.dng` | raw.pixls.us, "Canon - EOS 5D Mark III - 14bit 14bit (2.3471882640587).dng" (file id 2204). | CC0 1.0 (public domain dedication) |
| `canon-eos-r6-craw-crop.cr3` | raw.pixls.us, "Canon - EOS R6 - 3:2.CR3", mode "CRAW 1.6x crop", contributed 2021-05-14 (file id 4659, 5.03 MB). The smallest CC0 CR3 in the repository listing (`raw.pixls.us/json/getrepository.php`). | CC0 1.0 (public domain dedication) |

sha256:

- `librispeech-voices-sp0307-sg0042.wav`: `c65fcd726d6b08c82c1e5dc7558f863cd8d483e3ed2f4a7bcf271dc1865ada14`
- `canon-eos-5d-mark-iii-14bit.dng`: `1d77dcc6cdb839b10c1948f0b4471984ab48cf15e973fb77520584cee72b603e`
- `canon-eos-r6-craw-crop.cr3`: `74abb0a113d075ad9887a058082f40dd2a938c4813a08474d82356f11a027778` (matches the checksum raw.pixls.us publishes for the file)

Why this speech clip: openslr.org distributes LibriSpeech only as multi-hundred-megabyte archives,
so a single utterance cannot be pinned there. The VOiCES "source" files are unmodified LibriSpeech
utterances and are published as individual files under the same license.

Fixtures under `tests/fixtures/generated/` (and the temporary copies the tests make) are built by
`node tests/fixtures/generate.mjs` from code in this repository (pdf-lib, a small ZIP writer,
exiftool); they contain only invented text and are not committed. There is no HEIC fixture: no
CC0 HEIC is available from a pinned source, and none can be generated with the project's tools
(ImageMagick/ffmpeg here cannot write HEIF), so the camera tests use the generated TIFF (iPhone-style
EXIF written by exiftool) and the downloaded DNG and CR3.

`tests/fixtures/pdf/password-protected.pdf` (committed; Task R6) is a one-page PDF of invented text
made once from `buildPdf()` of `tests/fixtures/generate.mjs` and encrypted with Ghostscript 10.02.1
(`gs -dSAFER -sDEVICE=pdfwrite -dEmbedAllFonts=false -sOwnerPassword=ao-fixture-owner
-sUserPassword=ao-fixture -dEncryptionR=3 -dKeyLength=128 -dPermissions=-4`): RC4 128-bit, user
password `ao-fixture`, no embedded fonts. Our own work, no third-party content. sha256
`2d50ec3424f216f288c7776bce71861b70d2f5588cbac4ee36ae448de7c0d0c3`.
