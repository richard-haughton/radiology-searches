// patterns.js — plain script, no modules. Depends on db.js, editor.js, app.js globals.

// ── State ────────────────────────────────────────────────────
var _pUid = null;
var allPatterns = [];
var filteredPatterns = [];
var selectedPatternId = null;
var currentStepIndex = 0;
var timerInterval = null;
var timerSeconds = 0;
var timerRunning = false;
var activeModality = 'All';
var pendingRecordPatternName = '';
var pendingRecordSeconds = 0;
var _unsubscribePatterns = null;
var _patternSidebarCollapsed = false;
var _preferredStepIndex = null;
var STEP_SECTION_ORDER = ['searchPattern', 'notes', 'dontMissPathology', 'measurements', 'images', 'hyperlinks'];
var STEP_SECTION_LABELS = {
  searchPattern: 'Search Pattern',
  notes: 'Notes',
  dontMissPathology: 'Dont Miss Pathology',
  measurements: 'Measurements',
  images: 'Images',
  hyperlinks: 'Hyperlinks'
};
var STEP_SECTIONS_STATE_KEY = 'patternStepSectionsState';
var _stepSectionsOpenState = {
  searchPattern: true,
  notes: false,
  dontMissPathology: false,
  measurements: false,
  images: false,
  hyperlinks: false
};

// ── Init ─────────────────────────────────────────────────────
function initPatterns(userId) {
  _pUid = userId;

  initPatternSidebarToggle();
  loadStepSectionsOpenState();

  // Subscribe to Firestore patterns
  _unsubscribePatterns = subscribePatterns(_pUid, patterns => {
    allPatterns = patterns;
    setAllPatternsRef(patterns);
    applyFilters();
  });

  // Filter events
  document.getElementById('pattern-filter').addEventListener('input', applyFilters);

  // Modality buttons
  document.querySelectorAll('.mod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeModality = btn.dataset.mod;
      applyFilters();
    });
  });

  // Pattern selection
  document.getElementById('pattern-select').addEventListener('change', e => {
    const id = e.target.value;
    loadPattern(id);
  });

  // Step navigation
  document.getElementById('btn-prev-step').addEventListener('click', () => navigateStep(-1));
  document.getElementById('btn-next-step').addEventListener('click', () => navigateStep(1));

  // Timer controls
  document.getElementById('btn-record-study').addEventListener('click', openRecordModal);
  document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);

  // Record modal
  document.getElementById('btn-record-confirm').addEventListener('click', confirmRecord);
  document.getElementById('btn-record-cancel').addEventListener('click', () => {
    document.getElementById('modal-record').style.display = 'none';
  });
  document.getElementById('modal-record').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-record')) {
      document.getElementById('modal-record').style.display = 'none';
    }
  });

  // Edit / Delete / New buttons
  document.getElementById('btn-new-pattern').addEventListener('click', () => openEditor(_pUid, null));
  document.getElementById('btn-edit-pattern').addEventListener('click', () => {
    if (selectedPatternId) {
      openEditor(_pUid, selectedPatternId, currentStepIndex);
    }
  });
  document.getElementById('btn-delete-pattern').addEventListener('click', handleDeletePattern);

  // HDF5 import
  document.getElementById('btn-import-h5').addEventListener('click', () => {
    document.getElementById('import-h5-input').click();
  });
  document.getElementById('import-h5-input').addEventListener('change', handleH5Import);

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);
}

function initPatternSidebarToggle() {
  const layout = document.querySelector('.patterns-layout');
  const btn = document.getElementById('btn-toggle-pattern-sidebar');
  if (!layout || !btn) return;

  const saved = localStorage.getItem('patternSidebarCollapsed');
  applyPatternSidebarState(saved === '1', false);

  btn.addEventListener('click', () => {
    applyPatternSidebarState(!_patternSidebarCollapsed, true);
  });
}

function applyPatternSidebarState(collapsed, persist) {
  const layout = document.querySelector('.patterns-layout');
  const btn = document.getElementById('btn-toggle-pattern-sidebar');
  if (!layout || !btn) return;

  _patternSidebarCollapsed = collapsed;
  layout.classList.toggle('sidebar-collapsed', collapsed);

  btn.textContent = collapsed ? '>' : '<';
  btn.title = collapsed ? 'Expand panel' : 'Minimize panel';
  btn.setAttribute('aria-label', collapsed ? 'Expand search pattern panel' : 'Minimize search pattern panel');
  btn.setAttribute('aria-expanded', String(!collapsed));

  if (persist) {
    localStorage.setItem('patternSidebarCollapsed', collapsed ? '1' : '0');
  }
}

