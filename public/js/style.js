export const FONTS = Object.freeze([
  Object.freeze({ family: 'Montserrat ExtraBold', weight: 800, label: 'Montserrat ExtraBold' }),
  Object.freeze({ family: 'Anton', weight: 400, label: 'Anton' }),
  Object.freeze({ family: 'Bebas Neue', weight: 400, label: 'Bebas Neue' }),
  Object.freeze({ family: 'Archivo Black', weight: 400, label: 'Archivo Black' }),
]);

export const DEFAULT_STYLE = Object.freeze({
  font_size: 108, y_position: 0.66, font: 'Montserrat ExtraBold',
  caption_color: '#ffffff', highlight_color: '#fff34a', stroke_color: '#000000',
  stroke_width: 4.5, min_words: 2, max_words: 3, max_chars: 22, pause_split: 0.65,
  highlight_enabled: true, normalize_audio: true,
});

const BOUNDS = {
  font_size: [24, 180, true], y_position: [0.1, 0.9, false], stroke_width: [0, 12, false],
  min_words: [1, 8, true], max_words: [1, 8, true], max_chars: [8, 80, true], pause_split: [0.1, 3, false],
};
const COLORS = ['caption_color', 'highlight_color', 'stroke_color'];

export function normalizeStyle(input = {}) {
  const style = { ...DEFAULT_STYLE };
  for (const [name, [min, max, integer]] of Object.entries(BOUNDS)) {
    const value = input[name] ?? style[name];
    if (value === '' || value === null || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new RangeError(`Invalid caption setting: ${name}`);
    }
    style[name] = integer ? Math.trunc(Number(value)) : Number(value);
  }
  if (style.min_words > style.max_words) throw new RangeError('Minimum words must not exceed maximum words.');
  for (const name of COLORS) {
    const value = input[name] ?? style[name];
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new TypeError(`Invalid caption colour: ${name}`);
    style[name] = value.toLowerCase();
  }
  style.highlight_enabled = input.highlight_enabled === undefined ? DEFAULT_STYLE.highlight_enabled : Boolean(input.highlight_enabled);
  style.normalize_audio = input.normalize_audio === undefined ? DEFAULT_STYLE.normalize_audio : Boolean(input.normalize_audio);
  const requestedFont = input.font;
  style.font = typeof requestedFont === 'string' && FONTS.some(font => font.family === requestedFont)
    ? requestedFont
    : DEFAULT_STYLE.font;
  return style;
}

export function clampStyleValue(name, value) {
  const [min, max, integer] = BOUNDS[name] ?? [];
  if (min === undefined || !Number.isFinite(Number(value))) return DEFAULT_STYLE[name];
  const result = Math.max(min, Math.min(max, Number(value)));
  return integer ? Math.trunc(result) : result;
}
