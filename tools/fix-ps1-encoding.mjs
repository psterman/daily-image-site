#!/usr/bin/env node
/**
 * 把 .ps1 文件统一成 UTF-8 with BOM，并做一次 PS 5.1 语法解析检查。
 *
 * 为什么必须是 BOM：Windows PowerShell 5.1 读取无 BOM 的 .ps1 时，
 * 会按系统 ANSI 代码页解码文件里的中文，于是中文字符被拆成乱码字节，
 * 引号配对失败 -> "字符串缺少终止符" 之类的解析崩溃。
 *
 * 用法：node tools/fix-ps1-encoding.mjs [文件...]
 *       不带参数则处理 tools/ 下全部 .ps1
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => path.resolve(ROOT, f))
  : fs
      .readdirSync(path.join(ROOT, 'tools'))
      .filter((f) => f.endsWith('.ps1'))
      .map((f) => path.join(ROOT, 'tools', f));

let bad = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`跳过（不存在）: ${file}`);
    continue;
  }
  const buf = fs.readFileSync(file);
  const hasBom = buf.subarray(0, 3).toString('hex').toUpperCase() === 'EFBBBF';
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!hasBom) {
    fs.writeFileSync(file, '\uFEFF' + text, 'utf8');
    console.log(`已加 BOM: ${path.basename(file)}`);
  }

  // 语法检查：让 PowerShell 自己解析一遍
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$errors=$null; [void][System.Management.Automation.PSParser]::Tokenize((Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw), [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(`✓ 语法 OK  ${path.basename(file)}`);
  } catch (e) {
    bad++;
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    console.log(`✗ 语法错误 ${path.basename(file)}`);
    console.log(out.split(/\r?\n/).slice(0, 6).map((l) => '    ' + l).join('\n'));
  }
}

process.exit(bad ? 1 : 0);
