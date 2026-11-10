# Test fixture attribution

Files under `tests/fixtures/downloaded/` are fetched by `node scripts/fetch-fixtures.mjs`
(pinned by URL and sha256) and are not committed. Their sources and licenses:

| File | Source | License |
| --- | --- | --- |
| `librispeech-voices-sp0307-sg0042.wav` | LibriSpeech ASR corpus (Panayotov, Chen, Povey, Khudanpur, 2015; openslr.org/12), speaker 307, as redistributed in the VOiCES corpus source set (Lab41 / SRI International) and hosted by the PyTorch project at `download.pytorch.org/torchaudio/tutorial-assets/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav`. 3.4 s, 16 kHz mono WAV. Spoken text: "I had that curiosity beside me at this moment." | CC BY 4.0 (LibriSpeech and VOiCES are both CC BY 4.0). The underlying LibriVox recording is public domain. |
| `canon-eos-5d-mark-iii-14bit.dng` | raw.pixls.us, "Canon - EOS 5D Mark III - 14bit 14bit (2.3471882640587).dng" (file id 2204). | CC0 1.0 (public domain dedication) |

sha256:

- `librispeech-voices-sp0307-sg0042.wav`: `c65fcd726d6b08c82c1e5dc7558f863cd8d483e3ed2f4a7bcf271dc1865ada14`
- `canon-eos-5d-mark-iii-14bit.dng`: `1d77dcc6cdb839b10c1948f0b4471984ab48cf15e973fb77520584cee72b603e`

Why this speech clip: openslr.org distributes LibriSpeech only as multi-hundred-megabyte archives,
so a single utterance cannot be pinned there. The VOiCES "source" files are unmodified LibriSpeech
utterances and are published as individual files under the same license.
