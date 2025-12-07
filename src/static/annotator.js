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

    // AI Mode Elements
    const aiModeToggle = document.getElementById('ai-mode-toggle');
    const aiOptions = document.getElementById('ai-options');
    const aiStatus = document.getElementById('ai-status');
    const aiModelSelect = document.getElementById('ai-model');
    const aiConfidenceSlider = document.getElementById('ai-confidence');
    const confidenceValue = document.getElementById('confidence-value');
    const classFilterInput = document.getElementById('class-filter');
    const classFilterSection = document.getElementById('class-filter-section');
    const detectCurrentBtn = document.getElementById('detect-current-btn');
    const detectionModeRadios = document.querySelectorAll('input[name="detection-mode"]');

    // --- State ---
    const data = window.annotateData || { images: [] };
    const images = data.images || [];
    const total = images.length;
    const labelDir = data.label_dir || null; // Optional label directory for loading existing labels
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

    // AI Mode State
    let aiModeEnabled = false;
    let isDetecting = false;
    let isBatchDetecting = false;
    let batchStartTime = 0;
    let batchDetectedCount = 0;
    let batchTotalBoxes = 0;

    // --- Initialization ---
    async function init() {
        // Show label dir indicator if present
        if (labelDir) {
            console.log(`[Labels] Label directory: ${labelDir}`);
            showLabelDirIndicator();
        }
        
        if (total > 0) await loadIndex(0);
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
        
        // Initialize AI Mode
        initAIMode();
    }
    
    function showLabelDirIndicator() {
        // Add indicator to the UI showing label directory is active
        const sidebar = document.querySelector('.ann-sidebar');
        if (!sidebar) return;
        
        const indicator = document.createElement('div');
        indicator.className = 'label-dir-indicator';
        indicator.innerHTML = `
            <div style="padding: 0.75rem; background: rgba(16, 185, 129, 0.1); border: 1px solid var(--accent); border-radius: 8px; margin-bottom: 1rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
                    <span style="font-size: 1rem;">📁</span>
                    <span style="font-weight: 600; color: var(--accent);">라벨 수정 모드</span>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); word-break: break-all;">
                    ${labelDir}
                </div>
            </div>
        `;
        sidebar.insertBefore(indicator, sidebar.firstChild);
    }

    // --- AI Mode ---
    function initAIMode() {
        console.log('[AI] initAIMode called');
        console.log('[AI] aiModeToggle:', aiModeToggle);
        console.log('[AI] aiOptions:', aiOptions);
        console.log('[AI] detectCurrentBtn:', detectCurrentBtn);
        
        // Toggle AI Mode
        if (aiModeToggle) {
            aiModeToggle.onchange = () => {
                console.log('[AI] Toggle changed:', aiModeToggle.checked);
                aiModeEnabled = aiModeToggle.checked;
                if (aiOptions) {
                    aiOptions.classList.toggle('hidden', !aiModeEnabled);
                    console.log('[AI] aiOptions hidden:', aiOptions.classList.contains('hidden'));
                }
                
                const aiSection = document.querySelector('.ai-mode-section');
                
                if (aiModeEnabled) {
                    updateAIStatus('active');
                    // Just show options, don't start batch yet
                    // User will click "Detect Current Image" to start
                } else {
                    // Disable AI mode - cleanup
                    updateAIStatus('');
                    if (aiSection) aiSection.classList.remove('ai-working');
                    setCanvasInteraction(true);
                    
                    // Stop batch if running
                    if (isBatchDetecting) {
                        isBatchDetecting = false;
                        isDetecting = false;
                    }
                    
                    // Re-enable controls
                    if (prevBtn) prevBtn.disabled = false;
                    if (nextBtn) nextBtn.disabled = false;
                    if (detectCurrentBtn) {
                        detectCurrentBtn.disabled = false;
                        detectCurrentBtn.innerHTML = '<span>🔍</span> Detect Current Image';
                    }
                }
            };
        } else {
            console.warn('[AI] aiModeToggle not found!');
        }
        
        // Confidence slider
        if (aiConfidenceSlider && confidenceValue) {
            aiConfidenceSlider.oninput = () => {
                confidenceValue.textContent = aiConfidenceSlider.value;
            };
        }
        
        // Detection mode toggle (all vs specific classes)
        detectionModeRadios.forEach(radio => {
            radio.onchange = () => {
                const isSpecific = radio.value === 'specific' && radio.checked;
                if (classFilterSection) {
                    classFilterSection.classList.toggle('hidden', !isSpecific);
                }
            };
        });
        
        // Detect current image button
        if (detectCurrentBtn) {
            detectCurrentBtn.onclick = () => {
                console.log('[AI] Detect button clicked');
                if (aiModeEnabled && total > 0) {
                    // Start batch detection with animation
                    const aiSection = document.querySelector('.ai-mode-section');
                    if (aiSection) aiSection.classList.add('ai-working');
                    setCanvasInteraction(false);
                    startBatchDetection();
                } else if (total > 0) {
                    // Single image detection
                    runDetection(false);
                }
            };
        } else {
            console.warn('[AI] detectCurrentBtn not found!');
        }
    }
    
    function updateAIStatus(status, extra = '') {
        if (!aiStatus) return;
        aiStatus.className = 'ai-status';
        if (status === 'active') {
            aiStatus.textContent = 'ON';
            aiStatus.classList.add('active');
        } else if (status === 'loading') {
            aiStatus.textContent = extra || 'Detecting...';
            aiStatus.classList.add('loading');
        } else if (status === 'batch') {
            aiStatus.textContent = extra || 'Batch...';
            aiStatus.classList.add('loading');
        } else {
            aiStatus.textContent = '';
        }
    }
    
    function setCanvasInteraction(enabled) {
        const canvasArea = document.getElementById('canvas-container');
        if (!canvasArea) return;
        
        if (enabled) {
            canvasArea.classList.remove('ai-locked');
            canvas.style.pointerEvents = 'auto';
        } else {
            canvasArea.classList.add('ai-locked');
            canvas.style.pointerEvents = 'none';
        }
    }
    
    function getDetectionParams() {
        const model = aiModelSelect ? aiModelSelect.value : 'yolo12x';
        const conf = aiConfidenceSlider ? parseFloat(aiConfidenceSlider.value) : 0.25;
        
        // Check detection mode
        let classes = null;
        const specificMode = document.querySelector('input[name="detection-mode"][value="specific"]');
        if (specificMode && specificMode.checked && classFilterInput) {
            const filterText = classFilterInput.value.trim();
            if (filterText) {
                classes = filterText.split(',')
                    .map(s => parseInt(s.trim(), 10))
                    .filter(n => !isNaN(n));
            }
        }
        
        return { model, conf, classes };
    }
    
    async function runDetection(continueToNext = false) {
        if (isDetecting || total === 0) return;
        
        const relPath = images[currentIndex];
        if (!relPath) return;
        
        isDetecting = true;
        
        if (isBatchDetecting) {
            updateAIStatus('batch', `${currentIndex + 1}/${total}`);
        } else {
            updateAIStatus('loading');
        }
        
        if (detectCurrentBtn && !isBatchDetecting) {
            detectCurrentBtn.disabled = true;
            detectCurrentBtn.innerHTML = '<span>⏳</span> Detecting...';
        }
        
        const params = getDetectionParams();
        let detectedCount = 0;
        
        try {
            const res = await fetch('/api/detect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    img_dir: data.img_dir,
                    rel_path: relPath,
                    model: params.model,
                    classes: params.classes,
                    conf: params.conf
                })
            });
            
            if (res.ok) {
                const result = await res.json();
                if (result.detections && result.detections.length > 0) {
                    pushHistory();
                    
                    // Add detected boxes (format: [class_id, x, y, w, h, conf])
                    // We store as [class_id, x, y, w, h] (no confidence)
                    for (const det of result.detections) {
                        const newBox = [det[0], det[1], det[2], det[3], det[4]];
                        boxes.push(newBox);
                    }
                    
                    saveCurrent();
                    updateBoxList();
                    redraw();
                    
                    detectedCount = result.detections.length;
                    batchTotalBoxes += detectedCount;
                    console.log(`[AI] Detected ${detectedCount} objects`);
                } else {
                    console.log('[AI] No objects detected');
                }
                
                // Batch mode: continue to next image
                if (isBatchDetecting && aiModeEnabled) {
                    batchDetectedCount++;
                    
                    if (currentIndex < total - 1) {
                        // Move to next image and continue detection
                        isDetecting = false;
                        loadIndexForBatch(currentIndex + 1);
                        return;
                    } else {
                        // Reached last image - finish batch
                        finishBatchDetection();
                        return;
                    }
                }
            } else {
                const errText = await res.text();
                console.error('[AI] Detection failed:', errText);
                if (!isBatchDetecting) {
                    alert('Detection failed: ' + errText);
                }
                // Stop batch on error
                if (isBatchDetecting) {
                    finishBatchDetection(true);
                    return;
                }
            }
        } catch (e) {
            console.error('[AI] Error:', e);
            if (!isBatchDetecting) {
                alert('Detection error: ' + e.message);
            }
            if (isBatchDetecting) {
                finishBatchDetection(true);
                return;
            }
        } finally {
            isDetecting = false;
            
            if (!isBatchDetecting) {
                updateAIStatus(aiModeEnabled ? 'active' : '');
                
                if (detectCurrentBtn) {
                    detectCurrentBtn.disabled = false;
                    detectCurrentBtn.innerHTML = '<span>🔍</span> Detect Current Image';
                }
            }
        }
    }
    
    async function loadIndexForBatch(idx) {
        // Save current annotations
        const currentPath = images[currentIndex];
        if (currentPath) {
            annotations[currentPath] = JSON.parse(JSON.stringify(boxes));
        }
        
        if (idx >= total) {
            finishBatchDetection();
            return;
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
        currentImage.onload = async () => {
            fitImageToCanvas();
            
            // When labelDir is set, always try to load from file first
            if (labelDir) {
                const loadedLabels = await loadExistingLabels(relPath);
                boxes = loadedLabels;
                annotations[relPath] = JSON.parse(JSON.stringify(boxes));
            } else {
                const cachedAnnotations = annotations[relPath];
                const hasCachedAnnotations = cachedAnnotations && cachedAnnotations.length > 0;
                
                if (hasCachedAnnotations) {
                    boxes = JSON.parse(JSON.stringify(cachedAnnotations));
                } else {
                    boxes = [];
                }
            }
            
            boxHistory = [];
            activeBoxIdx = -1;
            updateBoxList();
            redraw();
            
            // Continue batch detection
            if (isBatchDetecting && aiModeEnabled) {
                runDetection(true);
            }
        };
    }
    
    function startBatchDetection() {
        if (isBatchDetecting || total === 0) return;
        
        isBatchDetecting = true;
        batchStartTime = Date.now();
        batchDetectedCount = 0;
        batchTotalBoxes = 0;
        
        // Add working animation to AI section
        const aiSection = document.querySelector('.ai-mode-section');
        if (aiSection) aiSection.classList.add('ai-working');
        
        // Disable controls during batch
        if (detectCurrentBtn) {
            detectCurrentBtn.disabled = true;
            detectCurrentBtn.innerHTML = '<span>⏳</span> Batch Running...';
        }
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        
        // Start from current image
        runDetection(true);
    }
    
    function finishBatchDetection(hasError = false) {
        isBatchDetecting = false;
        isDetecting = false;
        
        const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        
        // Remove working animation
        const aiSection = document.querySelector('.ai-mode-section');
        if (aiSection) aiSection.classList.remove('ai-working');
        
        // Disable AI mode
        aiModeEnabled = false;
        if (aiModeToggle) aiModeToggle.checked = false;
        if (aiOptions) aiOptions.classList.add('hidden');
        updateAIStatus('');
        
        // Re-enable canvas interaction
        setCanvasInteraction(true);
        
        // Re-enable controls
        if (detectCurrentBtn) {
            detectCurrentBtn.disabled = false;
            detectCurrentBtn.innerHTML = '<span>🔍</span> Detect Current Image';
        }
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
        
        // Show result modal
        showBatchResultModal({
            elapsed,
            imagesProcessed: batchDetectedCount,
            totalImages: total,
            totalBoxes: batchTotalBoxes,
            hasError
        });
    }
    
    function showBatchResultModal(results) {
        // Create modal if not exists
        let modal = document.getElementById('batch-result-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'batch-result-modal';
            modal.className = 'batch-modal';
            modal.innerHTML = `
                <div class="dataset-form" style="width: 400px; text-align: center;">
                    <h2 style="margin-bottom: 1rem;">🎉 Batch Detection Complete</h2>
                    <div id="batch-result-content" style="text-align: left; margin-bottom: 1.5rem;"></div>
                    <button class="btn primary" id="close-batch-modal">Close (ESC)</button>
                </div>
            `;
            document.body.appendChild(modal);
            
            // Close button
            document.getElementById('close-batch-modal').onclick = () => {
                modal.classList.add('hidden');
            };
        }
        
        // Update content
        const content = document.getElementById('batch-result-content');
        content.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem; background: var(--bg-primary); border-radius: 8px;">
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-secondary);">⏱️ Elapsed Time</span>
                    <span style="font-weight: 600;">${results.elapsed}s</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-secondary);">🖼️ Images Processed</span>
                    <span style="font-weight: 600;">${results.imagesProcessed} / ${results.totalImages}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-secondary);">📦 Total Boxes Detected</span>
                    <span style="font-weight: 600;">${results.totalBoxes}</span>
                </div>
                ${results.hasError ? '<div style="color: #ef4444; font-size: 0.9rem;">⚠️ Stopped due to error</div>' : ''}
            </div>
        `;
        
        modal.classList.remove('hidden');
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
    async function loadIndex(idx) {
        const currentPath = images[currentIndex];
        if (currentPath) {
            annotations[currentPath] = JSON.parse(JSON.stringify(boxes));
        }

        if (idx < 0) idx = 0;
        if (idx >= total) idx = total - 1;
        
        // Note: "Copy boxes to next image" is disabled when labelDir is set
        // because we want to load existing labels from files
        let isCopied = false;
        if (!labelDir && idx === currentIndex + 1 && autoCopyCheck && autoCopyCheck.checked && boxes.length > 0) {
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
        currentImage.onload = async () => {
            fitImageToCanvas();
            
            // When labelDir is set, always try to load from file first
            if (labelDir) {
                // Load existing labels from label directory
                const loadedLabels = await loadExistingLabels(relPath);
                boxes = loadedLabels;
                annotations[relPath] = JSON.parse(JSON.stringify(boxes));
            } else {
                // No labelDir: use cached annotations or empty
                const cachedAnnotations = annotations[relPath];
                const hasCachedAnnotations = cachedAnnotations && cachedAnnotations.length > 0;
                
                if (hasCachedAnnotations) {
                    boxes = JSON.parse(JSON.stringify(cachedAnnotations));
                } else {
                    boxes = [];
                }
            }
            
            boxHistory = [];
            activeBoxIdx = -1;
            updateBoxList();
            redraw();
            
            // Note: Auto-detect is now handled by batch mode
            // Manual navigation doesn't auto-detect anymore
        };
    }
    
    // Load existing labels from label directory
    async function loadExistingLabels(relPath) {
        if (!labelDir) return [];
        
        try {
            const url = new URL('/api/annotate/labels', window.location.origin);
            url.searchParams.set('rel_path', relPath);
            url.searchParams.set('label_dir', labelDir);
            
            const res = await fetch(url.toString());
            if (res.ok) {
                const result = await res.json();
                if (result.labels && result.labels.length > 0) {
                    console.log(`[Labels] Loaded ${result.labels.length} boxes for ${relPath}`);
                    return result.labels;
                }
            }
        } catch (e) {
            console.error('[Labels] Failed to load existing labels:', e);
        }
        return [];
    }

    async function saveCurrent() {
        if (total === 0) return;
        const relPath = images[currentIndex];
        annotations[relPath] = JSON.parse(JSON.stringify(boxes));
        
        // If label directory is set, save to file
        if (labelDir) {
            try {
                const res = await fetch('/api/annotate/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        label_dir: labelDir,
                        rel_path: relPath,
                        boxes: boxes
                    })
                });
                
                if (res.ok) {
                    console.log(`[Labels] Saved ${boxes.length} boxes for ${relPath}`);
                } else {
                    console.error('[Labels] Failed to save labels:', await res.text());
                }
            } catch (e) {
                console.error('[Labels] Error saving labels:', e);
            }
        }
        
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
        // ESC to close modals
        if (e.key === 'Escape') {
            const batchModal = document.getElementById('batch-result-modal');
            if (batchModal && !batchModal.classList.contains('hidden')) {
                batchModal.classList.add('hidden');
                return;
            }
            if (exportModal && !exportModal.classList.contains('hidden')) {
                exportModal.classList.add('hidden');
                return;
            }
        }
        
        if (e.target.tagName === 'INPUT') return;

        if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            e.preventDefault();
            undo();
            return;
        }

        if (e.key === 'd' || e.key === 'ArrowRight') {
            if (isBatchDetecting) return; // Disable during batch
            saveCurrent().then(() => loadIndex(currentIndex + 1));
        } else if (e.key === 'a' || e.key === 'ArrowLeft') {
            if (isBatchDetecting) return; // Disable during batch
            saveCurrent().then(() => loadIndex(currentIndex - 1));
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
    if (prevBtn) prevBtn.onclick = () => { saveCurrent().then(() => loadIndex(currentIndex - 1)); };
    if (nextBtn) nextBtn.onclick = () => { saveCurrent().then(() => loadIndex(currentIndex + 1)); };
    if (saveBtn) saveBtn.onclick = () => saveCurrent();

    init();
})();
