import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STYLE, normalizeStyle } from '../public/js/style.js';

test('style defaults match CaptionValues.php', () => {
  assert.deepEqual(DEFAULT_STYLE, {font_size:108,y_position:.66,caption_color:'#ffffff',highlight_color:'#fff34a',stroke_color:'#000000',stroke_width:4.5,min_words:2,max_words:3,max_chars:22,pause_split:.65,highlight_enabled:true,normalize_audio:true});
});
test('style accepts inclusive bounds and normalizes numeric/integer values', () => {
  assert.deepEqual(normalizeStyle({font_size:24,y_position:.1,stroke_width:12,min_words:1,max_words:1,max_chars:8,pause_split:.1}), {...DEFAULT_STYLE,font_size:24,y_position:.1,stroke_width:12,min_words:1,max_words:1,max_chars:8,pause_split:.1});
});
test('style rejects out-of-range, nonfinite, bad colours, and min greater than max', () => {
  for (const input of [{font_size:23},{y_position:Infinity},{stroke_width:12.1},{caption_color:'red'},{min_words:4,max_words:3},{pause_split:0}]) assert.throws(() => normalizeStyle(input));
});
