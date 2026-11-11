# Third-party components

Shorts Studio is MIT licensed (see `LICENSE`). It ships other people's code and
weights, vendored into `public/vendor/` and `public/models/` so the app works
offline and never calls a CDN at runtime. Those files keep their own licences.

| Component | Version | Licence | Where |
|---|---|---|---|
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | 3.7.x | Apache-2.0 | `public/vendor/transformers/` |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | bundled with the above | MIT | `public/vendor/ort/` |
| [mp4box.js](https://github.com/gpac/mp4box.js) | — | BSD-3-Clause | `public/vendor/mp4box.all.js` |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | — | MIT | `public/vendor/mp4-muxer.mjs` |
| [Whisper](https://github.com/openai/whisper) weights, `whisper-base.en` (ONNX export by [Xenova](https://huggingface.co/Xenova/whisper-base.en)) | — | MIT (OpenAI) | `public/models/whisper-base.en/` |
| [Montserrat](https://github.com/JulietaUla/Montserrat) ExtraBold | — | SIL OFL 1.1 | `public/assets/fonts/` + `Montserrat-OFL.txt` |
| [Anton](https://fonts.google.com/specimen/Anton) | — | SIL OFL 1.1 | `public/assets/fonts/` + `Anton-OFL.txt` |
| [Bebas Neue](https://fonts.google.com/specimen/Bebas+Neue) | — | SIL OFL 1.1 | `public/assets/fonts/` + `BebasNeue-OFL.txt` |
| [Archivo Black](https://fonts.google.com/specimen/Archivo+Black) | — | SIL OFL 1.1 | `public/assets/fonts/` + `ArchivoBlack-OFL.txt` |

The font licence texts ship next to the fonts, which is what OFL 1.1 requires
when you redistribute the files. Whisper weights are not in git — fetch them
with `scripts/fetch-models.sh`, which pulls the unmodified Xenova ONNX export.
