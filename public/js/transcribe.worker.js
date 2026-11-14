import { pipeline, env } from '../vendor/transformers/transformers.web.js';
import { normalizeWordChunks } from './transcribe-shared.js';

// Transformers and ONNX Runtime must use only assets shipped with this static app.
env.allowRemoteModels = false;
env.allowLocalModels = true;
// Resolve the page's ./models/ directory from this worker's /js/ location.
env.localModelPath = new URL('../models/', import.meta.url).href;
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;

const MODELS = {
  'base.en': 'whisper-base.en',
};
const REQUIRED_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'preprocessor_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const recognizers = new Map();

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

function sendProgress(payload) {
  self.postMessage({ type: 'progress', payload });
}

self.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'transcribe') return;

  try {
    const { model, samples: sampleBuffer } = data;
    if (!Object.hasOwn(MODELS, model)) {
      throw new Error(`Unknown Whisper model "${model}". Choose "base.en".`);
    }
    if (!(sampleBuffer instanceof ArrayBuffer) || sampleBuffer.byteLength === 0 || sampleBuffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new TypeError('Whisper input must be a non-empty Float32Array of 16 kHz mono samples.');
    }

    const modelDirectory = MODELS[model];
    sendProgress({ stage: 'model-check', progress: 0 });
    await assertLocalModelFiles(modelDirectory);
    sendProgress({ stage: 'model-check', progress: 1 });

    let recognizer = recognizers.get(model);
    if (!recognizer) {
      sendProgress({ stage: 'model-load', progress: 0 });
      recognizer = await pipeline('automatic-speech-recognition', modelDirectory, {
        dtype: 'q8',
        progress_callback: (event) => sendProgress({ ...event, stage: 'model-load' }),
      });
      recognizers.set(model, recognizer);
      sendProgress({ stage: 'model-load', progress: 1 });
    }

    sendProgress({ stage: 'transcription', progress: 0 });
    const result = await recognizer(new Float32Array(sampleBuffer), {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      progress_callback: (event) => sendProgress({ ...event, stage: 'transcription' }),
    });
    const words = normalizeWordChunks(result);
    sendProgress({ stage: 'transcription', progress: 1 });
    self.postMessage({
      type: 'result',
      words,
      text: String(result?.text ?? words.map((word) => word.text).join(' ')).trim(),
    });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
});
