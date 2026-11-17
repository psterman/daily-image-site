#!/usr/bin/env node
/**
 * 读取本地凭据：环境变量优先，其次 .env.local
 * .env.local 形如：
 *   CLOUDFLARE_ACCOUNT_ID=xxxx
 *   CLOUDFLARE_API_TOKEN=yyyy
 *   R2_BUCKET=your-bucket
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v && !process.env[m[1]]) process.env[m[1]] = v;
    }
  }
  return process.env;
}
