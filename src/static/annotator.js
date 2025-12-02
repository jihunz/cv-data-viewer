/* Annotator Logic */
// Expose global function first to ensure availability
window.openExportModal = () => {
    const modal = document.getElementById('export-modal');
    if (modal) modal.classList.remove('hidden');
    else alert("Modal not found!");
};

(() => {
    // --- DOM Elements & Null Checks ---
    const canvas = document.getElementById('work-canvas');
    if (!canvas) { console.error("Canvas not found"); return; }
    
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');
    const boxList = document.getElementById('box-list');
    const filenameDisplay = document.getElementById('filename-display');
    const progressText = document.getElementById('progress-text');
    const classInput = document.getElementById('class-id');
    const autoCopyCheck = document.getElementById('auto-copy');
    
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const saveBtn = document.getElementById('save-btn');
    // exportBtn is handled via window.openExportModal
    
    // Export Modal Elements
    const exportModal = document.getElementById('export-modal');
    const cancelExportBtn = document.getElementById('cancel-export');
    const confirmExportBtn = document.getElementById('confirm-export');
    const resizeW = document.getElementById('resize-w');
    const resizeH = document.getElementById('resize-h');

    // --- State ---
    const data = window.annotateData || { images: [] };
    const images = data.images || [];
    const total = images.length;
    let currentIndex = 0;
    
    // Annotation Store
    const annotations = {}; 
    
    // Canvas State
    let currentImage = new Image();
    let boxes = [];
    
    // Undo History
    let boxHistory = [];
    const MAX_HISTORY = 20;

    let activeBoxIdx = -1;
    let isDrawing = false;
    let isDragging = false;
    let isResizing = false;
    let dragStart = { x: 0, y: 0 };
    let drawStart = { x: 0, y: 0 };
    let resizeHandle = null; 

    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;

    // --- Initialization ---
    function init() {
        if (total > 0) loadIndex(0);
        window.addEventListener('resize', () => {
            fitImageToCanvas();
            redraw();
        });
        
        // Bind Modal Events Here
        if (cancelExportBtn && exportModal) {
            cancelExportBtn.onclick = () => exportModal.classList.add('hidden');
        }
        
        if (confirmExportBtn) {
            confirmExportBtn.onclick = handleExport;
        }
    }

    // --- History ---
    function pushHistory() {
        const snapshot = JSON.parse(JSON.stringify(boxes));
        boxHistory.push(snapshot);
        if (boxHistory.length > MAX_HISTORY) boxHistory.shift();
    }

    function undo() {
        if (boxHistory.length === 0) return;
        const prevState = boxHistory.pop();
        boxes = prevState;
        activeBoxIdx = -1;
        saveCurrent();
        updateBoxList();
        redraw();
    }

    // --- Logic ---
    function loadIndex(idx) {
        const currentPath = images[currentIndex];
        if (currentPath) {
            annotations[currentPath] = JSON.parse(JSON.stringify(boxes));
        }

        if (idx < 0) idx = 0;
        if (idx >= total) idx = total - 1;
        
        let isCopied = false;
        if (idx === currentIndex + 1 && autoCopyCheck && autoCopyCheck.checked && boxes.length > 0) {
            const nextPath = images[idx];
            if (!annotations[nextPath]) {
                annotations[nextPath] = JSON.parse(JSON.stringify(boxes));
                isCopied = true;
            }
        }

        currentIndex = idx;
        const relPath = images[currentIndex];
        if (filenameDisplay) filenameDisplay.textContent = relPath;
        if (progressText) progressText.textContent = `${currentIndex + 1} / ${total}`;

        const url = new URL('/image', window.location.origin);
        url.searchParams.set('mode', 'folder');
        url.searchParams.set('rel_path', relPath);
        url.searchParams.set('img_dir', data.img_dir);
        
        currentImage = new Image();
        currentImage.src = url.toString();
        currentImage.onload = () => {
            fitImageToCanvas();
            boxes = annotations[relPath] ? JSON.parse(JSON.stringify(annotations[relPath])) : [];
            boxHistory = [];
            activeBoxIdx = -1;
            updateBoxList();
            redraw();
        };
    }

    function saveCurrent() {
        if (total === 0) return;
        const relPath = images[currentIndex];
        annotations[relPath] = JSON.parse(JSON.stringify(boxes));
        
        if (saveBtn) {
            const originalText = saveBtn.textContent;
            saveBtn.textContent = 'Saved!';
            setTimeout(() => { saveBtn.textContent = originalText; }, 1000);
        }
    }

    // --- Rendering ---
    function fitImageToCanvas() {
        if (!currentImage.width || !container) return;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        
        const iw = currentImage.naturalWidth;
        const ih = currentImage.naturalHeight;
        
        const wr = cw / iw;
        const hr = ch / ih;
        scale = Math.min(wr, hr) * 0.9;
        
        const renderW = iw * scale;
        const renderH = ih * scale;
        
        offsetX = (cw - renderW) / 2;
        offsetY = (ch - renderH) / 2;
        
        canvas.width = cw;
        canvas.height = ch;
    }

    function toScreen(nx, ny, nw, nh) {
        const iw = currentImage.naturalWidth;
        const ih = currentImage.naturalHeight;
        return {
            x: (nx * iw * scale) + offsetX - (nw * iw * scale / 2),
            y: (ny * ih * scale) + offsetY - (nh * ih * scale / 2),
            w: nw * iw * scale,
            h: nh * ih * scale
        };
    }

    function toNorm(sx, sy) {
        const iw = currentImage.naturalWidth;
        const ih = currentImage.naturalHeight;
        return {
            x: (sx - offsetX) / (iw * scale),
            y: (sy - offsetY) / (ih * scale)
        };
    }

    function redraw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!currentImage.width) return;

        const iw = currentImage.naturalWidth;
        const ih = currentImage.naturalHeight;
        ctx.drawImage(currentImage, offsetX, offsetY, iw * scale, ih * scale);

        boxes.forEach((box, i) => {
            const isActive = i === activeBoxIdx;
            const s = toScreen(box[1], box[2], box[3], box[4]);
            
            ctx.lineWidth = isActive ? 2 : 1.5;
            ctx.strokeStyle = isActive ? '#10b981' : 'rgba(239, 68, 68, 0.8)';
            
            ctx.fillStyle = isActive ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.1)';
            ctx.fillRect(s.x, s.y, s.w, s.h);
            ctx.strokeRect(s.x, s.y, s.w, s.h);
            
            const label = `#${i + 1} Cls ${box[0]}`;
            ctx.font = 'bold 12px Inter, sans-serif';
            const tm = ctx.measureText(label);
            ctx.fillStyle = isActive ? '#10b981' : '#ef4444';
            ctx.fillRect(s.x, s.y - 18, tm.width + 8, 18);
            
            ctx.fillStyle = '#fff';
            ctx.fillText(label, s.x + 4, s.y - 5);

            if (isActive) {
                drawFancyHandle(s.x, s.y);
                drawFancyHandle(s.x + s.w, s.y);
                drawFancyHandle(s.x, s.y + s.h);
                drawFancyHandle(s.x + s.w, s.y + s.h);
            }
        });
        
        if (isDrawing && drawStart.x !== 0) {
             // Drawing feedback handled in mousemove
        }
    }

    function drawFancyHandle(x, y) {
        const size = 8;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    // --- Interaction Helpers ---
    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function getHandle(boxIdx, mx, my) {
        const box = boxes[boxIdx];
        const s = toScreen(box[1], box[2], box[3], box[4]);
        const d = 12; 
        if (Math.abs(mx - s.x) < d && Math.abs(my - s.y) < d) return 'tl';
        if (Math.abs(mx - (s.x + s.w)) < d && Math.abs(my - s.y) < d) return 'tr';
        if (Math.abs(mx - s.x) < d && Math.abs(my - (s.y + s.h)) < d) return 'bl';
        if (Math.abs(mx - (s.x + s.w)) < d && Math.abs(my - (s.y + s.h)) < d) return 'br';
        return null;
    }

    function isInside(boxIdx, mx, my) {
        const box = boxes[boxIdx];
        const s = toScreen(box[1], box[2], box[3], box[4]);
        const padding = 8;
        return mx >= s.x - padding && mx <= s.x + s.w + padding && 
               my >= s.y - padding && my <= s.y + s.h + padding;
    }

    // --- Event Listeners ---
    canvas.addEventListener('mousedown', (e) => {
        const { x, y } = getMousePos(e);
        
        // Resize
        if (activeBoxIdx !== -1) {
            const handle = getHandle(activeBoxIdx, x, y);
            if (handle) {
                pushHistory();
                isResizing = true;
                resizeHandle = handle;
                dragStart = { x, y };
                return;
            }
        }

        // Select/Move
        let clickedIdx = -1;
        for (let i = boxes.length - 1; i >= 0; i--) {
            if (isInside(i, x, y)) {
                clickedIdx = i;
                break;
            }
        }

        if (clickedIdx !== -1) {
            if (clickedIdx !== activeBoxIdx) {
                activeBoxIdx = clickedIdx;
                updateBoxList();
                redraw();
            }
            isDragging = true;
            dragStart = { x, y };
            pushHistory(); 
            return;
        }

        // Draw
        pushHistory();
        activeBoxIdx = -1;
        isDrawing = true;
        drawStart = { x, y };
        redraw();
    });

    canvas.addEventListener('mousemove', (e) => {
        const { x, y } = getMousePos(e);
        const n = toNorm(x, y);

        // Cursor
        if (!isDrawing && !isDragging && !isResizing) {
            let cursor = 'crosshair';
            if (activeBoxIdx !== -1) {
                const handle = getHandle(activeBoxIdx, x, y);
                if (handle) {
                    if (handle === 'tl' || handle === 'br') cursor = 'nwse-resize';
                    else if (handle === 'tr' || handle === 'bl') cursor = 'nesw-resize';
                } else if (isInside(activeBoxIdx, x, y)) {
                    cursor = 'move';
                }
            } 
            if (cursor === 'crosshair') {
                for (let i = boxes.length - 1; i >= 0; i--) {
                    if (isInside(i, x, y)) {
                        cursor = 'pointer';
                        break;
                    }
                }
            }
            canvas.style.cursor = cursor;
        }

        if (isResizing && activeBoxIdx !== -1) {
            const box = boxes[activeBoxIdx];
            let s = toScreen(box[1], box[2], box[3], box[4]);
            let sx = s.x, sy = s.y, sw = s.w, sh = s.h;
            let ex = sx + sw, ey = sy + sh;

            if (resizeHandle === 'tl') { sx = x; sy = y; }
            else if (resizeHandle === 'tr') { ex = x; sy = y; }
            else if (resizeHandle === 'bl') { sx = x; ey = y; }
            else if (resizeHandle === 'br') { ex = x; ey = y; }

            if (sx > ex) [sx, ex] = [ex, sx];
            if (sy > ey) [sy, ey] = [ey, sy];

            const nw = ex - sx;
            const nh = ey - sy;
            const nxc = sx + nw / 2;
            const nyc = sy + nh / 2;

            const normC = toNorm(nxc, nyc);
            const iw = currentImage.naturalWidth * scale;
            const ih = currentImage.naturalHeight * scale;
            
            boxes[activeBoxIdx] = [box[0], normC.x, normC.y, nw / iw, nh / ih];
            redraw();
        } 
        else if (isDragging && activeBoxIdx !== -1) {
            const dx = x - dragStart.x;
            const dy = y - dragStart.y;
            const iw = currentImage.naturalWidth * scale;
            const ih = currentImage.naturalHeight * scale;
            
            const box = boxes[activeBoxIdx];
            boxes[activeBoxIdx] = [
                box[0], box[1] + (dx / iw), box[2] + (dy / ih), box[3], box[4]
            ];
            dragStart = { x, y };
            redraw();
        }
        else if (isDrawing) {
            redraw();
            const w = x - drawStart.x;
            const h = y - drawStart.y;
            ctx.save();
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#10b981';
            ctx.setLineDash([5, 3]);
            ctx.fillStyle = 'rgba(16, 185, 129, 0.1)';
            ctx.fillRect(drawStart.x, drawStart.y, w, h);
            ctx.strokeRect(drawStart.x, drawStart.y, w, h);
            ctx.fillStyle = '#fff';
            ctx.font = '10px Inter';
            ctx.fillText(`${Math.abs(w).toFixed(0)} x ${Math.abs(h).toFixed(0)}`, drawStart.x, drawStart.y - 5);
            ctx.restore();
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (isDrawing) {
            const { x, y } = getMousePos(e);
            if (Math.abs(x - drawStart.x) > 5 && Math.abs(y - drawStart.y) > 5) {
                let sx = drawStart.x, sy = drawStart.y;
                let ex = x, ey = y;
                if (sx > ex) [sx, ex] = [ex, sx];
                if (sy > ey) [sy, ey] = [ey, sy];

                const w = ex - sx;
                const h = ey - sy;
                const xc = sx + w / 2;
                const yc = sy + h / 2;

                const nC = toNorm(xc, yc);
                const iw = currentImage.naturalWidth * scale;
                const ih = currentImage.naturalHeight * scale;

                const newBox = [
                    parseInt(classInput.value, 10) || 0,
                    nC.x, nC.y,
                    w / iw, h / ih
                ];
                boxes.push(newBox);
                activeBoxIdx = boxes.length - 1;
                saveCurrent();
                updateBoxList();
            }
        } else if (isDragging || isResizing) {
            saveCurrent();
        }

        isDrawing = false;
        isDragging = false;
        isResizing = false;
        resizeHandle = null;
        redraw();
    });

    function updateBoxList() {
        if (!boxList) return;
        boxList.innerHTML = '';
        boxes.forEach((box, i) => {
            const li = document.createElement('li');
            li.style.padding = '4px 8px';
            li.style.border = '1px solid var(--border)';
            li.style.marginBottom = '4px';
            li.style.borderRadius = '4px';
            li.style.cursor = 'pointer';
            li.style.display = 'flex';
            li.style.justifyContent = 'space-between';
            
            if (i === activeBoxIdx) {
                li.style.background = 'var(--accent)';
                li.style.color = 'white';
            }

            const text = document.createElement('span');
            text.textContent = `Box #${i + 1} (Cls ${box[0]})`;
            text.onclick = () => {
                activeBoxIdx = i;
                updateBoxList();
                redraw();
            };

            const delBtn = document.createElement('span');
            delBtn.textContent = '×';
            delBtn.style.fontWeight = 'bold';
            delBtn.style.cursor = 'pointer';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                pushHistory();
                boxes.splice(i, 1);
                activeBoxIdx = -1;
                saveCurrent();
                updateBoxList();
                redraw();
            };

            li.appendChild(text);
            li.appendChild(delBtn);
            boxList.appendChild(li);
        });
    }

    // --- Export Async Function ---
    // Expose globally for inline onclick
    window.handleExport = async function() {
        const resizeW = document.getElementById('resize-w');
        const resizeH = document.getElementById('resize-h');
        const confirmExportBtn = document.getElementById('confirm-export');
        const exportModal = document.getElementById('export-modal');

        const w = parseInt(resizeW.value, 10);
        const h = parseInt(resizeH.value, 10);
        
        if (!w || !h) {
            alert('Invalid target size');
            return;
        }

        try {
            // We need access to saveCurrent from closure scope. 
            // If this is global, we might not have access.
            // But we are inside IIFE? No, we are assigning to window inside IIFE.
            // So we have access to saveCurrent closure.
            saveCurrent(); 
        } catch(e) { console.warn(e); }
        
        if (confirmExportBtn) {
            confirmExportBtn.disabled = true;
            confirmExportBtn.textContent = 'Processing...';
        }

        // Format annotations for export
        const exportData = {};
        for (const [path, boxList] of Object.entries(annotations)) {
            if (boxList && boxList.length > 0) {
                // Use safe access based on object structure
                exportData[path] = boxList.map(b => {
                    // Handle both array and object format just in case
                    if (Array.isArray(b)) return b; 
                    return [b.cls, b.x, b.y, b.w, b.h];
                });
            }
        }

        const payload = {
            img_dir: data.img_dir,
            target_size: [w, h],
            annotations: exportData
        };

        try {
            const res = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (res.ok) {
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `dataset_export.zip`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                if (exportModal) exportModal.classList.add('hidden');
            } else {
                const errText = await res.text();
                alert('Export failed: ' + errText);
            }
        } catch (e) {
            console.error(e);
            alert('Error exporting dataset: ' + e.message);
        } finally {
            if (confirmExportBtn) {
                confirmExportBtn.disabled = false;
                confirmExportBtn.textContent = 'Download ZIP';
            }
        }
    };

    // --- Keyboard ---
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;

        if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            e.preventDefault();
            undo();
            return;
        }

        if (e.key === 'd' || e.key === 'ArrowRight') {
            saveCurrent();
            loadIndex(currentIndex + 1);
        } else if (e.key === 'a' || e.key === 'ArrowLeft') {
            saveCurrent();
            loadIndex(currentIndex - 1);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (activeBoxIdx !== -1) {
                pushHistory();
                boxes.splice(activeBoxIdx, 1);
                activeBoxIdx = -1;
                saveCurrent();
                updateBoxList();
                redraw();
            }
        } else if (e.key >= '0' && e.key <= '9') {
            if (classInput) classInput.value = e.key;
        }
    });

    // --- Start ---
    if (prevBtn) prevBtn.onclick = () => loadIndex(currentIndex - 1);
    if (nextBtn) nextBtn.onclick = () => loadIndex(currentIndex + 1);
    if (saveBtn) saveBtn.onclick = saveCurrent;

    init();
})();
