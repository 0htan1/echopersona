import zlib from 'node:zlib';
import path from 'node:path';
import { config } from '../config.js';

const SUPPORTED_EXT = new Set(['txt', 'log', 'json', 'csv', 'tsv', 'md', 'markdown']);

/**
 * Safe ZIP extraction using the central directory.
 * Guards: entry count, per-entry + total uncompressed size (zip-bomb),
 * path traversal, absolute paths, encrypted entries, symlinks.
 */
export function extractZip(buffer, { maxEntries = config.maxZipEntries, maxTotal = config.maxZipUncompressed } = {}) {
  // locate EOCD
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到中央目录）');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries > maxEntries) throw new Error(`压缩包内文件过多（${totalEntries}），上限 ${maxEntries}`);
  if (cdOffset >= buffer.length) throw new Error('ZIP 中央目录偏移损坏');

  const out = [];
  let totalOut = 0;
  let p = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (p + 46 > buffer.length) break;
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;

    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const extAttr = buffer.readUInt32LE(p + 38);
    const localOff = buffer.readUInt32LE(p + 42);
    const nameBuf = buffer.subarray(p + 46, p + 46 + nameLen);
    const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');

    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) continue;                                    // encrypted -> skip
    if (name.endsWith('/')) continue;                             // directory
    const unixMode = (extAttr >>> 16) & 0o170000;
    if (unixMode === 0o120000) continue;                          // symlink
    if (name.startsWith('/') || name.includes('\\') || /(^|\/)\.\.(\/|$)/.test(name)) continue; // traversal
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) continue; // zip64 -> skip

    if (totalOut + uncompSize > maxTotal) {
      throw new Error(`压缩包解压后总大小超过限制（>${Math.round(maxTotal / 1024 / 1024)}MB）`);
    }

    // read local header to find data offset
    if (localOff + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) continue;
    const raw = buffer.subarray(dataStart, dataEnd);

    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompSize, 1024) + 1024 });
      else continue; // unsupported compression
    } catch {
      continue; // corrupted entry -> skip, report via caller
    }

    totalOut += data.length;
    out.push({ name: path.basename(name), fullPath: name, data, crcOk: crc === crc32(data) });
  }

  return out;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

export function isSupportedFile(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return SUPPORTED_EXT.has(ext);
}

export const SUPPORTED_FORMATS = [...SUPPORTED_EXT];
