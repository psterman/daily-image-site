/**
 * WebP 尺寸读取（不起进程，直接读文件头）。
 *
 * 为什么不用 ffprobe：量一张图的尺寸要起一个进程（约 150ms），
 * 回退路径要对 245 张图各读 2 次，490 次就是一分半 —— 每次发版都得等。
 * WebP 的宽高写在固定偏移处，直接读字节是微秒级。
 *
 * 三种变体都覆盖：
 *   VP8   有损，ffmpeg 的 libwebp 默认输出；起始码 9d 01 2a 之后是宽高
 *   VP8L  无损，14 位宽 + 14 位高（各减 1）
 *   VP8X  扩展头（带 alpha / 动画），24 位宽 + 24 位高（各减 1）
 */
import fs from 'node:fs/promises';

export async function webpSize(file) {
  const fd = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(30);
    const { bytesRead } = await fd.read(buf, 0, 30, 0);
    if (bytesRead < 30) throw new Error(`WebP 文件过短: ${file}`);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
      throw new Error(`不是 WebP 文件: ${file}`);
    }
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ') {
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) {
        throw new Error(`VP8 帧头异常: ${file}`);
      }
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      if (buf[20] !== 0x2f) throw new Error(`VP8L 头异常: ${file}`);
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') {
      return {
        w: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
        h: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
      };
    }
    throw new Error(`未知的 WebP 变体 ${fourcc}: ${file}`);
  } finally {
    await fd.close();
  }
}
