import test from 'node:test';
import assert from 'node:assert/strict';
import { formatVideoProcessingError, normalizeWordChunks } from '../public/js/transcribe-shared.js';

test('single-word chunks pass through unchanged', () => {
  const chunk = { text: 'hello', start: 1.234, end: 2.345 };
  const splitStats = {};
  const words = normalizeWordChunks({ chunks: [chunk] }, splitStats);

  assert.deepEqual(words, [chunk]);
  assert.equal(splitStats.splitChunkCount, 0);
});

test('a three-word chunk splits into adjacent intervals that tile the source interval', () => {
  const splitStats = {};
  const words = normalizeWordChunks({ chunks: [{ text: 'one two three', timestamp: [2, 8] }] }, splitStats);

  assert.deepEqual(words.map(({ text }) => text), ['one', 'two', 'three']);
  assert.equal(words[0].start, 2);
  assert.equal(words.at(-1).end, 8);
  assert.deepEqual(words.slice(0, -1).map(word => word.end), words.slice(1).map(word => word.start));
  assert.ok(words.every(word => word.start <= word.end));
  assert.ok(words.every((word, index) => index === 0 || words[index - 1].end <= word.start));
  assert.equal(splitStats.splitChunkCount, 1);
});

test('word intervals are weighted by character length', () => {
  const [short, long] = normalizeWordChunks({ chunks: [{ text: 'a longer', start: 0, end: 10 }] });

  assert.ok(short.end - short.start < long.end - long.start);
  assert.equal(short.end, long.start);
});

test('generated split timings are rounded to two decimal places', () => {
  const words = normalizeWordChunks({ chunks: [{ text: 'a bb ccc', start: 0.1, end: 2.1 }] });

  for (const word of words) {
    for (const time of [word.start, word.end]) {
      assert.ok(Math.abs(time - Number(time.toFixed(2))) < 1e-9);
    }
  }
});

test('empty and invalid results keep their existing errors', () => {
  assert.throws(
    () => normalizeWordChunks({ chunks: [] }),
    { message: 'Whisper did not return word-level timestamps (no words[] or timestamped chunks were returned).' },
  );
  for (const chunk of [
    { text: '   ', start: 0, end: 1 },
    { text: 'word', start: Number.NaN, end: 1 },
    { text: 'word', start: Number.POSITIVE_INFINITY, end: 1 },
    { text: 'word', start: 0, end: Number.NaN },
    { text: 'word', start: 0, end: Number.POSITIVE_INFINITY },
    { text: 'word', start: 2, end: 1 },
  ]) {
    assert.throws(
      () => normalizeWordChunks({ chunks: [chunk] }),
      { message: 'Whisper returned incomplete word timestamps; expected one word with a finite start and end time per item.' },
    );
  }
});

test('decode failures get codec context, while model failures retain only their cause', () => {
  const decodeError = new Error('Could not parse this MP4 file: invalid box');
  const modelError = new Error('Whisper returned incomplete word timestamps.');

  assert.equal(
    formatVideoProcessingError(decodeError, true),
    'Could not decode or transcribe this video. Confirm it is an MP4 with H.264 video and a supported audio track. Could not parse this MP4 file: invalid box',
  );
  assert.equal(formatVideoProcessingError(modelError, false), modelError.message);
});
