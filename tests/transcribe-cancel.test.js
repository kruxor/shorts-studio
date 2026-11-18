import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWorker {
  static instances = [];

  constructor() {
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage() {
    if (this.respond) {
      queueMicrotask(() => this.onmessage?.({ data: {
        type: 'result',
        words: [{ text: 'hello', start: 0, end: 1 }],
        text: 'hello',
      } }));
    }
  }

  terminate() { this.terminated = true; }
}

test('cancelling rejects the current run and permits a fresh worker run', async () => {
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  const { cancel, transcribeAudio } = await import(`../public/js/transcribe.js?cancel-test=${Date.now()}`);

  const firstRun = transcribeAudio(new Float32Array([0.1]));
  const firstWorker = FakeWorker.instances[0];
  assert.ok(firstWorker);
  assert.equal(cancel(), true);
  await assert.rejects(firstRun, error => error.cancelled === true);
  assert.equal(firstWorker.terminated, true);

  FakeWorker.prototype.respond = true;
  const secondRun = transcribeAudio(new Float32Array([0.2]));
  const secondWorker = FakeWorker.instances[1];
  assert.ok(secondWorker);
  assert.notEqual(secondWorker, firstWorker);
  assert.deepEqual(await secondRun, {
    words: [{ text: 'hello', start: 0, end: 1 }],
    text: 'hello',
  });
});
