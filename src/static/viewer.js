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

  const BATCH_SIZE = 4;
  const data = window.viewerData;
  const mode = (data.mode || 'folder');
  // Normalized images array
  const images = Array.isArray(data.images)
    ? data.images.map((item) => (typeof item === 'string' ? { rel_path: item } : item))
    : [];
  
  const total = images.length;
  let currentIndex = 0; // Starts at 0, increments by BATCH_SIZE

  // State
  const excludedSet = new Map(); // Permenantly excluded: path -> reason/label
  const selectedSet = new Set(); // Currently selected in UI (to be excluded)
  let autoInterval = null;
  let autoActive = false;
  let searchHighlightPath = null; // Path of the image to highlight (Green)
  
  // Search State
  let lastQuery = "";
  let searchResults = [];
  let currentSearchIdx = -1;

  // DOM Elements
  const gridContainer = document.getElementById('grid-container');
  const counterEl = document.getElementById('counter');
  const pathsEl = document.getElementById('paths');
  const firstBtn = document.getElementById('first-btn');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const lastBtn = document.getElementById('last-btn');
  const autoBtn = document.getElementById('auto-btn');
  const excludeBtn = document.getElementById('exclude-btn');
  const exportBtn = document.getElementById('export-btn');
  const selectedCountEl = document.getElementById('selected-count');
  const classFilter = document.getElementById('class-filter');
  const searchInput = document.getElementById('search-input');
  const toast = document.getElementById('toast');

  let toastTimeout = null;

  // -- Initialization --
  try {
    if (!images.length) {
      showToast('No images loaded. Please check dataset path.', 'error');
      console.error('Images array is empty:', data);
    }

    const metaParts = [];
    if (mode === 'txt' && data.train_file) {
      metaParts.push(`Train: ${data.train_file}`);
    } else if (data.img_dir) {
      metaParts.push(`Images: ${data.img_dir}`);
    }
    if (data.label_dir) {
      metaParts.push(`Labels: ${data.label_dir}`);
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
        renderGrid(); // Re-render to update boxes based on filter
      });
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
    counterEl.textContent = `${currentIndex + 1} - ${end} / ${total}`;
    selectedCountEl.textContent = selectedSet.size;
    
    excludeBtn.style.opacity = selectedSet.size > 0 ? '1' : '0.5';
    excludeBtn.style.cursor = selectedSet.size > 0 ? 'pointer' : 'not-allowed';
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

  function createGridItem(entry, index) {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-item';
    
    // Apply selection state
    if (selectedSet.has(entry.rel_path)) {
      wrapper.classList.add('selected');
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
    if (mode === 'folder' && data.img_dir) imgUrl.searchParams.set('img_dir', data.img_dir);
    else if (mode === 'txt' && data.train_file) {
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

    // Logic: Load labels after image loads to size canvas correctly
    img.decoding = 'async'; // Optimize decoding
    img.onload = () => {
      canvas.width = img.clientWidth;
      canvas.height = img.clientHeight;
      
      fetchLabels(entry.rel_path)
        .then(data => {
          // Attach raw labels to wrapper for exclusion export logic if needed
          wrapper.dataset.labelPath = data.label; 
          drawBoxes(canvas, data.labels, img); // Pass img element for ratio calculation
        })
        .catch(() => {
            // No labels or error, just ignore
        });
    };

    // Interaction
    wrapper.addEventListener('click', () => {
      if (selectedSet.has(entry.rel_path)) {
        selectedSet.delete(entry.rel_path);
        wrapper.classList.remove('selected');
      } else {
        selectedSet.add(entry.rel_path);
        wrapper.classList.add('selected');
      }
      updateCounter();
    });

    return wrapper;
  }

  function renderGrid() {
    if (!gridContainer) return;
    gridContainer.innerHTML = '';
    updateCounter();

    const batch = images.slice(currentIndex, currentIndex + BATCH_SIZE);
    if (batch.length === 0 && total > 0) {
        // Edge case correction
        currentIndex = 0;
        const retryBatch = images.slice(0, BATCH_SIZE);
        retryBatch.forEach((entry, i) => {
            const globalIndex = 0 + i;
            const el = createGridItem(entry, globalIndex);
            gridContainer.appendChild(el);
        });
        // Prefetch next after render
        setTimeout(prefetchNextBatch, 100);
        return;
    }

    batch.forEach((entry, i) => {
      const globalIndex = currentIndex + i;
      const el = createGridItem(entry, globalIndex);
      gridContainer.appendChild(el);
    });
    
    // Trigger prefetch for the NEXT batch immediately
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
          if (mode === 'folder' && data.img_dir) url.searchParams.set('img_dir', data.img_dir);
          else if (mode === 'txt' && data.train_file) {
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
    selectedSet.clear(); // Clear selection on move? Usually better UX to clear.
    // Don't clear search highlight if user just moves page, but maybe we should?
    // Let's keep highlight until new search or refresh.
    renderGrid();
  }

  function prevBatch() {
    if (currentIndex - BATCH_SIZE < 0) currentIndex = 0;
    else currentIndex -= BATCH_SIZE;
    selectedSet.clear();
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

  function toggleAuto() {
    autoActive = !autoActive;
    if (autoActive) {
      autoBtn.classList.add('active');
      autoBtn.textContent = 'Stop Auto';
      autoInterval = setInterval(() => {
        if (currentIndex + BATCH_SIZE >= total) {
          stopAuto();
          return;
        }
        nextBatch();
      }, 400); // Optimized: 0.4 seconds per batch
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

  function excludeSelected() {
    if (selectedSet.size === 0) return;
    
    let count = 0;
    selectedSet.forEach(relPath => {
      if (!excludedSet.has(relPath)) {
        excludedSet.set(relPath, { image: relPath, reason: 'User Selection' });
        count++;
      }
    });

    selectedSet.clear();
    showToast(`Excluded ${count} images`);
    updateCounter();
    
    // Visually update current grid
    const items = gridContainer.querySelectorAll('.grid-item');
    items.forEach(item => {
        item.classList.remove('selected');
    });
  }

  function exportExcluded() {
    if (!excludedSet.size) {
      showToast('No images excluded yet', 'error');
      return;
    }
    const lines = Array.from(excludedSet.values()).map((item) => `${item.image}`);
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'excluded_list.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Exported exclusion list');
  }

  // -- Event Listeners --
  if (firstBtn) firstBtn.addEventListener('click', goToFirst);
  if (lastBtn) lastBtn.addEventListener('click', goToLast);
  prevBtn.addEventListener('click', () => { stopAuto(); prevBatch(); });
  nextBtn.addEventListener('click', () => { stopAuto(); nextBatch(); });
  autoBtn.addEventListener('click', toggleAuto);
  excludeBtn.addEventListener('click', excludeSelected);
  exportBtn.addEventListener('click', exportExcluded);
  
  // Search listener
  if (searchInput) {
      searchInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
              performSearch();
          }
      });
  }

  // Keyboard Navigation
  document.addEventListener('keydown', (ev) => {
    // Ignore shortcuts if typing in search box
    if (document.activeElement === searchInput) return;

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
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      if (ev.key === 'Enter') {
          ev.preventDefault();
          excludeSelected();
      }
    }
  });

  // Initial Render
  renderGrid();
})();
