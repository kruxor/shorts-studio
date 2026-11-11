#!/usr/bin/env bash
# Fetch Whisper ONNX weights for Shorts Studio.
#
# IMPORTANT: word-level timestamps in transformers.js require the decoder to
# expose cross-attention outputs (output_attentions=True in the export).
# The Xenova/* repos have them (48 for base.en). The openai/whisper-* exports
# do NOT, and fail with:
#   "Model outputs must contain cross attentions to extract timestamps."
#
# Weights are large (~320 MB) so they are gitignored; run this after cloning.
set -euo pipefail

DEST="${1:-public/models}"
cd "$(dirname "$0")/.."

FILES=(
  config.json generation_config.json preprocessor_config.json
  tokenizer.json tokenizer_config.json special_tokens_map.json
  normalizer.json added_tokens.json merges.txt vocab.json
  onnx/encoder_model_quantized.onnx
  onnx/decoder_model_merged_quantized.onnx
)

fetch_model() {
  local repo="$1" dir="$2"
  mkdir -p "$DEST/$dir/onnx"
  for f in "${FILES[@]}"; do
    if [[ -s "$DEST/$dir/$f" ]]; then continue; fi
    echo "  $repo/$f"
    curl -sSL --retry 3 --retry-delay 2 -o "$DEST/$dir/$f" \
      "https://huggingface.co/$repo/resolve/main/$f"
  done
  # Note: `strings ... | grep -q` under `pipefail` gives a false negative —
  # grep -q exits early, strings dies of SIGPIPE, and the pipeline reports
  # failure. Count matches instead.
  local decoder="$DEST/$dir/onnx/decoder_model_merged_quantized.onnx"
  local cross_attn
  cross_attn=$(strings "$decoder" | grep -c cross_attentions || true)
  if [[ "${cross_attn:-0}" -eq 0 ]]; then
    echo "ERROR: $dir decoder has no cross-attention outputs; word timestamps would fail." >&2
    return 1
  fi
  echo "  ok: $dir (cross-attentions present: $cross_attn)"
}

echo "Fetching Whisper models into $DEST"
fetch_model "Xenova/whisper-base.en"  "whisper-base.en"
# The served build ships base.en only (77 MB). small.en is 242 MB, so it is
# opt-in for local experiments: FETCH_SMALL=1 ./scripts/fetch-models.sh
# Re-adding it to the app also means re-adding it to MODELS in transcribe.js.
if [ "${FETCH_SMALL:-0}" = "1" ]; then
  fetch_model "Xenova/whisper-small.en" "whisper-small.en"
fi
echo "Done."
