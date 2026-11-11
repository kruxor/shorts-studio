import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceTranscriptText, transcriptText } from '../public/js/alignment.js';

const transcript = {
  text: 'Hello there',
  language: 'en',
  words: [
    { text: 'Hello', start: 0.2, end: 0.6, probability: 0.98 },
    { text: 'there', start: 0.7, end: 1.1, probability: 0.91 },
  ],
};

test('paragraph text round-trips unchanged as a clone', () => {
  const text = transcriptText(transcript);
  const result = replaceTranscriptText(transcript, text);
  assert.notStrictEqual(result, transcript);
  assert.deepEqual(result, transcript);
});

test('an edited paragraph word keeps sane existing timings', () => {
  const result = replaceTranscriptText(transcript, 'Hello world');
  assert.deepEqual(result.words.map(word => word.text), ['Hello', 'world']);
  assert.equal(result.words[0].start, 0.2);
  assert.equal(result.words[0].end, 0.6);
  assert.equal(result.words[1].start, 0.7);
  assert.equal(result.words[1].end, 1.1);
  assert.ok(result.words.every(word => Number.isFinite(word.start) && Number.isFinite(word.end) && word.start < word.end));
});
