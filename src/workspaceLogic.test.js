import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssetOrder,
  validateWorkspace,
  buildPromptPreview,
  createCanvasSlots,
  createProductSlots,
  canSelectMode,
  getCanvasSpec,
  buildReferenceChain,
  createClearedState,
  buildSubmissionAssets,
  getActionState,
  splitPagePrompts,
} from './workspaceLogic.js';
import { BEAUTY_V5_SYSTEM_PROMPT } from '../server/beautySkillPrompt.js';

test('builds the required fixed image order for two product assets', () => {
  assert.deepEqual(buildAssetOrder(2), [
    '产品精修图 01',
    '产品精修图 02',
    '运营要求图',
    '风格参考图',
  ]);
});

test('submits images in strict product then operations then style order', () => {
  assert.deepEqual(buildSubmissionAssets({
    productAssets: [{ dataUrl: 'p1' }, { dataUrl: 'p2' }, null],
    operationsAsset: { dataUrl: 'ops' },
    styleAsset: { dataUrl: 'style' },
  }), ['p1', 'p2', 'ops', 'style']);
});

test('keeps both action buttons idle until one is clicked', () => {
  assert.equal(getActionState('batch', null, false), 'idle');
  assert.equal(getActionState('pages', null, false), 'idle');
  assert.equal(getActionState('batch', 'batch', false), 'active');
  assert.equal(getActionState('pages', 'batch', false), 'idle');
  assert.equal(getActionState('batch', 'batch', true), 'loading');
});

test('treats notes as image interpretation constraints rather than appended copy', () => {
  assert.match(BEAUTY_V5_SYSTEM_PROMPT, /解释与约束层/);
  assert.match(BEAUTY_V5_SYSTEM_PROMPT, /不得机械追加/);
});

test('uses the successfully uploaded product count without asking for confirmation', () => {
  assert.match(BEAUTY_V5_SYSTEM_PROMPT, /实际成功读取的上传数量/);
  assert.match(BEAUTY_V5_SYSTEM_PROMPT, /不得再次询问或要求确认/);
});

test('keeps five visible slots while assigning a four-image submission order for two products', () => {
  const chain = buildReferenceChain({
    productAssets: [{ id: 'p1' }, { id: 'p2' }, null],
    operationsAsset: { id: 'ops' },
    styleAsset: { id: 'style' },
  });
  assert.deepEqual(chain.map(item => [item.position, item.label, item.asset?.id, item.optional]), [
    [1, '产品精修图 01', 'p1', false],
    [2, '产品精修图 02', 'p2', true],
    [null, '产品精修图 03', undefined, true],
    [3, '运营要求图', 'ops', false],
    [4, '风格参考图', 'style', false],
  ]);
});

test('shows all five available slots before any product upload', () => {
  const chain = buildReferenceChain({ productAssets: [null, null, null], operationsAsset: null, styleAsset: null });
  assert.deepEqual(chain.map(item => item.label), ['产品精修图 01', '产品精修图 02', '产品精修图 03', '运营要求图', '风格参考图']);
  assert.deepEqual(chain.map(item => item.position), [1, null, null, 2, 3]);
});

test('keeps one required product placeholder in the order before uploads', () => {
  assert.deepEqual(buildAssetOrder(0), [
    '产品精修图 01',
    '运营要求图',
    '风格参考图',
  ]);
});

test('blocks prompt generation when fewer than three required images are ready', () => {
  const result = validateWorkspace({
    productAssets: [{ status: 'ready' }],
    operationsAsset: null,
    styleAsset: { status: 'ready' },
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /运营要求图/);
});

test('accepts one to three product assets plus operations and style images', () => {
  const result = validateWorkspace({
    productAssets: [{ status: 'ready' }, { status: 'ready' }],
    operationsAsset: { status: 'ready' },
    styleAsset: { status: 'ready' },
  });

  assert.deepEqual(result, { ok: true, message: '' });
});

test('keeps exactly three independent product upload slots', () => {
  const slots = createProductSlots([{ id: 'asset-1', status: 'ready' }]);
  assert.equal(slots.length, 3);
  assert.equal(slots[0].id, 'asset-1');
  assert.equal(slots[1], null);
  assert.equal(slots[2], null);
});

test('enables mode selection after the complete minimum image set is ready', () => {
  assert.equal(canSelectMode({
    productAssets: [{ status: 'ready' }, null, null],
    operationsAsset: { status: 'ready' },
    styleAsset: { status: 'ready' },
  }), true);
});

test('creates a concise prompt placeholder for the chosen mode', () => {
  const prompt = buildPromptPreview({
    mode: 'batch',
    modelName: '视觉模型 A',
    productCount: 2,
  });

  assert.match(prompt, /Lovart 批量/);
  assert.match(prompt, /视觉模型 A/);
  assert.match(prompt, /2 张产品精修图/);
});

test('creates exactly five output canvases', () => {
  assert.deepEqual(createCanvasSlots(), [1, 2, 3, 4, 5]);
});

test('splits fenced Chinese screen prompts into independent ordered pages', () => {
  const prompts = splitPagePrompts('```text\n【第1屏｜KV】\n内容一\n```\n```text\n【第2屏｜卖点】\n内容二\n```\n```text\n【第3屏｜成分】\n内容三\n```');
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /第1屏/);
  assert.match(prompts[1], /第2屏/);
  assert.match(prompts[2], /第3屏/);
});

test('splits PAGE markers without requiring a word boundary after Chinese text', () => {
  assert.equal(splitPagePrompts('PAGE 01 hero\na\nPAGE 02 detail\nb').length, 2);
});

test('uses the requested portrait result ratio without full-size rendering', () => {
  assert.deepEqual(getCanvasSpec(), { width: 1330, height: 2200, ratio: '1330 / 2200' });
});

test('creates a complete empty state for one-click reset', () => {
  const state = createClearedState();
  assert.equal(state.modelId, 'kimi');
  assert.deepEqual(state.productAssets, [null, null, null]);
  assert.deepEqual(state.productNotes, ['', '', '']);
  assert.equal(state.operationsAsset, null);
  assert.equal(state.styleAsset, null);
  assert.equal(state.activeMode, null);
  assert.match(state.prompt, /选择生成方式/);
});
