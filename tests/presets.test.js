import test from 'node:test';
import assert from 'node:assert/strict';
import { serializePresets, parsePresets } from '../public/js/presets.js';

const presets = [{name:'Bright captions',style:{font:'Montserrat ExtraBold',font_size:108,y_position:.66,caption_color:'#ffffff',highlight_color:'#fff34a',stroke_color:'#000000',stroke_width:4.5,min_words:2,max_words:3,max_chars:22,pause_split:.65,highlight_enabled:true,normalize_audio:true}}];
test('portable preset JSON round-trips and validates imported values', () => {
  assert.deepEqual(parsePresets(serializePresets(presets)), presets);
  assert.throws(() => parsePresets('{"presets":[{"name":"x","style":{"font_size":0}}]}'));
});
test('presets saved before font selection existed still import with the default font', () => {
  const legacy = {schemaVersion:1,presets:[{name:'Legacy',style:{font_size:108,y_position:.66,stroke_width:4.5,min_words:2,max_words:3,max_chars:22,pause_split:.65}}]};
  const [imported] = parsePresets(JSON.stringify(legacy));
  assert.equal(imported.style.font, 'Montserrat ExtraBold');
  assert.equal(imported.style.font_size, 108);
});
test('unknown fonts fall back to the default instead of breaking a preset', () => {
  const bad = {schemaVersion:1,presets:[{name:'Bad font',style:{font:'Comic Sans MS',font_size:108}}]};
  const [imported] = parsePresets(JSON.stringify(bad));
  assert.equal(imported.style.font, 'Montserrat ExtraBold');
});
