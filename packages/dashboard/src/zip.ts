// A ZIP with the files stored as they are (no compression): enough to carry a document and its picture, e.g. for Notion's import.

const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (data: Uint8Array) => { let c = 0xffffffff; for (const b of data) c = TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files: { name: string; data: Uint8Array<ArrayBuffer> }[]): Blob {
  const parts: BlobPart[] = [];
  const directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const record = (size: number, write: (v: DataView) => void) => { const v = new DataView(new ArrayBuffer(size)); write(v); return new Uint8Array(v.buffer); };
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const [crc, size] = [crc32(f.data), f.data.length];
    // fields shared by the local header and the directory entry, from the version on: UTF-8 names, stored, a fixed date, crc, sizes, name length
    const shared = (v: DataView, at: number) => { v.setUint16(at, 20, true); v.setUint16(at + 2, 0x0800, true); v.setUint16(at + 8, 0x0021, true); v.setUint32(at + 10, crc, true); v.setUint32(at + 14, size, true); v.setUint32(at + 18, size, true); v.setUint16(at + 22, name.length, true); };
    parts.push(record(30, (v) => { v.setUint32(0, 0x04034b50, true); shared(v, 4); }), name, f.data);
    directory.push(record(46, (v) => { v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); shared(v, 6); v.setUint32(42, offset, true); }), name);
    offset += 30 + name.length + size;
  }
  const size = directory.reduce((n, d) => n + d.length, 0);
  const end = record(22, (v) => { v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true); v.setUint32(12, size, true); v.setUint32(16, offset, true); });
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}