// ── Filter & Render list ─────────────────────────────────────
function applyFilters() {
  const q = document.getElementById('pattern-filter').value.trim().toLowerCase();

  filteredPatterns = allPatterns.filter(p => {
    const matchMod = activeModality === 'All' || (p.modality || '').includes(activeModality);
    const matchQ   = !q || p.name.toLowerCase().includes(q);
    return matchMod && matchQ;
  });

  renderPatternList();
}

function renderPatternList() {
  const sel = document.getElementById('pattern-select');
  const prevId = selectedPatternId;
  const stepToRestore = _preferredStepIndex !== null ? _preferredStepIndex : currentStepIndex;
  _preferredStepIndex = null;
  sel.innerHTML = '';

  filteredPatterns.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });

  // Restore selection if still present, otherwise auto-load first pattern
  if (prevId && filteredPatterns.find(p => p.id === prevId)) {
    sel.value = prevId;
    loadPattern(prevId, stepToRestore);
  } else if (filteredPatterns.length) {
    sel.value = filteredPatterns[0].id;
    loadPattern(filteredPatterns[0].id);
  } else {
    selectedPatternId = null;
    clearStepView();
    updateSidebarButtons(false);
  }
}

// ── Load pattern ─────────────────────────────────────────────
function loadPattern(id, preferredStepIndex) {
  const pattern = allPatterns.find(p => p.id === id);
  if (!pattern) return;

  selectedPatternId = id;
  const steps = pattern.steps || [];
  if (typeof preferredStepIndex === 'number' && steps.length) {
    currentStepIndex = Math.max(0, Math.min(preferredStepIndex, steps.length - 1));
  } else {
    currentStepIndex = 0;
  }
  updateSidebarButtons(true);

  // Reset timer
  stopTimer();
  timerSeconds = 0;
  startTimer(pattern.name);

  renderCurrentStep(pattern);
}

function getSelectedPattern() {
  return allPatterns.find(p => p.id === selectedPatternId) || null;
}

// ── Step rendering ───────────────────────────────────────────
function renderCurrentStep(pattern) {
  const steps = pattern.steps || [];

  const emptyEl   = document.getElementById('step-empty');
  const headerEl  = document.getElementById('step-header');
  const contentEl = document.getElementById('step-content');

  if (!steps.length) {
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    contentEl.style.display = 'none';
    emptyEl.querySelector('p').textContent = 'This pattern has no steps yet.';
    return;
  }

  const step = resolveLinkedStep(steps[currentStepIndex]);
  if (!step) return;

  emptyEl.style.display = 'none';
  headerEl.style.display = '';
  contentEl.style.display = '';

  // Counter
  document.getElementById('step-counter').textContent =
    `Step ${currentStepIndex + 1} of ${steps.length}`;

  // Title
  document.getElementById('step-title').textContent = step.stepTitle || '';

  // Content
  contentEl.innerHTML = '';
  renderStepSections(contentEl, step);

  // Auto-stop timer on last step
  if (currentStepIndex === steps.length - 1 && timerRunning) {
    stopTimer();
  }

  // Nav buttons
  document.getElementById('btn-prev-step').disabled = currentStepIndex === 0;
  document.getElementById('btn-next-step').disabled = currentStepIndex === steps.length - 1;
}

function resolveLinkedStep(step) {
  if (!step) return step;

  const linkedStepId = String(step.linkedStepId || '').trim();
  if (!linkedStepId) return normaliseStepForViewer(step);

  const shared = findLinkedStepData(linkedStepId);
  if (!shared) return normaliseStepForViewer(step);

  return {
    stepTitle: shared.stepTitle,
    richContent: shared.richContent,
    linkedStepId,
    sections: shared.sections
  };
}

