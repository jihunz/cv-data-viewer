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
    const firstBtn = document.getElementById('first-btn');
    const lastBtn = document.getElementById('last-btn');
    const searchInput = document.getElementById('search-input');
    const saveBtn = document.getElementById('save-btn');
    // exportBtn is handled via window.openExportModal
    
    // Export Modal Elements
    const exportModal = document.getElementById('export-modal');
    const cancelExportBtn = document.getElementById('cancel-export');
    const confirmExportBtn = document.getElementById('confirm-export');
    const resizeW = document.getElementById('resize-w');
    const resizeH = document.getElementById('resize-h');

    // Navigation

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
    
    // Track images that have been loaded from file (to preserve edits)
    const loadedFromFile = new Set(); 
    
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

    // Point Mode Elements & State
    const pointModeToggle = document.getElementById('point-mode-toggle');
    const pointOptions = document.getElementById('point-options');
    const pointWSlider = document.getElementById('point-w');
    const pointHSlider = document.getElementById('point-h');
    const pointWVal = document.getElementById('point-w-val');
    const pointHVal = document.getElementById('point-h-val');
    let pointModeEnabled = false;
    let pointBoxW = 0.15;
    let pointBoxH = 0.30;

    // CSV Class Map
    const csvModeToggle = document.getElementById('csv-mode-toggle');
    const csvOptions = document.getElementById('csv-options');
    const csvPathInput = document.getElementById('csv-path');
    const csvLoadBtn = document.getElementById('csv-load-btn');
    const csvStatus = document.getElementById('csv-status');
    let csvEnabled = false;
    let csvData = {}; // { "fall-01": { 1: -1, 2: 1, ... }, ... }

    // Range Edit Mode
    const rangeClassInput = document.getElementById('range-class');
    const rangeStartBtn = document.getElementById('range-start-btn');
    const rangeApplyBtn = document.getElementById('range-apply-btn');
    const rangeStatus = document.getElementById('range-status');
    const rangeSection = rangeStartBtn ? rangeStartBtn.closest('.sb-section') : null;
    let rangeStartIdx = -1;

    // Class edit via keyboard (multi-digit with debounce)
    let classKeyBuffer = '';
    let classKeyTimer = null;

    // AI Mode State
    let aiModeEnabled = false;
    let isDetecting = false;
    let isBatchDetecting = false;
    let batchStartTime = 0;
    let batchDetectedCount = 0;
    let batchTotalBoxes = 0;

    // --- Initialization ---
    async function init() {
        // Initialize Navigation
        initNavigation();

        // Uncheck auto-copy when label directory is loaded (existing labels present)
        if (labelDir && autoCopyCheck) {
            autoCopyCheck.checked = false;
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
        initPointMode();
        initCSVMode();
        initRangeMode();
    }

    function initNavigation() {
        // counter-input: focus → select, Enter → jump
        if (progressText) {
            progressText.addEventListener('focus', () => {
                progressText.select();
            });
            progressText.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    jumpToIndex(progressText.value);
                    progressText.blur();
                }
            });
        }

        // search-input: Enter → find next match
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    searchFilename(searchInput.value.trim());
                }
            });
        }
    }

    function searchFilename(query) {
        if (!query) return;
        const q = query.toLowerCase();
        // Search forward from current index, wrap around
        for (let i = 1; i <= total; i++) {
            const idx = (currentIndex + i) % total;
            const name = (images[idx] || '').toLowerCase();
            if (name.includes(q)) {
                saveCurrent().then(() => loadIndex(idx));
                return;
            }
        }
    }

    function goToFirst() {
        stopAuto();
        saveCurrent().then(() => loadIndex(0));
    }

    function goToLast() {
        stopAuto();
        saveCurrent().then(() => loadIndex(total - 1));
    }

    function jumpToIndex(val) {
        let idx = parseInt(val, 10);
        if (isNaN(idx)) return;
        idx = idx - 1; // 1-based → 0-based
        if (idx < 0) idx = 0;
        if (idx >= total) idx = total - 1;
        saveCurrent().then(() => loadIndex(idx));
    }

    function updateFilenameDisplay(relPath) {
        if (!filenameDisplay) return;
        if (!relPath) { filenameDisplay.textContent = '-'; return; }
        if (labelDir) {
            const labelRelPath = relPath.replace(/\.[^.]+$/, '.txt');
            filenameDisplay.innerHTML = `<b>IMG</b> ${relPath} &nbsp; <b>LBL</b> ${labelRelPath}`;
        } else {
            filenameDisplay.textContent = relPath;
        }
    }

    // --- Point Mode ---
    function initPointMode() {
        if (pointModeToggle) {
            pointModeToggle.onchange = () => {
                pointModeEnabled = pointModeToggle.checked;
                if (pointOptions) pointOptions.classList.toggle('hidden', !pointModeEnabled);
                if (container) container.classList.toggle('point-cursor', pointModeEnabled);
            };
        }
        if (pointWSlider) {
            pointWSlider.oninput = () => {
                pointBoxW = parseFloat(pointWSlider.value);
                if (pointWVal) pointWVal.textContent = pointBoxW.toFixed(2);
                redraw();
            };
        }
        if (pointHSlider) {
            pointHSlider.oninput = () => {
                pointBoxH = parseFloat(pointHSlider.value);
                if (pointHVal) pointHVal.textContent = pointBoxH.toFixed(2);
                redraw();
            };
        }
    }

    function getCSVClassForCurrentImage() {
        if (!csvEnabled || Object.keys(csvData).length === 0) return null;
        const relPath = images[currentIndex] || '';
        const filename = relPath.split('/').pop().replace(/\.[^.]+$/, ''); // e.g. fall-01-cam0-rgb-005
        // Extract sequence and frame: "fall-01-cam0-rgb-005" → seq="fall-01", frame=5
        const match = filename.match(/^((?:fall|adl)-\d+).*?(\d+)$/);
        if (!match) return null;
        const seq = match[1];
        const frame = parseInt(match[2], 10);
        if (csvData[seq] && csvData[seq][frame] !== undefined) {
            const label = csvData[seq][frame];
            // -1 = not lying (class 0), 0 = falling (class 1), 1 = lying (class 2)
            if (label === -1) return 0;
            if (label === 0) return 1;
            if (label === 1) return 2;
        }
        return null;
    }

    // --- CSV Mode ---
    function initCSVMode() {
        if (csvModeToggle) {
            csvModeToggle.onchange = () => {
                csvEnabled = csvModeToggle.checked;
                if (csvOptions) csvOptions.classList.toggle('hidden', !csvEnabled);
            };
        }
        if (csvLoadBtn) {
            csvLoadBtn.onclick = async () => {
                const csvPath = csvPathInput ? csvPathInput.value.trim() : '';
                if (!csvPath) return;
                csvLoadBtn.disabled = true;
                csvLoadBtn.textContent = 'Loading...';
                try {
                    const res = await fetch(`/api/csv-labels?path=${encodeURIComponent(csvPath)}`);
                    if (!res.ok) throw new Error((await res.json()).detail || 'Failed');
                    const result = await res.json();
                    csvData = result.data;
                    const count = Object.values(csvData).reduce((s, v) => s + Object.keys(v).length, 0);
                    if (csvStatus) csvStatus.textContent = `Loaded: ${Object.keys(csvData).length} sequences, ${count} frames`;
                } catch (e) {
                    if (csvStatus) csvStatus.textContent = 'Error: ' + e.message;
                } finally {
                    csvLoadBtn.disabled = false;
                    csvLoadBtn.textContent = 'Load CSV';
                }
            };
        }
    }

    // --- Range Edit Mode ---
    function initRangeMode() {
        if (rangeStartBtn) {
            rangeStartBtn.onclick = () => {
                rangeStartIdx = currentIndex;
                if (rangeSection) rangeSection.classList.add('range-active');
                if (rangeApplyBtn) rangeApplyBtn.disabled = false;
                if (rangeStatus) rangeStatus.textContent = `Start: #${currentIndex + 1} (${images[currentIndex]?.split('/').pop() || ''})`;
            };
        }
        if (rangeApplyBtn) {
            rangeApplyBtn.onclick = () => {
                if (rangeStartIdx === -1) return;
                const targetClass = parseInt(rangeClassInput?.value ?? '0', 10);
                const startI = Math.min(rangeStartIdx, currentIndex);
                const endI = Math.max(rangeStartIdx, currentIndex);

                // Save current boxes first
                annotations[images[currentIndex]] = JSON.parse(JSON.stringify(boxes));

                let changed = 0;
                for (let i = startI; i <= endI; i++) {
                    const path = images[i];
                    const ann = annotations[path];
                    if (ann && ann.length > 0) {
                        for (const box of ann) {
                            box[0] = targetClass;
                        }
                        changed++;
                    }
                }

                // Reload current image boxes from annotations
                boxes = annotations[images[currentIndex]] ? JSON.parse(JSON.stringify(annotations[images[currentIndex]])) : [];

                // Auto-save all changed labels if labelDir exists
                if (labelDir) {
                    for (let i = startI; i <= endI; i++) {
                        const path = images[i];
                        const ann = annotations[path];
                        if (ann && ann.length > 0) {
                            fetch('/api/annotate/save', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ label_dir: labelDir, rel_path: path, boxes: ann })
                            });
                        }
                    }
                }

                // Reset range
                rangeStartIdx = -1;
                if (rangeSection) rangeSection.classList.remove('range-active');
                if (rangeApplyBtn) rangeApplyBtn.disabled = true;
                if (rangeStatus) rangeStatus.textContent = `Done: ${startI + 1}~${endI + 1} → class ${targetClass} (${changed} images)`;

                updateBoxList();
                redraw();
            };
        }
    }

    // --- Class Edit Helpers ---
    function showClassEditToast(text) {
        let toast = document.getElementById('class-edit-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'class-edit-toast';
            toast.className = 'class-edit-toast';
            container.appendChild(toast);
        }
        toast.textContent = text;
        toast.style.display = 'block';
    }

    function hideClassEditToast() {
        const toast = document.getElementById('class-edit-toast');
        if (toast) toast.style.display = 'none';
    }

    function applyClassKeyBuffer() {
        if (classKeyBuffer === '' || activeBoxIdx === -1) {
            classKeyBuffer = '';
            hideClassEditToast();
            return;
        }
        const newCls = parseInt(classKeyBuffer, 10);
        if (!isNaN(newCls) && newCls >= 0) {
            pushHistory();
            boxes[activeBoxIdx][0] = newCls;
            saveCurrent();
            updateBoxList();
            redraw();
        }
        classKeyBuffer = '';
        hideClassEditToast();
    }

    // --- AI Mode ---
    async function loadModelOptions() {
        if (!aiModelSelect) return;
        try {
            const res = await fetch('/api/models');
            if (!res.ok) return;
            const { models } = await res.json();
            if (models.length === 0) return;
            aiModelSelect.innerHTML = '';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                aiModelSelect.appendChild(opt);
            }
        } catch (e) {
            console.error('[AI] Failed to load models:', e);
        }
    }

    function initAIMode() {
        loadModelOptions();

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
        updateFilenameDisplay(relPath);
        if (progressText) progressText.value = `${currentIndex + 1} / ${total}`;

        const url = new URL('/image', window.location.origin);
        url.searchParams.set('mode', 'folder');
        url.searchParams.set('rel_path', relPath);
        url.searchParams.set('img_dir', data.img_dir);

        currentImage = new Image();
        currentImage.src = url.toString();
        currentImage.onload = async () => {
            fitImageToCanvas();

            if (labelDir) {
                if (loadedFromFile.has(relPath)) {
                    boxes = annotations[relPath] ? JSON.parse(JSON.stringify(annotations[relPath])) : [];
                } else {
                    const loadedLabels = await loadExistingLabels(relPath);
                    boxes = loadedLabels;
                    annotations[relPath] = JSON.parse(JSON.stringify(boxes));
                    loadedFromFile.add(relPath);
                }
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
        updateFilenameDisplay(relPath);
        if (progressText) progressText.value = `${currentIndex + 1} / ${total}`;

        const url = new URL('/image', window.location.origin);
        url.searchParams.set('mode', 'folder');
        url.searchParams.set('rel_path', relPath);
        url.searchParams.set('img_dir', data.img_dir);

        currentImage = new Image();
        currentImage.src = url.toString();
        currentImage.onload = async () => {
            fitImageToCanvas();

            if (labelDir) {
                if (loadedFromFile.has(relPath)) {
                    boxes = annotations[relPath] ? JSON.parse(JSON.stringify(annotations[relPath])) : [];
                } else {
                    const loadedLabels = await loadExistingLabels(relPath);
                    boxes = loadedLabels;
                    annotations[relPath] = JSON.parse(JSON.stringify(boxes));
                    loadedFromFile.add(relPath);
                }
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

    // Class color palette
    const CLASS_COLORS = [
        '#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6',
        '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
        '#14b8a6', '#e11d48', '#0ea5e9', '#a855f7', '#eab308',
        '#22c55e', '#f43f5e', '#2563eb', '#d946ef', '#64748b',
    ];
    function classColor(clsId) {
        return CLASS_COLORS[clsId % CLASS_COLORS.length];
    }
    function classColorAlpha(clsId, alpha) {
        const hex = classColor(clsId);
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function redraw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!currentImage.width) return;

        const iw = currentImage.naturalWidth;
        const ih = currentImage.naturalHeight;
        ctx.drawImage(currentImage, offsetX, offsetY, iw * scale, ih * scale);

        boxes.forEach((box, i) => {
            const isActive = i === activeBoxIdx;
            const clsId = box[0];
            const color = classColor(clsId);
            const s = toScreen(box[1], box[2], box[3], box[4]);

            ctx.lineWidth = isActive ? 2.5 : 1.5;
            ctx.strokeStyle = isActive ? '#fff' : classColorAlpha(clsId, 0.8);

            ctx.fillStyle = classColorAlpha(clsId, isActive ? 0.25 : 0.1);
            ctx.fillRect(s.x, s.y, s.w, s.h);
            ctx.strokeRect(s.x, s.y, s.w, s.h);

            // Active box: draw colored border inside white border
            if (isActive) {
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = color;
                ctx.strokeRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4);
            }

            const label = `#${i + 1} Cls ${clsId}`;
            ctx.font = 'bold 12px Inter, sans-serif';
            const tm = ctx.measureText(label);
            ctx.fillStyle = color;
            ctx.fillRect(s.x, s.y - 18, tm.width + 8, 18);

            ctx.fillStyle = '#fff';
            ctx.fillText(label, s.x + 4, s.y - 5);

            if (isActive) {
                drawFancyHandle(s.x, s.y, color);
                drawFancyHandle(s.x + s.w, s.y, color);
                drawFancyHandle(s.x, s.y + s.h, color);
                drawFancyHandle(s.x + s.w, s.y + s.h, color);
            }
        });
        
        if (isDrawing && drawStart.x !== 0) {
             // Drawing feedback handled in mousemove
        }
    }

    function drawFancyHandle(x, y, color) {
        const size = 8;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = color || '#10b981';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    // --- Interaction Helpers ---
    let _cachedRect = null;
    let _rafPending = false;
    function _updateCachedRect() { _cachedRect = canvas.getBoundingClientRect(); }
    _updateCachedRect();
    window.addEventListener('resize', _updateCachedRect);
    window.addEventListener('scroll', _updateCachedRect, true);

    function getMousePos(e) {
        if (!_cachedRect) _updateCachedRect();
        return { x: e.clientX - _cachedRect.left, y: e.clientY - _cachedRect.top };
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

        // Resize handle always takes priority (even in point mode)
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

        // Point Mode: create box on empty area click
        if (pointModeEnabled) {
            const n = toNorm(x, y);
            if (n.x < 0 || n.x > 1 || n.y < 0 || n.y > 1) return;
            pushHistory();
            const csvClass = getCSVClassForCurrentImage();
            const cls = csvClass !== null ? csvClass : (parseInt(classInput.value, 10) || 0);
            boxes.push([cls, n.x, n.y, pointBoxW, pointBoxH]);
            activeBoxIdx = boxes.length - 1;
            saveCurrent();
            updateBoxList();
            redraw();
            return;
        }

        // Draw (drag mode)
        pushHistory();
        activeBoxIdx = -1;
        isDrawing = true;
        drawStart = { x, y };
        redraw();
    });

    canvas.addEventListener('mousemove', (e) => {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => { _rafPending = false; _handleMouseMove(e); });
    });

    function _handleMouseMove(e) {
        const { x, y } = getMousePos(e);

        // Point Mode: draw crosshair + preview (only when not dragging/resizing)
        if (pointModeEnabled && !isDragging && !isResizing) {
            redraw();
            const n = toNorm(x, y);
            if (n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1) {
                const s = toScreen(n.x, n.y, pointBoxW, pointBoxH);
                ctx.save();
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(s.x, s.y, s.w, s.h);
                ctx.setLineDash([]);
                ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x - 15, y); ctx.lineTo(x + 15, y);
                ctx.moveTo(x, y - 15); ctx.lineTo(x, y + 15);
                ctx.stroke();
                ctx.restore();
            }
            return;
        }
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
    }

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

    // Wheel: adjust point mode box size
    canvas.addEventListener('wheel', (e) => {
        if (!pointModeEnabled) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.01 : 0.01;
        if (e.shiftKey) {
            pointBoxH = Math.max(0.03, Math.min(0.8, pointBoxH + delta));
            if (pointHSlider) pointHSlider.value = pointBoxH;
            if (pointHVal) pointHVal.textContent = pointBoxH.toFixed(2);
        } else {
            pointBoxW = Math.max(0.03, Math.min(0.5, pointBoxW + delta));
            if (pointWSlider) pointWSlider.value = pointBoxW;
            if (pointWVal) pointWVal.textContent = pointBoxW.toFixed(2);
        }
    }, { passive: false });

    function updateBoxList() {
        if (!boxList) return;
        boxList.innerHTML = '';

        // Update badge count
        const boxCount = document.getElementById('box-count');
        if (boxCount) boxCount.textContent = boxes.length;

        boxes.forEach((box, i) => {
            const li = document.createElement('li');
            li.style.cssText = 'padding:3px 6px;border:1px solid var(--border);margin-bottom:3px;border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:5px;font-size:0.75rem;';

            if (i === activeBoxIdx) {
                li.style.background = 'var(--accent)';
                li.style.color = 'white';
            }

            // Label
            const label = document.createElement('span');
            label.textContent = `#${i + 1}`;
            label.style.cssText = 'font-weight:600;font-size:0.7rem;min-width:24px;';
            label.onclick = () => { activeBoxIdx = i; updateBoxList(); redraw(); };

            // Class input
            const clsInput = document.createElement('input');
            clsInput.type = 'number';
            clsInput.value = box[0];
            clsInput.min = 0;
            clsInput.style.cssText = 'width:42px;padding:2px 3px;background:var(--bg-primary);border:1px solid var(--border);color:white;border-radius:3px;font-size:0.7rem;text-align:center;';
            clsInput.onclick = (e) => e.stopPropagation();
            clsInput.onchange = (e) => {
                e.stopPropagation();
                const newCls = parseInt(clsInput.value, 10);
                if (!isNaN(newCls) && newCls >= 0) {
                    pushHistory();
                    boxes[i][0] = newCls;
                    saveCurrent();
                    redraw();
                }
            };

            // Spacer
            const spacer = document.createElement('span');
            spacer.style.flex = '1';

            // Delete button
            const delBtn = document.createElement('span');
            delBtn.textContent = '×';
            delBtn.style.cssText = 'font-weight:bold;cursor:pointer;font-size:0.9rem;opacity:0.6;';
            delBtn.onmouseenter = () => { delBtn.style.opacity = '1'; delBtn.style.color = '#ef4444'; };
            delBtn.onmouseleave = () => { delBtn.style.opacity = '0.6'; delBtn.style.color = ''; };
            delBtn.onclick = (e) => {
                e.stopPropagation();
                pushHistory();
                boxes.splice(i, 1);
                activeBoxIdx = -1;
                saveCurrent();
                updateBoxList();
                redraw();
            };

            li.appendChild(label);
            li.appendChild(clsInput);
            li.appendChild(spacer);
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
        
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            e.preventDefault();
            undo();
            return;
        }

        if (e.key === ' ') {
            e.preventDefault();
            if (isBatchDetecting) return;
            toggleAuto();
        } else if (e.key === 'd' || e.key === 'ArrowRight') {
            if (isBatchDetecting) return;
            stopAuto();
            saveCurrent().then(() => loadIndex(currentIndex + 1));
        } else if (e.key === 'a' || e.key === 'ArrowLeft') {
            if (isBatchDetecting) return;
            stopAuto();
            saveCurrent().then(() => loadIndex(currentIndex - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (isBatchDetecting) return;
            goToFirst();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (isBatchDetecting) return;
            goToLast();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (activeBoxIdx !== -1) {
                pushHistory();
                boxes.splice(activeBoxIdx, 1);
                activeBoxIdx = -1;
                saveCurrent();
                updateBoxList();
                redraw();
            }
        } else if (e.key === 'p' || e.key === 'P') {
            if (pointModeToggle) {
                pointModeToggle.checked = !pointModeToggle.checked;
                pointModeToggle.onchange();
            }
        } else if (e.key >= '0' && e.key <= '9') {
            if (activeBoxIdx !== -1) {
                // Multi-digit class edit for selected box
                classKeyBuffer += e.key;
                showClassEditToast(`Class → ${classKeyBuffer}_`);
                clearTimeout(classKeyTimer);
                classKeyTimer = setTimeout(applyClassKeyBuffer, 800);
            } else {
                if (classInput) classInput.value = e.key;
            }
        } else if (e.key === 'Enter' && classKeyBuffer !== '') {
            // Confirm class immediately
            clearTimeout(classKeyTimer);
            applyClassKeyBuffer();
        }
    });

    // --- Auto Play ---
    const autoBtn = document.getElementById('auto-btn');
    const autoSpeedSlider = document.getElementById('auto-speed');
    const autoSpeedLabel = document.getElementById('auto-speed-label');
    const autoBtnSvg = autoBtn ? autoBtn.querySelector('svg')?.outerHTML || '' : '';
    let autoInterval = null;
    let autoActive = false;

    function getAutoSpeed() {
        return autoSpeedSlider ? parseInt(autoSpeedSlider.value, 10) : 500;
    }

    function startAutoInterval() {
        if (autoInterval) clearInterval(autoInterval);
        autoInterval = setInterval(() => {
            if (currentIndex + 1 >= total) { stopAuto(); return; }
            saveCurrent().then(() => loadIndex(currentIndex + 1));
        }, getAutoSpeed());
    }

    function toggleAuto() {
        autoActive = !autoActive;
        if (autoActive) {
            if (autoBtn) { autoBtn.classList.add('active'); autoBtn.innerHTML = autoBtnSvg + ' Stop'; }
            startAutoInterval();
        } else {
            stopAuto();
        }
    }

    function stopAuto() {
        autoActive = false;
        if (autoBtn) { autoBtn.classList.remove('active'); autoBtn.innerHTML = autoBtnSvg + ' Auto'; }
        if (autoInterval) { clearInterval(autoInterval); autoInterval = null; }
    }

    if (autoBtn) autoBtn.addEventListener('click', toggleAuto);
    if (autoSpeedSlider) {
        autoSpeedSlider.addEventListener('input', () => {
            const v = parseInt(autoSpeedSlider.value, 10);
            if (autoSpeedLabel) autoSpeedLabel.textContent = v + 'ms';
            if (autoActive) startAutoInterval();
        });
    }

    // --- Start ---
    if (firstBtn) firstBtn.onclick = goToFirst;
    if (prevBtn) prevBtn.onclick = () => { stopAuto(); saveCurrent().then(() => loadIndex(currentIndex - 1)); };
    if (nextBtn) nextBtn.onclick = () => { stopAuto(); saveCurrent().then(() => loadIndex(currentIndex + 1)); };
    if (lastBtn) lastBtn.onclick = goToLast;
    if (saveBtn) saveBtn.onclick = () => saveCurrent();

    init();
})();
