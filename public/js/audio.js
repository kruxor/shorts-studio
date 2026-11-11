const TARGET_SAMPLE_RATE = 16_000;

/** Decode, downmix, then explicitly resample user-provided audio to Whisper's 16 kHz mono input. */
export async function extractAudio(file, { onProgress } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('Choose a readable audio or video file first.');
  }

  let context;
  try {
    onProgress?.({ stage: 'audio-decode', progress: 0 });
    const encoded = await file.arrayBuffer();
    if (!encoded.byteLength) throw new Error('The selected media file is empty.');

    context = new AudioContext();
    let decoded;
    try {
      decoded = await context.decodeAudioData(encoded.slice(0));
    } catch (error) {
      throw new Error(`Could not decode this audio format. Choose a browser-supported audio/video file (for example, MP3, WAV, or MP4 with AAC audio).${error?.message ? ` Details: ${error.message}` : ''}`);
    }

    const sourceRate = Number(decoded.sampleRate);
    const frameCount = Number(decoded.length);
    const channelCount = Math.max(1, Number(decoded.numberOfChannels) || 1);
    if (!(sourceRate > 0) || !(frameCount > 0)) {
      throw new Error('The decoded audio has no usable samples or sample rate.');
    }

    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let index = 0; index < frameCount; index += 1) mono[index] += data[index] / channelCount;
    }

    const outputLength = Math.max(1, Math.round(frameCount * TARGET_SAMPLE_RATE / sourceRate));
    const samples = new Float32Array(outputLength);
    if (sourceRate === TARGET_SAMPLE_RATE) {
      samples.set(mono.subarray(0, outputLength));
    } else {
      const lastInputIndex = Math.max(0, frameCount - 1);
      for (let index = 0; index < outputLength; index += 1) {
        const sourcePosition = Math.min(lastInputIndex, index * sourceRate / TARGET_SAMPLE_RATE);
        const left = Math.floor(sourcePosition);
        const right = Math.min(lastInputIndex, left + 1);
        const fraction = sourcePosition - left;
        samples[index] = mono[left] * (1 - fraction) + mono[right] * fraction;
      }
    }

    const duration = frameCount / sourceRate;
    onProgress?.({ stage: 'audio-decode', progress: 1 });
    return { samples, duration };
  } catch (error) {
    if (error instanceof TypeError || error instanceof Error) throw error;
    throw new Error(`Audio extraction failed: ${String(error)}`);
  } finally {
    if (context && context.state !== 'closed') {
      try { await context.close(); } catch { /* Closing is best-effort after decoding. */ }
    }
  }
}