function findLinkedStepData(linkedStepId) {
  for (const pattern of allPatterns) {
    const steps = pattern.steps || [];
    for (const step of steps) {
      if (String(step.linkedStepId || '').trim() === linkedStepId) {
        return {
          stepTitle: step.stepTitle || '',
          richContent: normaliseRichContent(step.richContent || step.rich_content || []),
          sections: normaliseStepSectionsSafe(step.sections, step.richContent || step.rich_content || [])
        };
      }
    }
  }
  return null;
}

function normaliseStepSectionsSafe(sections, fallbackRichContent) {
  if (typeof normaliseStepSections === 'function') {
    return normaliseStepSections(sections, normaliseRichContent(fallbackRichContent || []));
  }

  const fallback = normaliseRichContent(fallbackRichContent || []);
  const out = {
    searchPattern: [],
    notes: [],
    dontMissPathology: [],
    measurements: [],
    images: [],
    hyperlinks: []
  };

  STEP_SECTION_ORDER.forEach(key => {
    const raw = sections && Array.isArray(sections[key]) ? sections[key] : [];
    out[key] = normaliseRichContent(raw);
  });

  if (!out.searchPattern.length && fallback.length) {
    out.searchPattern = fallback;
  }

  return out;
}

function normaliseStepForViewer(step) {
  const fallback = normaliseRichContent((step && (step.richContent || step.rich_content)) || []);
  return {
    stepTitle: (step && step.stepTitle) || '',
    richContent: fallback,
    linkedStepId: (step && step.linkedStepId) || '',
    sections: normaliseStepSectionsSafe(step && step.sections, fallback)
  };
}

function renderStepSections(container, step) {
  const sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);

  STEP_SECTION_ORDER.forEach(key => {
    const sectionWrap = document.createElement('section');
    sectionWrap.className = 'step-section';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-section-toggle';
    const isOpen = isStepSectionOpen(key);
    btn.setAttribute('aria-expanded', String(isOpen));
    btn.innerHTML = `
      <span>${STEP_SECTION_LABELS[key] || key}</span>
      <span class="step-section-chevron" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
    `;

    const panel = document.createElement('div');
    panel.className = 'step-section-panel';
    if (!isOpen) panel.style.display = 'none';

    const panelInner = document.createElement('div');
    panelInner.className = 'step-section-content';
    const content = sections[key] || [];
    if (content.length) {
      if (key === 'hyperlinks') {
        renderHyperlinkSection(panelInner, content);
      } else {
        renderRichContent(panelInner, content);
      }
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      panelInner.appendChild(empty);
    }
    panel.appendChild(panelInner);

    btn.addEventListener('click', () => {
      const nextOpen = !isStepSectionOpen(key);
      setStepSectionOpenState(key, nextOpen);
      btn.setAttribute('aria-expanded', String(nextOpen));
      panel.style.display = nextOpen ? '' : 'none';
      const chevron = btn.querySelector('.step-section-chevron');
      if (chevron) chevron.textContent = nextOpen ? '▾' : '▸';
    });

    sectionWrap.appendChild(btn);
    sectionWrap.appendChild(panel);
    container.appendChild(sectionWrap);
  });
}

function loadStepSectionsOpenState() {
  const raw = localStorage.getItem(STEP_SECTIONS_STATE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    STEP_SECTION_ORDER.forEach(key => {
      if (typeof parsed[key] === 'boolean') {
        _stepSectionsOpenState[key] = parsed[key];
      }
    });
  } catch (err) {
    console.warn('Failed to load step section state:', err);
  }
}

function persistStepSectionsOpenState() {
  localStorage.setItem(STEP_SECTIONS_STATE_KEY, JSON.stringify(_stepSectionsOpenState));
}

function setStepSectionOpenState(key, isOpen) {
  if (!Object.prototype.hasOwnProperty.call(_stepSectionsOpenState, key)) return;
  _stepSectionsOpenState[key] = Boolean(isOpen);
  persistStepSectionsOpenState();
}

function isStepSectionOpen(key) {
  return Boolean(_stepSectionsOpenState[key]);
}

function rememberStepForPattern(patternId, stepIndex) {
  if (!patternId || patternId !== selectedPatternId) return;
  _preferredStepIndex = typeof stepIndex === 'number' ? stepIndex : null;
}

