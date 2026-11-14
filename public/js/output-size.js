const DEFAULT_OUTPUT_SIZE = Object.freeze({ width: 1080, height: 1920 });

function evenNearest(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Select an even H.264 frame size that follows the source orientation without
 * enlarging its shorter side beyond 1080 pixels or the source dimensions.
 */
export function outputSizeFor(videoWidth, videoHeight) {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth < 2 || videoHeight < 2) {
    return { ...DEFAULT_OUTPUT_SIZE };
  }

  const sourceShortSide = Math.min(videoWidth, videoHeight);
  const sourceLongSide = Math.max(videoWidth, videoHeight);
  const shortSide = Math.max(2, Math.floor(Math.min(1080, sourceShortSide) / 2) * 2);
  const longSide = evenNearest(sourceLongSide * shortSide / sourceShortSide);

  return videoWidth >= videoHeight
    ? { width: longSide, height: shortSide }
    : { width: shortSide, height: longSide };
}
