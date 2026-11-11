import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STYLE, FONTS, normalizeStyle, clampStyleValue } from '../public/js/style.js';

test('style defaults match CaptionValues.php', () => {
  assert.deepEqual(DEFAULT_STYLE, {font_size:108,x_position:.5,y_position:.66,caption_color:'#ffffff',highlight_color:'#fff34a',stroke_color:'#000000',stroke_width:4.5,min_words:2,max_words:3,max_chars:22,pause_split:.65,highlight_enabled:true,normalize_audio:true,font:'Montserrat ExtraBold'});
});
test('x position defaults to center when absent and clamps to the preview bounds', () => {
  assert.equal(normalizeStyle({}).x_position, .5);
  assert.equal(clampStyleValue('x_position', 0), .05);
  assert.equal(clampStyleValue('x_position', 1), .95);
  assert.equal(normalizeStyle({ x_position: .72 }).x_position, .72);
});
test('style accepts inclusive bounds and normalizes numeric/integer values', () => {
  assert.deepEqual(normalizeStyle({font_size:24,y_position:.1,stroke_width:12,min_words:1,max_words:1,max_chars:8,pause_split:.1}), {...DEFAULT_STYLE,font_size:24,y_position:.1,stroke_width:12,min_words:1,max_words:1,max_chars:8,pause_split:.1});
});
test('font selection is allowlisted and unknown values fall back to Montserrat', () => {
  assert.ok(FONTS.length >= 3);
  assert.ok(FONTS.some(font => font.family === DEFAULT_STYLE.font && font.weight === 800));
  assert.equal(normalizeStyle({ font: FONTS.at(-1).family }).font, FONTS.at(-1).family);
  assert.equal(normalizeStyle({ font: 'Not A Local Font' }).font, DEFAULT_STYLE.font);
});
test('style rejects out-of-range, nonfinite, bad colours, and min greater than max', () => {
  for (const input of [{font_size:23},{y_position:Infinity},{stroke_width:12.1},{caption_color:'red'},{min_words:4,max_words:3},{pause_split:0}]) assert.throws(() => normalizeStyle(input));
});
