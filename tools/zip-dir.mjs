// 纯 Node 的目录打包（真 ZIP），不依赖任何外部程序。
//
// 为什么不用系统自带的 bsdtar（`tar -a -c -f x.zip`）：
//   2026-09-23 实测——在这台机器上那次调用**静默产出了一个 tar**（372.8 MB ≈ 原始体积，
//   头部是 tar 的文件名而非 `PK\x03\x04`），但退出码是 0、脚本还打印了"zip 完成"。
//   也就是说 `-a`（按后缀自动选格式）没有生效，而失败**没有任何声音**。
//   对方拿到的是一个改名为 .zip 的 tar，双击解不开；而这种失败在自动化的"打包成功"日志里
//   完全看不出来。⇒ 与其赌 PATH 上那个 `tar` 是哪一个、支不支持 `-a`，
//   不如自己写：确定性、可单测（断头部魔数）、零外部依赖。
//
// 也刻意不用 PowerShell 的 Compress-Archive：373 MB 的输入它要跑很久，且同样绕不开
// "它到底是哪个实现"的问题。
//
// 用法（CLI）：
//   node tools/zip-dir.mjs <源目录> <输出.zip>
// 用法（模块）：
//   import { zipDirectory } from './zip-dir.mjs';
//   const r = zipDirectory('dist-win/desktop-pet', 'dist-win/x.zip');
//   // → { bytes, entries, stored, deflated }
//
// 压缩后的条目在 zip 里的顶层名 = 源目录的 basename（与 `tar -C <父目录> <目录名>` 同语义），
// 所以解压出来正好是一个 `desktop-pet/` 目录。

import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';

// —— CRC-32（ZIP 每个条目都要带）——
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 把 mtime 转成 DOS 时间/日期（ZIP 用的老格式，1980 起算、秒按 2 秒粒度）。 */
function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

/** 递归列出条目（目录在前、组内按名排序 ⇒ 每次打包产物稳定、可比对）。 */
function listEntries(root, prefix) {
  const out = [];
  // 顶层目录**自己**也写一条 —— GNU tar / bsdtar 都会写，跟着它们走：
  // 这样"解压出来是一个 desktop-pet/ 目录"不依赖解压器愿不愿意替我们补全父目录。
  out.push({ zipPath: `${prefix}/`, abs: root, st: statSync(root), dir: true });
  const walk = (dir, rel) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const abs = join(dir, name);
      const st = statSync(abs);
      const zipPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        out.push({ zipPath: `${prefix}/${zipPath}/`, abs, st, dir: true });
        walk(abs, zipPath);
      } else if (st.isFile()) {
        out.push({ zipPath: `${prefix}/${zipPath}`, abs, st, dir: false });
      }
      // 符号链接/其它类型一律跳过：这个分发目录里不该有，出现了要人工看。
    }
  };
  walk(root, '');
  return out;
}

/**
 * 把 `srcDir` 整个目录压成一个真 ZIP。
 *
 * 逐条目流式写出（不把整个 zip 驻留内存）：大文件只同时持有"原始 + 压缩"两份，
 * 本工程最大的条目是 ~235 MB 的 exe，压缩后 ~104 MB —— 远低于 node 默认 4 GB 堆上限。
 */
export function zipDirectory(srcDir, outZip, opts = {}) {
  const level = opts.level ?? 6;
  const prefix = opts.prefix ?? basename(srcDir);
  const entries = listEntries(srcDir, prefix);

  const fd = openSync(outZip, 'w');
  const central = [];
  let offset = 0;
  let stored = 0;
  let deflated = 0;

  const w = (buf) => {
    writeSync(fd, buf);
    offset += buf.length;
  };

  try {
    for (const e of entries) {
      const { date, time } = dosDateTime(e.st.mtimeMs);
      const nameBuf = Buffer.from(e.zipPath, 'utf8');

      let method = 0;
      let data = Buffer.alloc(0);
      let rawSize = 0;
      let crc = 0;

      if (!e.dir) {
        const raw = readFileSync(e.abs);
        rawSize = raw.length;
        crc = crc32(raw);
        const packed = deflateRawSync(raw, { level });
        // 压不动就原样存（同为合法 ZIP；小文件有时反而会"压大"）
        if (packed.length < raw.length) {
          method = 8;
          data = packed;
          deflated++;
        } else {
          method = 0;
          data = raw;
          stored++;
        }
      } else {
        stored++;
      }

      // 目录条目没有内容，但保留它，解压时目录结构才完整（含空目录）
      const localOffset = offset;
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
      h.writeUInt16LE(20, 4); // 需要的版本
      h.writeUInt16LE(0x0800, 6); // 通用标志位：文件名用 UTF-8
      h.writeUInt16LE(method, 8);
      h.writeUInt16LE(time, 10);
      h.writeUInt16LE(date, 12);
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(data.length, 18);
      h.writeUInt32LE(rawSize, 22);
      h.writeUInt16LE(nameBuf.length, 26);
      h.writeUInt16LE(0, 28); // extra 长度
      w(h);
      w(nameBuf);
      if (data.length) w(data);

      central.push({ nameBuf, method, time, date, crc, comp: data.length, raw: rawSize, localOffset, dir: e.dir });
    }

    // —— 中央目录 ——
    const cdOffset = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // 制作版本
      h.writeUInt16LE(20, 6); // 需要的版本
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.comp, 20);
      h.writeUInt32LE(c.raw, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // 注释
      h.writeUInt16LE(0, 34); // 起始磁盘
      h.writeUInt16LE(0, 36); // 内部属性
      h.writeUInt32LE(c.dir ? 0x10 : 0, 38); // 外部属性：目录位
      h.writeUInt32LE(c.localOffset, 42);
      w(h);
      w(c.nameBuf);
    }
    const cdSize = offset - cdOffset;

    // —— EOCD ——
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    w(eocd);
  } finally {
    closeSync(fd);
  }

  return { bytes: offset, entries: entries.length, stored, deflated };
}

// —— CLI ——
const isCli = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isCli) {
  const [, , src, out] = process.argv;
  if (!src || !out) {
    console.error('用法：node tools/zip-dir.mjs <源目录> <输出.zip>');
    process.exit(2);
  }
  const t0 = Date.now();
  const r = zipDirectory(src, out);
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`[zip] ${relative(process.cwd(), out) || out}`);
  console.log(`[zip] ${r.entries} 个条目（deflate ${r.deflated} / store ${r.stored}）·`
    + ` ${mb(r.bytes)} MB · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
