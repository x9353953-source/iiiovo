// Service Worker 注册
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(registration => {
            console.log('SW 注册成功:', registration.scope);
        }, err => {
            console.log('SW 注册失败:', err);
        });
    });
}

// 全局变量
let imagesData = [];
let generatedBlobs = [];
let stickerImg = null;
let currentMaskMode = 'line';
let targetImageIndex = -1; 
let isCancelled = false;
let globalOverlayImg = null;
let sortableInstance = null;
const MAX_CANVAS_DIMENSION = 8192; 

// 拖拽事件
document.addEventListener('dragover', e => { e.preventDefault(); document.getElementById('dragOverlay').classList.add('active'); });
document.addEventListener('dragleave', e => { if(e.relatedTarget === null) document.getElementById('dragOverlay').classList.remove('active'); });
document.addEventListener('drop', e => {
    e.preventDefault();
    document.getElementById('dragOverlay').classList.remove('active');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if(files.length > 0) handleFiles(files);
});

// 导入处理：静默修复版 - 优化大量图片导入
async function handleFiles(files) {
    if (!files.length) return;
    
    // 关键缓冲：等待300ms让设备从相册返回后恢复内存
    await new Promise(r => setTimeout(r, 300));

    try {
        const newImages = [];
        const fileArray = Array.from(files);
        const chunkSize = 50; 
        for (let i = 0; i < fileArray.length; i += chunkSize) {
            const chunk = fileArray.slice(i, i + chunkSize);
            chunk.forEach((file) => {
                if (file.type.startsWith('image/') || file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                    newImages.push({ 
                        url: URL.createObjectURL(file), 
                        name: file.name, 
                        size: file.size 
                    });
                }
            });
            if(fileArray.length > 50) await new Promise(r => setTimeout(r, 10));
        }
        if (newImages.length > 0) {
            imagesData.push(...newImages);
            refreshGridHTML();
            refreshUI(); 
            calculateGroupBatch(); 
            checkForDuplicates();
        }
    } catch (e) {
        console.error(e);
        alert('导入出错：' + e.message);
    } finally {
        document.getElementById('fileInput').value = '';
    }
}

function refreshGridHTML() {
    const grid = document.getElementById('imageGrid');
    grid.innerHTML = '<div id="emptyState" class="col-span-full py-8 text-center" style="display:none"><span class="text-gray-400">导入图片</span></div>';
    const fragment = document.createDocumentFragment();
    
    // 渲染优化：限制一次性渲染的DOM数量，虽然这里为了保持逻辑完整全渲染，但CSS中开启了content-visibility
    imagesData.forEach((imgObj, i) => {
        const div = document.createElement('div');
        div.className = 'relative aspect-square rounded-xl overflow-hidden bg-gray-100 border border-gray-100 thumbnail-item active:opacity-80 transition cursor-grab active:cursor-grabbing';
        div.style.contentVisibility = 'auto'; 
        div.style.contain = 'paint layout'; 
        div.innerHTML = `<img src="${imgObj.url}" class="w-full h-full object-cover pointer-events-none select-none" loading="lazy">`; 
        div.onmouseup = (e) => { openImageActions(i); };
        fragment.appendChild(div);
    });
    grid.appendChild(fragment);

    if(sortableInstance) sortableInstance.destroy();
    sortableInstance = new Sortable(grid, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        delay: 100, 
        delayOnTouchOnly: true,
        onEnd: function (evt) {
            const item = imagesData.splice(evt.oldIndex, 1)[0];
            imagesData.splice(evt.newIndex, 0, item);
            refreshUI(); 
        }
    });
}    

function openImageActions(index) { targetImageIndex = index; document.getElementById('imageActionOverlay').style.display = 'block'; setTimeout(() => document.getElementById('imageActionSheet').classList.add('show'), 10); }
function closeImageActions() { document.getElementById('imageActionSheet').classList.remove('show'); setTimeout(() => document.getElementById('imageActionOverlay').style.display = 'none', 300); }

function triggerReplace() { document.getElementById('replaceInput').click(); closeImageActions(); }
function handleReplaceAction(files) { if(!files.length || targetImageIndex === -1) return; const file = files[0]; URL.revokeObjectURL(imagesData[targetImageIndex].url); imagesData[targetImageIndex] = { url: URL.createObjectURL(file), name: file.name, size: file.size }; refreshGridHTML(); checkForDuplicates(); document.getElementById('replaceInput').value = ''; }
function triggerDelete() { if(confirm('确定删除?')) { URL.revokeObjectURL(imagesData[targetImageIndex].url); imagesData.splice(targetImageIndex, 1); refreshGridHTML(); refreshUI(); calculateGroupBatch(); checkForDuplicates(); } closeImageActions(); }

function clearAll() { if(confirm('确定清空?')) { imagesData.forEach(i => URL.revokeObjectURL(i.url)); imagesData=[]; refreshGridHTML(); refreshUI(); checkForDuplicates(); } }