function renderHyperlinkSection(container, content) {
  const chunks = normaliseRichContent(content);
  var links = [];
  chunks.forEach(function(chunk) {
    if (chunk.type === 'link' && (chunk.url || chunk.text)) {
      links.push({ url: chunk.url || chunk.text, label: chunk.text || chunk.url });
    } else if (chunk.type === 'text' && chunk.text) {
      // auto-linkify plain text that looks like a URL
      var urlMatch = chunk.text.match(/https?:\/\/\S+|www\.\S+/i);
      if (urlMatch) {
        links.push({ url: urlMatch[0], label: chunk.text });
      }
    }
  });
  if (!links.length) {
    var empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = 'No links yet.';
    container.appendChild(empty);
    return;
  }
  links.forEach(function(link) {
    var href = sanitiseLinkUrl(link.url || '');
    if (!href) return;
    var row = document.createElement('div');
    row.className = 'step-hyperlink-row';
    var anchor = document.createElement('a');
    anchor.href = href;
    anchor.textContent = link.label || href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'step-link';
    row.appendChild(anchor);
    container.appendChild(row);
  });
}

function renderRichContent(container, richContent) {
  const chunks = normaliseRichContent(richContent);
  if (!chunks.length) return;

  let currentParagraph = null;

  chunks.forEach(chunk => {
    if (chunk.type === 'image') {
      if (!chunk.data) return;
      if (currentParagraph) { container.appendChild(currentParagraph); currentParagraph = null; }
      const img = document.createElement('img');
      img.src = `data:image/${chunk.format || 'png'};base64,${chunk.data}`;
      img.alt = 'Step image';
      img.addEventListener('click', () => openLightbox(img.src));
      container.appendChild(img);
    } else if (chunk.type === 'link') {
      const href = sanitiseLinkUrl(chunk.url || '');
      const label = chunk.text || chunk.url || '';
      if (!href || !label) return;
      if (!currentParagraph) {
        currentParagraph = document.createElement('p');
      }
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.textContent = label;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.className = 'step-link';
      currentParagraph.appendChild(anchor);
      currentParagraph.appendChild(document.createTextNode(' '));
    } else {
      // text chunk
      if (!currentParagraph) {
        currentParagraph = document.createElement('p');
      }
      const text = chunk.text || '';
      if (!text && !chunk.bold && !chunk.color) {
        if (currentParagraph.childNodes.length) {
          container.appendChild(currentParagraph);
          currentParagraph = null;
        }
        return;
      }
      if (chunk.bold || chunk.color) {
        const span = document.createElement('span');
        span.textContent = text;
        if (chunk.bold) span.style.fontWeight = '700';
        if (chunk.color === 'red')   span.classList.add('rich-red');
        if (chunk.color === 'green') span.classList.add('rich-green');
        if (chunk.color === 'blue')  span.classList.add('rich-blue');
        currentParagraph.appendChild(span);
      } else {
        currentParagraph.appendChild(document.createTextNode(text));
      }
    }
  });

  if (currentParagraph && currentParagraph.childNodes.length) {
    container.appendChild(currentParagraph);
  }
}

function clearStepView() {
  document.getElementById('step-empty').style.display = '';
  document.getElementById('step-empty').querySelector('p').textContent = 'Select a pattern to begin.';
  document.getElementById('step-header').style.display = 'none';
  document.getElementById('step-content').style.display = 'none';
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = 'none';
  stopTimer();
}

function navigateStep(delta) {
  const pattern = getSelectedPattern();
  if (!pattern) return;
  const steps = pattern.steps || [];
  const next = currentStepIndex + delta;
  if (next < 0 || next >= steps.length) return;
  currentStepIndex = next;
  renderCurrentStep(pattern);
}

// ── Timer ────────────────────────────────────────────────────
function startTimer(patternName) {
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = '';
  document.getElementById('timer-pattern-name').textContent = patternName;
  timerSeconds = 0;
  timerRunning = true;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
}

function updateTimerDisplay() {
  const m = Math.floor(timerSeconds / 60);
  const s = timerSeconds % 60;
  document.getElementById('timer-display').textContent =
    `${m}:${String(s).padStart(2, '0')}`;
}

