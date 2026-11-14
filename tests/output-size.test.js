import test from 'node:test';
import assert from 'node:assert/strict';
import { outputSizeFor } from '../public/js/output-size.js';

test('keeps portrait output at 1080x1920', () => {
  assert.deepEqual(outputSizeFor(1080, 1920), { width: 1080, height: 1920 });
});

test('matches landscape sources without letterboxing', () => {
  assert.deepEqual(outputSizeFor(1920, 1080), { width: 1920, height: 1080 });
});

test('keeps square sources square', () => {
  assert.deepEqual(outputSizeFor(1080, 1080), { width: 1080, height: 1080 });
});

test('caps 4K landscape and portrait at a 1080-pixel short side', () => {
  assert.deepEqual(outputSizeFor(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(outputSizeFor(2160, 3840), { width: 1080, height: 1920 });
});

test('does not upscale a small landscape source', () => {
  assert.deepEqual(outputSizeFor(640, 360), { width: 640, height: 360 });
});

test('rounds odd source dimensions to even outputs while preserving scale', () => {
  assert.deepEqual(outputSizeFor(1919, 1079), { width: 1918, height: 1078 });
  assert.deepEqual(outputSizeFor(1918, 1078), { width: 1918, height: 1078 });
});

test('falls back to portrait for invalid dimensions', () => {
  for (const dimensions of [[0, 1920], [NaN, 1080], [-1920, 1080], [1920, Infinity]]) {
    assert.deepEqual(outputSizeFor(...dimensions), { width: 1080, height: 1920 });
  }
});
