import test from 'node:test';
import assert from 'node:assert/strict';
import { serializePresets, parsePresets } from '../public/js/presets.js';

const presets = [{name:'Bright captions',style:{font_size:108,y_position:.66,caption_color:'#ffffff',highlight_color:'#fff34a',stroke_color:'#000000',stroke_width:4.5,min_words:2,max_words:3,max_chars:22,pause_split:.65,highlight_enabled:true,normalize_audio:true}}];
test('portable preset JSON round-trips and validates imported values', () => {
  assert.deepEqual(parsePresets(serializePresets(presets)), presets);
  assert.throws(() => parsePresets('{"presets":[{"name":"x","style":{"font_size":0}}]}'));
});
