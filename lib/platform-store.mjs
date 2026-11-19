/**
 * 用户自建平台：持久化层（仅 Node）。
 *
 * 纯数据原语已拆到 platform-model.mjs（浏览器 / Node 通用）。这个文件只做一件事：
 * 把 db 落盘到 JSON 文件、从文件读回。业务函数（platform-flow.mjs）不依赖这里，
 * 所以整条流水线在浏览器里也能跑；接 Supabase 时只需换掉 loadDb / saveDb。
 *
 * 为了不改变调用方，这里把 platform-model.mjs 的全部导出原样重导出 ——
 * 旧代码 `import { emptyDb, seedTagPacks } from './platform-store.mjs'` 继续可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './platform-model.mjs';
import { emptyDb, seedTagPacks } from './platform-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_DB_PATH = path.join(ROOT, '.data', 'platform', 'db.json');

/** 读库；文件不存在或坏掉时回落到 seed 过的新库，不让闭环因脏文件起不来。 */
export async function loadDb(file = DEFAULT_DB_PATH) {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const db = JSON.parse(raw);
    return seedTagPacks({ ...emptyDb(), ...db });
  } catch {
    return seedTagPacks(emptyDb());
  }
}

/** 原子落盘：先写临时文件再改名，避免半截文件被下一次 loadDb 读到。 */
export async function saveDb(db, file = DEFAULT_DB_PATH) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, file);
  return file;
}
