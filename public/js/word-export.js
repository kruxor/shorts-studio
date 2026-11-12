// Word-timing export for external caption tooling.
//
// The schema is fixed by a consumer script that already reads it ("Video Caption
// Popover"), so the field names and version are not ours to improve. Two fields
// cannot be filled honestly from a browser-side Whisper run:
//
//   probability          faster-whisper reports per-word confidence; the ONNX
//                        export used here returns only text and timestamps, so
//                        1 is a placeholder, not a measurement.
//   source_video         a browser never learns the file's path. Only the name
//                        is available, so that is what goes in.
//
// Timings are rounded to two decimals to match the existing files. JSON prints
// 9.0 as 9, which is the same number and parses identically.

const APP_NAME = 'Video Caption Popover';

const round2 = value => Math.round(value * 100) / 100;

export function buildWordTimings({ words, sourceVideo = '', language = 'en', languageProbability = 1 }) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('No word timings to export.');
  }
  return {
    version: 1,
    app: APP_NAME,
    source_video: String(sourceVideo || ''),
    language,
    language_probability: languageProbability,
    words: words.map(word => {
      const start = Number(word?.start);
      const end = Number(word?.end);
      const text = String(word?.text ?? '').trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`Incomplete word timing for "${text || 'empty word'}".`);
      }
      return {
        text,
        start: round2(start),
        end: round2(end),
        probability: Number.isFinite(Number(word?.probability)) ? Number(word.probability) : 1,
      };
    }),
  };
}

export function wordTimingsFileName(sourceVideo = '') {
  // Strip any directory first: existing files carry Windows paths like
  // "D:\Game Movies\clip.mp4", and a browser download name cannot contain them.
  const base = String(sourceVideo)
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^./\\]+$/, '')
    .trim();
  return `${base || 'captions'}-word-timings.json`;
}
