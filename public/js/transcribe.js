import { pipeline, env } from '../vendor/transformers/transformers.web.js';

export const MODELS = {
  'base.en': 'whisper-base.en',
  'small.en': 'whisper-small.en',
};

// Transformers and ONNX Runtime must use only assets shipped with this static app.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = './models/';
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;

const REQUIRED_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'preprocessor_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

async function assertLocalModelFiles(modelDirectory) {
  for (const relativePath of REQUIRED_MODEL_FILES) {
    const modelUrl = new URL(`../models/${modelDirectory}/${relativePath}`, import.meta.url);
    let response;
    try {
      response = await fetch(modelUrl, { method: 'HEAD', cache: 'no-store' });
    } catch (error) {
      throw new Error(`Unable to check local Whisper model file "models/${modelDirectory}/${relativePath}". Serve the app over HTTP and confirm that file exists. ${error?.message || ''}`.trim());
    }
    if (!response.ok) {
      throw new Error(`Required local Whisper model file is missing: models/${modelDirectory}/${relativePath} (HTTP ${response.status}).`);
    }
  }
}

function normalizeWordChunks(result) {
  const candidates = Array.isArray(result?.words)
    ? result.words
    : (Array.isArray(result?.chunks) ? result.chunks : null);
  if (!candidates?.length) {
    throw new Error('Whisper did not return word-level timestamps (no words[] or timestamped chunks were returned).');
  }

  const words = candidates.map((item) => {
    const text = String(item?.text ?? '').trim();
    const start = Number(item?.start ?? item?.timestamp?.[0]);
    const end = Number(item?.end ?? item?.timestamp?.[1]);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error('Whisper returned incomplete word timestamps; expected one word with a finite start and end time per item.');
    }
    if (text.split(/\s+/u).length > 1) {
      throw new Error('Whisper returned chunk-level timestamps instead of word-level timestamps. Confirm the local model supports return_timestamps: "word".');
    }
    return { text, start, end };
  });

  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('Whisper did not return a non-empty words[] array.');
  }
  return words;
}

export async function transcribeAudio(samples, { model = 'base.en', onProgress } = {}) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('Whisper input must be a non-empty Float32Array of 16 kHz mono samples.');
  }
  if (!Object.hasOwn(MODELS, model)) {
    throw new Error(`Unknown Whisper model "${model}". Choose "base.en" or "small.en".`);
  }

  const modelDirectory = MODELS[model];
  onProgress?.({ stage: 'model-check', progress: 0 });
  await assertLocalModelFiles(modelDirectory);
  onProgress?.({ stage: 'model-check', progress: 1 });

  let recognizer = transcribeAudio._recognizers?.get(model);
  if (!recognizer) {
    onProgress?.({ stage: 'model-load', progress: 0 });
    const onModelProgress = (event) => onProgress?.({ stage: 'model-load', ...event });
    recognizer = await pipeline('automatic-speech-recognition', modelDirectory, {
      dtype: 'q8',
      progress_callback: onModelProgress,
    });
    if (!transcribeAudio._recognizers) transcribeAudio._recognizers = new Map();
    transcribeAudio._recognizers.set(model, recognizer);
    onProgress?.({ stage: 'model-load', progress: 1 });
  }

  onProgress?.({ stage: 'transcription', progress: 0 });
  const result = await recognizer(samples, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
    progress_callback: (event) => onProgress?.({ stage: 'transcription', ...event }),
  });
  const words = normalizeWordChunks(result);
  onProgress?.({ stage: 'transcription', progress: 1 });
  return { words, text: String(result?.text ?? words.map((word) => word.text).join(' ')).trim() };
}
