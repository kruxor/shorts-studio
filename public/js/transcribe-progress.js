export function formatElapsedTime(seconds) {
  const wholeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  const pad = value => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(remainder)}`
    : `${pad(minutes)}:${pad(remainder)}`;
}

export function isLongClip(durationSeconds) {
  return Number(durationSeconds) > 60;
}
