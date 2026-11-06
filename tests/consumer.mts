import { encodeMultipart, parseMultipart, MultipartError } from '@lp-labs/multipart-codec';
const api = [encodeMultipart, parseMultipart, MultipartError];
void api;
const bytes: AsyncGenerator<Uint8Array> = encodeMultipart(
  [{ name: 'field', data: new Uint8Array() }],
  'b',
);
void bytes;
async function consume() {
  for await (const part of parseMultipart(
    (async function* () {
      yield new Uint8Array();
    })(),
    'b',
  )) {
    const name: string = part.name;
    void name;
  }
}
void consume;
