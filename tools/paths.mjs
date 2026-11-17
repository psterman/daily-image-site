#!/usr/bin/env node
/**
 * 图片本地存储的路径解析（唯一真源）。
 *
 * 为什么要有这个模块：
 *   图片相关的本地存储有两块，都不该留在 C 盘（系统盘常年吃紧）：
 *     - 源图（人工下载的原始图）        -> IMAGE_ROOT/src/<日期>/{见闻,见她,见笑}
 *     - 已转码母本（上传 R2 的 WebP）    -> IMAGE_ROOT/r2/<日期>/<分类>/*.webp
 *   早先这两块分别在 C:\Users\<user>\Downloads 和工程目录下的 r2/，
 *   散在多个工具里各自硬编码。挪盘就得改 6 个文件，漏一个就静默出 bug。
 *
 * 设计原则：
 *   1. **写**永远写 IMAGE_ROOT 下的规范位置（单一真源，不会两边分裂）
 *   2. **读**按候选列表找，第一个存在的就用 —— 旧路径仍然能认，
 *      所以「源图缺失时从已转码产物重建」那条回退路径不会因为挪盘而断掉
 *   3. 改盘只改 .env.local 里的 IMAGE_ROOT 一行，不动代码
 *
 * 环境变量：
 *   IMAGE_ROOT   本地图片存储总根，默认 <家目录>/image-root
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnv();

export const ROOT = path.resolve(__dirname, '..');

/**
 * 图像本地存储总根（可用 .env.local 的 IMAGE_ROOT 覆盖）。
 *
 * 默认值 = 用户家目录下的 image-root，**所有平台一致**。
 *
 * ⚠️ 刻意不写盘符：写死 'D:\\xxx' 的话，macOS 上没有 D 盘 →
 * **所有读源图的地方静默拿到空目录** —— 审稿台会一张图都不显示，
 * 构建会以为「今天没有图」，而**没有任何报错**。
 * 家目录写法在两个平台上都成立，所以这里必须跟 common.ps1 的
 * Get-ImageRoot 保持同一套规则。
 */
export const IMAGE_ROOT = path.resolve(
  process.env.IMAGE_ROOT && process.env.IMAGE_ROOT.trim()
    ? process.env.IMAGE_ROOT.trim()
    : path.join(os.homedir(), 'image-root')
);

/** 已转码母本目录 —— 构建的写入目标 */
export const R2_LOCAL = path.join(IMAGE_ROOT, 'r2');

/** 源图目录 —— 人工把图片放进 IMAGE_ROOT/src/<日期>/ */
export const SRC_LOCAL = path.join(IMAGE_ROOT, 'src');

/**
 * 旧的源图位置（挪盘前的历史路径，仍然认）。
 * 只在 Windows 上存在 —— macOS 上留个空串，别让 srcSearchRoots 把它当候选。
 */
const LEGACY_SRC = process.platform === 'win32' ? path.join(os.homedir(), 'Downloads') : '';

/** 旧的母本位置（工程目录内，挪盘前的历史路径，仍然认） */
const LEGACY_R2 = path.join(ROOT, 'r2');

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 母本目录的读取候选（第一个存在的胜出）。
 * 找不到时返回规范位置，让报错信息指向「应该在哪」。
 */
export function r2SearchRoots() {
  const list = [R2_LOCAL, LEGACY_R2];
  return list.filter(exists).length ? list.filter(exists) : [R2_LOCAL];
}

/** 源图目录的读取候选（第一个存在的胜出） */
export function srcSearchRoots() {
  // LEGACY_SRC 在 macOS 上是空串 —— 必须滤掉，否则会当成一个候选路径
  const list = [SRC_LOCAL, LEGACY_SRC].filter(Boolean);
  const hit = list.filter(exists);
  return hit.length ? hit : list;
}

/**
 * 在候选根里找出最新的 YYYY-MM-DD 目录名。
 * 返回 null 表示一个都没找到。
 */
export function findLatestDatedDir(roots) {
  const found = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)) found.add(e.name);
    }
  }
  const sorted = [...found].sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/** 在候选根里找出指定日期的目录（返回绝对路径，或 null） */
export function findDatedDir(roots, date) {
  for (const root of roots) {
    const p = path.join(root, date);
    if (exists(p)) return p;
  }
  return null;
}
