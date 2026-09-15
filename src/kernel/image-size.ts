// 纯 TS 的图片头解析：在把图集交给渲染层之前先确认它是真的 PNG/WebP，
// 并读出真实尺寸用于校验图集规格。不引任何第三方依赖。
//
// 这是 PLAN §8「恶意宠物包」风险的第一道闸：魔数校验 + 尺寸匹配，
// 避免把任意二进制当成精灵图喂给渲染层。
import { readFileSync } from 'node:fs';

export interface ImageInfo {
  format: 'webp' | 'png';
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageHeader(buf: Buffer): ImageInfo {
  if (buf.length < 32) throw new Error('文件过小，不是合法图片');

  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 缺少 IHDR 块');
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ...parseWebP(buf), format: 'webp' };
  }

  throw new Error('不是受支持的图片格式（仅 PNG / WebP）');
}

function parseWebP(buf: Buffer): { width: number; height: number } {
  let p = 12;
  while (p + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const payload = p + 8;

    if (fourcc === 'VP8X') {
      // 扩展型：canvasWidth-1 与 canvasHeight-1 各占 3 字节小端
      if (payload + 10 > buf.length) break;
      return {
        width: (buf.readUIntLE(payload + 4, 3)) + 1,
        height: (buf.readUIntLE(payload + 7, 3)) + 1,
      };
    }
    if (fourcc === 'VP8 ') {
      // 有损：3 字节帧头之后是 14 位宽、14 位高
      if (payload + 10 > buf.length) break;
      return {
        width: buf.readUInt16LE(payload + 6) & 0x3fff,
        height: buf.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    if (fourcc === 'VP8L') {
      // 无损：签名 1 字节后，14 位宽-1、14 位高-1
      if (payload + 5 > buf.length) break;
      const bits = buf.readUInt32LE(payload + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }

    // 块尺寸按偶数字节对齐
    p = payload + size + (size % 2);
  }
  throw new Error('WebP 中找不到 VP8/VP8L/VP8X 图像块');
}

/** 读文件头部用于嗅探（最多 64 KB，足够覆盖所有头块）。 */
export function sniffImageFile(path: string, maxBytes: number): { info: ImageInfo; bytes: number } {
  const fd = readFileSync(path);
  return { info: sniffImageHeader(fd.subarray(0, Math.min(fd.length, 65536))), bytes: fd.length };
}

/** 图集尺寸契约：V1 = 1536x1872，V2 = 1536x2288。 */
export function expectedAtlasSize(spriteVersionNumber: number | undefined): { width: number; height: number } {
  return spriteVersionNumber === 2 ? { width: 1536, height: 2288 } : { width: 1536, height: 1872 };
}

export const CELL = { width: 192, height: 208 } as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;   // 官方上传上限，超出仅告警
export const HARD_MAX_BYTES = 64 * 1024 * 1024;     // 本地运行时的硬上限，超出直接拒绝
