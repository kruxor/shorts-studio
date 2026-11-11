import { normalizeStyle } from './style.js';

export function validatePreset(item) {
  if (!item || typeof item.name !== 'string') throw new TypeError('Each preset needs a name and style.');
  const name = item.name.trim();
  if (!name || [...name].length > 80) throw new RangeError('Preset names must contain 1 to 80 characters.');
  return { name, style: normalizeStyle(item.style) };
}

export function serializePresets(presets) {
  return JSON.stringify({ schemaVersion: 1, presets: presets.map(validatePreset) }, null, 2);
}

export function parsePresets(json) {
  const parsed = JSON.parse(json);
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.presets) || parsed.presets.length > 100) {
    throw new TypeError('This is not a supported Shorts Studio preset file.');
  }
  const presets = parsed.presets.map(validatePreset);
  const names = new Set();
  for (const preset of presets) {
    const key = preset.name.toLocaleLowerCase();
    if (names.has(key)) throw new TypeError(`Duplicate preset name: ${preset.name}`);
    names.add(key);
  }
  return presets;
}
