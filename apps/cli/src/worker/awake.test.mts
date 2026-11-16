import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { keepAwake } from './awake.mts';

function fakeChild(): EventEmitter & { unref: () => void; kill: () => boolean; killed: boolean } {
  return Object.assign(new EventEmitter(), {
    killed: false,
    unref() {},
    kill() {
      this.killed = true;
      return true;
    },
  });
}

test('caffeinate holds idle sleep off for the worker and ends with it', () => {
  const calls: string[][] = [];
  const child = fakeChild();
  const start = (program: string, args: string[]) => {
    calls.push([program, ...args]);
    return child;
  };
  const stop = keepAwake(4242, start);
  assert.deepEqual(calls, [['caffeinate', '-i', '-w', '4242']]);
  stop();
  assert.equal(child.killed, true);
});

test('a Mac without caffeinate runs the task all the same', () => {
  const child = fakeChild();
  const stop = keepAwake(1, () => child);
  assert.doesNotThrow(() => child.emit('error', new Error('spawn caffeinate ENOENT')));
  assert.doesNotThrow(stop);
  const throwing = keepAwake(1, () => {
    throw new Error('cannot spawn');
  });
  assert.doesNotThrow(throwing);
});
