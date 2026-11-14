export function normalizeWordChunks(result) {
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
