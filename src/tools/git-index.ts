/**
 * Read the paths of regular files tracked in a Git index (.git/index), formats
 * 2 to 4, SHA-1 or SHA-256. Git lists tracked files even when they match an
 * ignore pattern, and the file listing uses this to do the same.
 *
 * The index is untrusted input. Its paths are only ever compared with paths
 * the listing found on disk, so a crafted index can keep a file from being
 * skipped but cannot add one. Anything malformed yields undefined.
 */
export function readIndexPaths(data: Buffer): string[] | undefined {
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "DIRC") return undefined;

  const version = data.readUInt32BE(4);
  const count = data.readUInt32BE(8);

  if (version < 2 || version > 4 || count * 46 > data.length) return undefined;

  // The hash length depends on the repository's object format, which the index
  // does not record; with the wrong length the entries do not line up.
  return readEntries(data, version, count, 20) ?? readEntries(data, version, count, 32);
}

const ENTRY_STAT_BYTES = 40; // ctime, mtime, dev, ino, mode, uid, gid, size
const EXTENDED_FLAG = 0x4000;
const NAME_LENGTH_MASK = 0x0fff;
const REGULAR_FILE = 0b1000;

function readEntries(data: Buffer, version: number, count: number, hashBytes: number): string[] | undefined {
  const paths: string[] = [];
  let previous: Buffer = Buffer.alloc(0);
  let offset = 12;

  for (let i = 0; i < count; i++) {
    const start = offset;
    const flagsAt = start + ENTRY_STAT_BYTES + hashBytes;

    if (flagsAt + 2 > data.length) return undefined;

    const mode = data.readUInt32BE(start + 24);
    const flags = data.readUInt16BE(flagsAt);
    let nameAt = flagsAt + 2;

    if (flags & EXTENDED_FLAG) {
      if (version < 3) return undefined;
      nameAt += 2;
    }

    let name: Buffer;

    if (version === 4) {
      // The name is the previous one minus N trailing bytes, plus a NUL-terminated suffix.
      const varint = readVarint(data, nameAt);
      if (!varint || varint.value > previous.length) return undefined;

      const end = data.indexOf(0, varint.next);
      if (end === -1) return undefined;

      name = Buffer.concat([previous.subarray(0, previous.length - varint.value), data.subarray(varint.next, end)]);
      offset = end + 1;
    } else {
      const end = data.indexOf(0, nameAt);
      if (end === -1) return undefined;

      name = data.subarray(nameAt, end);
      // Padded with 1 to 8 NUL bytes to a multiple of 8.
      offset = start + ((nameAt - start + name.length + 8) & ~7);
    }

    const declared = flags & NAME_LENGTH_MASK;
    if ((declared !== NAME_LENGTH_MASK && declared !== name.length) || name.length === 0 || offset > data.length) return undefined;

    if (((mode >>> 12) & 0b1111) === REGULAR_FILE) paths.push(name.toString("utf8"));
    previous = name;
  }

  return paths;
}

/** Git's offset varint: 7 bits per byte, high bit set on all but the last, with +1 per continuation. */
function readVarint(data: Buffer, offset: number): { value: number; next: number } | undefined {
  if (offset >= data.length) return undefined;

  let byte = data[offset++]!;
  let value = byte & 0x7f;

  while (byte & 0x80) {
    if (offset >= data.length || value >= 0x1000000) return undefined;
    byte = data[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }

  return { value, next: offset };
}
