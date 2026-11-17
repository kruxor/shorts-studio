export function normalizeWordChunks(result, stats) {
  const candidates = Array.isArray(result?.words)
    ? result.words
    : (Array.isArray(result?.chunks) ? result.chunks : null);
  if (!candidates?.length) {
    throw new Error('Whisper did not return word-level timestamps (no words[] or timestamped chunks were returned).');
  }

  const words = [];
  let splitChunkCount = 0;
  for (const item of candidates) {
    const text = String(item?.text ?? '').trim();
    const start = Number(item?.start ?? item?.timestamp?.[0]);
    const end = Number(item?.end ?? item?.timestamp?.[1]);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error('Whisper returned incomplete word timestamps; expected one word with a finite start and end time per item.');
    }

    const chunkWords = text.split(/\s+/u);
    if (chunkWords.length === 1) {
      words.push({ text, start, end });
      continue;
    }

    splitChunkCount += 1;
    const lengths = chunkWords.map(word => Array.from(word).length);
    const totalLength = lengths.reduce((total, length) => total + length, 0);
    let consumedLength = 0;
    let wordStart = start;
    chunkWords.forEach((word, index) => {
      consumedLength += lengths[index];
      const wordEnd = index === chunkWords.length - 1
        ? end
        : Math.max(wordStart, Math.min(end, Math.round((start + (end - start) * consumedLength / totalLength) * 100) / 100));
      words.push({ text: word, start: wordStart, end: wordEnd });
      wordStart = wordEnd;
    });
  }

  if (stats && typeof stats === 'object') stats.splitChunkCount = splitChunkCount;
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('Whisper did not return a non-empty words[] array.');
  }
  return words;
}

export function formatVideoProcessingError(error, decodeFailure = false) {
  const message = error instanceof Error && error.message ? error.message : 'Try a different file or browser.';
  return decodeFailure
    ? `Could not decode or transcribe this video. Confirm it is an MP4 with H.264 video and a supported audio track. ${message}`
    : message;
}
