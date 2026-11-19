/**
 * 日更流水策略：按源名 / contentType 解析 maxAgeDays + dailyCap。
 * 浏览器不依赖；Node 抓取与入库共用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'tools/pipeline-sources.json');

let _cached = null;

export function loadPipelineConfig() {
  if (_cached) return _cached;
  try {
    _cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    _cached = { defaultsByType: {}, sources: {} };
  }
  return _cached;
}

/** 测试或热更新时可清缓存 */
export function resetPipelineConfigCache() {
  _cached = null;
}

/**
 * @param {{ name?: string, contentType?: string, content_type?: string, maxAgeDays?: number, dailyCap?: number, perFeed?: number }} feed
 * @param {{ maxAgeDays?: number, perFeed?: number }} [cfg]
 * @returns {{ tier: string, maxAgeDays: number, dailyCap: number, keepNoTs: boolean, pipeline: boolean }}
 */
export function resolveFeedPolicy(feed, cfg = {}) {
  const conf = loadPipelineConfig();
  const name = String((feed && feed.name) || '').trim();
  const ct = String((feed && (feed.contentType || feed.content_type)) || '').trim();
  const byName = (conf.sources && conf.sources[name]) || null;
  const byType = (conf.defaultsByType && (conf.defaultsByType[ct] || conf.defaultsByType._)) || {};

  const globalAge = Number(cfg.maxAgeDays) > 0 ? Number(cfg.maxAgeDays) : 0;
  const globalPer = Number(cfg.perFeed) > 0 ? Number(cfg.perFeed) : 8;

  // 优先级：源名特例 > 格式默认 > feed 字段 > 全局
  // （格式默认压过旧的 feed.maxAgeDays=45，避免播客整库）
  const maxAgeDays = Number(byName?.maxAgeDays) > 0
    ? Number(byName.maxAgeDays)
    : (Number(byType.maxAgeDays) > 0
      ? Number(byType.maxAgeDays)
      : (Number(feed?.maxAgeDays) > 0 ? Number(feed.maxAgeDays) : globalAge));

  const dailyCap = Number(byName?.dailyCap) > 0
    ? Number(byName.dailyCap)
    : (Number(byType.dailyCap) > 0
      ? Number(byType.dailyCap)
      : (Number(feed?.dailyCap || feed?.perFeed) > 0
        ? Number(feed.dailyCap || feed.perFeed)
        : globalPer));

  const keepNoTs = !!(byName?.keepNoTs || byType.keepNoTs);
  const tier = String(byName?.tier || (ct === 'note' ? 'note' : ct === 'podcast' ? 'podcast' : ct === 'link' ? 'link' : 'default'));
  const pipeline = ['board', 'wire', 'media', 'thin'].includes(String(byName?.tier || ''));

  return {
    tier,
    maxAgeDays,
    dailyCap: Math.max(1, dailyCap),
    keepNoTs,
    pipeline,
  };
}

/** publisher 名 → dailyCap（仅白名单流水源） */
export function pipelinePublisherCaps() {
  const conf = loadPipelineConfig();
  const out = new Map();
  for (const [name, rule] of Object.entries(conf.sources || {})) {
    if (!rule || !['board', 'wire', 'media', 'thin'].includes(String(rule.tier || ''))) continue;
    const cap = Number(rule.dailyCap) > 0 ? Number(rule.dailyCap) : 0;
    if (cap > 0) out.set(name, cap);
  }
  return out;
}
