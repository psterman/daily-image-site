/**
 * 流水策略自检
 *   node tools/test-pipeline-policy.mjs
 */
import assert from 'node:assert/strict';
import {
  resolveFeedPolicy,
  pipelinePublisherCaps,
  resetPipelineConfigCache,
} from '../lib/pipeline-policy.mjs';

resetPipelineConfigCache();

const reuters = resolveFeedPolicy({ name: '路透中文' }, { maxAgeDays: 2, perFeed: 8 });
assert.equal(reuters.tier, 'wire');
assert.equal(reuters.maxAgeDays, 1);
assert.equal(reuters.dailyCap, 40);
assert.equal(reuters.pipeline, true);

const tw = resolveFeedPolicy({ name: 'Twitter·OpenAI', contentType: 'note' }, { maxAgeDays: 2, perFeed: 8 });
assert.equal(tw.maxAgeDays, 2);
assert.equal(tw.dailyCap, 8);
assert.equal(tw.pipeline, false);

const pod = resolveFeedPolicy(
  { name: '故事FM', contentType: 'podcast', maxAgeDays: 45 },
  { maxAgeDays: 2, perFeed: 8 },
);
assert.equal(pod.maxAgeDays, 7); // 格式默认压过 feed 的 45
assert.equal(pod.dailyCap, 5);

const bili = resolveFeedPolicy({ name: 'B站每周必看', contentType: 'video', maxAgeDays: 45 }, {});
assert.equal(bili.maxAgeDays, 45);
assert.equal(bili.dailyCap, 50);
assert.equal(bili.keepNoTs, true);

const caps = pipelinePublisherCaps();
assert.ok(caps.get('抽屉热榜') >= 25);
assert.ok(caps.get('路透中文') === 40);

console.log('ok pipeline-policy');
