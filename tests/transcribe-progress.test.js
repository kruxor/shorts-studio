import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsedTime, isLongClip } from '../public/js/transcribe-progress.js';

test('elapsed time formats under an hour as mm:ss', () => {
  assert.equal(formatElapsedTime(0), '00:00');
  assert.equal(formatElapsedTime(83), '01:23');
  assert.equal(formatElapsedTime(3599), '59:59');
});

test('elapsed time formats an hour or more as h:mm:ss', () => {
  assert.equal(formatElapsedTime(3600), '1:00:00');
  assert.equal(formatElapsedTime(3723), '1:02:03');
});

test('elapsed time clamps negative input to zero', () => {
  assert.equal(formatElapsedTime(-1), '00:00');
  assert.equal(formatElapsedTime(-120), '00:00');
});

test('long-clip predicate is strictly over 60 seconds', () => {
  assert.equal(isLongClip(0), false);
  assert.equal(isLongClip(60), false);
  assert.equal(isLongClip(60.001), true);
});
