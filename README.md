# @lp-labs/multipart-codec

Incremental bounded multipart/form-data parsing and binary-safe encoding with explicit diagnostics.

Original independent MIT TypeScript implementation with **zero runtime or peer dependencies**. ESM/CommonJS with separate declarations; Node 18+ and compatible browser runtimes. No external code is downloaded or service started at import. TypeScript/Prettier are development-only tools.

## Install

```sh
npm install @lp-labs/multipart-codec
```

## Working example

```js
import assert from 'node:assert/strict';
import { encodeMultipart, parseMultipart, MultipartError } from '@lp-labs/multipart-codec';
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
```

CommonJS: `const api = require('@lp-labs/multipart-codec')`. Use type-only imports for exported interfaces in TypeScript.

## Behavior, customization, limits and performance

This is a strict, documented multipart/form-data subset, not a general MIME email parser. Encoder streams parts but each input part contains a complete Uint8Array. Parser accepts incremental chunks, handles split delimiters, and buffers ONE complete part before yielding it. Repeated names preserve arrival order; filename is metadata, NEVER a filesystem path. Header names are case insensitive. Supports quoted name/filename with backslash escaping, optional bare content-type; rejects extended filename*, nested multipart, folded/extra headers, non-ASCII headers, unquoted disposition parameters, preamble and nonempty epilogue. Unicode field contents remain bytes. Use printable ASCII field/filename metadata. Caller creates an unpredictable collision-resistant boundary and supplies a correctly quoted HTTP Content-Type boundary parameter as appropriate; no HTTP server/fetch integration.

Defaults: maxParts 1,000, maxPartBytes 16 MiB, maxTotalBytes 64 MiB (wire bytes), maxHeaderBytes 8 KiB, maxChunkBytes 1 MiB. All limits positive safe integers <=1 GiB. Headers and encoded overhead count toward total. Encoder checks payload delimiter collisions and rejects; no random dependency. Each operation is single-consumer and signal cancellation is cooperative. On malformed late input, earlier yielded parts remain delivered: stage parts before committing a whole request. Part bytes are detached. Peak parse memory approximately two part buffers plus one input chunk; concatenating many tiny chunks can be quadratic in part size, so use appropriate incoming chunk sizes and small per-part limits for hostile workloads. Resource errors use MultipartError code limit, malformed data invalid, missing closing framing truncated, cancellation aborted.

## Errors and application integration

Use the exported error class and its documented code (where present); invalid structural input throws rather than silently defaulting. Await async methods and handle rejections. Trusted adapters/callbacks must meet documented ownership and isolation requirements. Hostile proxies and custom prototype objects are outside the contract; ordinary data properties are required. No runtime network/worker/database dependency is hidden behind the API. Examples use Node assertions for reproducible outcomes, not as package dependencies. The declared bounded subset is the supported functionality, not a claim of complete compatibility with another library.

## Complete API and customization contract

The public declaration below specifies all exported functions, field names, options, return shapes and error codes. Configure explicit limits and supply callbacks/adapters through these interfaces; do not modify package internals. Optional fields follow the defaults and missing-data policies above. TypeScript consumers receive this same contract through both ESM and CommonJS exports.

```ts
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}
export interface MultipartLimits {
  maxParts?: number;
  maxPartBytes?: number;
  maxTotalBytes?: number;
  maxHeaderBytes?: number;
  maxChunkBytes?: number;
  signal?: AbortSignal;
}
export declare class MultipartError extends Error {
  readonly code: 'invalid' | 'limit' | 'truncated' | 'aborted';
  constructor(code: 'invalid' | 'limit' | 'truncated' | 'aborted', message: string);
}
export declare function encodeMultipart(
  parts: Iterable<MultipartPart> | AsyncIterable<MultipartPart>,
  boundary: string,
  options?: MultipartLimits,
): AsyncGenerator<Uint8Array>;
export declare function parseMultipart(
  source: AsyncIterable<Uint8Array>,
  boundary: string,
  options?: MultipartLimits,
): AsyncGenerator<MultipartPart>;
```

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
