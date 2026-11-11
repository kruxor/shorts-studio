# Shorts Studio

Browser-only caption tool for short-form video. Drop an MP4, get word-timed
captions, edit and style them, preview live, render the captioned video, and
download it. **Nothing is uploaded.** There is no backend, no database, no
account, and no video ever leaves the machine.

## Why this exists

The previous internal tool (workbench `ShortsStudio` module) was good but needed
a Python/Whisper worker running on one specific PC, plus FFmpeg+libass for
rendering. That meant: a worker to rebuild after any PC change, a server that
could not transcribe without a GPU (the homelab has none), and hosting costs
that scale with every render.

This version pushes both halves into the browser, which removes all three.

## Architecture

```
audio.js       decodeAudioData -> downmix to mono -> resample 16 kHz
                (decodeAudioData is NOT a resampler; this resamples explicitly)

transcribe.js  @huggingface/transformers Whisper, weights served locally,
                return_timestamps: 'word' -> words[{text,start,end}]

captions.js    ported grouping rules: min/max words, max chars,
                pause_split, sentence-punctuation splits
style.js       ported style defaults + clamps (24-180 font size, etc.)
alignment.js   edit transcript text without losing word timings
presets.js     IndexedDB presets + JSON export/import

app.js         one drawCaptionLayer() used by BOTH preview and render
               whole-transcript (paragraph) editor: edit the text, then
                 replaceTranscriptText() re-aligns the existing timings
render.js      mp4box demux -> VideoDecoder -> canvas -> VideoEncoder
                (avc1.640028) -> mp4-muxer -> Blob -> download
                ONE streaming pass with backpressure (max 6 frames in flight),
                so memory stays flat regardless of source length or resolution.
                Frames are quantised onto the output fps grid, which preserves
                duration for any input rate (24/25/30/60fps).
```

Preview and export share the same canvas drawing function on purpose. The old
tool had a CSS preview and a separate libass renderer, which drift apart and
produce styling bugs that cannot be reproduced.

## Running it

Rendering requires a **secure context**, because WebCodecs is secure-context
only. `http://localhost` and HTTPS qualify; `http://<hostname>.local` and plain
HTTP on a LAN IP do **not**, and `VideoEncoder` will be `undefined` there.

```bash
# development (secure context via localhost)
python3 -m http.server 8099 -d public
# open http://localhost:8099/

# or the local vhost, which has a self-signed cert on 7443
#   https://shorts-studio.local:7443   (accept the warning once)
# 443 and 8443 are already taken by tailscaled on this host.
```

Deploy by copying `public/` behind HTTPS. There is no build step.

## Models

Whisper weights are gitignored (320 MB) and reproducible:

```bash
./scripts/fetch-models.sh
```

The script fetches from the `Xenova/*` repos specifically, and fails loudly if
the decoder has no cross-attention outputs. This matters: the `openai/whisper-*`
ONNX re-exports lack them, and word-level timestamps fail with
`Model outputs must contain cross attentions to extract timestamps.`

## Verified

Measured on a 4-core CPU box, headless Chromium 1254, 24-second 1080x1920
30 fps H.264/AAC fixture containing speech:

| Check | Result |
|---|---|
| In-browser transcription | 53 words, word-level timestamps confirmed |
| Caption grouping | 21 groups in the editor |
| Whole-transcript editor | prefilled with 53 words; inserting a word reported "1 word changed and re-aligned" and rebuilt groups |
| Invalid transcript edit | inline error, typed text preserved, captions still rendered |
| Bundled fonts | all 4 families load (`document.fonts.check` true) |
| Console / page errors | 0 |
| Render | completed, download produced |
| Output format | H.264 1080x1920 30 fps + AAC 44.1 kHz mono, 24.02 s |
| Captions actually burned in | caption band 4.42% pixels changed vs 0.00% in a control band |
| Logic tests (`node --test`) | 18/18 pass |
| Caption hold | a line stays up until the next line starts; no blank gaps |
| 4K render (2160x3840, 720 frames, 24s) | 28.5s wall clock, 26 fps throughput, peak browser RSS 2.88 GB and flat |
| 24fps source | output duration 24.000s — duration and caption sync preserved |
| Render progress | label advances with frames done/total, fps and ETA |

## Not verified

- Output frame pacing: timestamps sit on the 1/30 s grid, so a 24fps source
  produces slightly uneven spacing. Duration and caption sync are exact, but
  the stream is not strictly constant-frame-rate for sub-30fps inputs.
- **Speed on other hardware.** The test box has no GPU; these numbers are a
  software-only floor. A weak laptop may be slower, a GPU machine faster.
- **iOS Safari.** WebCodecs encoder support is the weakest link there. Unproven.
- **Containers other than MP4/H.264+AAC.** MOV/HEVC is detected and rejected
  with an explanation rather than handled.
- Audio is AAC passthrough, never re-encoded. A non-AAC audio track is rejected
  by design (re-encoding audio in the browser is a separate project).

## Tests

```bash
node --test                     # logic: grouping, clamps, preset round-trip
E2E_URL=http://localhost:8099/ node tests/e2e/shorts-studio.mjs
```

The E2E script needs `tests/fixtures/shorts-studio-speech-test.mp4` (a short
MP4 with real speech) and a Chromium binary at the path set in
`CHROMIUM_EXECUTABLE_PATH`.
