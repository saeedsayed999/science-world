// Converts a .glb into a self-contained glTF JSON (buffer as a data URI).
// Usage: node tools/glb_to_json.mjs in.glb out.json
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
const glb = readFileSync(src);
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file');
let off = 12, json, bin;
while (off < glb.length) {
  const len = glb.readUInt32LE(off), type = glb.readUInt32LE(off + 4);
  const chunk = glb.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
  if (type === 0x004e4942) bin = chunk;
  off += 8 + len;
}
json.buffers = [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }];
writeFileSync(dst, JSON.stringify(json));
console.log(`wrote ${dst} (${(JSON.stringify(json).length / 1024).toFixed(1)} KB)`);
