import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMultipart, parseMultipart } from '../dist/esm/index.js';

test('encoder framing respects maxChunkBytes and round-trips at one-byte chunks', async () => {
  const chunks = [];
  for await (const chunk of encodeMultipart([{ name: 'field', data: Uint8Array.of(1, 2) }], 'b', {
    maxChunkBytes: 1,
  })) {
    assert.equal(chunk.length, 1);
    chunks.push(chunk);
  }
  const decoded = [];
  for await (const part of parseMultipart(
    (async function* () {
      yield* chunks;
    })(),
    'b',
    { maxChunkBytes: 1 },
  ))
    decoded.push(part);
  assert.deepEqual([...decoded[0].data], [1, 2]);
});

test('staged parts precede late errors but no invalid late part is yielded', async () => {
  const chunks = [];
  for await (const chunk of encodeMultipart(
    [
      { name: 'a', data: Uint8Array.of(1) },
      { name: 'b', data: Uint8Array.of(2) },
    ],
    'b',
  ))
    chunks.push(chunk);
  const bytes = Uint8Array.from(chunks.flatMap((chunk) => [...chunk])).slice(0, -6);
  const yielded = [];
  await assert.rejects(
    async () => {
      for await (const part of parseMultipart(
        (async function* () {
          yield bytes;
        })(),
        'b',
      ))
        yielded.push(part.name);
    },
    { code: 'truncated' },
  );
  assert.deepEqual(yielded, ['a']);
});