function refreshUI() { document.getElementById('countBadge').innerText = imagesData.length; document.getElementById('emptyState').style.display = imagesData.length ? 'none' : 'flex'; document.getElementById('clearBtn').style.display = imagesData.length ? 'block' : 'none'; if(typeof updateStickerPreview === 'function') updateStickerPreview(); }
function handleStickerFile(files) { if(!files.length) return; const img = new Image(); img.onload = () => { stickerImg = img; if(typeof updateStickerPreview === 'function') updateStickerPreview(); }; img.src = URL.createObjectURL(files[0]); }

function toggleCustomRatio() { document.getElementById('customRatioBox').style.display = (document.getElementById('aspectRatio').value === 'custom') ? 'flex' : 'none'; }
function getCurrentRatio() {
    let ratio = parseFloat(document.getElementById('aspectRatio').value);
    if(isNaN(ratio) || document.getElementById('aspectRatio').value === 'custom') {
        const cw = parseInt(document.getElementById('customW').value) || 1000;
        const ch = parseInt(document.getElementById('customH').value) || 1500;
        ratio = cw / ch;
    }
    return ratio;
}

function calculateGroupBatch() {
    const cols = parseInt(document.getElementById('cols').value) || 3;
    const rowsInput = document.getElementById('group_rows').value;
    const total = imagesData.length;
    const hint = document.getElementById('group_hint');
    const rows = rowsInput ? parseInt(rowsInput) : 50;
    
    if (cols > 0 && rows > 0) {
        const batchSize = cols * rows;
        const groups = total > 0 ? Math.ceil(total / batchSize) : 0;
        hint.innerHTML = `<span class="text-[#007AFF] font-bold">✅ 已就绪:</span> <span>每组 <b>${batchSize}</b> 张，共 <b>${groups}</b> 组</span>`;
        hint.className = "mt-3 text-[11px] bg-[#007AFF]/5 text-[#007AFF] border border-[#007AFF]/20 p-2 rounded flex items-center gap-2";
    } else {
        hint.innerHTML = `<span class="font-bold">Waiting...</span><span>请设置行和列</span>`;
        hint.className = "mt-3 text-[11px] text-gray-500 bg-[#F2F2F7] p-2 rounded flex items-center gap-2";
    }
}    

function applyQualityPreset(select) { const val = select.value; if (val === 'none') return; const input = document.getElementById('customQ_unified'); if (val === 'custom') input.focus(); else input.value = Math.round(parseFloat(val) * 100); }
function validateQualityInput(el) { let val = parseInt(el.value); if (isNaN(val)) return; if (val > 100) el.value = 100; }

async function previewQuality() {
    if (!imagesData.length) return alert('请先添加至少一张图片');
    showLoading(true, '生成预览...');
    const modal = document.getElementById('previewModal'); const header = document.getElementById('previewHeader'); const imgEl = document.getElementById('qualityPreviewImg'); const canvasEl = document.getElementById('enlargedPreviewCanvas');
    canvasEl.classList.add('hidden'); imgEl.classList.remove('hidden'); header.classList.remove('hidden');
    let qVal = parseInt(document.getElementById('customQ_unified').value); if (isNaN(qVal) || qVal < 10) qVal = 10; if (qVal > 100) qVal = 100;
    header.innerText = `画质预览 (当前: ${qVal}%)`;
    try {
        const imgObj = imagesData[0];
        const img = new Image(); img.src = imgObj.url; await new Promise(r => img.onload = r);
        const cvs = document.createElement('canvas');
        const scale = Math.min(1, 1000 / img.width); cvs.width = img.width * scale; cvs.height = img.height * scale;
        const ctx = cvs.getContext('2d'); ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
        imgEl.src = cvs.toDataURL((qVal === 100) ? 'image/png' : 'image/jpeg', (qVal === 100) ? undefined : qVal / 100);
        modal.style.display = 'flex';
    } catch(e) { console.error(e); alert('预览失败'); }
    showLoading(false);
}

function syncOpacity(source) {
    const range = document.getElementById('overlayOpacityRange');
    const input = document.getElementById('overlayOpacityInput');
    if (source === 'range') input.value = range.value;
    else { let val = parseFloat(input.value); if (isNaN(val)) val = 1; if (val < 0) val = 0; if (val > 1) val = 1; range.value = val; }
}

function handleOverlayFile(files) {
    if (!files.length) return;
    const file = files[0]; const img = new Image();
    img.onload = () => { globalOverlayImg = img; document.getElementById('overlayInfoBox').classList.remove('hidden'); document.getElementById('overlayName').innerText = file.name; document.getElementById('overlayThumb').src = img.src; };
    img.src = URL.createObjectURL(file);
}
function clearOverlay() { globalOverlayImg = null; document.getElementById('overlayInput').value = ''; document.getElementById('overlayInfoBox').classList.add('hidden'); }

