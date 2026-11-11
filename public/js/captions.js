export function splitTimedWords(input) {
  const words = [];
  for (const word of input) {
    const parts = String(word.text).trim().split(/\s+/u).filter(Boolean);
    parts.forEach((text, index) => words.push({
      ...word,
      text,
      start: Number(word.start) + (Number(word.end) - Number(word.start)) * index / parts.length,
      end: Number(word.start) + (Number(word.end) - Number(word.start)) * (index + 1) / parts.length,
    }));
  }
  return words;
}

// Port of ShortsStudio/assets/studio.js: minimum words gate pause/punctuation
// splitting; max words and max chars always split before the next token.
export function groupWords(input, settings) {
  const words = splitTimedWords(input);
  const minimum = Number(settings.min_words);
  const maximum = Number(settings.max_words);
  const maxChars = Number(settings.max_chars);
  const pause = Number(settings.pause_split);
  const groups = [];
  let current = [];
  let previousEnd = null;
  const finish = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const word of words) {
    const tooLong = [...current.map(item => item.text), word.text].join(' ').length > maxChars;
    if (current.length && (
      (previousEnd !== null && word.start - previousEnd >= pause && current.length >= minimum)
      || current.length >= maximum || tooLong
    )) finish();
    current.push(word);
    previousEnd = word.end;
    if (current.length >= minimum && /[.!?;:,…)\u2026]$/.test(word.text)) finish();
  }
  finish();
  return groups;
}

// A line stays on screen until the next line starts, instead of vanishing the
// instant its final word ends. Fast speech produces two- and three-word lines
// lasting a few hundred milliseconds; without the hold the viewer sees a
// flicker with blank gaps between lines and cannot read short lines at all.
// The last line additionally gets a floor so a clipped final word is still
// legible. Lines never overlap, so this cannot desync from the audio.
export function activeGroup(groups, time, minTailDuration = 0.35) {
  if (!groups?.length) return null;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group?.length) continue;
    const start = Number(group[0].start);
    const spokenEnd = Number(group[group.length - 1].end);
    const nextStart = groups[index + 1]?.length ? Number(groups[index + 1][0].start) : null;
    const end = nextStart === null || !Number.isFinite(nextStart)
      ? Math.max(spokenEnd, start + Math.max(0, Number(minTailDuration) || 0))
      : Math.max(spokenEnd, nextStart);
    if (time >= start && time < end) return group;
  }
  return null;
}

export function spokenWordIndex(group, time) {
  if (!group) return -1;
  return group.findIndex(word => time >= word.start && time < word.end);
}

export function flattenGroups(groups) {
  return groups.flat();
}
