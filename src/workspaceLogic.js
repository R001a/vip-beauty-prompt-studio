export const buildAssetOrder = productCount => [
  ...Array.from({ length: Math.max(1, Math.min(3, productCount)) }, (_, index) => `产品精修图 ${String(index + 1).padStart(2, '0')}`),
  '运营要求图',
  '风格参考图',
];

export const validateWorkspace = ({ productAssets, operationsAsset, styleAsset }) => {
  const uploadedProducts = productAssets.filter(Boolean);
  if (!uploadedProducts.length) return { ok: false, message: '请至少上传 1 张产品精修图。' };
  if (uploadedProducts.length > 3) return { ok: false, message: '产品精修图最多上传 3 张。' };
  if (uploadedProducts.some(asset => asset.status !== 'ready')) return { ok: false, message: '产品精修图尚未全部读取成功。' };
  if (!operationsAsset || operationsAsset.status !== 'ready') return { ok: false, message: '请上传并确认运营要求图读取成功。' };
  if (!styleAsset || styleAsset.status !== 'ready') return { ok: false, message: '请上传并确认风格参考图读取成功。' };
  return { ok: true, message: '' };
};

export const buildPromptPreview = ({ mode, modelName, productCount }) => {
  const modeName = mode === 'batch' ? 'Lovart 批量' : '分屏独立生成';
  return `【${modeName}｜待模型解析】\n当前模型：${modelName}\n输入素材：${productCount} 张产品精修图 + 1 张运营要求图 + 1 张风格参考图。\n\n图片读取锁已通过。接入视觉大模型后，此区域将依据「美妆项目反推提示词 Skill」输出完整 V5 提示词；当前版本仅完成交互与模型接口占位，不会上传素材或调用远端模型。`;
};

export const createCanvasSlots = () => Array.from({ length: 5 }, (_, index) => index + 1);

export const createProductSlots = assets => Array.from({ length: 3 }, (_, index) => assets[index] || null);

export const canSelectMode = workspace => validateWorkspace(workspace).ok;

export const getActionState = (mode, activeMode, generating) => generating && mode === activeMode ? 'loading' : mode === activeMode ? 'active' : 'idle';

export const buildSubmissionAssets = ({ productAssets, operationsAsset, styleAsset }) => [
  ...productAssets.filter(Boolean).map(asset => asset.dataUrl),
  operationsAsset?.dataUrl,
  styleAsset?.dataUrl,
].filter(Boolean);

export const getCanvasSpec = () => ({ width: 1330, height: 2200, ratio: '1330 / 2200' });

export const splitPagePrompts = text => {
  const source = String(text || '').trim();
  if (!source) return [];
  const marked = source.split(/(?=^\s*(?:#{1,4}\s*)?(?:第\s*[一二三四五六七八九十\d]+\s*屏|PAGE\s*0?\d+)\b)/gim).map(value => value.trim()).filter(Boolean);
  return marked.length > 1 ? marked : [source];
};

export const buildReferenceChain = ({ productAssets, operationsAsset, styleAsset }) => {
  const uploadedCount = productAssets.filter(Boolean).length;
  let submittedProductPosition = 0;
  const products = createProductSlots(productAssets).map((asset, index) => ({
    label: `产品精修图 ${String(index + 1).padStart(2, '0')}`,
    asset,
    optional: index > 0,
    position: asset ? ++submittedProductPosition : uploadedCount === 0 && index === 0 ? 1 : null,
  }));
  const requiredProductCount = Math.max(1, uploadedCount);
  return [
    ...products,
    { label: '运营要求图', asset: operationsAsset, optional: false, position: requiredProductCount + 1 },
    { label: '风格参考图', asset: styleAsset, optional: false, position: requiredProductCount + 2 },
  ];
};

export const createClearedState = () => ({
  modelId: 'kimi',
  productAssets: createProductSlots([]),
  productNotes: ['', '', ''],
  operationsAsset: null,
  styleAsset: null,
  operationsNote: '',
  styleNote: '',
  activeMode: null,
  message: '',
  prompt: '选择生成方式后，V5 提示词将在这里生成。\n\n提示词区域保持固定高度，可通过右侧滚动条检查完整内容。',
});