async function previewOverlayEffect() {
    if (!imagesData.length) return alert('请先添加拼图图片');
    if (!globalOverlayImg) return alert('请先选择一张覆盖层图片');
    showLoading(true, '生成预览...');
    try {
        const cols = 3;
        const rows = 3; const batchSize = 9; 
        const firstBatchImgs = imagesData.slice(0, batchSize).map(d => d.url);
        while(firstBatchImgs.length < 9 && imagesData.length > 0) { firstBatchImgs.push(imagesData[0].url); }
        
        const previewCellW = 200;
        const ratio = getCurrentRatio(); 
        const previewCellH = Math.floor(previewCellW / ratio);
        const gap = parseInt(document.getElementById('gap').value) || 0;
        const previewGap = Math.max(0, Math.floor(gap / 5)); 
        
        const tempCanvas = document.createElement('canvas'); 
        const tempCtx = tempCanvas.getContext('2d');
        await drawAsync(tempCtx, firstBatchImgs, rows, cols, previewCellW, previewCellH, previewGap, 0, 1, [], false, true);
        const modal = document.getElementById('previewModal'); 
        const header = document.getElementById('previewHeader'); 
        const imgEl = document.getElementById('qualityPreviewImg'); 
        const canvasEl = document.getElementById('enlargedPreviewCanvas');
        
        header.classList.remove('hidden');
        header.innerText = "效果预览 (强制3x3，无序号)"; 
        canvasEl.classList.add('hidden'); 
        imgEl.classList.remove('hidden');
        
        tempCanvas.toBlob(blob => { 
            imgEl.src = URL.createObjectURL(blob); 
            modal.style.display = 'flex'; 
            showLoading(false); 
        }, 'image/jpeg', 0.8);
    } catch (e) { console.error(e); alert('预览生成失败'); showLoading(false); }
}

function showLoading(show, text) {
    const toast = document.getElementById('progressToast');
    const txt = document.getElementById('progressText');
    if (show) {
        toast.classList.remove('-translate-y-[200%]', 'opacity-0', 'pointer-events-none');
        if(text) txt.innerText = text;
    } else {
        toast.classList.add('-translate-y-[200%]', 'opacity-0', 'pointer-events-none');
    }
}

function cancelProcess() { isCancelled = true; showLoading(false); alert('已取消生成'); }

async function generate() { 
    isCancelled = false;
    showLoading(true, '准备开始...');
    await new Promise(r => setTimeout(r, 50)); 
    await runGeneration('normal');
}

async function generateMasked(type) { 
    isCancelled = false;
    showLoading(true, '处理中...');
    await new Promise(r => setTimeout(r, 50));
    await runGeneration(type);
}
// 核心修复：分批生成循环，增加强制GC暂停
async function runGeneration(opType) {
    if (!imagesData.length) { showLoading(false); return alert('请添加图片'); }
    
    const container = document.getElementById('seamlessContainer');
    container.innerHTML = ''; 
    generatedBlobs = []; 
    document.getElementById('realSizeContainer').classList.add('hidden');
    document.getElementById('resultArea').classList.add('hidden'); 
    
    const startNum = parseInt(document.getElementById('startNumber').value) || 1;
    let targets = imagesData.map(d => d.url);
    
    const rawInput = document.getElementById('maskIndices').value.trim();
    if (opType === 'normal' && rawInput.length > 0) { opType = 'apply'; }

    let maskTargets = [];
    const parts = rawInput.split(/[,，、\s]+/);
    parts.forEach(part => {
        part = part.trim(); if (!part) return;
        const standardPart = part.replace(/[~—–]/g, '-');
        if (standardPart.includes('-')) {
            const rangeParts = standardPart.split('-');
            if (rangeParts.length === 2) { const s = parseInt(rangeParts[0]); const e = parseInt(rangeParts[1]); if (!isNaN(s) && !isNaN(e)) { for (let k = Math.min(s,e); k <= Math.max(s,e); k++) maskTargets.push(k); } }
        } else { const num = parseInt(standardPart); if (!isNaN(num)) maskTargets.push(num); }
    });

    if (opType === 'repack') { targets = targets.filter((_, i) => !maskTargets.includes(startNum + i)); }

    const cols = parseInt(document.getElementById('cols').value) || 3;
    const rowsInput = document.getElementById('group_rows').value;
    const rows = rowsInput ? parseInt(rowsInput) : 50;
    const batchSize = cols * rows;
    let qVal = parseInt(document.getElementById('customQ_unified').value);
    if (isNaN(qVal) || qVal < 10) qVal = 10; 
    if (qVal > 100) qVal = 100;
    const isPng = (qVal === 100); 
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    
    const totalBatches = Math.ceil(targets.length / batchSize);
    const canvas = document.getElementById('canvas'); 
    const ctx = canvas.getContext('2d');
    const gap = parseInt(document.getElementById('gap').value) || 0;

    try {
        for (let b = 0; b < totalBatches; b++) {
            if (isCancelled) break;
            // 内存修复：每组生成前强制等待，让浏览器回收上一组的内存
            showLoading(true, `正在生成 ${b+1}/${totalBatches} 组... `);
            await new Promise(r => setTimeout(r, 200)); 
            
            const currentImgs = targets.slice(b*batchSize, Math.min((b+1)*batchSize, targets.length));
            const ratio = getCurrentRatio(); 
            
            let cellW = 1500;
            if (cols * cellW > MAX_CANVAS_DIMENSION) {
                cellW = Math.floor((MAX_CANVAS_DIMENSION - (cols*gap)) / cols);
            }
            let cellH = Math.floor(cellW / ratio);

            // 调用绘制核心
            await drawAsync(ctx, currentImgs, Math.ceil(currentImgs.length/cols), cols, cellW, cellH, gap, b*batchSize, startNum, maskTargets, opType === 'apply');
            
            currentImgs.length = 0; // 清空引用

            if (isCancelled) break;
            
            await new Promise(res => canvas.toBlob(blob => {
                if (isCancelled) { res(); return; }
                generatedBlobs.push(blob);
                
                const img = document.createElement('img'); 
                img.src = URL.createObjectURL(blob); 
                img.className = "w-full block border-b border-gray-100 last:border-0"; 
                container.appendChild(img); 
                
                // 绘制完立即清理 Canvas，防止显存残留
                ctx.clearRect(0,0,canvas.width, canvas.height);
                canvas.width = 1; canvas.height = 1;
                res();
            }, mimeType, isPng ? undefined : qVal / 100));
        }
        if (!isCancelled) { 
            document.getElementById('resultArea').classList.remove('hidden');
            document.getElementById('resultDetails').open = true;
            document.getElementById('resultDetails').scrollIntoView({behavior:'smooth'}); 
            if (typeof updateRealSizeDisplay === 'function') updateRealSizeDisplay();
        }
    } catch(e) { console.error(e); if(!isCancelled) alert('生成过程中断:\n' + e.message + '\n\n建议：减少单组图片数量或降低画质。'); }
    showLoading(false);
}

