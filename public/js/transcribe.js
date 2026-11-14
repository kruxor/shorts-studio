import { normalizeWordChunks } from './transcribe-shared.js';

export const MODELS = {
  // The public build ships base.en only: 77 MB of weights versus 242 MB for
  // small.en, and accuracy on English shorts did not justify the extra 242 MB
  // that every first-time visitor would have to download.
  'base.en': 'whisper-base.en',
};

let worker = null;
let pendingRequest = null;

function clearPending(instance) {
  if (pendingRequest?.worker !== instance) return null;
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

function failWorker(instance, message) {
  if (worker !== instance) return;
  worker = null;
  const request = clearPending(instance);
  instance.onmessage = null;
  instance.onerror = null;
  instance.onmessageerror = null;
  instance.terminate();
  request?.reject(new Error(message));
}

function createWorker() {
  if (worker) return worker;
  const instance = new Worker(new URL('./transcribe.worker.js', import.meta.url), { type: 'module' });
  worker = instance;

  instance.onmessage = ({ data }) => {
    if (worker !== instance || pendingRequest?.worker !== instance) return;
    if (data?.type === 'progress') {
      try { pendingRequest.onProgress?.(data.payload); } catch { /* progress observers must not break inference */ }
      return;
    }

    const request = clearPending(instance);
    if (!request) return;
    if (data?.type === 'error') {
      request.reject(new Error(data.message || 'Whisper worker reported an unknown error.'));
      return;
    }
    if (data?.type !== 'result') {
      request.reject(new Error('Whisper worker returned an invalid response.'));
      return;
    }

    try {
      const result = data;
      const words = normalizeWordChunks(result);
      request.resolve({ words, text: String(result?.text ?? words.map((word) => word.text).join(' ')).trim() });
    } catch (error) {
      request.reject(error);
    }
  };

  instance.onerror = (event) => {
    event.preventDefault?.();
    const cause = event.error?.message || event.error?.stack || event.message || '';
    const location = event.filename ? ` at ${event.filename}:${event.lineno || 0}:${event.colno || 0}` : '';
    // A module worker that cannot fetch its imports reports an error event with
    // no message at all, so say what is actually actionable in that case.
    failWorker(instance, cause
      ? `Whisper worker crashed: ${cause}${location}`
      : `The transcription engine could not load${location}. Check your connection and reload the page.`);
  };
  instance.onmessageerror = () => {
    failWorker(instance, 'Whisper worker response could not be deserialized.');
  };
  return instance;
}

export async function unloadModels() {
  const instance = worker;
  if (!instance) return 0;

  worker = null;
  const request = clearPending(instance);
  instance.onmessage = null;
  instance.onerror = null;
  instance.onmessageerror = null;
  instance.terminate();
  request?.reject(new Error('Whisper worker was terminated while transcription was in progress.'));
  return 1;
}

export async function transcribeAudio(samples, { model = 'base.en', onProgress } = {}) {
  if (pendingRequest) {
    throw new Error('A Whisper transcription is already in progress. Wait for it to finish before starting another.');
  }
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('Whisper input must be a non-empty Float32Array of 16 kHz mono samples.');
  }
  if (!Object.hasOwn(MODELS, model)) {
    throw new Error(`Unknown Whisper model "${model}". Choose "base.en".`);
  }

  const instance = createWorker();
  const isTransferableBuffer = samples.buffer instanceof ArrayBuffer;
  const sampleBuffer = isTransferableBuffer && samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength
    ? samples.buffer
    : samples.slice().buffer;

  return new Promise((resolve, reject) => {
    pendingRequest = { worker: instance, onProgress, resolve, reject };
    try {
      instance.postMessage({ type: 'transcribe', model, samples: sampleBuffer }, [sampleBuffer]);
    } catch (error) {
      clearPending(instance);
      reject(new Error(`Could not send audio to the Whisper worker: ${error?.message || String(error)}`));
    }
  });
}
