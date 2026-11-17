/**
 * ffmpeg / ffprobe 的「格式探测失败」回退。
 *
 * 为什么需要：
 *   ffmpeg 靠**内容**猜输入格式，但福利吧的图有个坑 ——
 *   URL 形如
 *     .../v2/thumb/retype_exclude_gif/ext/auto/q/100/?appid=122&url=<真实地址>.jpg
 *   后缀是从 URL 猜的（URL 里带 "gif" → .gif），但**内容其实是 JPEG**。
 *
 *   2026-11-08 实测（336 张里正好 1 张）：039_67a65.gif
 *     默认探测    : ffprobe 报 "End of file"，ffmpeg 报 "could not find codec parameters"
 *     -f gif      : 一样失败（所以不是「解复用器选错」，是内容探测没匹配上）
 *     -f image2pipe / -f mjpeg : 尺寸对、转码也对（1164x1608 → 600x828 WebP）
 *
 *   而 PIL 放行这张图 —— Pillow 遇到截断的 JPEG 会静默补灰，不报错，
 *   所以「拿 PIL 验一遍」根本发现不了这个问题。
 *
 * 对策：默认探测失败就用 `-f image2pipe` 再来一次。
 *   两次都不行才算真坏（那才是真的要报错停手）。
 *
 * 单独抽成模块是为了能测：
 *   触发条件是「文件内容」，没法稳定复现；
 *   但**回退机制本身**可以用假二进制测得很死（见 tools/test-media-fallback.mjs）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 回退时强制指定的输入格式。 */
export const FALLBACK_IN_FMT = ['-f', 'image2pipe'];

/**
 * 跑一次外部命令；失败就把输入格式强制成 image2pipe 再跑一次。
 *
 * @param {string} bin     可执行文件
 * @param {string[]} args  完整参数
 * @param {number} inputAt 输入项在 args 里的下标（'-i' 或文件名的位置）
 * @param {string} [label] 出错时用来说明是哪个文件
 * @returns {Promise<{ ok: true, stdout: string, fallback: boolean }>}
 * @throws 两次都失败时抛 Error，消息里带上两次各自的失败原因
 */
export async function runWithFormatFallback(bin, args, inputAt, label = '') {
  try {
    const { stdout } = await execFileAsync(bin, args);
    return { ok: true, stdout, fallback: false };
  } catch (firstErr) {
    const retry = [...args];
    retry.splice(inputAt, 0, ...FALLBACK_IN_FMT);
    try {
      const { stdout } = await execFileAsync(bin, retry);
      return { ok: true, stdout, fallback: true };
    } catch (secondErr) {
      const detail = (e) => String(e.stderr || e.message || '').trim();
      throw new Error(
        (label ? label + '：' : '') + '两种输入格式都试过了，仍然失败\n' +
        '  默认探测  : ' + detail(firstErr) + '\n' +
        '  image2pipe: ' + detail(secondErr),
      );
    }
  }
}
