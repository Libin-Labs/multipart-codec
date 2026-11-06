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
export class MultipartError extends Error {
  constructor(
    readonly code: 'invalid' | 'limit' | 'truncated' | 'aborted',
    message: string,
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}
const encoder = new TextEncoder();
function fail(code: MultipartError['code'], message: string): never {
  throw new MultipartError(code, message);
}
function boundaryBytes(boundary: string): Uint8Array {
  if (typeof boundary !== 'string' || !/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary))
    fail('invalid', 'Boundary must contain 1..70 supported ASCII characters.');
  return encoder.encode(boundary);
}
function limits(input: MultipartLimits) {
  const result = {
    parts: input.maxParts ?? 1000,
    part: input.maxPartBytes ?? 16777216,
    total: input.maxTotalBytes ?? 67108864,
    header: input.maxHeaderBytes ?? 8192,
    chunk: input.maxChunkBytes ?? 1048576,
  };
  for (const value of Object.values(result))
    if (!Number.isSafeInteger(value) || value < 1 || value > 1073741824)
      fail('invalid', 'Invalid resource limit.');
  return result;
}
function find(bytes: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let i = start; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
function quote(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[^\x20-\x7e]/.test(value))
    fail('invalid', 'Names and filenames must be nonempty printable ASCII.');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function contentType(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
  )
    fail('invalid', 'Content type must be a bare MIME media type.');
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) fail('aborted', 'Multipart operation aborted.');
}
export async function* encodeMultipart(
  parts: Iterable<MultipartPart> | AsyncIterable<MultipartPart>,
  boundary: string,
  options: MultipartLimits = {},
): AsyncGenerator<Uint8Array> {
  boundaryBytes(boundary);
  const bound = limits(options);
  let count = 0;
  let total = 0;
  function* emit(bytes: Uint8Array): Generator<Uint8Array> {
    check(options.signal);
    if (bytes.length > bound.total - total) fail('limit', 'Total encoded size exceeded.');
    total += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += bound.chunk) {
      check(options.signal);
      yield bytes.slice(offset, offset + bound.chunk);
    }
  }
  for await (const part of parts) {
    check(options.signal);
    if (++count > bound.parts) fail('limit', 'Part count exceeded.');
    if (!part || !(part.data instanceof Uint8Array)) fail('invalid', 'Part requires byte data.');
    if (part.data.length > bound.part) fail('limit', 'Part size exceeded.');
    let header = `Content-Disposition: form-data; name=${quote(part.name)}`;
    if (part.filename !== undefined) header += `; filename=${quote(part.filename)}`;
    if (part.contentType !== undefined) {
      contentType(part.contentType);
      header += `\r\nContent-Type: ${part.contentType}`;
    }
    const headerBytes = encoder.encode(header + '\r\n\r\n');
    if (headerBytes.length > bound.header) fail('limit', 'Part header size exceeded.');
    const data = part.data.slice();
    const marker = encoder.encode(`\r\n--${boundary}`);
    for (let at = find(data, marker); at >= 0; at = find(data, marker, at + 1)) {
      const end = at + marker.length;
      if ((data[end] === 13 && data[end + 1] === 10) || (data[end] === 45 && data[end + 1] === 45))
        fail('invalid', 'Boundary collides with part data. Choose another boundary.');
    }
    // At end of a payload the encoder supplies CRLF; a trailing marker would become a delimiter.
    if (
      data.length >= marker.length &&
      find(data.subarray(data.length - marker.length), marker) === 0
    )
      fail('invalid', 'Trailing boundary collision.');
    yield* emit(encoder.encode(`--${boundary}\r\n`));
    yield* emit(headerBytes);
    for (let offset = 0; offset < data.length; offset += bound.chunk)
      yield* emit(data.slice(offset, offset + bound.chunk));
    yield* emit(encoder.encode('\r\n'));
  }
  yield* emit(encoder.encode(`--${boundary}--\r\n`));
}
function parseHeaders(bytes: Uint8Array): Omit<MultipartPart, 'data'> {
  if (bytes.some((byte) => byte > 127 || byte === 0))
    fail('invalid', 'Only ASCII headers supported.');
  const lines = new TextDecoder().decode(bytes).split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) fail('invalid', 'Malformed part header.');
    const key = match[1]!.toLowerCase();
    if (!['content-disposition', 'content-type'].includes(key) || headers.has(key))
      fail('invalid', 'Unsupported or duplicate part header.');
    headers.set(key, match[2]!);
  }
  const disposition = headers.get('content-disposition') ?? '';
  if (!/^form-data[ \t]*;/i.test(disposition)) fail('invalid', 'Expected form-data disposition.');
  let rest = disposition.replace(/^form-data[ \t]*;/i, '');
  const parameters = new Map<string, string>();
  while (rest.trim()) {
    const match =
      /^\s*(name|filename)\s*=\s*"((?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*)"\s*(?:;|$)/i.exec(
        rest,
      );
    if (!match) fail('invalid', 'Expected quoted name/filename parameters.');
    const key = match[1]!.toLowerCase();
    if (parameters.has(key)) fail('invalid', 'Duplicate disposition parameter.');
    const value = match[2]!.replace(/\\(.)/g, '$1');
    quote(value);
    parameters.set(key, value);
    rest = rest.slice(match[0].length);
  }
  const name = parameters.get('name');
  if (name === undefined) fail('invalid', 'Missing field name.');
  const type = headers.get('content-type');
  if (type !== undefined) contentType(type);
  return {
    name,
    ...(parameters.has('filename') ? { filename: parameters.get('filename')! } : {}),
    ...(type ? { contentType: type } : {}),
  };
}
export async function* parseMultipart(
  source: AsyncIterable<Uint8Array>,
  boundary: string,
  options: MultipartLimits = {},
): AsyncGenerator<MultipartPart> {
  boundaryBytes(boundary);
  const bound = limits(options);
  const first = encoder.encode(`--${boundary}`);
  const marker = encoder.encode(`\r\n--${boundary}`);
  const separator = encoder.encode('\r\n\r\n');
  let buffer: Uint8Array = new Uint8Array();
  let state: 'initial' | 'headers' | 'body' | 'closed' = 'initial';
  let metadata: Omit<MultipartPart, 'data'> | undefined;
  let total = 0;
  let count = 0;
  let scan = 0;
  for await (const input of source) {
    check(options.signal);
    if (!(input instanceof Uint8Array)) fail('invalid', 'Source must yield bytes.');
    if (input.length > bound.chunk || input.length > bound.total - total)
      fail('limit', 'Input chunk/total bound exceeded.');
    total += input.length;
    const next = new Uint8Array(buffer.length + input.length);
    next.set(buffer);
    next.set(input, buffer.length);
    buffer = next;
    while (true) {
      if (state === 'initial') {
        if (buffer.length < first.length + 2) break;
        if (find(buffer, first) !== 0) fail('invalid', 'Preamble or initial boundary mismatch.');
        const suffix = buffer.subarray(first.length, first.length + 2);
        buffer = buffer.slice(first.length + 2);
        if (suffix[0] === 45 && suffix[1] === 45) state = 'closed';
        else if (suffix[0] === 13 && suffix[1] === 10) state = 'headers';
        else fail('invalid', 'Invalid initial delimiter.');
      } else if (state === 'headers') {
        const end = find(buffer, separator);
        if (end < 0) {
          if (buffer.length > bound.header) fail('limit', 'Header size exceeded.');
          break;
        }
        if (end + 4 > bound.header) fail('limit', 'Header size exceeded.');
        if (++count > bound.parts) fail('limit', 'Part count exceeded.');
        metadata = parseHeaders(buffer.subarray(0, end));
        buffer = buffer.slice(end + 4);
        scan = 0;
        state = 'body';
      } else if (state === 'body') {
        let at = find(buffer, marker, scan);
        while (at >= 0) {
          const end = at + marker.length;
          if (buffer.length < end + 2) break;
          if (
            (buffer[end] === 13 && buffer[end + 1] === 10) ||
            (buffer[end] === 45 && buffer[end + 1] === 45)
          )
            break;
          scan = at + 1;
          at = find(buffer, marker, scan);
        }
        if (at < 0 || buffer.length < at + marker.length + 2) {
          if (buffer.length > bound.part + marker.length + 2) fail('limit', 'Part size exceeded.');
          scan = at < 0 ? Math.max(scan, buffer.length - marker.length - 1) : at;
          break;
        }
        if (at > bound.part) fail('limit', 'Part size exceeded.');
        const closing = buffer[at + marker.length] === 45;
        const part = { ...metadata!, data: buffer.slice(0, at) };
        buffer = buffer.slice(at + marker.length + 2);
        state = closing ? 'closed' : 'headers';
        scan = 0;
        yield part;
      } else {
        if (
          buffer.length > 2 ||
          (buffer.length > 0 && buffer[0] !== 13) ||
          (buffer.length === 2 && buffer[1] !== 10)
        )
          fail('invalid', 'Epilogue is unsupported.');
        break;
      }
    }
  }
  check(options.signal);
  if (state !== 'closed' || buffer.length === 1)
    fail('truncated', 'Multipart closing delimiter is incomplete.');
}
