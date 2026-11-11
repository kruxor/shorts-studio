const tokens = text => String(text).trim().split(/\s+/u).filter(Boolean);
const key = text => text.replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase() || text.toLocaleLowerCase();

export function transcriptText(transcript) {
  let text = '';
  let previous = null;
  for (const word of transcript.words) {
    const piece = String(word.text).trim();
    if (!piece) continue;
    if (text && previous) {
      const lineBreak = Number(word.start) - Number(previous.end) >= 0.65 || /[.!?]["\u201d\u2019)]*$/u.test(previous.text);
      text += lineBreak ? '\n' : ' ';
    }
    text += piece;
    previous = word;
  }
  return text;
}

function matches(oldWords, newWords) {
  const n = oldWords.length;
  const m = newWords.length;
  let frontier = new Map([[1, 0]]);
  const trace = [];
  for (let depth = 0; depth <= Math.min(n + m, 512); depth++) {
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = diagonal === -depth || (diagonal !== depth && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && oldWords[x] === newWords[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x >= n && y >= m) {
        trace.push(new Map(frontier));
        const pairs = [];
        for (let d = trace.length - 1; d >= 0; d--) {
          const previous = d > 0 ? trace[d - 1] : new Map([[1, 0]]);
          const k = x - y;
          const isDown = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1));
          const previousK = isDown ? k + 1 : k - 1;
          const previousX = previous.get(previousK) ?? 0;
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) pairs.push([--x, --y]);
          x = previousX;
          y = previousY;
        }
        return pairs.reverse();
      }
    }
    trace.push(new Map(frontier));
  }
  throw new RangeError('There are too many changes to match safely at once. Save smaller corrections or use timed words.');
}

const wordWithText = (word, text) => {
  const result = { ...word, text };
  if (word.text !== text) delete result.probability;
  return result;
};

function replaceRun(oldRun, newRun) {
  if (!newRun.length) return [];
  if (!oldRun.length) throw new RangeError('Use timed words to give this text a speech interval.');
  if (oldRun.length === newRun.length) return newRun.map((text, index) => wordWithText(oldRun[index], text));
  const start = Number(oldRun[0].start);
  const end = Number(oldRun.at(-1).end);
  if (end - start < newRun.length * 0.001) throw new RangeError('There is not enough speech time for these added words. Adjust the timed words.');
  return newRun.map((text, index) => ({
    text,
    start: start + (end - start) * index / newRun.length,
    end: start + (end - start) * (index + 1) / newRun.length,
  }));
}

export function replaceTranscriptText(transcript, text) {
  if (String(text).length > 200000) throw new RangeError('Keep the quick transcript below 200,000 characters.');
  const replacement = tokens(text);
  if (!replacement.length || replacement.length > 5000) throw new RangeError('Keep between 1 and 5,000 words in the transcript.');
  if (replacement.some(token => [...token].length > 120)) throw new RangeError('A caption word cannot exceed 120 characters.');
  if (replacement.join(' ') === tokens(transcriptText(transcript)).join(' ')) return structuredClone(transcript);

  const original = [];
  for (const word of transcript.words) {
    const parts = tokens(word.text);
    parts.forEach((text, index) => original.push({
      ...word,
      text,
      start: Number(word.start) + (Number(word.end) - Number(word.start)) * index / parts.length,
      end: Number(word.start) + (Number(word.end) - Number(word.start)) * (index + 1) / parts.length,
    }));
  }
  if (!original.length || original.length > 5000) throw new RangeError('Use timed words to correct this transcript first.');
  const aligned = matches(original.map(word => key(word.text)), replacement.map(key));
  aligned.push([original.length, replacement.length]);
  const result = [];
  let oldStart = 0;
  let newStart = 0;
  for (const [oldEnd, newEnd] of aligned) {
    let oldRun = original.slice(oldStart, oldEnd);
    let newRun = replacement.slice(newStart, newEnd);
    let consumeMatch = false;
    if (!oldRun.length && newRun.length) {
      if (result.length) {
        const previous = result.pop();
        oldRun = [previous];
        newRun = [previous.text, ...newRun];
      } else if (original[oldEnd]) {
        oldRun = [original[oldEnd]];
        newRun.push(replacement[newEnd]);
        consumeMatch = true;
      }
    }
    result.push(...replaceRun(oldRun, newRun));
    if (!consumeMatch && original[oldEnd]) result.push(wordWithText(original[oldEnd], replacement[newEnd]));
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }
  return { ...transcript, version: 1, words: result };
}
