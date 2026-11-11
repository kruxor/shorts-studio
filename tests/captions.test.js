import test from 'node:test';
import assert from 'node:assert/strict';
import { groupWords } from '../public/js/captions.js';

const w = (text, start, end = start + 0.2) => ({ text, start, end });
test('groups split at max words and punctuation after minimum words', () => {
  assert.deepEqual(groupWords([w('One',0),w('two',.2),w('three',.4),w('Done.',.6)], {min_words:2,max_words:3,max_chars:80,pause_split:2}), [
    [w('One',0),w('two',.2),w('three',.4)], [w('Done.',.6)]
  ]);
});
test('groups split before exceeding max characters', () => {
  assert.deepEqual(groupWords([w('alpha',0),w('bravo',.2),w('charlie',.4)], {min_words:1,max_words:8,max_chars:11,pause_split:3}), [[w('alpha',0),w('bravo',.2)],[w('charlie',.4)]]);
});
test('pause split only applies once minimum words have accumulated', () => {
  assert.deepEqual(groupWords([w('a',0),w('b',.2),w('c',2)], {min_words:2,max_words:8,max_chars:80,pause_split:.65}), [[w('a',0),w('b',.2)],[w('c',2)]]);
});
test('punctuation split requires minimum words and handles listed marks', () => {
  assert.deepEqual(groupWords([w('wait,',0),w('really?',.2),w('yes…',.4)], {min_words:2,max_words:8,max_chars:80,pause_split:3}), [[w('wait,',0),w('really?',.2)],[w('yes…',.4)]]);
});
