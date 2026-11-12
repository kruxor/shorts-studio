import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordTimings, wordTimingsFileName } from '../public/js/word-export.js';

const words = [
  { text: 'Alright,', start: 8.481, end: 9.0 },
  { text: 'welcome', start: 9.36, end: 9.36 },
  { text: 'back.', start: 9.36, end: 9.824 },
];

test('builds the schema the external tool expects', () => {
  const doc = buildWordTimings({ words, sourceVideo: 'RS Construction 120 NOM.mp4' });
  assert.equal(doc.version, 1);
  assert.equal(doc.app, 'Video Caption Popover');
  assert.equal(doc.source_video, 'RS Construction 120 NOM.mp4');
  assert.equal(doc.language, 'en');
  assert.equal(doc.language_probability, 1);
  assert.deepEqual(doc.words[0], { text: 'Alright,', start: 8.48, end: 9, probability: 1 });
  assert.equal(doc.words.length, 3);
});

test('rounds timings to two decimals like the existing files', () => {
  const doc = buildWordTimings({ words, sourceVideo: 'x.mp4' });
  assert.equal(doc.words[0].start, 8.48);
  assert.equal(doc.words[2].end, 9.82);
});

test('keeps a real probability when one is supplied', () => {
  const doc = buildWordTimings({ words: [{ text: 'hi', start: 0, end: 1, probability: 0.1163 }], sourceVideo: 'x.mp4' });
  assert.equal(doc.words[0].probability, 0.1163);
});

test('language fields can be overridden', () => {
  const doc = buildWordTimings({ words, sourceVideo: 'x.mp4', language: 'de', languageProbability: 0.87 });
  assert.equal(doc.language, 'de');
  assert.equal(doc.language_probability, 0.87);
});

test('refuses to export nothing', () => {
  assert.throws(() => buildWordTimings({ words: [] }), /No word timings/);
  assert.throws(() => buildWordTimings({}), /No word timings/);
});

test('refuses a word with no usable timing', () => {
  assert.throws(
    () => buildWordTimings({ words: [{ text: 'hi', start: Number.NaN, end: 1 }] }),
    /Incomplete word timing/,
  );
  assert.throws(() => buildWordTimings({ words: [{ text: '  ', start: 0, end: 1 }] }), /Incomplete word timing/);
});

test('file name drops the video extension and copes with paths', () => {
  assert.equal(wordTimingsFileName('RS Construction 120 NOM.mp4'), 'RS Construction 120 NOM-word-timings.json');
  assert.equal(wordTimingsFileName('D:\\Game Movies\\clip.MOV'), 'clip-word-timings.json');
  assert.equal(wordTimingsFileName(''), 'captions-word-timings.json');
  assert.equal(wordTimingsFileName('noextension'), 'noextension-word-timings.json');
});
