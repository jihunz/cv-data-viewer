(() => {
  const COCO_CLASSES = [
    'person', 'fall_person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep',
    'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase',
    'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard',
    'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana',
    'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
    'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
    'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
    'hair drier', 'toothbrush'
  ];

  const data = window.viewerData;
  const mode = (data.mode || 'folder');
  const isCompareMode = mode === 'compare';
  const isSideBySide = isCompareMode && !!data.pred_label_dir_b;
  const BATCH_SIZE = isSideBySide ? 1 : 4;

  const images = Array.isArray(data.images)
    ? data.images.map((item) => (typeof item === 'string' ? { rel_path: item } : item))
    : [];
  
  const total = images.length;
  let currentIndex = 0;

  const excludedSet = new Map();
  const selectedSet = new Set();
  let autoInterval = null;
  let autoActive = false;
  let searchHighlightPath = null;
  let showGT = true;
  let showPredA = true;
  let showPredB = true;

  // Search State
  let lastQuery = "";
  let searchResults = [];
  let currentSearchIdx = -1;

  // DOM Elements
  const gridContainer = document.getElementById('grid-container');
  // Replace counterEl with input reference
  const counterInput = document.getElementById('counter-input');
  const pathsEl = document.getElementById('paths');
  const firstBtn = document.getElementById('first-btn');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const lastBtn = document.getElementById('last-btn');
  const autoBtn = document.getElementById('auto-btn');
  const autoSpeedSlider = document.getElementById('auto-speed');
  const autoSpeedLabel = document.getElementById('auto-speed-label');
  const excludeBtn = document.getElementById('exclude-btn');
  const exportBtn = document.getElementById('export-btn');
  const selectedCountEl = document.getElementById('selected-count');
  const classFilter = document.getElementById('class-filter');
  const searchInput = document.getElementById('search-input');
  const toast = document.getElementById('toast');
  const compareControls = document.getElementById('compare-controls');
  const excludeGroup = document.getElementById('exclude-group');
  const toggleGtBtn = document.getElementById('toggle-gt');
  const togglePredABtn = document.getElementById('toggle-pred-a');
  const togglePredBBtn = document.getElementById('toggle-pred-b');
  const labelAText = document.getElementById('label-a-text');
  const labelBText = document.getElementById('label-b-text');
  const compareClassFilter = document.getElementById('compare-class-filter');
  const copyBtn = document.getElementById('copy-btn');
  const markBtn = document.getElementById('mark-btn');
  const marksToggleBtn = document.getElementById('marks-toggle-btn');
  const marksPanel = document.getElementById('marks-panel');
  const marksList = document.getElementById('marks-list');
  const marksCount = document.getElementById('marks-count');
  const marksBadge = document.getElementById('marks-badge');
  const marksCloseBtn = document.getElementById('marks-close');

  const markedSet = new Set();
  let marksOnlyMode = false;
  let marksOnlyList = [];

  let toastTimeout = null;

  // -- Initialization --
  try {
    if (!images.length) {
      showToast('No images loaded. Please check dataset path.', 'error');
      console.error('Images array is empty:', data);
    }

  const metaParts = [];
  if (mode === 'compare') {
    if (data.compare_class) metaParts.push(`Class: ${data.compare_class}`);
    if (data.label_a) metaParts.push(`모델1: ${data.label_a}`);
    if (data.label_b) metaParts.push(`모델2: ${data.label_b}`);
  } else if (mode === 'txt' && data.train_file) {
    metaParts.push(`Train: ${data.train_file}`);
  } else if (data.img_dir) {
    metaParts.push(`Images: ${data.img_dir}`);
  }
  if (!isCompareMode) {
    if (data.label_dir) {
      metaParts.push(`Labels: ${data.label_dir}`);
    } else if (mode === 'txt') {
      metaParts.push(`Labels: Auto (/images/ → /labels/)`);
    }
  }
    
    if (pathsEl) {
        pathsEl.textContent = metaParts.join(' | ') || 'No paths info';
    }

    if (classFilter) {
      COCO_CLASSES.forEach((name, idx) => {
        const option = document.createElement('option');
        option.value = String(idx);
        option.textContent = `${idx}: ${name}`;
        classFilter.appendChild(option);
      });
      classFilter.addEventListener('change', () => {
        renderGrid();
      });
    }

    if (isCompareMode) {
      if (compareControls) compareControls.classList.remove('hidden');
      if (excludeGroup) excludeGroup.classList.add('hidden');
      if (classFilter) classFilter.parentElement.querySelector('#class-filter')?.parentElement?.classList.add('hidden');

      if (isSideBySide && gridContainer) {
        gridContainer.classList.add('compare-side-by-side');
      }

      if (labelAText && data.label_a) labelAText.textContent = `모델1: ${data.label_a}`;
      if (labelBText && data.label_b) {
        labelBText.textContent = `모델2: ${data.label_b}`;
        if (togglePredBBtn) togglePredBBtn.classList.remove('hidden');
      }

      if (compareClassFilter) {
        COCO_CLASSES.forEach((name, idx) => {
          const option = document.createElement('option');
          option.value = String(idx);
          option.textContent = `${idx}: ${name}`;
          compareClassFilter.appendChild(option);
        });
        compareClassFilter.addEventListener('change', () => renderGrid());
      }
      if (toggleGtBtn) {
        toggleGtBtn.addEventListener('click', () => {
          showGT = !showGT;
          toggleGtBtn.classList.toggle('active', showGT);
          renderGrid();
        });
      }
      if (togglePredABtn) {
        togglePredABtn.addEventListener('click', () => {
          showPredA = !showPredA;
          togglePredABtn.classList.toggle('active', showPredA);
          renderGrid();
        });
      }
      if (togglePredBBtn) {
        togglePredBBtn.addEventListener('click', () => {
          showPredB = !showPredB;
          togglePredBBtn.classList.toggle('active', showPredB);
          renderGrid();
        });
      }
      function copyCompareToClipboard() {
        try {
          const panels = Array.from(gridContainer.querySelectorAll('.compare-panel'));
          if (!panels.length) { showToast('Nothing to copy', 'error'); return; }

          const firstImg = panels[0].querySelector('img');
          if (!firstImg || !firstImg.naturalWidth) return;
          const natW = firstImg.naturalWidth;
          const natH = firstImg.naturalHeight;

          const barH = Math.round(natH * 0.06);
          const botH = Math.round(natH * 0.045);
          const fontSize = Math.round(natH * 0.04);
          const botFontSize = Math.round(natH * 0.03);
          const panelCount = panels.length;
          const totalW = natW * panelCount;
          const totalH = natH + barH + botH;

          const out = document.createElement('canvas');
          out.width = totalW;
          out.height = totalH;
          const ctx = out.getContext('2d');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, totalW, totalH);

          for (let i = 0; i < panelCount; i++) {
            const panel = panels[i];
            const img = panel.querySelector('img');
            const side = panel._side || (i === 0 ? 'a' : 'b');
            const x = i * natW;

            const topBg = side === 'a' ? '#1e40af' : '#9a3412';
            const topColor = side === 'a' ? '#bfdbfe' : '#fed7aa';
            const label = side === 'a' ? (data.label_a || '모델1') : (data.label_b || '모델2');

            ctx.fillStyle = topBg;
            ctx.fillRect(x, 0, natW, barH);
            ctx.font = `bold ${fontSize}px Inter, sans-serif`;
            ctx.fillStyle = topColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x + natW / 2, barH / 2);

            ctx.drawImage(img, x, barH, natW, natH);

            const gtLabels = panel._gtLabels || [];
            const predLabels = panel._predLabels || [];
            const predStyle = PRED_STYLES[side] || PRED_STYLES.a;

            const copyFilterSet = getCompareSelectedClasses();

            function drawNativeBox(item, style) {
              if (copyFilterSet && !copyFilterSet.has(item.class)) return;
              const [xc, yc, w, h] = item.bbox;
              const bw = w * natW, bh = h * natH;
              const bx = x + (xc * natW) - bw / 2;
              const by = barH + (yc * natH) - bh / 2;

              ctx.lineWidth = Math.max(2, Math.round(natH * 0.004));
              ctx.strokeStyle = style.stroke;
              ctx.fillStyle = style.fill;
              if (style.dashed) ctx.setLineDash([8, 4]); else ctx.setLineDash([]);
              ctx.strokeRect(bx, by, bw, bh);
              ctx.fillRect(bx, by, bw, bh);
              ctx.setLineDash([]);

              const name = COCO_CLASSES[item.class] ?? `cls ${item.class}`;
              let lt = `${style.prefix} ${name}`;
              if (item.confidence !== undefined) lt += ` ${item.confidence.toFixed(2)}`;
              const lfs = Math.round(natH * 0.022);
              ctx.font = `${lfs}px Inter, sans-serif`;
              const pad = Math.round(natH * 0.006);
              const tw = ctx.measureText(lt).width + pad * 2;
              const th = lfs + pad;
              const ly = style.labelBelow ? Math.min(by + bh, barH + natH - th) : Math.max(barH, by - th);
              ctx.fillStyle = style.labelBg;
              ctx.fillRect(bx, ly, tw, th);
              ctx.fillStyle = '#fff';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(lt, bx + pad, ly + pad / 2);
            }

            if (showGT) gtLabels.forEach(item => drawNativeBox(item, GT_STYLE));
            if (side === 'a' ? showPredA : showPredB) predLabels.forEach(item => drawNativeBox(item, predStyle));

            const entry = images[currentIndex];
            const fileName = entry ? `#${currentIndex + 1}  ${entry.rel_path}` : '';
            ctx.fillStyle = '#1a1a2e';
            ctx.fillRect(x, barH + natH, natW, botH);
            ctx.font = `600 ${botFontSize}px Inter, sans-serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(fileName, x + 10, barH + natH + botH / 2);
          }

          ctx.textAlign = 'start';
          out.toBlob(blob => {
            if (!blob) { showToast('Copy failed', 'error'); return; }
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            showToast('Copied to clipboard');
          }, 'image/png');
        } catch (e) {
          showToast('Copy failed: ' + e.message, 'error');
        }
      }

      if (copyBtn) copyBtn.addEventListener('click', copyCompareToClipboard);
    }
  } catch (err) {
      console.error("Initialization Error:", err);
      showToast("Viewer init failed: " + err.message, 'error');
  }

  // -- Core Functions --

  function showToast(message, type = 'info') {
    if (!toast) return;
    
    // If message is an object with actions, render them
    if (typeof message === 'object' && message.text) {
        const content = document.createElement('div');
        content.className = 'toast-content';
        content.textContent = message.text;
        
        const actions = document.createElement('div');
        actions.className = 'toast-actions';
        
        if (message.onPrev) {
            const prevBtn = document.createElement('button');
            prevBtn.className = 'toast-btn';
            prevBtn.textContent = '← Prev';
            prevBtn.onclick = () => { 
                message.onPrev(); 
                // Don't close toast immediately to allow rapid navigation
                resetToastTimeout();
            };
            actions.appendChild(prevBtn);
        }
        
        if (message.onNext) {
            const nextBtn = document.createElement('button');
            nextBtn.className = 'toast-btn';
            nextBtn.textContent = 'Next →';
            nextBtn.onclick = () => { 
                message.onNext(); 
                resetToastTimeout();
            };
            actions.appendChild(nextBtn);
        }
        
        toast.innerHTML = '';
        toast.appendChild(content);
        toast.appendChild(actions);
    } else {
        // Simple text message
        toast.textContent = message;
    }

    toast.classList.remove('hidden');
    toast.style.background = type === 'error' ? 'rgba(220, 38, 38, 0.95)' : 'rgba(15, 118, 110, 0.95)';
    
    resetToastTimeout();
  }

  function resetToastTimeout() {
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 4000);
  }

  function updateCounter() {
    const end = Math.min(currentIndex + BATCH_SIZE, total);
    if (counterInput) {
        if (isSideBySide) {
            counterInput.value = `${currentIndex + 1} / ${total}`;
        } else {
            counterInput.value = `${currentIndex + 1} - ${end} / ${total}`;
        }
    }
    if (selectedCountEl) {
        selectedCountEl.textContent = excludedSet.size;
    }
    updateMarkUI();
  }

  function jumpToIndex(val) {
      let targetIdx = parseInt(val, 10);
      if (isNaN(targetIdx)) return;
      
      // Convert 1-based index to 0-based
      targetIdx = targetIdx - 1;
      
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= total) targetIdx = total - 1;
      
      // Calculate batch start
      const batchStart = Math.floor(targetIdx / BATCH_SIZE) * BATCH_SIZE;
      
      stopAuto();
      currentIndex = batchStart;
      selectedSet.clear();
      renderGrid();
  }

  function getSelectedClasses() {
    if (!classFilter) return null;
    const val = classFilter.value;
    return val ? new Set([Number(val)]) : null;
  }

  async function fetchLabels(relPath) {
    const url = new URL('/api/labels', window.location.origin);
    url.searchParams.set('mode', mode);
    url.searchParams.set('rel_path', relPath);
    if (data.label_dir) url.searchParams.set('label_dir', data.label_dir);
    if (mode === 'folder' && data.img_dir) url.searchParams.set('img_dir', data.img_dir);
    else if (mode === 'txt' && data.train_file) url.searchParams.set('train_file', data.train_file);

    const res = await fetch(url);
    if (!res.ok) throw new Error('No labels');
    return res.json();
  }

  function colorForClass(cls) {
    const hue = (cls * 47) % 360;
    return {
      stroke: `hsl(${hue}, 72%, 55%)`,
      fill: `hsla(${hue}, 72%, 55%, 0.15)`,
      labelBg: `hsla(${hue}, 72%, 35%, 0.85)`
    };
  }

  function drawBoxes(canvas, labels, img) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Calculate the actual rendered image dimensions and offsets within the img element
    // Since object-fit: contain is used.
    const naturalRatio = img.naturalWidth / img.naturalHeight;
    const elementRatio = width / height;
    
    let renderWidth, renderHeight, offsetX, offsetY;

    if (naturalRatio > elementRatio) {
        // Image is wider than the container (constrained by width)
        renderWidth = width;
        renderHeight = width / naturalRatio;
        offsetX = 0;
        offsetY = (height - renderHeight) / 2;
    } else {
        // Image is taller than container (constrained by height)
        renderWidth = height * naturalRatio;
        renderHeight = height;
        offsetX = (width - renderWidth) / 2;
        offsetY = 0;
    }

    const filterSet = getSelectedClasses();

    labels.forEach((item) => {
      if (filterSet && !filterSet.has(item.class)) return;

      const [xc, yc, w, h] = item.bbox;
      
      // Transform normalized coordinates (0~1) to Rendered Image Coordinates
      // And then add the letterboxing offsets
      const boxW = w * renderWidth;
      const boxH = h * renderHeight;
      const boxX = (xc * renderWidth) - (boxW / 2) + offsetX;
      const boxY = (yc * renderHeight) - (boxH / 2) + offsetY;

      const colors = colorForClass(item.class);

      // Box
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.stroke;
      ctx.fillStyle = colors.fill;
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillRect(boxX, boxY, boxW, boxH);

      // Label Tag
      const name = COCO_CLASSES[item.class] ?? `cls ${item.class}`;
      const labelText = `${item.class}: ${name}`;
      
      ctx.font = '12px Inter, sans-serif';
      const padding = 4;
      const metrics = ctx.measureText(labelText);
      const bgWidth = metrics.width + padding * 2;
      const bgHeight = 16;
      
      const labelX = Math.max(offsetX, boxX); // Clamp to image area roughly
      const labelY = Math.max(offsetY, boxY - bgHeight);

      ctx.fillStyle = colors.labelBg;
      ctx.fillRect(labelX, labelY, bgWidth, bgHeight);
      
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'top';
      ctx.fillText(labelText, labelX + padding, labelY + 2);
    });
  }

  async function fetchCompareLabels(relPath) {
    const url = new URL('/api/compare-labels', window.location.origin);
    url.searchParams.set('rel_path', relPath);
    url.searchParams.set('gt_label_dir', data.gt_label_dir);
    url.searchParams.set('pred_label_dir_a', data.pred_label_dir_a);
    if (data.pred_label_dir_b) url.searchParams.set('pred_label_dir_b', data.pred_label_dir_b);
    const res = await fetch(url);
    if (!res.ok) throw new Error('No compare labels');
    return res.json();
  }

  function getCompareSelectedClasses() {
    if (!compareClassFilter) return null;
    const val = compareClassFilter.value;
    return val ? new Set([Number(val)]) : null;
  }

  const PRED_STYLES = {
    a: { stroke: '#3b82f6', fill: 'rgba(59, 130, 246, 0.12)', labelBg: 'rgba(30, 64, 175, 0.85)', prefix: 'M1', dashed: true, labelBelow: true },
    b: { stroke: '#f97316', fill: 'rgba(249, 115, 22, 0.12)', labelBg: 'rgba(154, 52, 18, 0.85)', prefix: 'M2', dashed: true, labelBelow: true },
  };
  const GT_STYLE = { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.12)', labelBg: 'rgba(6, 95, 70, 0.85)', prefix: 'GT', dashed: false, labelBelow: false };

  function drawCompareBoxes(canvas, gtLabels, predLabels, img, side) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const naturalRatio = img.naturalWidth / img.naturalHeight;
    const elementRatio = width / height;
    let renderWidth, renderHeight, offsetX, offsetY;

    if (naturalRatio > elementRatio) {
      renderWidth = width;
      renderHeight = width / naturalRatio;
      offsetX = 0;
      offsetY = (height - renderHeight) / 2;
    } else {
      renderWidth = height * naturalRatio;
      renderHeight = height;
      offsetX = (width - renderWidth) / 2;
      offsetY = 0;
    }

    const filterSet = getCompareSelectedClasses();

    function drawBox(item, style) {
      if (filterSet && !filterSet.has(item.class)) return;
      const [xc, yc, w, h] = item.bbox;
      const boxW = w * renderWidth;
      const boxH = h * renderHeight;
      const boxX = (xc * renderWidth) - (boxW / 2) + offsetX;
      const boxY = (yc * renderHeight) - (boxH / 2) + offsetY;

      ctx.lineWidth = 2;
      ctx.strokeStyle = style.stroke;
      ctx.fillStyle = style.fill;
      if (style.dashed) { ctx.setLineDash([6, 3]); } else { ctx.setLineDash([]); }
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.setLineDash([]);

      const name = COCO_CLASSES[item.class] ?? `cls ${item.class}`;
      let labelText = `${style.prefix} ${name}`;
      if (item.confidence !== undefined) labelText += ` ${item.confidence.toFixed(2)}`;

      ctx.font = '11px Inter, sans-serif';
      const padding = 3;
      const metrics = ctx.measureText(labelText);
      const bgWidth = metrics.width + padding * 2;
      const bgHeight = 15;
      const labelX = Math.max(offsetX, boxX);
      const labelY = style.labelBelow ? Math.min(boxY + boxH, height - bgHeight) : Math.max(offsetY, boxY - bgHeight);
      ctx.fillStyle = style.labelBg;
      ctx.fillRect(labelX, labelY, bgWidth, bgHeight);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'top';
      ctx.fillText(labelText, labelX + padding, labelY + 2);
    }

    if (showGT) {
      gtLabels.forEach(item => drawBox(item, GT_STYLE));
    }

    const showPred = side === 'a' ? showPredA : showPredB;
    const predStyle = PRED_STYLES[side] || PRED_STYLES.a;
    if (showPred && predLabels) {
      predLabels.forEach(item => drawBox(item, predStyle));
    }
  }

  function createGridItem(entry, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-item';
    
    // Apply excluded state
    if (excludedSet.has(entry.rel_path)) {
      wrapper.classList.add('excluded');
    }

    // Apply Search Highlight state
    if (searchHighlightPath && entry.rel_path === searchHighlightPath) {
        wrapper.classList.add('highlighted');
    }

    // Image
    const img = document.createElement('img');
    img.className = 'grid-image';
    img.loading = 'lazy';

    const imgUrl = new URL('/image', window.location.origin);
    imgUrl.searchParams.set('mode', mode);
    imgUrl.searchParams.set('rel_path', entry.rel_path);
    if ((mode === 'folder' || mode === 'compare') && data.img_dir) {
      imgUrl.searchParams.set('img_dir', data.img_dir);
    } else if (mode === 'txt' && data.train_file) {
      imgUrl.searchParams.set('train_file', data.train_file);
      if (data.label_dir) imgUrl.searchParams.set('label_dir', data.label_dir);
    }
    img.src = imgUrl.toString();

    // Canvas Overlay
    const canvas = document.createElement('canvas');
    canvas.className = 'grid-overlay';

    // Metadata Overlay
    const meta = document.createElement('div');
    meta.className = 'grid-meta';
    meta.textContent = `#${index + 1} ${entry.rel_path}`;

    wrapper.appendChild(img);
    wrapper.appendChild(canvas);
    wrapper.appendChild(meta);

    img.decoding = 'async';
    img.onload = () => {
      canvas.width = img.clientWidth;
      canvas.height = img.clientHeight;

      if (!isCompareMode) {
        fetchLabels(entry.rel_path)
          .then(data => {
            wrapper.dataset.labelPath = data.label;
            drawBoxes(canvas, data.labels, img);
          })
          .catch(() => {});
      }
    };

    // Interaction: 클릭 시 즉시 exclude 토글
    wrapper.addEventListener('click', () => {
      toggleExclude(entry.rel_path);
    });

    return wrapper;
  }

  function createComparePanel(entry, index, side, labelsCachePromise) {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-item compare-panel';

    const topBar = document.createElement('div');
    topBar.className = `compare-top-bar side-${side}`;
    topBar.textContent = side === 'a' ? (data.label_a || '모델1') : (data.label_b || '모델2');

    const imgWrap = document.createElement('div');
    imgWrap.className = 'compare-img-wrap';

    const img = document.createElement('img');
    img.className = 'grid-image';
    img.loading = 'lazy';
    const imgUrl = new URL('/image', window.location.origin);
    imgUrl.searchParams.set('mode', mode);
    imgUrl.searchParams.set('rel_path', entry.rel_path);
    if (data.img_dir) imgUrl.searchParams.set('img_dir', data.img_dir);
    img.src = imgUrl.toString();

    const canvas = document.createElement('canvas');
    canvas.className = 'grid-overlay';

    imgWrap.appendChild(img);
    imgWrap.appendChild(canvas);

    const bottomBar = document.createElement('div');
    bottomBar.className = 'compare-bottom-bar';
    bottomBar.textContent = `#${index + 1}  ${entry.rel_path}`;

    wrapper.appendChild(topBar);
    wrapper.appendChild(imgWrap);
    wrapper.appendChild(bottomBar);

    wrapper._side = side;
    wrapper._gtLabels = [];
    wrapper._predLabels = [];

    img.decoding = 'async';
    img.onload = () => {
      canvas.width = img.clientWidth;
      canvas.height = img.clientHeight;
      labelsCachePromise.then(result => {
        wrapper._gtLabels = result.gt_labels;
        wrapper._predLabels = side === 'a' ? result.pred_a_labels : (result.pred_b_labels || []);
        drawCompareBoxes(canvas, wrapper._gtLabels, wrapper._predLabels, img, side);
      }).catch(() => {});
    };

    return wrapper;
  }

  function renderGrid() {
    if (!gridContainer) return;
    gridContainer.innerHTML = '';
    updateCounter();

    if (isSideBySide) {
      const entry = images[currentIndex];
      if (!entry && total > 0) { currentIndex = 0; return renderGrid(); }
      if (!entry) return;
      const labelsPromise = fetchCompareLabels(entry.rel_path);
      gridContainer.appendChild(createComparePanel(entry, currentIndex, 'a', labelsPromise));
      gridContainer.appendChild(createComparePanel(entry, currentIndex, 'b', labelsPromise));
      setTimeout(prefetchNextBatch, 50);
      return;
    }

    if (isCompareMode && !isSideBySide) {
      const batch = images.slice(currentIndex, currentIndex + BATCH_SIZE);
      batch.forEach((entry, i) => {
        const globalIndex = currentIndex + i;
        const labelsPromise = fetchCompareLabels(entry.rel_path);
        gridContainer.appendChild(createComparePanel(entry, globalIndex, 'a', labelsPromise));
      });
      setTimeout(prefetchNextBatch, 50);
      return;
    }

    const batch = images.slice(currentIndex, currentIndex + BATCH_SIZE);
    if (batch.length === 0 && total > 0) {
        currentIndex = 0;
        const retryBatch = images.slice(0, BATCH_SIZE);
        retryBatch.forEach((entry, i) => {
            const el = createGridItem(entry, i);
            gridContainer.appendChild(el);
        });
        setTimeout(prefetchNextBatch, 100);
        return;
    }

    batch.forEach((entry, i) => {
      const globalIndex = currentIndex + i;
      const el = createGridItem(entry, globalIndex);
      gridContainer.appendChild(el);
    });
    
    setTimeout(prefetchNextBatch, 50);
  }

  // -- Optimization: Prefetching --
  function prefetchNextBatch() {
      const nextIdx = currentIndex + BATCH_SIZE;
      if (nextIdx >= total) return;
      
      const batch = images.slice(nextIdx, nextIdx + BATCH_SIZE);
      batch.forEach(entry => {
          const img = new Image();
          const url = new URL('/image', window.location.origin);
          url.searchParams.set('mode', mode);
          url.searchParams.set('rel_path', entry.rel_path);
          if ((mode === 'folder' || mode === 'compare') && data.img_dir) {
            url.searchParams.set('img_dir', data.img_dir);
          } else if (mode === 'txt' && data.train_file) {
            url.searchParams.set('train_file', data.train_file);
            if (data.label_dir) url.searchParams.set('label_dir', data.label_dir);
          }
          img.src = url.toString();
      });
  }

  // -- Actions --

  function nextBatch() {
    if (currentIndex + BATCH_SIZE >= total) return; // End reached
    currentIndex += BATCH_SIZE;
    renderGrid();
  }

  function prevBatch() {
    if (currentIndex - BATCH_SIZE < 0) currentIndex = 0;
    else currentIndex -= BATCH_SIZE;
    renderGrid();
  }

  function goToFirst() {
      stopAuto();
      currentIndex = 0;
      selectedSet.clear();
      renderGrid();
  }

  function goToLast() {
      stopAuto();
      // Calculate start index of the last batch
      // e.g. total=10, batch=4 -> indices: 0, 4, 8. Last start is 8.
      // floor( (total - 1) / batch ) * batch
      if (total === 0) return;
      currentIndex = Math.floor((total - 1) / BATCH_SIZE) * BATCH_SIZE;
      selectedSet.clear();
      renderGrid();
  }

  function navigateSearch(direction) {
      if (searchResults.length === 0) return;

      if (direction === 'next') {
          currentSearchIdx = (currentSearchIdx + 1) % searchResults.length;
      } else {
          currentSearchIdx = (currentSearchIdx - 1 + searchResults.length) % searchResults.length;
      }
      
      const result = searchResults[currentSearchIdx];
      const batchStartIndex = Math.floor(result.idx / BATCH_SIZE) * BATCH_SIZE;
      currentIndex = batchStartIndex;
      searchHighlightPath = result.path;
      
      stopAuto();
      selectedSet.clear();
      renderGrid();
      
      showSearchToast(currentSearchIdx, searchResults.length, result.path);
  }

  function showSearchToast(idx, total, path) {
      showToast({
          text: `Found ${idx + 1}/${total}: "${path}"`,
          onPrev: () => navigateSearch('prev'),
          onNext: () => navigateSearch('next')
      });
  }

  function performSearch() {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
          searchHighlightPath = null;
          searchResults = [];
          currentSearchIdx = -1;
          lastQuery = "";
          renderGrid();
          return;
      }

      // New search or changed query
      if (query !== lastQuery) {
          searchResults = images
            .map((img, idx) => ({ idx, path: img.rel_path }))
            .filter(item => item.path.toLowerCase().includes(query));
          
          lastQuery = query;
          currentSearchIdx = -1;
          
          if (searchResults.length === 0) {
              showToast(`No images found matching "${query}"`, 'error');
              return;
          }
      }

      // Initial move (next)
      navigateSearch('next');
  }

  function getAutoSpeed() {
    return autoSpeedSlider ? parseInt(autoSpeedSlider.value, 10) : 400;
  }

  function startAutoInterval() {
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(() => {
      if (currentIndex + BATCH_SIZE >= total) {
        stopAuto();
        return;
      }
      nextBatch();
    }, getAutoSpeed());
  }

  function toggleAuto() {
    autoActive = !autoActive;
    if (autoActive) {
      autoBtn.classList.add('active');
      autoBtn.textContent = 'Stop Auto';
      startAutoInterval();
    } else {
      stopAuto();
    }
  }

  function stopAuto() {
    autoActive = false;
    autoBtn.classList.remove('active');
    autoBtn.textContent = 'Auto Play';
    if (autoInterval) {
      clearInterval(autoInterval);
      autoInterval = null;
    }
  }

  function toggleExclude(relPath) {
    if (excludedSet.has(relPath)) {
      excludedSet.delete(relPath);
    } else {
      excludedSet.set(relPath, { image: relPath, reason: 'User Selection' });
    }
    updateCounter();
    renderGrid();
  }

  function toggleExcludeBySlot(slotIndex) {
    const globalIndex = currentIndex + slotIndex;
    if (globalIndex >= total) return;
    const entry = images[globalIndex];
    if (entry) toggleExclude(entry.rel_path);
  }

  function exportExcluded() {
    if (!excludedSet.size) {
      showToast('No images excluded yet', 'error');
      return;
    }
    const lines = Array.from(excludedSet.values()).map((item) => `${item.image}`);
    const content = lines.join('\n') + '\n';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'excluded_list.txt';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 100);
    showToast(`Exported ${excludedSet.size} excluded images`);
  }

  // -- Marking --
  function toggleMark() {
    const idx = currentIndex;
    if (markedSet.has(idx)) {
      markedSet.delete(idx);
      showToast(`Unmarked #${idx + 1}`);
    } else {
      markedSet.add(idx);
      showToast(`Marked #${idx + 1}`);
    }
    updateMarkUI();
  }

  function updateMarkUI() {
    const count = markedSet.size;
    if (marksBadge) marksBadge.textContent = count;
    if (marksCount) marksCount.textContent = count;
    if (markBtn) {
      markBtn.classList.toggle('marked', markedSet.has(currentIndex));
    }
  }

  function renderMarksList() {
    if (!marksList) return;
    marksList.innerHTML = '';
    if (markedSet.size === 0) {
      marksList.innerHTML = '<div style="padding:12px;color:var(--text-secondary);text-align:center;">No marked images</div>';
      return;
    }
    const sorted = Array.from(markedSet).sort((a, b) => a - b);
    sorted.forEach(idx => {
      const entry = images[idx];
      if (!entry) return;
      const item = document.createElement('div');
      item.className = 'marks-item';
      if (idx === currentIndex) item.classList.add('active');
      item.innerHTML = `<span class="marks-item-num">#${idx + 1}</span><span class="marks-item-name">${entry.rel_path}</span><button class="marks-item-remove" data-idx="${idx}">&times;</button>`;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('marks-item-remove')) {
          markedSet.delete(parseInt(e.target.dataset.idx));
          updateMarkUI();
          renderMarksList();
          return;
        }
        currentIndex = idx;
        selectedSet.clear();
        renderGrid();
        updateMarkUI();
        renderMarksList();
      });
      marksList.appendChild(item);
    });
  }

  function toggleMarksPanel() {
    if (!marksPanel) return;
    const isHidden = marksPanel.classList.toggle('hidden');
    if (!isHidden) renderMarksList();
  }

  // -- Event Listeners --
  if (markBtn) markBtn.addEventListener('click', toggleMark);
  if (marksToggleBtn) marksToggleBtn.addEventListener('click', toggleMarksPanel);
  if (marksCloseBtn) marksCloseBtn.addEventListener('click', () => marksPanel.classList.add('hidden'));
  if (firstBtn) firstBtn.addEventListener('click', goToFirst);
  if (lastBtn) lastBtn.addEventListener('click', goToLast);
  prevBtn.addEventListener('click', () => { stopAuto(); prevBatch(); });
  nextBtn.addEventListener('click', () => { stopAuto(); nextBatch(); });
  autoBtn.addEventListener('click', toggleAuto);
  if (autoSpeedSlider) {
    autoSpeedSlider.addEventListener('input', () => {
      const v = parseInt(autoSpeedSlider.value, 10);
      if (autoSpeedLabel) autoSpeedLabel.textContent = v + 'ms';
      if (autoActive) {
        clearInterval(autoInterval);
        autoInterval = setInterval(() => {
          if (currentIndex + BATCH_SIZE >= total) { stopAuto(); return; }
          nextBatch();
        }, v);
      }
    });
  }
  if (exportBtn) exportBtn.addEventListener('click', exportExcluded);
  
  // Search listener
  if (searchInput) {
      searchInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
              performSearch();
          }
    });
  }

  // Jump to Index listener
  if (counterInput) {
      counterInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
              jumpToIndex(counterInput.value);
              counterInput.blur(); // Remove focus
          }
      });
      counterInput.addEventListener('focus', () => {
          // Select all text on focus for easy replacement
          counterInput.select();
      });
  }

  // Keyboard Navigation
  document.addEventListener('keydown', (ev) => {
    if (document.activeElement === searchInput || document.activeElement === counterInput) return;

    if (ev.key === 'm' || ev.key === 'M') {
      toggleMark();
      return;
    }

    // 1,2,3,4: toggle exclude (좌상=1, 우상=2, 좌하=3, 우하=4)
    if (['1','2','3','4'].includes(ev.key)) {
      toggleExcludeBySlot(parseInt(ev.key) - 1);
      return;
    }

    if (isCompareMode && ev.key === 'c' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      if (typeof copyCompareToClipboard === 'function') copyCompareToClipboard();
      return;
    }

    if (ev.key === 'ArrowLeft') {
      stopAuto();
      prevBatch();
    } else if (ev.key === 'ArrowRight') {
      stopAuto();
      nextBatch();
    } else if (ev.key === 'ArrowUp') {
        stopAuto();
        goToFirst();
    } else if (ev.key === 'ArrowDown') {
        stopAuto();
        goToLast();
    }
  });

  // Initial Render
  renderGrid();
})();
