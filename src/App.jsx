import { useEffect, useMemo, useRef, useState } from 'react';
import { buildReferenceChain, buildSubmissionAssets, canSelectMode, createCanvasSlots, createClearedState, createProductSlots, getActionState, getCanvasSpec, splitPagePrompts, validateWorkspace } from './workspaceLogic.js';

const MODELS = [
  { id: 'kimi', name: 'Kimi K3', meta: 'Vision · 1M Context', tone: 'coral' },
  { id: 'openai', name: 'OpenAI GPT-5.6', meta: 'Responses · Image 2 Ready', tone: 'violet' },
  { id: 'cpass', name: 'CPASS 平台 GPT-5.6 Terra', meta: 'OpenAI Compatible · 暂不可用', tone: 'cyan' },
];
const IMAGE_MODEL = 'gpt-image-2.5-sunburst';
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || 'https://vip-beauty-prompt-studio.vercel.app').replace(/\/$/, '');
const apiUrl = path => import.meta.env.DEV ? path : `${API_BASE_URL}${path}`;

const readFile = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片文件读取失败')); reader.readAsDataURL(file); });
const decodeImage = source => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片无法解码，请重新上传')); image.src = source; });
const fileToAsset = async file => {
  if (!file.type.startsWith('image/')) throw new Error('请选择有效图片文件');
  const source = await readFile(file);
  const image = await decodeImage(source);
  let dataUrl = source;
  if (image.naturalWidth > 1000 || image.naturalHeight > 6500 || file.size > 24 * 1024 * 1024) {
    const scale = Math.min(1, 1000 / image.naturalWidth, 6500 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL('image/webp', .94);
    await decodeImage(dataUrl);
  }
  return { id: `${file.name}-${file.lastModified}-${Math.random()}`, name: file.name, size: file.size, status: 'ready', url: dataUrl, dataUrl, resized: dataUrl !== source };
};
const prettySize = bytes => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function UploadEmpty({ title, hint, onClick, compact = false }) {
  return <button className={`upload-empty ${compact ? 'compact' : ''}`} type="button" onClick={onClick}><span className="upload-plus">+</span><strong>{title}</strong><span>{hint}</span></button>;
}

function AssetPreview({ asset, label, onRemove, onNoteChange }) {
  return <article className="asset-card">
    <div className="asset-image-wrap"><img src={asset.url} alt={label} /><span className="asset-index">{label}</span><button className="remove-button" type="button" onClick={onRemove} aria-label={`移除${label}`}>×</button></div>
    <div className="asset-meta"><div><strong>{asset.name}</strong><span>{prettySize(asset.size)} · {asset.resized ? '已等比缩至宽≤1000px、高≤6500px' : '本地临时缓存'}</span></div><span className="read-state"><i /> 已读取</span></div>
    {onNoteChange && <textarea value={asset.note} onChange={event => onNoteChange(event.target.value)} placeholder="补充这张精修图的用途，例如：首屏主视觉 / 打开状态…" rows={2} />}
  </article>;
}

function ProductSlot({ index, asset, note, onFile, onRemove, onNoteChange }) {
  const inputRef = useRef(null);
  const label = `A${String(index + 1).padStart(2, '0')}`;
  return <article className="product-slot">
    <input ref={inputRef} hidden type="file" accept="image/*" onChange={event => event.target.files[0] && onFile(event.target.files[0])} />
    {asset
      ? <AssetPreview asset={asset} label={label} onRemove={onRemove} />
      : <UploadEmpty title={`精修图 ${String(index + 1).padStart(2, '0')}`} hint="点击上传单张图片" onClick={() => inputRef.current?.click()} />}
    <label className="field-label product-note">备注提示词 <span>可选</span><textarea value={note} onChange={event => onNoteChange(event.target.value)} rows={3} placeholder={`补充 Asset ${String(index + 1).padStart(2, '0')} 的用途或限制…`} /></label>
    {asset && <button className="replace-button" type="button" onClick={() => inputRef.current?.click()}>替换这张图片</button>}
  </article>;
}

function SingleAssetPanel({ number, eyebrow, title, description, asset, note, onNoteChange, onFile, onRemove }) {
  const inputRef = useRef(null);
  return <section className="single-panel panel">
    <div className="panel-heading"><span className="section-number">{number}</span><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div></div>
    <input ref={inputRef} hidden type="file" accept="image/*" onChange={event => event.target.files[0] && onFile(event.target.files[0])} />
    {asset ? <AssetPreview asset={asset} label={number === '03' ? 'OPS' : 'STYLE'} onRemove={onRemove} /> : <UploadEmpty compact title={`上传${title}`} hint="PNG / JPG / WEBP" onClick={() => inputRef.current?.click()} />}
    <label className="field-label">补充提示词 <span>可选</span><textarea value={note} onChange={event => onNoteChange(event.target.value)} rows={3} placeholder={`补充${title}中未写明、但需要模型执行的信息…`} /></label>
  </section>;
}

export default function App() {
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [providerState, setProviderState] = useState({});
  const [generating, setGenerating] = useState(false);
  const [errorToast, setErrorToast] = useState('');
  const [productAssets, setProductAssets] = useState(() => createProductSlots([]));
  const [productNotes, setProductNotes] = useState(['', '', '']);
  const [operationsAsset, setOperationsAsset] = useState(null);
  const [styleAsset, setStyleAsset] = useState(null);
  const [operationsNote, setOperationsNote] = useState('');
  const [styleNote, setStyleNote] = useState('');
  const [prompt, setPrompt] = useState('选择生成方式后，V5 提示词将在这里生成。\n\n提示词区域保持固定高度，可通过右侧滚动条检查完整内容。');
  const [activeMode, setActiveMode] = useState(null);
  const [message, setMessage] = useState('');
  const [copyState, setCopyState] = useState('复制提示词');
  const [generatedImages, setGeneratedImages] = useState([]);
  const [previewImage, setPreviewImage] = useState(null);
  const [generationPassword, setGenerationPassword] = useState('');
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState(null);
  const activeModel = MODELS.find(model => model.id === modelId);
  const productCount = productAssets.filter(Boolean).length;
  const referenceChain = useMemo(() => buildReferenceChain({ productAssets, operationsAsset, styleAsset }), [productAssets, operationsAsset, styleAsset]);
  const canvasSlots = useMemo(() => createCanvasSlots(), []);
  const canvasSpec = getCanvasSpec();
  const modeReady = canSelectMode({ productAssets, operationsAsset, styleAsset });
  const showError = error => { const text = error?.message || String(error); setMessage(text); setErrorToast(text); };
  useEffect(() => { fetch(apiUrl('/api/providers')).then(response => response.json()).then(data => setProviderState(Object.fromEntries((data.providers || []).map(provider => [provider.id, provider])))).catch(() => showError('模型配置状态读取失败，请检查 Vercel 接口。')); }, []);
  useEffect(() => { if (!errorToast) return undefined; const timer = setTimeout(() => setErrorToast(''), 4500); return () => clearTimeout(timer); }, [errorToast]);

  const setProductAt = async (index, file) => { try { const asset = await fileToAsset(file); setProductAssets(current => { const next = [...current]; next[index] = asset; return next; }); setMessage(''); } catch (error) { showError(error); } };
  const removeProductAt = index => setProductAssets(current => {
    const next = [...current];
    if (next[index]) URL.revokeObjectURL(next[index].url);
    next[index] = null;
    return next;
  });
  const updateProductNote = (index, note) => setProductNotes(current => current.map((value, noteIndex) => noteIndex === index ? note : value));
  const replaceSingle = async (setter, current, file) => { try { setter(await fileToAsset(file)); setMessage(''); } catch (error) { showError(error); } };
  const removeSingle = (setter, current) => { if (current) URL.revokeObjectURL(current.url); setter(null); };
  const createPrompt = async (mode, passwordOverride = generationPassword) => {
    const check = validateWorkspace({ productAssets, operationsAsset, styleAsset });
    if (!check.ok) { showError(check.message); return; }
    if (!providerState[modelId]?.configured) { showError('当前模型尚未配置或配置未被服务端读取。'); return; }
    setMessage(''); setActiveMode(mode); setGenerating(true); setPrompt(`正在由 ${activeModel.name} 读取图片并编译 V5 提示词…`);
    try {
      const response = await fetch(apiUrl('/api/compile-prompt'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: modelId, mode, images: buildSubmissionAssets({ productAssets, operationsAsset, styleAsset }), notes: { productNotes, operationsNote, styleNote } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '提示词生成失败');
      setPrompt(data.text);
      if (mode === 'pages') {
        const pagePrompts = splitPagePrompts(data.text);
        setMessage(`提示词已完成，正在用 ${IMAGE_MODEL} 逐屏生图…`);
        setGeneratedImages([]);
        const images = [];
        for (let index = 0; index < pagePrompts.length; index += 1) {
          setMessage(`正在生成第 ${index + 1} / ${pagePrompts.length} 屏…`);
          const imageResponse = await fetch(apiUrl('/api/generate-image'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: passwordOverride, prompt: pagePrompts[index], referenceImages: productAssets.filter(Boolean).map(asset => asset.dataUrl) }) });
          const imageData = await imageResponse.json();
          if (!imageResponse.ok) throw new Error(imageData.error || '生图失败');
          const next = imageData.images?.[0];
          if (!next) throw new Error(`第 ${index + 1} 屏未返回图片`);
          images.push(next); setGeneratedImages([...images]);
        }
        setMessage(`已用 ${IMAGE_MODEL} 完成 ${images.length} 屏，点击图片可放大查看。`);
      } else setMessage(`已通过 ${data.provider} 完成图片读取与 Lovart 提示词编译。`);
    } catch (error) { if (String(error?.message).includes('密码')) { setGenerationPassword(''); setPendingMode(mode); setPasswordDialogOpen(true); } setPrompt('生成已停止。'); showError(error); }
    finally { setGenerating(false); }
  };
  const requestMode = mode => {
    if (mode === 'pages' && !generationPassword) { setPendingMode(mode); setPasswordDialogOpen(true); return; }
    createPrompt(mode);
  };
  const submitGenerationPassword = event => {
    event.preventDefault();
    const value = generationPassword.trim();
    if (!value) { showError('请输入生图密码。'); return; }
    setPasswordDialogOpen(false);
    createPrompt(pendingMode || 'pages', value);
  };
  const copyPrompt = async () => { await navigator.clipboard.writeText(prompt); setCopyState('已复制'); setMessage('提示词已复制。'); setTimeout(() => setCopyState('复制提示词'), 1800); };
  const clearConfiguration = () => {
    [...productAssets, operationsAsset, styleAsset].filter(Boolean).forEach(asset => URL.revokeObjectURL(asset.url));
    const cleared = createClearedState();
    setModelId(cleared.modelId);
    setProductAssets(cleared.productAssets);
    setProductNotes(cleared.productNotes);
    setOperationsAsset(cleared.operationsAsset);
    setStyleAsset(cleared.styleAsset);
    setOperationsNote(cleared.operationsNote);
    setStyleNote(cleared.styleNote);
    setActiveMode(cleared.activeMode);
    setMessage(cleared.message);
    setPrompt(cleared.prompt);
    setGeneratedImages([]);
    setErrorToast('');
  };

  const LoadingDots = () => <span className="loading-dots" aria-label="正在执行"><i /><i /><i /></span>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark"><span>BEAUTY</span><i /></div><div className="brand-copy"><h1>美妆项目反推工作台</h1><p>Beauty Prompt Reverse Studio · V5</p></div><div className="skill-badge"><span className="status-dot" /> Skill rules connected</div></header>
    <main>
      <section className="model-section panel">
        <div className="panel-heading horizontal"><span className="section-number">01</span><div><span className="eyebrow">MODEL ROUTING</span><h2>选择提示词解析模型</h2><p>解析模型可切换；网页生图模型固定为 {IMAGE_MODEL}。</p></div><span className="placeholder-pill">生图：Sunburst</span></div>
        <div className="model-grid">{MODELS.map(model => <button key={model.id} type="button" className={`model-card ${model.tone} ${modelId === model.id ? 'selected' : ''}`} onClick={() => setModelId(model.id)}><span className="model-orb" /><span><strong>{model.name}</strong><small>{model.meta}</small></span><em>{modelId === model.id ? '已选择' : providerState[model.id]?.configured ? '已配置' : '未配置'}</em></button>)}</div>
      </section>

      <section className="product-panel panel">
        <div className="panel-heading horizontal"><span className="section-number">02</span><div><span className="eyebrow">PRODUCT TRUTH</span><h2>上传产品精修图</h2><p>三个独立位置，至少上传 1 张。每张图拥有自己的备注提示词。</p></div><span className="count-pill">{productCount} / 3</span></div>
        <div className="product-grid">{productAssets.map((asset, index) => <ProductSlot key={index} index={index} asset={asset} note={productNotes[index]} onFile={file => setProductAt(index, file)} onRemove={() => removeProductAt(index)} onNoteChange={note => updateProductNote(index, note)} />)}</div>
      </section>

      <div className="reference-grid">
        <SingleAssetPanel number="03" eyebrow="PAGE SPEC" title="运营要求图" description="页面数量、顺序、文案与产品分配的最高依据。" asset={operationsAsset} note={operationsNote} onNoteChange={setOperationsNote} onFile={file => replaceSingle(setOperationsAsset, operationsAsset, file)} onRemove={() => removeSingle(setOperationsAsset, operationsAsset)} />
        <SingleAssetPanel number="04" eyebrow="VISUAL DNA" title="风格参考图" description="只提取色彩、版式、材质、光影与视觉语言。" asset={styleAsset} note={styleNote} onNoteChange={setStyleNote} onFile={file => replaceSingle(setStyleAsset, styleAsset, file)} onRemove={() => removeSingle(setStyleAsset, styleAsset)} />
      </div>

      <section className="chain-panel panel">
        <div className="chain-heading"><div><span className="eyebrow">REFERENCE INPUT CHAIN · STRICT ORDER</span><h2>固定图片输入顺序</h2><p>这是生图规则，不是建议。提交模型时必须严格按编号顺序放置垫图。</p></div><button className="clear-button" type="button" onClick={clearConfiguration}>清空配置</button></div>
        <div className="reference-chain">{referenceChain.map((item, index) => <div className="chain-unit" key={`${item.label}-${index}`}><article className={`chain-card ${item.asset ? 'ready' : ''} ${item.position === null ? 'inactive' : ''}`}><span className="chain-index">{item.position ?? '—'}</span><span className="chain-role">{item.optional ? '可选' : '必填'}</span><div className="chain-preview">{item.asset ? <img src={item.asset.url} alt={item.label} /> : <span>+</span>}</div><strong>{item.label}</strong><small>{item.asset ? `提交序号 ${item.position}` : item.position === null ? '未启用 · 不进入提交序列' : `预定提交序号 ${item.position}`}</small></article>{index < referenceChain.length - 1 && <span className={`chain-arrow ${item.position === null ? 'inactive' : ''}`}>→</span>}</div>)}</div>
      </section>

      <section className="output-panel panel">
        <div className="output-header"><div><span className="eyebrow">PROMPT OUTPUT</span><h2>最终提示词</h2><p>固定高度浏览，右侧滚动条始终保留。</p></div><button className={`quiet-button ${copyState === '已复制' ? 'copied' : ''}`} type="button" onClick={copyPrompt}>{copyState}</button></div>
        <pre className="prompt-scroll">{prompt}</pre>{message && <div className="notice">{message}</div>}
        <div className="action-row"><button disabled={!modeReady || generating} className={`action-button ${getActionState('batch', activeMode, generating)}`} type="button" onClick={() => requestMode('batch')}><span>↗</span><div><strong>Lovart 批量 {generating && activeMode === 'batch' && <LoadingDots />}</strong><small>{modeReady ? '只输出整套多页面提示词' : '上传完整素材后可选'}</small></div></button><button disabled={!modeReady || generating} className={`action-button ${getActionState('pages', activeMode, generating)}`} type="button" onClick={() => requestMode('pages')}><span>▦</span><div><strong>单独生图 {generating && activeMode === 'pages' && <LoadingDots />}</strong><small>{modeReady ? `首次点击需验证密码 · ${IMAGE_MODEL}` : '上传完整素材后可选'}</small></div></button></div>
      </section>

      <section className="gallery-section"><div className="gallery-heading"><div><span className="eyebrow">OUTPUT CANVASES · 5 PAGES</span><h2>生成结果预览</h2><p>提示词目标为 1330×2200；Sunburst 原生输出接近比例的 1344×2224，不裁切、不拉伸。</p></div></div><div className="canvas-grid">{canvasSlots.map(slot => { const image = generatedImages[slot - 1]; return <button type="button" className={`canvas-card ${image ? 'has-image' : ''}`} style={{ aspectRatio: canvasSpec.ratio }} key={slot} onClick={() => image && setPreviewImage(image)}><span>CANVAS {String(slot).padStart(2, '0')}</span>{image ? <img src={image} alt={`第 ${slot} 屏生成结果`} /> : <><div className="canvas-mark">◇</div><p>{generating && activeMode === 'pages' && slot === generatedImages.length + 1 ? '正在生成…' : '等待逐屏生图'}</p></>}<small>{image ? 'API 原图 1344 × 2224 px' : '提示词目标 1330 × 2200 px'}</small></button>; })}</div></section>
    </main>
    <footer><span>BEAUTY PROMPT SYSTEM / LOCAL WORKSPACE</span><span>素材仅在当前浏览器会话临时使用</span></footer>
    {errorToast && <aside className="error-toast" role="alert"><span>!</span><div><strong>操作未完成</strong><p>{errorToast}</p></div><button type="button" aria-label="关闭错误提醒" onClick={() => setErrorToast('')}>×</button></aside>}
    {previewImage && <div className="image-dialog" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}><div onClick={event => event.stopPropagation()}><button type="button" onClick={() => setPreviewImage(null)}>关闭</button><img src={previewImage} alt="生成结果大图预览" /></div></div>}
    {passwordDialogOpen && <div className="password-dialog" role="dialog" aria-modal="true"><form onSubmit={submitGenerationPassword}><span className="eyebrow">IMAGE GENERATION ACCESS</span><h2>请输入生图密码</h2><p>本次网页会话验证一次即可，密码不会写入浏览器永久存储。</p><input autoFocus type="password" autoComplete="off" value={generationPassword} onChange={event => setGenerationPassword(event.target.value)} placeholder="生图密码" /><div><button type="button" onClick={() => { setPasswordDialogOpen(false); setPendingMode(null); }}>取消</button><button type="submit">验证并开始</button></div></form></div>}
  </div>;
}
