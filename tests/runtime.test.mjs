import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMultipart, parseMultipart, MultipartError } from '../dist/esm/index.js';
test('documented workflow produces required outputs', async () => {
  const parts = [
    { name: 'tag', data: new TextEncoder().encode('one') },
    {
      name: 'tag',
      data: Uint8Array.of(0, 255, 1),
      filename: 'binary.dat',
      contentType: 'application/octet-stream',
    },
  ];
  const chunks = [];
  for await (const chunk of encodeMultipart(parts, 'example-boundary')) chunks.push(chunk);
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  const decoded = [];
  for await (const part of parseMultipart(source(), 'example-boundary')) decoded.push(part);
  assert.deepEqual(
    decoded.map((part) => part.name),
    ['tag', 'tag'],
  );
  assert.deepEqual([...decoded[1].data], [0, 255, 1]);
});
async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
async function wire(parts, boundary = 'b') {
  const chunks = await collect(encodeMultipart(parts, boundary));
  return Uint8Array.from(chunks.flatMap((c) => [...c]));
}
async function* split(bytes, size) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.slice(offset, offset + size);
}
test('every one-cut boundary split preserves binary and repeated names', async () => {
  const parts = [
    { name: 'x', filename: 'a"b.dat', data: Uint8Array.of(0, 255, 13, 10, 1) },
    { name: 'x', data: new Uint8Array() },
  ];
  const bytes = await wire(parts);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const decoded = await collect(
      parseMultipart(
        (async function* () {
          yield bytes.slice(0, cut);
          yield bytes.slice(cut);
        })(),
        'b',
      ),
    );
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0].filename, 'a"b.dat');
    assert.deepEqual([...decoded[0].data], [0, 255, 13, 10, 1]);
    assert.equal(decoded[1].name, 'x');
  }
});
test('one-byte chunks work for empty request and empty fields', async () => {
  const empty = await wire([]);
  assert.deepEqual(await collect(parseMultipart(split(empty, 1), 'b')), []);
  const bytes = await wire([{ name: 'x', data: new Uint8Array() }]);
  assert.equal((await collect(parseMultipart(split(bytes, 1), 'b')))[0].data.length, 0);
});
test('false delimiter prefixes remain binary content', async () => {
  const data = new TextEncoder().encode('hello\r\n--bX\r\n--b-\r\nworld');
  const bytes = await wire([{ name: 'x', data }]);
  for (const size of [1, 2, 3, 7])
    assert.deepEqual((await collect(parseMultipart(split(bytes, size), 'b')))[0].data, data);
});
test('encoder refuses delimiter collisions and header injection', async () => {
  for (const data of ['a\r\n--b\r\n', 'a\r\n--b--', 'a\r\n--b'])
    await assert.rejects(
      collect(encodeMultipart([{ name: 'x', data: new TextEncoder().encode(data) }], 'b')),
      { code: 'invalid' },
    );
  await assert.rejects(
    collect(encodeMultipart([{ name: 'x\r\nInjected: yes', data: new Uint8Array() }], 'b')),
    { code: 'invalid' },
  );
});
test('truncated closing frames and epilogues are explicit errors', async () => {
  const bytes = await wire([{ name: 'x', data: Uint8Array.of(1) }]);
  for (const missing of [3, 4, 7])
    await assert.rejects(collect(parseMultipart(split(bytes.slice(0, -missing), 1), 'b')), {
      code: 'truncated',
    });
  await assert.rejects(collect(parseMultipart(split(Uint8Array.from([...bytes, 88]), 2), 'b')), {
    code: 'invalid',
  });
});
test('rejects duplicate headers, unsupported parameters and preambles', async () => {
  for (const header of [
    'Content-Disposition: form-data; name="x"\r\nContent-Disposition: form-data; name="y"',
    'Content-Disposition: form-data; name="x"; filename*=UTF-8\'\'x',
    'Content-Disposition: form-data; name=x',
  ]) {
    const bytes = new TextEncoder().encode('--b\r\n' + header + '\r\n\r\nX\r\n--b--\r\n');
    await assert.rejects(collect(parseMultipart(split(bytes, 2), 'b')), { code: 'invalid' });
  }
  await assert.rejects(
    collect(parseMultipart(split(new TextEncoder().encode('preamble--b--\r\n'), 1), 'b')),
    { code: 'invalid' },
  );
});
test('enforces input, total, header, part and count budgets', async () => {
  const bytes = await wire([{ name: 'x', data: Uint8Array.of(1, 2) }]);
  for (const options of [
    { maxPartBytes: 1 },
    { maxHeaderBytes: 10 },
    { maxTotalBytes: 10 },
    { maxChunkBytes: 1 },
  ])
    await assert.rejects(collect(parseMultipart(split(bytes, 2), 'b', options)), { code: 'limit' });
  const two = await wire([
    { name: 'x', data: new Uint8Array() },
    { name: 'y', data: new Uint8Array() },
  ]);
  await assert.rejects(collect(parseMultipart(split(two, 2), 'b', { maxParts: 1 })), {
    code: 'limit',
  });
});
test('cancellation and malformed boundary never succeed', async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(collect(encodeMultipart([], 'b', { signal: c.signal })), {
    code: 'aborted',
  });
  await assert.rejects(collect(encodeMultipart([], 'bad boundary')), { code: 'invalid' });
  await assert.rejects(
    collect(
      parseMultipart(
        (async function* () {
          yield 'not bytes';
        })(),
        'b',
      ),
    ),
    { code: 'invalid' },
  );
});
