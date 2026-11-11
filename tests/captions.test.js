import test from 'node:test';
import assert from 'node:assert/strict';
import { groupWords, activeGroup, spokenWordIndex } from '../public/js/captions.js';

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

// Display timing: a line must stay up long enough to be read.
const line = (start, end) => {
  const mid = start + (end - start) / 2;
  return [w('one', start, mid), w('two', mid, end)];
};
test('a line holds through the silence until the next line starts', () => {
  // Line one is spoken 0.0-0.4, line two starts at 1.6 after a 1.2s pause.
  const groups = [line(0, 0.4), line(1.6, 2.0)];
  assert.deepEqual(activeGroup(groups, 1.2), groups[0], 'silence after a line keeps the line on screen');
  assert.deepEqual(activeGroup(groups, 1.59), groups[0]);
  assert.deepEqual(activeGroup(groups, 1.6), groups[1], 'the next line takes over exactly when it is spoken');
});
test('lines never overlap, so a held line cannot delay the next one', () => {
  const groups = [line(0, 0.2), line(0.25, 0.5), line(0.55, 0.9)];
  for (const group of groups) {
    const start = group[0].start;
    assert.deepEqual(activeGroup(groups, start), group);
  }
});
test('nothing is shown before the first word', () => {
  assert.equal(activeGroup([line(1, 1.4)], 0.5), null);
  assert.equal(activeGroup([], 0), null);
  assert.equal(activeGroup(null, 0), null);
});
test('the final line has a minimum on-screen time after its last word', () => {
  const groups = [line(0, 0.1), line(2, 2.1)];
  assert.deepEqual(activeGroup(groups, 2.3, 0.35), groups[1], 'still visible 0.2s after the last word');
  assert.deepEqual(activeGroup(groups, 2.34, 0.35), groups[1], 'still visible just inside the 0.35s floor');
  assert.equal(activeGroup(groups, 2.36, 0.35), null, 'gone once the floor has passed');
});
test('a held line reports no active word, so the whole line renders in the base colour', () => {
  const groups = [line(0, 0.4), line(1.6, 2.0)];
  const held = activeGroup(groups, 1.2);
  assert.equal(spokenWordIndex(held, 1.2), -1);
  assert.equal(spokenWordIndex(held, 0.1), 0, 'word highlighting still works while being spoken');
});