// 异步绘制核心 - 第一部分：准备与加载
async function drawAsync(ctx, imgs, rows, cols, w, h, gap, globalOffset, startNum, maskIndices, applyMask, forceHideNums = false) {
    if (isCancelled) return;
    const canvas = ctx.canvas;
    canvas.width = cols * w + (cols-1) * gap;
    canvas.height = rows * h + (rows-1) * gap;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const showNum = document.getElementById('showNum').checked;
    const fontSize = parseInt(document.getElementById('fontSize').value) || 350;
    const fontPos = document.getElementById('fontPos').value;
    const fontFamily = document.getElementById('fontFamily').value; 
    const fontColor = document.getElementById('fontColor').value || '#FFFFFF';
    const strokeColor = document.getElementById('fontStrokeColor').value || '#000000';
    const shadowColor = document.getElementById('fontShadowColor').value || '#000000';
    const enableShadow = document.getElementById('enableShadow').checked;
    const lineStyle = document.querySelector('input[name="lineStyle"]:checked') ? document.querySelector('input[name="lineStyle"]:checked').value : 'cross';

    for (let i = 0; i < imgs.length; i++) {
        if (isCancelled) return;
        // 关键优化：每绘制30张暂停一帧，防止主线程卡死导致浏览器崩溃
        if (i % 30 === 0) await new Promise(r => setTimeout(r, 10)); 
        
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = c * (w + gap);
        const y = r * (h + gap);
        
        const currentNum = startNum + globalOffset + i;
        const img = new Image(); 
        
        // 健壮的图片加载：加载失败不抛错，而是标记
        await new Promise(resolve => { 
            img.onload = resolve; 
            img.onerror = () => { img.isBroken = true; resolve(); }; 
            img.src = imgs[i];
        });
        
        // 绘制逻辑下半部分：绘制与内存释放
        try {
            if (img.isBroken || img.naturalWidth === 0) {
                // 如果图片损坏，绘制一个明显的错误占位符
                ctx.fillStyle = '#f9f9f9';
                ctx.fillRect(x, y, w, h);
                ctx.fillStyle = '#ff3b30';
                ctx.font = `bold ${w/10}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText('❌图片损坏', x + w/2, y + h/2);
            } else {
                ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
                const iRatio = img.width / img.height; const cRatio = w / h;
                if (iRatio > cRatio) { ctx.drawImage(img, x - (h*iRatio - w)/2, y, h*iRatio, h); } 
                else { ctx.drawImage(img, x, y - (w/iRatio - h)/2, w, w/iRatio); }
                ctx.restore();
            }
        } catch (err) {
            console.warn(`跳过损坏图片 index:${i}`, err);
            ctx.fillStyle = '#eee'; ctx.fillRect(x, y, w, h); 
        } finally {
            // ！！！至关重要！！！：立即断开引用并移除，防止内存累积
            img.src = ''; 
            img.remove();
        }

        // 绘制序号
        if (showNum && forceHideNums !== true) {
            ctx.save();
            ctx.font = `bold ${fontSize}px ${fontFamily}`; 
            let tx = x + w/2, ty = y + h - fontSize/2;
            if(fontPos === 'center') ty = y + h/2 + fontSize/3; 
            else if(fontPos.includes('top')) ty = y + fontSize + 20;
            
            if(fontPos.includes('left')) { tx = x + 20; ctx.textAlign = 'left'; } 
            else if(fontPos.includes('right')) { tx = x + w - 20; ctx.textAlign = 'right'; } 
            else ctx.textAlign = 'center';

            ctx.lineWidth = fontSize / 12;
            ctx.strokeStyle = strokeColor; 
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.strokeText(currentNum, tx, ty);

            if (enableShadow) {
                ctx.shadowColor = shadowColor;
                ctx.shadowBlur = fontSize / 10;
                ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
            } else {
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            }
            ctx.fillStyle = fontColor;
            ctx.fillText(currentNum, tx, ty);
            ctx.restore(); 
        }
        
        // 绘制打码
        if (applyMask && maskIndices.includes(currentNum)) {
            if (currentMaskMode === 'line') {
                ctx.beginPath();
                ctx.strokeStyle = document.getElementById('maskColor').value; 
                ctx.lineWidth = document.getElementById('maskWidth').value * (w/500) * 5; 
                ctx.lineCap = 'round';
                if (lineStyle === 'cross') { 
                    ctx.moveTo(x+w*0.2, y+h*0.2); ctx.lineTo(x+w*0.8, y+h*0.8); 
                    ctx.moveTo(x+w*0.8, y+h*0.2); ctx.lineTo(x+w*0.2, y+h*0.8); 
                } else { 
                    ctx.moveTo(x+w*0.2, y+h*0.8); ctx.lineTo(x+w*0.8, y+h*0.2); 
                }
                ctx.stroke();
            } else if (currentMaskMode === 'image' && stickerImg) {
                const sizePct = document.getElementById('stickerSize').value / 100;
                const xPct = document.getElementById('stickerX').value / 100; 
                const yPct = document.getElementById('stickerY').value / 100;
                const sw = w * sizePct;
                const sh = sw * (stickerImg.height / stickerImg.width);
                ctx.drawImage(stickerImg, x + (w * xPct) - sw/2, y + (h * yPct) - sh/2, sw, sh);
            }
        }
    }
    
    if (globalOverlayImg) { 
        ctx.save();
        ctx.globalAlpha = parseFloat(document.getElementById('overlayOpacityInput').value); 
        ctx.globalCompositeOperation = document.getElementById('overlayMode').value; 
        ctx.drawImage(globalOverlayImg, 0, 0, canvas.width, canvas.height); 
        ctx.restore();
    }
}

function updateRealSizeDisplay() {
    if (!generatedBlobs.length) return;
    const container = document.getElementById('realSizeContainer'); 
    const totalText = document.getElementById('realTotalSize');
    const detailBox = document.getElementById('groupSizeDetail'); 
    const toggleBtn = document.getElementById('btnToggleSizes');
    const combinedTip = document.getElementById('combinedSizeTip');
    const combinedVal = document.getElementById('combinedSizeValue');
    
    let totalBytes = 0; 
    detailBox.innerHTML = '';
    generatedBlobs.forEach((blob, index) => {
        totalBytes += blob.size;
        const item = document.createElement('div'); item.className = "px-2";
        item.innerHTML = `<span class="opacity-70">分组 ${index + 1}:</span> <span class="font-bold">${(blob.size / 1024 / 1024).toFixed(2)} MB</span>`;
        detailBox.appendChild(item);
    });
    const totalMB = (totalBytes / 1024 / 1024).toFixed(2); 
    totalText.innerText = `分卷总计: ${totalMB} MB`;
    
    if (imagesData.length <= 100) { 
        combinedTip.classList.remove('hidden');
        combinedVal.innerText = `${totalMB} MB`; 
    } else { 
        combinedTip.classList.add('hidden');
    }
    
    container.classList.remove('hidden');
    if (generatedBlobs.length <= 1) { 
        toggleBtn.classList.add('hidden'); detailBox.classList.add('hidden');
    } else { 
        toggleBtn.classList.remove('hidden'); detailBox.classList.add('hidden');
        toggleBtn.innerText = `展开 ${generatedBlobs.length} 个分组详情 ▼`; 
    }
}

function toggleGroupSizes() { 
    const detailBox = document.getElementById('groupSizeDetail');
    const btn = document.getElementById('btnToggleSizes'); 
    if (detailBox.classList.contains('hidden')) { 
        detailBox.classList.remove('hidden');
        btn.innerText = '收起详情 ▲'; 
    } else { 
        detailBox.classList.add('hidden');
        btn.innerText = `展开 ${generatedBlobs.length} 个分组详情 ▼`; 
    } 
}

function confirmDownload(type) { 
    if (!generatedBlobs.length) return alert('请先生成拼图');
    const totalBytes = generatedBlobs.reduce((acc, b) => acc + b.size, 0); 
    const msg = `当前文件总大小为：${(totalBytes / 1024 / 1024).toFixed(2)} MB\n\n确认开始下载吗？`;
    if (confirm(msg)) { 
        if (type === 'zip') downloadZip();
        else if (type === 'combine') combineAndDownload(); 
        else if (type === 'parts') downloadAllParts();
    } 
}

function downloadZip() {
    showLoading(true, '正在打包 ZIP...');
    const zip = new JSZip(); 
    const folder = zip.folder("拼图分组");
    let qVal = parseInt(document.getElementById('customQ_unified').value);
    if (isNaN(qVal) || qVal < 10) qVal = 10;
    const ext = (qVal === 100) ? 'png' : 'jpg';
    generatedBlobs.forEach((blob, i) => { folder.file(`拼图_Part_${i+1}.${ext}`, blob); });
    
    zip.generateAsync({type:"blob"}).then(function(content) { 
        if(isCancelled) return; 
        downloadBlob(content, `拼图打包_${new Date().getTime()}.zip`); 
        showLoading(false); 
    }).catch(function(e) { 
        if(!isCancelled) alert('打包失败: ' + e.message); 
        showLoading(false); 
    });
}

async function combineAndDownload() {
    if (imagesData.length > 100) return alert('⚠️ 图片数量超过100张，禁止合并导出。\n\n请使用 "打包下载所有分组 (ZIP)"。');
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    let qVal = parseInt(document.getElementById('customQ_unified').value); 
    if (isNaN(qVal) || qVal < 10) qVal = 10;
    if (qVal > 100) qVal = 100;
    const isPng = (qVal === 100); const ext = isPng ? 'png' : 'jpg';
    
    if (generatedBlobs.length === 1) { downloadBlob(generatedBlobs[0], `拼图_完整版.${ext}`); return; }
    
    showLoading(true, '正在合并...');
    try {
        const bitmaps = await Promise.all(generatedBlobs.map(b => createImageBitmap(b)));
        const totalH = bitmaps.reduce((sum, bmp) => sum + bmp.height, 0); const maxW = bitmaps[0].width;
        if (maxW * totalH > (isMobile ? 16777216 : 50000000)) { 
            showLoading(false);
            return alert('图片总像素过大，手机浏览器无法处理。\n请使用 "打包下载 (ZIP)"。'); 
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = maxW; canvas.height = totalH; 
        const ctx = canvas.getContext('2d'); 
        let y = 0;
        for(let bmp of bitmaps) { 
            if (isCancelled) break;
            ctx.drawImage(bmp, 0, y); 
            y += bmp.height; 
        }
        
        if(!isCancelled) { 
            canvas.toBlob(blob => { 
                if (isCancelled) return; 
                downloadBlob(blob, `拼图_合并版_${new Date().getTime()}.${ext}`); 
                showLoading(false); 
            }, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : qVal/100);
        }
    } catch(e) { if(!isCancelled) alert('合并失败，请使用ZIP打包。'); showLoading(false); }
}

async function downloadAllParts() { 
    if (!generatedBlobs.length) return;
    const confirmMsg = `即将开始逐张下载 ${generatedBlobs.length} 张图片。\n\n⚠️ 为防止浏览器拦截，每张图片之间将有 1.5 秒的间隔。\n\n请保持页面在前台，不要关闭。`;
    if (!confirm(confirmMsg)) return;

    showLoading(true, '正在启动下载队列...');
    for (let i = 0; i < generatedBlobs.length; i++) {
        showLoading(true, `正在下载第 ${i + 1} / ${generatedBlobs.length} 张...\n(请允许浏览器下载多个文件)`);
        const blob = generatedBlobs[i];
        const ext = blob.type.includes('png') ? 'png' : 'jpg'; 
        downloadBlob(blob, `拼图_Part_${i+1}.${ext}`);
        if (i < generatedBlobs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
    setTimeout(() => {
        showLoading(false);
        alert('所有图片下载请求已发送！\n如果仍有遗漏，请检查浏览器是否拦截了弹窗。');
    }, 1000);
}

function downloadBlob(blob, name) { 
    const link = document.createElement('a');
    link.download = name; 
    link.href = URL.createObjectURL(blob); 
    document.body.appendChild(link);
    link.click(); 
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000); 
}

function switchMaskTab(mode) {
    currentMaskMode = mode;
    const lineTab = document.getElementById('tab-line'); 
    const imgTab = document.getElementById('tab-image');
    lineTab.className = mode==='line' ? 'flex-1 py-1.5 text-xs font-medium rounded-md bg-white shadow text-black transition-all' : 'flex-1 py-1.5 text-xs font-medium rounded-md text-gray-500 transition-all';
    imgTab.className = mode==='image' ? 'flex-1 py-1.5 text-xs font-medium rounded-md bg-white shadow text-black transition-all' : 'flex-1 py-1.5 text-xs font-medium rounded-md text-gray-500 transition-all';
    document.getElementById('mask-panel-line').style.display = mode==='line' ? 'block' : 'none'; 
    document.getElementById('mask-panel-image').style.display = mode==='image' ? 'block' : 'none';
    if(mode === 'image') updateStickerPreview();
}

function updateStickerPreview() {
    const canvas = document.getElementById('stickerPreviewCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d'); 
    const w = canvas.width = 300; const h = canvas.height = 300; 
    ctx.clearRect(0,0,w,h);
    if (imagesData.length > 0) { 
        const bgImg = new Image(); 
        bgImg.src = imagesData[0].url; 
        if(bgImg.complete) drawPreviewContent(ctx, w, h, bgImg); 
        else bgImg.onload = () => drawPreviewContent(ctx, w, h, bgImg); 
    } else { 
        ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0,0,w,h); 
        ctx.fillStyle = '#ccc'; ctx.textAlign = 'center'; ctx.fillText('无图', w/2, h/2); 
    }
}

function drawPreviewContent(ctx, w, h, bgImg) {
    const sRatio = bgImg.width / bgImg.height; const cRatio = w / h;
    if(sRatio > cRatio) ctx.drawImage(bgImg, (bgImg.width - bgImg.height*cRatio)/2, 0, bgImg.height*cRatio, bgImg.height, 0, 0, w, h);
    else ctx.drawImage(bgImg, 0, (bgImg.height - bgImg.width/cRatio)/2, bgImg.width, bgImg.width/cRatio, 0, 0, w, h);
    if (stickerImg) { 
        const sizePct = document.getElementById('stickerSize').value / 100; 
        const xPct = document.getElementById('stickerX').value / 100;
        const yPct = document.getElementById('stickerY').value / 100; 
        const sw = w * sizePct; const sh = sw * (stickerImg.height / stickerImg.width);
        const dx = (w * xPct) - sw/2; const dy = (h * yPct) - sh/2;
        ctx.drawImage(stickerImg, dx, dy, sw, sh);
    }
}

function enlargeStickerPreview() {
    const modal = document.getElementById('previewModal');
    const header = document.getElementById('previewHeader'); 
    const canvasEl = document.getElementById('enlargedPreviewCanvas'); 
    const imgEl = document.getElementById('qualityPreviewImg');
    header.classList.add('hidden'); imgEl.classList.add('hidden'); canvasEl.classList.remove('hidden');
    const ratio = getCurrentRatio();
    const baseW = 600; const baseH = baseW / ratio; 
    canvasEl.width = baseW; canvasEl.height = baseH; 
    const ctx = canvasEl.getContext('2d');
    if (imagesData.length > 0) { 
        const bgImg = new Image(); 
        bgImg.src = imagesData[0].url; 
        bgImg.onload = () => { drawPreviewContent(ctx, baseW, baseH, bgImg); modal.style.display = 'flex'; } 
    } else { 
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,baseW,baseH); modal.style.display = 'flex'; 
    }
}

const SETTINGS_KEY = 'puzzleSettings_Ultimate_V3';
function saveSettings() {
    const settings = { 
        cols: document.getElementById('cols').value, 
        aspectRatio: document.getElementById('aspectRatio').value, 
        customW: document.getElementById('customW').value, 
        customH: document.getElementById('customH').value, 
        showNum: document.getElementById('showNum').checked, 
        startNumber: document.getElementById('startNumber').value, 
        fontSize: document.getElementById('fontSize').value, 
        fontPos: document.getElementById('fontPos').value, 
        fontFamily: document.getElementById('fontFamily').value,
        fontColor: document.getElementById('fontColor').value,
        fontStrokeColor: document.getElementById('fontStrokeColor').value,
        fontShadowColor: document.getElementById('fontShadowColor').value,
        enableShadow: document.getElementById('enableShadow').checked,
        gap: document.getElementById('gap').value,
        group_rows: document.getElementById('group_rows').value, 
        customQ_unified: document.getElementById('customQ_unified').value 
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadSettings() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return;
    try {
        const s = JSON.parse(saved);
        if(s.cols) document.getElementById('cols').value = s.cols;
        if(s.aspectRatio) { document.getElementById('aspectRatio').value = s.aspectRatio; toggleCustomRatio(); }
        if(s.customW) document.getElementById('customW').value = s.customW; 
        if(s.customH) document.getElementById('customH').value = s.customH;
        if(s.showNum !== undefined) document.getElementById('showNum').checked = s.showNum; 
        if(s.startNumber) document.getElementById('startNumber').value = s.startNumber; 
        if(s.fontSize) document.getElementById('fontSize').value = s.fontSize; 
        if(s.fontPos) document.getElementById('fontPos').value = s.fontPos;
        if(s.fontFamily) document.getElementById('fontFamily').value = s.fontFamily;
        if(s.fontColor) document.getElementById('fontColor').value = s.fontColor;
        if(s.fontStrokeColor) document.getElementById('fontStrokeColor').value = s.fontStrokeColor;
        if(s.fontShadowColor) document.getElementById('fontShadowColor').value = s.fontShadowColor;
        if(s.enableShadow !== undefined) document.getElementById('enableShadow').checked = s.enableShadow;
        if(s.gap) { document.getElementById('gap').value = s.gap; document.getElementById('gapValueDisplay').innerText = s.gap + 'px'; }
        if(s.group_rows) document.getElementById('group_rows').value = s.group_rows; 
        if(s.customQ_unified) document.getElementById('customQ_unified').value = s.customQ_unified;
        calculateGroupBatch(); 
    } catch(e) { console.error('读取设置失败', e); }
}

function checkForDuplicates() {
    const names = imagesData.map(i => i.name + i.size);
    const uniqueNames = new Set(names);
    const diff = names.length - uniqueNames.size;
    const alertBox = document.getElementById('duplicateAlert');
    if (diff > 0) {
        alertBox.classList.remove('hidden');
        document.getElementById('dupCount').innerText = diff;
    } else {
        alertBox.classList.add('hidden');
    }
}

function removeDuplicates() {
    const seen = new Set();
    imagesData = imagesData.filter(item => {
        const key = item.name + item.size;
        const duplicate = seen.has(key);
        seen.add(key);
        if(duplicate) URL.revokeObjectURL(item.url);
        return !duplicate;
    });
    refreshGridHTML(); refreshUI(); calculateGroupBatch(); checkForDuplicates();
}

function hardReset() { 
    const modal = document.getElementById('resetAlert'); 
    const backdrop = document.getElementById('resetBackdrop'); 
    const content = document.getElementById('resetModal'); 
    modal.classList.remove('hidden'); modal.classList.add('flex'); 
    setTimeout(() => { 
        backdrop.classList.remove('opacity-0'); 
        content.classList.remove('opacity-0', 'scale-110'); 
        content.classList.remove('scale-100'); content.classList.add('scale-100'); 
    }, 10); 
}

function closeResetAlert() { 
    const modal = document.getElementById('resetAlert'); 
    const backdrop = document.getElementById('resetBackdrop'); 
    const content = document.getElementById('resetModal'); 
    backdrop.classList.add('opacity-0'); 
    content.classList.add('opacity-0', 'scale-110'); content.classList.remove('scale-100'); 
    setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 200); 
}

function confirmResetAction() { localStorage.removeItem(SETTINGS_KEY); location.reload(); }

function initNotesCheck() { 
    const isHidden = localStorage.getItem('puzzle_hide_notes_v1'); 
    if (!isHidden) { 
        const btn = document.getElementById('noteFloatBtn'); 
        if(btn) btn.classList.remove('hidden'); 
    } 
}

function showNotes() { 
    const modal = document.getElementById('noteModal'); 
    if(modal) {
        modal.style.display = 'flex'; 
        const content = modal.querySelector('div'); 
        content.classList.remove('scale-95', 'opacity-0'); 
        content.classList.add('scale-100', 'opacity-100');
    }
}

function closeNotes() { document.getElementById('noteModal').style.display = 'none'; }

function permanentCloseNotes() { 
    if(confirm('确定不再显示此悬浮球吗？\n(您可以通过清除浏览器缓存来恢复)')) { 
        localStorage.setItem('puzzle_hide_notes_v1', 'true');
        closeNotes(); 
        document.getElementById('noteFloatBtn').classList.add('hidden'); 
    } 
}

const UPDATE_KEY = 'puzzle_update_notice_v3';
function checkUpdateNotice() {
    const hasRead = localStorage.getItem(UPDATE_KEY);
    if (!hasRead) {
        setTimeout(() => {
            const modal = document.getElementById('updateNoticeModal');
            if(modal) modal.style.display = 'flex';
        }, 500);
    }
}

function closeUpdateModal() { document.getElementById('updateNoticeModal').style.display = 'none'; }
function dontShowUpdateAgain() { localStorage.setItem(UPDATE_KEY, 'true'); closeUpdateModal(); }

window.addEventListener('beforeunload', function (e) { if (imagesData.length > 0) { e.preventDefault(); e.returnValue = '确定要离开吗？'; return '确定要离开吗？'; } });

window.addEventListener('DOMContentLoaded', () => { 
    loadSettings(); 
    initNotesCheck(); 
    checkUpdateNotice(); 
    const inputs = document.querySelectorAll('input, select'); 
    inputs.forEach(input => { 
        if(input.type !== 'file') { 
            input.addEventListener('change', saveSettings); 
            input.addEventListener('input', saveSettings); 
        } 
    }); 
});

function triggerBrowserPermission() {
    const a = document.createElement('a');
    const b = document.createElement('a');
    const blob = new Blob(["permission_check"], {type: "text/plain"});
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = "权限检测_1（都点取消即可）.txt";
    b.href = url; b.download = "权限检测_2.txt";
    document.body.appendChild(a); document.body.appendChild(b);
    a.click();
    setTimeout(() => {
        b.click();
        alert('请留意浏览器地址栏或顶部！\n\n如果出现【已拦截】或【允许下载多个文件】，请务必点击【允许】方便逐图导出\n\n允许后，再次点击“逐张下载”即可飞速下载。');
        setTimeout(() => {
            document.body.removeChild(a); document.body.removeChild(b);
            URL.revokeObjectURL(url);
            document.getElementById('permissionFixBtn').style.display = 'none'; 
        }, 1000);
    }, 100);
}