// ── Record modal ─────────────────────────────────────────────
function openRecordModal() {
  const pattern = getSelectedPattern();
  if (!pattern) return;

  pendingRecordPatternName = pattern.name;
  pendingRecordSeconds = timerSeconds;
  stopTimer();

  const dur = formatDuration(pendingRecordSeconds);
  document.getElementById('modal-record-body').textContent =
    `Record "${pendingRecordPatternName}" — ${dur}?`;
  document.getElementById('record-rvu-input').value = '';
  document.getElementById('modal-record').style.display = '';
  setTimeout(() => document.getElementById('record-rvu-input').focus(), 50);
}

async function confirmRecord() {
  const rvu = document.getElementById('record-rvu-input').value;
  document.getElementById('modal-record').style.display = 'none';

  try {
    await addStudyLogEntry(_pUid, {
      study:    pendingRecordPatternName,
      seconds:  pendingRecordSeconds,
      duration: formatDuration(pendingRecordSeconds),
      rvu:      rvu !== '' ? rvu : null
    });
    showToast(`Recorded "${pendingRecordPatternName}" — ${formatDuration(pendingRecordSeconds)}`);
  } catch (err) {
    console.error(err);
    showToast('Failed to save study record.', true);
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ── Sidebar buttons ──────────────────────────────────────────
function updateSidebarButtons(hasSelection) {
  document.getElementById('btn-edit-pattern').disabled = !hasSelection;
  document.getElementById('btn-delete-pattern').disabled = !hasSelection;
}

async function handleDeletePattern() {
  const pattern = getSelectedPattern();
  if (!pattern) return;

  const ok = await showConfirm('Delete Pattern', `Delete "${pattern.name}"? This cannot be undone.`);
  if (!ok) return;

  try {
    await deletePattern(_pUid, selectedPatternId);
    selectedPatternId = null;
    clearStepView();
    updateSidebarButtons(false);
    showToast('Pattern deleted.');
  } catch (err) {
    console.error(err);
    showToast('Failed to delete pattern.', true);
  }
}

// ── Keyboard navigation ──────────────────────────────────────
function handleKeydown(e) {
  // Only when not inside an input/textarea/contenteditable
  const tag = e.target.tagName;
  const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                    e.target.isContentEditable;
  if (isEditing) return;

  // Only when patterns panel is active
  const panel = document.getElementById('panel-patterns');
  if (!panel.classList.contains('active')) return;

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateStep(1);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    navigateStep(-1);
  } else if (e.key === ' ') {
    e.preventDefault();
    openRecordModal();
  }
}

// ── HDF5 Import ──────────────────────────────────────────────
/**
 * Import patterns from an HDF5 file using h5wasm loaded from CDN.
 * The .h5 format matches what the Python desktop app writes.
 */
async function handleH5Import(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset input

  showToast('Loading h5wasm…');

  try {
    // Dynamically load h5wasm from CDN
    const h5wasm = await loadH5Wasm();
    const buffer = await file.arrayBuffer();
    const uint8  = new Uint8Array(buffer);

    // Write to h5wasm virtual FS and open
    const filename = 'import.h5';
    h5wasm.FS.writeFile(filename, uint8);
    const f = new h5wasm.File(filename, 'r');

    const patterns = parseH5File(f);
    f.close();
    h5wasm.FS.unlink(filename);

    if (!patterns.length) {
      showToast('No patterns found in file.', true);
      return;
    }

    const ok = await showConfirm(
      'Import Patterns',
      `Import ${patterns.length} pattern(s) from "${file.name}"? Existing patterns will not be overwritten.`
    );
    if (!ok) return;

    showToast(`Compressing images…`);
    const compressed = await compressPatternImages(patterns);

    showToast(`Importing ${compressed.length} patterns…`);

    await batchImportPatterns(_pUid, compressed, (done, total) => {
      showToast(`Imported ${done} / ${total}…`);
    });

    showToast(`Imported ${compressed.length} patterns successfully.`);
  } catch (err) {
    console.error('HDF5 import error:', err);
    showToast('Import failed: ' + (err.message || err), true);
  }
}

// Compress all base64 images in patterns to stay under Firestore's 1MB doc limit.
// Images are resized to max 1024px and re-encoded as JPEG at 0.75 quality.
async function compressPatternImages(patterns) {
  return Promise.all(patterns.map(async p => {
    const steps = await Promise.all((p.steps || []).map(async step => {
      const richContent = await Promise.all((step.richContent || []).map(async chunk => {
        if (chunk.type !== 'image' || !chunk.data) return chunk;
        try {
          const compressed = await compressBase64Image(chunk.data, chunk.format || 'png');
          return Object.assign({}, chunk, { data: compressed, format: 'jpeg' });
        } catch (e) {
          console.warn('Image compression failed, keeping original:', e);
          return chunk;
        }
      }));
      return Object.assign({}, step, { richContent });
    }));
    return Object.assign({}, p, { steps });
  }));
}

function compressBase64Image(b64data, format) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = function() {
      const MAX = 1024;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      // Strip the "data:image/...;base64," prefix before returning
      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/' + format + ';base64,' + b64data;
  });
}

