import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { readAheadInOrder } from '../src/extraction/ordered-read-ahead';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized promise'); };
  let reject: (error: Error) => void = () => { throw new Error('uninitialized promise'); };
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe('ordered read ahead', () => {
  it('delivers a ready head without waiting for its batch and refills within the window', async () => {
    const slow = deferred<string>();
    const started: string[] = [];
    const results = readAheadInOrder(['first', 'slow', 'third', 'fourth'], async (item) => {
      started.push(item);
      return item === 'slow' ? slow.promise : item;
    }, { maxReads: 2 });

    const next = results.next();
    let delivered = false;
    void next.then(() => { delivered = true; });
    await setImmediate();
    const deliveredBeforeSlow = delivered;
    const startedBeforeSlow = [...started];
    slow.resolve('slow');
    expect(await next).toEqual({ value: 'first', done: false });
    expect(deliveredBeforeSlow).toBe(true);
    expect(startedBeforeSlow).toEqual(['first', 'slow', 'third']);
    const rest: string[] = [];
    for await (const result of results) rest.push(result);
    expect(rest).toEqual(['slow', 'third', 'fourth']);
    expect(started).toEqual(['first', 'slow', 'third', 'fourth']);
  });

  it('drains pending reads on abort without starting any additional files', async () => {
    const controller = new AbortController();
    const slow = deferred<string>();
    const started: string[] = [];
    const results = readAheadInOrder(['slow', 'must not start'], async (item) => {
      started.push(item);
      return slow.promise;
    }, { maxReads: 1, signal: controller.signal });

    const next = results.next();
    controller.abort();
    let drained = false;
    void next.then(() => { drained = true; });
    await setImmediate();
    expect(drained).toBe(false);
    slow.resolve('slow');
    expect(await next).toEqual({ value: undefined, done: true });
    expect(started).toEqual(['slow']);
  });

  it('drains the prefetch window when the consumer stops early', async () => {
    const slow = deferred<string>();
    const results = readAheadInOrder(['first', 'slow'], async (item) => (
      item === 'slow' ? slow.promise : item
    ), { maxReads: 2 });
    expect(await results.next()).toEqual({ value: 'first', done: false });
    const stopped = results.return(undefined);
    let drained = false;
    void stopped.then(() => { drained = true; });
    await setImmediate();
    expect(drained).toBe(false);
    slow.resolve('slow');
    expect(await stopped).toEqual({ value: undefined, done: true });
  });

  it('reports a prefetched failure at its ordered position and drains on failure', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const results = readAheadInOrder(['first', 'second'], (item) => (
      item === 'first' ? first.promise : second.promise
    ), { maxReads: 2 });

    const next = results.next();
    const failure = new Error('second file failed');
    second.reject(failure);
    first.resolve('first');
    expect(await next).toEqual({ value: 'first', done: false });
    await expect(results.next()).rejects.toBe(failure);
  });
});