let _h5wasmPromise = null;
function loadH5Wasm() {
  if (_h5wasmPromise) return _h5wasmPromise;
  _h5wasmPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/h5wasm@0.7.5/dist/iife/h5wasm.js';
    s.onload = async () => {
      try {
        await h5wasm.ready;
        resolve(h5wasm);
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error('Failed to load h5wasm'));
    document.head.appendChild(s);
  });
  return _h5wasmPromise;
}

function parseH5File(f) {
  const patterns = [];
  const patternsGroup = f.get('patterns');
  if (!patternsGroup) return patterns;

  // Each key in the patterns group is one pattern
  for (const key of patternsGroup.keys()) {
    try {
      const group = patternsGroup.get(key);
      const patternName = group.attrs['pattern_name']?.value || decodePatternKey(key);
      const stepsDataset = group.get('steps_json');
      if (!stepsDataset) continue;

      const rawBytes = stepsDataset.value;
      const json = typeof rawBytes === 'string'
        ? rawBytes
        : new TextDecoder().decode(rawBytes);

      let steps = [];
      try { steps = JSON.parse(json); } catch { /* skip malformed */ }

      // Normalise step shape
      steps = steps.map(s => ({
        stepTitle:    s.step_title || s.stepTitle || '',
        richContent:  normaliseRichContent(s.rich_content || s.richContent || []),
        linkedStepId: s.linked_step_id || s.linkedStepId || '',
        sections: normaliseStepSectionsSafe(s.sections, s.rich_content || s.richContent || [])
      }));

      // Infer modality from name
      const modality = inferModality(patternName);

      patterns.push({ name: patternName, modality, steps });
    } catch (groupErr) {
      console.warn('Error parsing pattern group:', groupErr);
    }
  }

  return patterns;
}

function decodePatternKey(key) {
  // Keys stored as "p_<base64url>" in the Python app
  if (key.startsWith('p_')) {
    try {
      const b64 = key.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      return atob(b64);
    } catch { /* fall through */ }
  }
  return key;
}

function inferModality(name) {
  const upper = name.toUpperCase();
  if (upper.includes('MRI') || upper.includes('MR ')) return 'MRI';
  if (upper.includes('CT'))  return 'CT';
  if (upper.includes(' US ') || upper.startsWith('US ') || upper.includes('ULTRASOUND')) return 'US';
  if (upper.includes('XR') || upper.includes('RADIOGRAPH') || upper.includes('X-RAY')) return 'Plain Radiograph';
  if (upper.includes('PET') || upper.includes('NUCLEAR') || upper.includes('NM ') || upper.includes('SPECT')) return 'Nuclear Medicine';
  return 'Other';
}

function normaliseRichContent(richContent) {
  if (!Array.isArray(richContent)) return [];

  return richContent.map(chunk => {
    const type = chunk?.type || (chunk?.image_data || chunk?.data ? 'image' : (chunk?.url ? 'link' : 'text'));

    if (type === 'image') {
      return {
        type: 'image',
        format: chunk?.format || chunk?.image_format || 'png',
        data: chunk?.data || chunk?.image_data || ''
      };
    }

    if (type === 'link') {
      return {
        type: 'link',
        text: chunk?.text || chunk?.content || chunk?.url || '',
        url: chunk?.url || ''
      };
    }

    return {
      type: 'text',
      text: chunk?.text || chunk?.content || '',
      bold: Boolean(chunk?.bold),
      color: chunk?.color || null
    };
  });
}

function sanitiseLinkUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw)) return raw;
  if (/^tel:/i.test(raw)) return raw;
  return 'https://' + raw;
}
