// patterns.js — plain script, no modules. Depends on db.js, editor.js, app.js globals.

// ── State ────────────────────────────────────────────────────
var _pUid = null;
var allPatterns = [];
var filteredPatterns = [];
var selectedPatternId = null;
var currentStepIndex = 0;
var timerInterval = null;
var timerSeconds = 0;
var timerStartWallTime = null;
var timerRunning = false;
var timerGoalSeconds = null;
var activeModality = 'All';
var pendingRecordPatternName = '';
var pendingRecordSeconds = 0;
var _unsubscribePatterns = null;
var _patternSidebarCollapsed = false;
var _findingsPanelCollapsed = false;
var _findingsPanelWidth = 360;
var _findingsPanelResizing = false;
var _findingsPanelResizeBound = false;
var _preferredStepIndex = null;
var _openStepIndices = new Set();
var _draggingPatternStepIndex = null;
var _patternViewerEditMode = false;
var _activeInlineEdit = null;
var _inlineEditSaving = false;
var _stepTitleSaveInFlight = {};
var _patternEditDraft = null;
var _patternEditCommitInFlight = false;
var _openFindingPanels = new Set();
var _accordionMode = false;
var STEP_SECTION_ORDER = ['searchPattern', 'dontMissPathology'];
var STEP_MAIN_SECTION_ORDER = ['searchPattern'];
var STEP_SECTION_LABELS = {
  dontMissPathology: 'Findings',
  searchPattern: 'Search Pattern'
};
var ACCORDION_MODE_STATE_KEY = 'patternStepAccordionMode';
var SECTION_WITH_SUBSECTIONS_KEYS = ['dontMissPathology'];
var STEP_SECTIONS_STATE_KEY = 'patternStepSectionsState';
var INLINE_EDITOR_FONT_SIZE_KEY = 'patternInlineEditorFontSize';
var _stepSectionsOpenState = {
  searchPattern: true,
  dontMissPathology: false
};
var _inlineToolbarOffsetBound = false;
var _inlineEditorFontSize = 'md';
var _yellowMarkedStepKeys = new Set();

function getCleanStepTitle(title) {
  if (typeof stripStepTitleNumbering === 'function') {
    return stripStepTitleNumbering(title);
  }
  var raw = String(title || '').trim();
  if (!raw) return '';
  return raw.replace(/^(?:step\s+\d+|\d+)\s*[.)\-:]?\s*/i, '').trim();
}

function syncInlineToolbarOffset() {
  const viewer = document.getElementById('step-viewer');
  const header = document.getElementById('step-header');
  const content = document.getElementById('step-content');
  if (!viewer || !header || !content) return;

  const viewerRect = viewer.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const visibleHeaderHeight = Math.max(0, headerRect.bottom - viewerRect.top);
  const toolbarOffset = Math.max(0, Math.round(visibleHeaderHeight + 8));
  content.style.setProperty('--inline-toolbar-offset', toolbarOffset + 'px');
}

function bindInlineToolbarOffsetSync() {
  if (_inlineToolbarOffsetBound) return;
  const viewer = document.getElementById('step-viewer');
  if (!viewer) return;

  viewer.addEventListener('scroll', syncInlineToolbarOffset, { passive: true });
  window.addEventListener('resize', syncInlineToolbarOffset);
  _inlineToolbarOffsetBound = true;
}

function normaliseInlineEditorFontSize(size) {
  var value = String(size || '').trim().toLowerCase();
  if (value === 'sm' || value === 'md' || value === 'lg') return value;
  return 'md';
}

function loadInlineEditorFontSizePreference() {
  var saved = localStorage.getItem(INLINE_EDITOR_FONT_SIZE_KEY);
  _inlineEditorFontSize = normaliseInlineEditorFontSize(saved || 'md');
}

function updateInlineFontSizeButtons(toolbar, size) {
  if (!toolbar) return;
  Array.prototype.forEach.call(toolbar.querySelectorAll('[data-rich-font-size]'), function(btn) {
    var selected = String(btn.getAttribute('data-rich-font-size') || '') === size;
    btn.classList.toggle('is-selected', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function applyInlineEditorFontSize(editor, size) {
  if (!editor) return;
  var safeSize = normaliseInlineEditorFontSize(size);
  editor.classList.remove('font-size-sm', 'font-size-md', 'font-size-lg');
  editor.classList.add('font-size-' + safeSize);
}

function bindInlineRichFontSizeControls(toolbar, editor) {
  if (!toolbar || !editor) return;

  var safeSize = normaliseInlineEditorFontSize(_inlineEditorFontSize);
  applyInlineEditorFontSize(editor, safeSize);
  updateInlineFontSizeButtons(toolbar, safeSize);

  Array.prototype.forEach.call(toolbar.querySelectorAll('[data-rich-font-size]'), function(btn) {
    btn.addEventListener('click', function() {
      var nextSize = normaliseInlineEditorFontSize(btn.getAttribute('data-rich-font-size'));
      _inlineEditorFontSize = nextSize;
      localStorage.setItem(INLINE_EDITOR_FONT_SIZE_KEY, nextSize);
      applyInlineEditorFontSize(editor, nextSize);
      updateInlineFontSizeButtons(toolbar, nextSize);
      editor.focus();
    });
  });
}

// ── Init ─────────────────────────────────────────────────────
function initPatterns(userId) {
  _pUid = userId;

  initPatternSidebarToggle();
  initPatternFindingsPanelToggle();
  loadStepSectionsOpenState();
  loadAccordionModeState();
  loadInlineEditorFontSizePreference();
  initPatternViewControls();
  bindInlineToolbarOffsetSync();

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

  // Timer controls
  document.getElementById('btn-start-timer').addEventListener('click', handleStartTimer);
  document.getElementById('btn-record-study').addEventListener('click', openRecordModal);
  document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);
  document.getElementById('btn-save-study-goal').addEventListener('click', saveStudyGoal);
  document.getElementById('timer-goal-minutes').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveStudyGoal();
    }
  });
  updateTimerActionButtons();

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
      togglePatternViewerEditMode();
    }
  });
  document.getElementById('btn-add-pattern-step').addEventListener('click', handleAddPatternStep);
  document.getElementById('btn-delete-pattern').addEventListener('click', handleDeletePattern);

  // HDF5 import
  document.getElementById('btn-import-h5').addEventListener('click', () => {
    document.getElementById('import-h5-input').click();
  });
  document.getElementById('import-h5-input').addEventListener('change', handleH5Import);

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);
}

function extractStepSearchText(step, fallbackNumber) {
  if (!step) return '';
  var parts = [];
  var title = getCleanStepTitle(step.stepTitle);
  if (title) parts.push(title);
  if (fallbackNumber) parts.push('step ' + String(fallbackNumber));

  var sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);
  var searchPatternChunks = normaliseRichContent(sections.searchPattern || []);
  var searchPatternText = typeof richContentToPlainText === 'function'
    ? richContentToPlainText(searchPatternChunks)
    : searchPatternChunks.map(function(chunk) {
        return chunk && chunk.type === 'text' ? String(chunk.text || '') : '';
      }).join(' ');
  if (searchPatternText) parts.push(searchPatternText);

  var findingsChunks = normaliseRichContent(sections.dontMissPathology || []);
  var findingsText = typeof richContentToPlainText === 'function'
    ? richContentToPlainText(findingsChunks)
    : findingsChunks.map(function(chunk) {
        return chunk && chunk.type === 'text' ? String(chunk.text || '') : '';
      }).join(' ');
  if (findingsText) parts.push(findingsText);

  return parts.join(' ').toLowerCase();
}

function parseGoToTarget(text) {
  var cleaned = String(text || '').trim();
  if (!cleaned) return { type: 'none', value: '' };

  var numberMatch = cleaned.match(/(?:step\s*)?(\d+)/i);
  if (numberMatch) {
    var stepNumber = Number(numberMatch[1]);
    if (Number.isFinite(stepNumber) && stepNumber > 0) {
      return { type: 'index', value: Math.floor(stepNumber) - 1 };
    }
  }

  return { type: 'query', value: cleaned.toLowerCase() };
}

function focusCurrentStepToggle(stepIndex) {
  var toggle = document.querySelector('.step-item[data-step-index="' + stepIndex + '"] .step-item-toggle');
  if (toggle && typeof toggle.focus === 'function') {
    toggle.focus({ preventScroll: true });
  }
}

function getStepMarkKey(patternId, stepIndex) {
  var safePatternId = String(patternId || '').trim();
  if (!safePatternId || !Number.isInteger(stepIndex) || stepIndex < 0) return '';
  return safePatternId + '::' + String(stepIndex);
}

function isStepYellowMarked(patternId, stepIndex) {
  var key = getStepMarkKey(patternId, stepIndex);
  return key ? _yellowMarkedStepKeys.has(key) : false;
}

function markCurrentStepYellow() {
  var pattern = getSelectedPattern();
  if (!pattern) return false;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length || currentStepIndex < 0 || currentStepIndex >= steps.length) return false;

  return markStepYellowByIndex(currentStepIndex);
}

function markStepYellowByIndex(stepIndex) {
  var pattern = getSelectedPattern();
  if (!pattern) return false;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) return false;

  var key = getStepMarkKey(pattern.id, stepIndex);
  if (!key) return false;

  _yellowMarkedStepKeys.add(key);
  currentStepIndex = stepIndex;
  _openStepIndices = new Set([stepIndex]);
  renderCurrentStep(pattern);
  focusCurrentStepToggle(stepIndex);
  return true;
}

function normaliseMarkTargetQuery(rawQuery) {
  var query = String(rawQuery || '').toLowerCase().trim();
  if (!query) return '';
  query = query.replace(/^step\s+/i, '').trim();
  query = query.replace(/^the\s+/i, '').trim();
  if (query.indexOf('the') === 0 && query.length > 3 && query.charAt(3) !== ' ') {
    query = query.slice(3).trim();
  }
  return query;
}

function markStepYellowByTarget(rawTarget) {
  var pattern = getSelectedPattern();
  if (!pattern) return false;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length) return false;

  var target = parseGoToTarget(normaliseMarkTargetQuery(rawTarget));
  if (target.type === 'index') {
    return markStepYellowByIndex(target.value);
  }

  if (target.type !== 'query' || !target.value) {
    return false;
  }

  var queryWords = target.value.split(/\s+/).filter(Boolean);
  if (!queryWords.length) return false;

  var bestIndex = -1;
  for (var i = 0; i < steps.length; i += 1) {
    var step = resolveLinkedStep(steps[i]);
    var haystack = extractStepSearchText(step, i + 1);
    var compactHaystack = haystack.replace(/\s+/g, '');
    var matched = queryWords.every(function(word) {
      var cleanWord = String(word || '').trim();
      if (!cleanWord) return true;
      if (haystack.indexOf(cleanWord) !== -1) return true;
      return compactHaystack.indexOf(cleanWord.replace(/\s+/g, '')) !== -1;
    });
    if (matched) {
      bestIndex = i;
      break;
    }
  }

  if (bestIndex < 0) return false;
  return markStepYellowByIndex(bestIndex);
}

function clearYellowStepMarks() {
  if (!_yellowMarkedStepKeys.size) return;
  _yellowMarkedStepKeys.clear();
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

function initPatternFindingsPanelToggle() {
  const panel = document.getElementById('pattern-findings-panel');
  const btn = document.getElementById('btn-toggle-pattern-findings-panel');
  if (!panel || !btn) return;

  const saved = localStorage.getItem('patternFindingsPanelCollapsed');
  applyPatternFindingsPanelState(saved === '1', false);

  btn.addEventListener('click', () => {
    applyPatternFindingsPanelState(!_findingsPanelCollapsed, true);
  });

  bindFindingsPanelResizeHandle();
  loadPatternFindingsPanelWidth();
}

function applyPatternFindingsPanelState(collapsed, persist) {
  const panel = document.getElementById('pattern-findings-panel');
  const btn = document.getElementById('btn-toggle-pattern-findings-panel');
  if (!panel || !btn) return;

  _findingsPanelCollapsed = collapsed;
  panel.classList.toggle('panel-collapsed', collapsed);

  btn.textContent = collapsed ? '>' : '<';
  btn.title = collapsed ? 'Expand findings window' : 'Minimize findings window';
  btn.setAttribute('aria-label', collapsed ? 'Expand search pattern findings window' : 'Minimize search pattern findings window');
  btn.setAttribute('aria-expanded', String(!collapsed));

  if (collapsed) {
    panel.style.removeProperty('width');
    panel.style.removeProperty('min-width');
  } else {
    applyPatternFindingsPanelWidth(_findingsPanelWidth, false);
  }

  if (persist) {
    localStorage.setItem('patternFindingsPanelCollapsed', collapsed ? '1' : '0');
  }
}

function clampFindingsPanelWidth(width) {
  const min = 280;
  const viewport = window.innerWidth || 1440;
  const max = Math.max(360, Math.floor(viewport * 0.62));
  const next = Number(width);
  if (!Number.isFinite(next)) return 360;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function applyPatternFindingsPanelWidth(width, persist) {
  const panel = document.getElementById('pattern-findings-panel');
  if (!panel) return;

  if (_findingsPanelCollapsed) {
    panel.style.removeProperty('width');
    panel.style.removeProperty('min-width');
    return;
  }

  if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
    panel.style.removeProperty('width');
    panel.style.removeProperty('min-width');
    return;
  }

  _findingsPanelWidth = clampFindingsPanelWidth(width);
  panel.style.width = _findingsPanelWidth + 'px';
  panel.style.minWidth = _findingsPanelWidth + 'px';

  if (persist) {
    localStorage.setItem('patternFindingsPanelWidth', String(_findingsPanelWidth));
  }
}

function loadPatternFindingsPanelWidth() {
  const saved = localStorage.getItem('patternFindingsPanelWidth');
  applyPatternFindingsPanelWidth(saved || _findingsPanelWidth, false);
}

function bindFindingsPanelResizeHandle() {
  if (_findingsPanelResizeBound) return;

  const handle = document.getElementById('pattern-findings-resize-handle');
  const panel = document.getElementById('pattern-findings-panel');
  if (!handle || !panel) return;

  function stopResize() {
    if (!_findingsPanelResizing) return;
    _findingsPanelResizing = false;
    document.body.classList.remove('is-resizing-findings-panel');
    localStorage.setItem('patternFindingsPanelWidth', String(_findingsPanelWidth));
  }

  function onPointerMove(event) {
    if (!_findingsPanelResizing || _findingsPanelCollapsed) return;
    const viewport = window.innerWidth || 1440;
    const desiredWidth = viewport - event.clientX;
    applyPatternFindingsPanelWidth(desiredWidth, false);
  }

  handle.addEventListener('pointerdown', function(event) {
    if (_findingsPanelCollapsed) return;
    if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) return;
    event.preventDefault();
    _findingsPanelResizing = true;
    document.body.classList.add('is-resizing-findings-panel');
    if (typeof handle.setPointerCapture === 'function') {
      handle.setPointerCapture(event.pointerId);
    }
  });

  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('resize', function() {
    if (_findingsPanelCollapsed) return;
    applyPatternFindingsPanelWidth(_findingsPanelWidth, false);
  });

  _findingsPanelResizeBound = true;
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

  const wasSamePattern = selectedPatternId === id;
  selectedPatternId = id;
  const steps = pattern.steps || [];
  if (typeof preferredStepIndex === 'number' && steps.length) {
    currentStepIndex = Math.max(0, Math.min(preferredStepIndex, steps.length - 1));
    _openStepIndices = _patternViewerEditMode ? new Set([currentStepIndex]) : new Set([currentStepIndex]);
  } else {
    currentStepIndex = 0;
    _openStepIndices = _patternViewerEditMode
      ? (steps.length ? new Set([currentStepIndex]) : new Set())
      : (steps.length ? new Set([0]) : new Set());
  }
  updateSidebarButtons(true);

  if (!wasSamePattern) {
    // Reset timer only when switching to a different pattern.
    stopTimer();
    timerSeconds = 0;
    startTimer(pattern);
  } else {
    // Keep elapsed time when reloading the same pattern after background updates.
    timerGoalSeconds = normaliseGoalSeconds(pattern && pattern.goalSeconds);
    syncGoalInputFromState();
    document.getElementById('timer-pattern-name').textContent = (pattern && pattern.name) ? pattern.name : '';
    if (timerRunning) {
      const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
      if (timerBar) timerBar.style.display = '';
    }
    updateTimerDisplay();
    updateTimerActionButtons();
  }

  renderCurrentStep(pattern);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('pattern-selection-changed', {
      detail: { patternId: id }
    }));
  }
  const viewer = document.getElementById('step-viewer');
  const filterInput = document.getElementById('pattern-filter');
  if (viewer && document.activeElement !== filterInput) {
    viewer.focus({ preventScroll: true });
  }
}

function openPatternAtStepFromSearch(patternId, stepIndex) {
  if (!patternId) return;

  const filterInput = document.getElementById('pattern-filter');
  if (filterInput) filterInput.value = '';

  activeModality = 'All';
  document.querySelectorAll('.mod-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mod === 'All');
  });

  applyFilters();
  loadPattern(patternId, typeof stepIndex === 'number' ? stepIndex : 0);

  const select = document.getElementById('pattern-select');
  if (select) select.value = patternId;
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
    updatePatternStepAddButton();
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    contentEl.style.display = 'none';
    emptyEl.innerHTML = '';
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = 'This pattern has no steps yet.';
    emptyEl.appendChild(emptyMsg);
    renderCurrentStepFindings(pattern, null, -1, 0);

    if (_patternViewerEditMode) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-accent btn-sm';
      addBtn.textContent = '+ Add Step';
      addBtn.addEventListener('click', handleAddPatternStep);
      emptyEl.appendChild(addBtn);
    }
    return;
  }

  updatePatternStepAddButton();
  emptyEl.style.display = 'none';
  headerEl.style.display = '';
  contentEl.style.display = '';
  contentEl.classList.toggle('step-content-edit-mode', Boolean(_patternViewerEditMode));

  document.getElementById('step-counter').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  const currentStep = steps[currentStepIndex] || steps[0] || null;
  document.getElementById('step-title').textContent = (currentStep && getCleanStepTitle(currentStep.stepTitle))
    ? getCleanStepTitle(currentStep.stepTitle)
    : 'Untitled Step';
  updateExpandAllButton(steps.length);

  contentEl.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'step-list';

  function clearDragOverState() {
    Array.from(list.querySelectorAll('.step-item')).forEach(function(item) {
      item.classList.remove('drag-over-before');
      item.classList.remove('drag-over-after');
      item.classList.remove('is-dragging');
    });
  }

  steps.forEach((rawStep, idx) => {
    const step = resolveLinkedStep(rawStep);
    if (!step) return;

    const item = document.createElement('section');
    item.className = 'step-item';
    if (step.isRedStep) item.classList.add('step-item-red');
    if (isStepYellowMarked(pattern.id, idx)) item.classList.add('step-item-yellow');
    item.dataset.stepIndex = String(idx);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'step-item-toggle';

    const isOpen = _openStepIndices.has(idx);
    toggle.setAttribute('aria-expanded', String(isOpen));

    const label = document.createElement('span');
    label.className = 'step-item-label';

    const number = document.createElement('span');
    number.className = 'step-item-number';
    number.textContent = `Step ${idx + 1}`;

    const title = document.createElement('span');
    title.className = 'step-item-title';
    title.textContent = getCleanStepTitle(step.stepTitle) || `Untitled Step ${idx + 1}`;

    label.appendChild(number);
    label.appendChild(title);

    const chevron = document.createElement('span');
    chevron.className = 'step-item-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = isOpen ? '▾' : '▸';

    const header = document.createElement('div');
    header.className = 'step-item-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'step-drag-handle';
    dragHandle.setAttribute('aria-hidden', 'true');
    dragHandle.title = steps.length > 1 ? 'Drag to reorder' : 'Add more steps to reorder';
    dragHandle.textContent = '☰';
    dragHandle.draggable = _patternViewerEditMode && steps.length > 1;
    if (!_patternViewerEditMode) dragHandle.style.display = 'none';

    toggle.appendChild(label);
    toggle.appendChild(chevron);

    header.appendChild(dragHandle);
    header.appendChild(toggle);

    const panel = document.createElement('div');
    panel.className = 'step-item-panel';
    if (!isOpen) panel.style.display = 'none';

    const panelInner = document.createElement('div');
    panelInner.className = 'step-item-panel-inner';
    renderStepSections(panelInner, step, idx);
    panel.appendChild(panelInner);

    toggle.addEventListener('click', () => {
      const nextOpen = !_openStepIndices.has(idx);
      if (nextOpen) {
        if (_accordionMode) {
          _openStepIndices = new Set([idx]);
        } else {
          _openStepIndices.add(idx);
        }
      } else {
        _openStepIndices.delete(idx);
      }
      currentStepIndex = idx;
      renderCurrentStep(pattern);
    });

    dragHandle.addEventListener('dragstart', e => {
      if (!_patternViewerEditMode) {
        e.preventDefault();
        return;
      }
      if (steps.length < 2) {
        e.preventDefault();
        return;
      }
      _draggingPatternStepIndex = idx;
      item.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      }
    });

    dragHandle.addEventListener('dragend', () => {
      _draggingPatternStepIndex = null;
      clearDragOverState();
    });

    item.addEventListener('dragover', e => {
      if (!_patternViewerEditMode) return;
      if (_draggingPatternStepIndex === null || _draggingPatternStepIndex === idx) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) < (rect.height / 2);
      item.classList.toggle('drag-over-before', before);
      item.classList.toggle('drag-over-after', !before);
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-before');
      item.classList.remove('drag-over-after');
    });

    item.addEventListener('drop', e => {
      if (!_patternViewerEditMode) return;
      if (_draggingPatternStepIndex === null) return;
      e.preventDefault();

      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) < (rect.height / 2);
      let targetIdx = before ? idx : (idx + 1);
      if (_draggingPatternStepIndex < targetIdx) targetIdx -= 1;

      clearDragOverState();
      reorderPatternSteps(pattern, _draggingPatternStepIndex, targetIdx);
    });

    item.appendChild(header);
    item.appendChild(panel);
    list.appendChild(item);
  });

  list.addEventListener('dragover', e => {
    if (!_patternViewerEditMode) return;
    if (_draggingPatternStepIndex === null || e.target !== list) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });

  list.addEventListener('drop', e => {
    if (!_patternViewerEditMode) return;
    if (_draggingPatternStepIndex === null || e.target !== list) return;
    e.preventDefault();
    clearDragOverState();
    reorderPatternSteps(pattern, _draggingPatternStepIndex, steps.length - 1);
  });

  contentEl.appendChild(list);
  renderCurrentStepFindings(pattern, currentStep, currentStepIndex, steps.length);

  const activeItem = list.querySelector(`[data-step-index="${currentStepIndex}"]`);
  if (activeItem && _openStepIndices.has(currentStepIndex)) {
    requestAnimationFrame(() => {
      const viewer = document.getElementById('step-viewer');
      const header = document.getElementById('step-header');
      if (!viewer) {
        activeItem.scrollIntoView({ block: 'start' });
        return;
      }

      const viewerRect = viewer.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      const headerHeight = header && header.style.display !== 'none' ? header.offsetHeight : 0;
      const targetTop = viewer.scrollTop + (itemRect.top - viewerRect.top) - headerHeight - 8;
      viewer.scrollTo({ top: Math.max(0, targetTop) });
    });
  }

  if (_openStepIndices.has(steps.length - 1) && timerRunning) {
    stopTimer();
  }

  syncInlineToolbarOffset();
}

function renderCurrentStepFindings(pattern, step, stepIndex, stepsLength) {
  const contentEl = document.getElementById('pattern-findings-content');
  if (!contentEl) return;

  const safePattern = pattern || null;
  const safeStep = step || null;
  const displayStepIndex = Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : -1;

  contentEl.innerHTML = '';
  contentEl.classList.toggle('step-content-edit-mode', Boolean(_patternViewerEditMode));

  if (!safeStep) {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = safePattern ? 'Select a step to view findings.' : 'Select a pattern to see findings.';
    contentEl.appendChild(empty);
    return;
  }

  const sections = normaliseStepSectionsSafe(safeStep.sections, safeStep.richContent || []);
  const findings = sections.dontMissPathology || [];

  if (findings.length) {
    renderNestedSubsections(contentEl, findings, displayStepIndex);
  } else {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = 'No findings yet.';
    contentEl.appendChild(empty);
  }

  if (_patternViewerEditMode) {
    const actions = document.createElement('div');
    actions.className = 'pattern-findings-actions';

    const addFindingBtn = document.createElement('button');
    addFindingBtn.type = 'button';
    addFindingBtn.className = 'btn btn-ghost btn-sm';
    addFindingBtn.textContent = 'Add Finding';
    addFindingBtn.addEventListener('click', function() {
      if (typeof openCreateFindingModal === 'function') {
        openCreateFindingModal({
          patternId: safePattern && safePattern.id ? safePattern.id : selectedPatternId,
          stepIndex: displayStepIndex >= 0 ? displayStepIndex : currentStepIndex
        });
      } else {
        showToast('Finding creation is unavailable right now.', true);
      }
    });

    actions.appendChild(addFindingBtn);
    contentEl.appendChild(actions);
  }
}

function moveStepIndexOrder(length, fromIndex, toIndex) {
  const order = Array.from({ length: length }, function(_, index) {
    return index;
  });
  if (fromIndex < 0 || fromIndex >= order.length || toIndex < 0 || toIndex >= order.length) {
    return order;
  }
  const moved = order.splice(fromIndex, 1)[0];
  order.splice(toIndex, 0, moved);
  return order;
}

function remapOpenStepIndices(order, openIndices) {
  const nextOpenIndices = new Set();
  order.forEach(function(previousIndex, nextIndex) {
    if (openIndices.has(previousIndex)) {
      nextOpenIndices.add(nextIndex);
    }
  });
  return nextOpenIndices;
}

async function reorderPatternSteps(pattern, fromIndex, toIndex) {
  const steps = Array.isArray(pattern && pattern.steps) ? pattern.steps : [];
  if (!_patternViewerEditMode || !pattern || !_pUid || steps.length < 2) return;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= steps.length || toIndex >= steps.length) {
    _draggingPatternStepIndex = null;
    return;
  }

  const previousSteps = steps.slice();
  const previousOpenIndices = new Set(_openStepIndices);
  const previousCurrentStepIndex = currentStepIndex;
  const order = moveStepIndexOrder(steps.length, fromIndex, toIndex);
  const nextSteps = order.map(function(previousIndex) {
    return previousSteps[previousIndex];
  });
  const movedStepNextIndex = order.indexOf(fromIndex);
  const nextCurrentStepIndex = order.indexOf(previousCurrentStepIndex);

  pattern.steps = nextSteps;
  _openStepIndices = _patternViewerEditMode
    ? (nextCurrentStepIndex >= 0 ? new Set([nextCurrentStepIndex]) : new Set())
    : remapOpenStepIndices(order, previousOpenIndices);
  if (!_patternViewerEditMode && movedStepNextIndex >= 0) {
    _openStepIndices.delete(movedStepNextIndex);
  }
  currentStepIndex = nextCurrentStepIndex >= 0 ? nextCurrentStepIndex : 0;
  rememberStepForPattern(pattern.id, currentStepIndex);
  _draggingPatternStepIndex = null;
  renderCurrentStep(pattern);

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    showToast('Step order saved.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    _openStepIndices = previousOpenIndices;
    currentStepIndex = previousCurrentStepIndex;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to save step order.', true);
  }
}

function resolveLinkedStep(step) {
  if (!step) return step;
  return resolveSectionLinksForViewer(normaliseStepForViewer(step));
}

function normaliseSectionLinkForViewer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    mode: raw.mode === 'snapshot' ? 'snapshot' : 'internal',
    sourcePatternId: String(raw.sourcePatternId || '').trim(),
    sourcePatternName: String(raw.sourcePatternName || '').trim(),
    sourceStepId: String(raw.sourceStepId || '').trim(),
    sourceStepTitle: String(raw.sourceStepTitle || '').trim(),
    sourceSubsectionId: String(raw.sourceSubsectionId || '').trim(),
    sourceSubsectionTitle: String(raw.sourceSubsectionTitle || '').trim(),
    targetType: String(raw.targetType || '').trim(),
    tokenVersion: Number(raw.tokenVersion || 1)
  };
}

function normaliseSectionLinksForViewer(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.searchPattern) {
    const link = normaliseSectionLinkForViewer(raw.searchPattern);
    if (link && link.sourceStepId) out.searchPattern = link;
  }
  return out;
}

function findSubsectionByIdForViewer(step, subsectionId) {
  if (!step || !subsectionId) return null;
  const sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);
  const findings = normaliseRichContent(sections.dontMissPathology || []);
  for (const item of findings) {
    if (!item || item.type !== 'subsection') continue;
    if (String(item.subsectionId || '').trim() === String(subsectionId).trim()) return item;
  }
  return null;
}

function hasRenderableRichContent(content) {
  return normaliseRichContent(content || []).some(function(chunk) {
    if (!chunk) return false;
    if (chunk.type === 'image') return Boolean(chunk.data);
    if (chunk.type === 'link') {
      return Boolean(String(chunk.url || '').trim() || String(chunk.text || '').trim());
    }
    if (chunk.type === 'subsection') {
      return Boolean(String(chunk.title || '').trim()) || hasRenderableRichContent(chunk.content || []);
    }
    return Boolean(String(chunk.text || '').trim());
  });
}

function resolveSectionLinksForViewer(step) {
  const resolved = normaliseStepForViewer(step);
  resolved.sectionLinks = {};
  resolved.linkMeta = null;
  resolved.linkedStepId = '';
  resolved.sections.dontMissPathology = normaliseRichContent(resolved.sections.dontMissPathology || []).map(function(item) {
    if (!item || item.type !== 'subsection') return item;
    return Object.assign({}, item, { linkMeta: null });
  });

  return resolved;
}

function getStepLinkKeyForViewer(step) {
  if (!step) return '';
  const linked = String(step.linkedStepId || '').trim();
  if (linked) return linked;
  return String(step.stepId || '').trim();
}

function findLinkedStepData(linkedStepId) {
  const target = String(linkedStepId || '').trim();
  if (!target) return null;

  for (const pattern of allPatterns) {
    const steps = pattern.steps || [];
    for (const step of steps) {
      if (String((step && step.stepId) || '').trim() === target) {
        return {
          stepTitle: step.stepTitle || '',
          isRedStep: Boolean(step.isRedStep || step.is_red_step || step.stepColorRed),
          richContent: normaliseRichContent(step.richContent || step.rich_content || []),
          sections: normaliseStepSectionsSafe(step.sections, step.richContent || step.rich_content || [])
        };
      }
    }
  }

  // Legacy fallback for previously saved manual link keys.
  for (const pattern of allPatterns) {
    const steps = pattern.steps || [];
    for (const step of steps) {
      if (getStepLinkKeyForViewer(step) === target) {
        return {
          stepTitle: step.stepTitle || '',
          isRedStep: Boolean(step.isRedStep || step.is_red_step || step.stepColorRed),
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
    dontMissPathology: [],
    searchPattern: []
  };

  STEP_SECTION_ORDER.forEach(key => {
    const raw = sections && Array.isArray(sections[key]) ? sections[key] : [];
    out[key] = normaliseRichContent(raw);
  });

  if (!out.searchPattern.length && fallback.length) {
    out.searchPattern = fallback;
  }

  // Migrate old section format to subsections within dontMissPathology
  if (sections) {
    const legacySections = [];
    const measurementContent = normaliseRichContent((sections.measurements) || []);
    const hyperlinkContent = normaliseRichContent((sections.hyperlinks) || []);
    const imageContent = normaliseRichContent((sections.images) || []);

    if (measurementContent && measurementContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Findings Section ' + (legacySections.length + 1),
        content: measurementContent
      });
    }
    if (hyperlinkContent && hyperlinkContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Findings Section ' + (legacySections.length + 1),
        content: hyperlinkContent
      });
    }
    if (imageContent && imageContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Findings Section ' + (legacySections.length + 1),
        content: imageContent
      });
    }

    if (legacySections.length && out.dontMissPathology && out.dontMissPathology.length) {
      out.dontMissPathology = out.dontMissPathology.concat(legacySections);
    } else if (legacySections.length) {
      out.dontMissPathology = legacySections;
    }
  }

  return out;
}

function normaliseStepForViewer(step) {
  const fallback = normaliseRichContent((step && (step.richContent || step.rich_content)) || []);
  return {
    stepTitle: getCleanStepTitle(step && step.stepTitle),
    isRedStep: Boolean(step && (step.isRedStep || step.is_red_step || step.stepColorRed)),
    richContent: fallback,
    stepId: (step && step.stepId) || '',
    linkedStepId: (step && step.linkedStepId) || '',
    linkMeta: (step && step.linkMeta) || null,
    sectionLinks: normaliseSectionLinksForViewer(step && step.sectionLinks),
    sections: normaliseStepSectionsSafe(step && step.sections, fallback)
  };
}

function renderStepSections(container, step, stepIndex) {
  const sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);

  if (_patternViewerEditMode) {
    const titleEditWrap = document.createElement('div');
    titleEditWrap.className = 'step-title-edit-row';
    titleEditWrap.dataset.stepIndex = String(stepIndex);

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-input step-title-edit-input';
    titleInput.value = getCleanStepTitle(step.stepTitle);
    titleInput.placeholder = 'Step title';
    titleInput.dataset.stepIndex = String(stepIndex);
    titleInput.addEventListener('input', function() {
      applyPatternViewerStepTitleDraft(stepIndex, titleInput.value);
    });

    const deleteStepBtn = document.createElement('button');
    deleteStepBtn.type = 'button';
    deleteStepBtn.className = 'btn btn-danger btn-sm';
    deleteStepBtn.textContent = 'Delete Step';
    deleteStepBtn.addEventListener('click', function() {
      handleDeletePatternStep(stepIndex);
    });

    titleEditWrap.appendChild(titleInput);
    titleEditWrap.appendChild(deleteStepBtn);
    container.appendChild(titleEditWrap);
  }

  const searchPatternWrap = document.createElement('div');
  searchPatternWrap.className = 'step-search-pattern-content';
  renderSearchPatternContent(searchPatternWrap, sections.searchPattern || [], Boolean(step.isRedStep), stepIndex);
  container.appendChild(searchPatternWrap);
}

function areRichContentValuesEqual(left, right) {
  return JSON.stringify(normaliseRichContent(left || [])) === JSON.stringify(normaliseRichContent(right || []));
}

function applyPatternViewerStepTitleDraft(stepIndex, nextTitleRaw) {
  if (!_patternViewerEditMode) return false;
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  if (!pattern || !steps[safeStepIndex]) return false;

  const nextTitle = getCleanStepTitle(nextTitleRaw);
  if (!nextTitle) return false;

  const currentTitle = String((steps[safeStepIndex] && steps[safeStepIndex].stepTitle) || '').trim();
  if (currentTitle === nextTitle) return false;

  steps[safeStepIndex].stepTitle = nextTitle;
  markPatternEditDraftDirty(pattern);
  return true;
}

function applyPatternViewerInlineDraft(options) {
  if (!_patternViewerEditMode) return false;
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(options && options.stepIndex) ? options.stepIndex : currentStepIndex;
  const sectionKey = String((options && options.sectionKey) || '').trim();
  if (!pattern || !steps[safeStepIndex] || !sectionKey) return false;

  const step = steps[safeStepIndex];
  step.sections = normaliseStepSectionsSafe(step.sections, step.richContent || step.rich_content || []);

  let changed = false;
  const nextRichContent = normaliseRichContent((options && options.content) || []);
  const nextIsMarkedRed = Boolean(options && options.isMarkedRed);

  function detachWholeStepLink() {
    if (String(step.linkedStepId || '').trim()) {
      step.linkedStepId = '';
      changed = true;
    }
    if (step.linkMeta) {
      step.linkMeta = null;
      changed = true;
    }
  }

  if (sectionKey === 'searchPattern') {
    detachWholeStepLink();
    if (step.sectionLinks && step.sectionLinks.searchPattern) {
      delete step.sectionLinks.searchPattern;
      changed = true;
    }

    const currentSearchPattern = normaliseRichContent(step.sections.searchPattern || []);
    if (!areRichContentValuesEqual(currentSearchPattern, nextRichContent)) {
      step.sections.searchPattern = nextRichContent;
      step.richContent = normaliseRichContent(nextRichContent);
      changed = true;
    }

    if (Boolean(step.isRedStep) !== nextIsMarkedRed) {
      step.isRedStep = nextIsMarkedRed;
      changed = true;
    }
  } else if (sectionKey === 'dontMissPathology') {
    const safeFindingId = String((options && options.findingId) || '').trim();
    if (!safeFindingId) return false;

    detachWholeStepLink();
    const findings = typeof ensureSubsectionMetadata === 'function'
      ? ensureSubsectionMetadata(step.sections.dontMissPathology || [])
      : normaliseRichContent(step.sections.dontMissPathology || []);
    step.sections.dontMissPathology = findings;

    const finding = typeof findStepSubsectionById === 'function'
      ? findStepSubsectionById(step, safeFindingId)
      : null;
    if (!finding) return false;

    const nextTitle = String((options && options.title) || '').trim();
    if (nextTitle && String(finding.title || '').trim() !== nextTitle) {
      finding.title = nextTitle;
      changed = true;
    }

    if (Boolean(finding.isRedFinding) !== nextIsMarkedRed) {
      finding.isRedFinding = nextIsMarkedRed;
      changed = true;
    }

    if (!areRichContentValuesEqual(finding.content || [], nextRichContent)) {
      finding.content = nextRichContent;
      changed = true;
    }

    if (finding.linkMeta) {
      finding.linkMeta = null;
      changed = true;
    }
  }

  if (changed) {
    markPatternEditDraftDirty(pattern);
  }
  return changed;
}

async function savePatternStepTitle(stepIndex, nextTitleRaw) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  if (!pattern || !_pUid || !steps[safeStepIndex]) return;

  const nextTitle = getCleanStepTitle(nextTitleRaw);
  if (!nextTitle) {
    showToast('Step title is required.', true);
    return;
  }

  const currentTitle = String((steps[safeStepIndex] && steps[safeStepIndex].stepTitle) || '').trim();
  if (currentTitle === nextTitle) {
    return;
  }
  if (_stepTitleSaveInFlight[String(safeStepIndex)]) {
    return;
  }

  _stepTitleSaveInFlight[String(safeStepIndex)] = true;

  const nextSteps = JSON.parse(JSON.stringify(steps));
  nextSteps[safeStepIndex].stepTitle = nextTitle;
  pattern.steps = nextSteps;
  if (safeStepIndex === currentStepIndex) {
    document.getElementById('step-title').textContent = nextTitle;
  }
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    _stepTitleSaveInFlight[String(safeStepIndex)] = false;
    showToast('Step title saved locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    if (_patternViewerEditMode) {
      _openStepIndices.add(safeStepIndex);
      currentStepIndex = safeStepIndex;
    }
    renderCurrentStep(pattern);
    queuePatternStepReloadFromFirestore(pattern.id, safeStepIndex, nextSteps[safeStepIndex], 0);
    showToast('Step title updated.');
  } catch (err) {
    console.error(err);
    const rollbackSteps = JSON.parse(JSON.stringify(nextSteps));
    rollbackSteps[safeStepIndex].stepTitle = currentTitle;
    pattern.steps = rollbackSteps;
    if (safeStepIndex === currentStepIndex) {
      document.getElementById('step-title').textContent = currentTitle;
    }
    renderCurrentStep(pattern);
    showToast('Failed to update step title.', true);
  } finally {
    _stepTitleSaveInFlight[String(safeStepIndex)] = false;
  }
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

function ensurePatternEditDraft(pattern) {
  var safePattern = pattern || getSelectedPattern();
  if (!safePattern) return null;
  var safePatternId = String(safePattern.id || '').trim();
  if (!safePatternId) return null;
  if (_patternEditDraft && _patternEditDraft.patternId === safePatternId) {
    return _patternEditDraft;
  }
  _patternEditDraft = {
    patternId: safePatternId,
    dirty: false
  };
  return _patternEditDraft;
}

function markPatternEditDraftDirty(pattern) {
  var draft = ensurePatternEditDraft(pattern);
  if (!draft) return;
  draft.dirty = true;
}

function clearPatternEditDraft() {
  _patternEditDraft = null;
}

function hasDirtyPatternEditDraft(patternId) {
  var safePatternId = String(patternId || '').trim();
  if (!_patternEditDraft || !_patternEditDraft.dirty) return false;
  if (!safePatternId) return true;
  return _patternEditDraft.patternId === safePatternId;
}

function isFirestorePermissionDeniedError(err) {
  if (!err) return false;
  if (String(err.code || '') === 'permission-denied') return true;
  var msg = String(err.message || err || '').toLowerCase();
  return msg.indexOf('insufficient privileges') >= 0 || msg.indexOf('permission denied') >= 0;
}

function withSyncTimeout(promise, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      reject(new Error('sync-timeout'));
    }, Math.max(1000, Number(timeoutMs) || 15000));

    Promise.resolve(promise).then(function(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function commitPatternEditDraftIfNeeded() {
  var pattern = getSelectedPattern();
  if (!pattern || !_pUid) return Promise.resolve();
  if (_patternEditCommitInFlight) return Promise.resolve();

  var patternId = String(pattern.id || '').trim();
  if (!patternId || !hasDirtyPatternEditDraft(patternId)) {
    return Promise.resolve();
  }

  _patternEditCommitInFlight = true;
  updateSidebarButtons(Boolean(selectedPatternId));

  return withSyncTimeout(updatePattern(_pUid, pattern.id, {
    name: pattern.name,
    modality: pattern.modality || 'Other',
    goalSeconds: pattern.goalSeconds,
    reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
    steps: pattern.steps || []
  }), 15000).then(function() {
    if (_patternEditDraft && _patternEditDraft.patternId === patternId) {
      _patternEditDraft.dirty = false;
    }
    queuePatternReloadFromFirestore(pattern.id, currentStepIndex, Array.isArray(pattern.steps) ? pattern.steps.length : null, 0);
    showToast('Saved edits to Firebase.');
  }).catch(function(err) {
    console.error(err);
    if (String(err && err.code || '') === 'resource-exhausted') {
      var waitMs = Number(err && err.retryAfterMs);
      var waitText = Number.isFinite(waitMs) && waitMs > 0 ? (' Retry in ' + Math.ceil(waitMs / 1000) + 's.') : '';
      showToast('Saved locally, but Firebase write queue is overloaded.' + waitText, true);
      return;
    }
    if (isFirestorePermissionDeniedError(err)) {
      showToast('Saved locally, but Firebase denied sync. Confirm Firestore permissions and signed-in account.', true);
      return;
    }
    if (String(err && err.message || '') === 'sync-timeout') {
      showToast('Saved locally. Firebase sync is taking too long (offline/network issue). Click Done Editing to retry.', true);
      return;
    }
    showToast('Saved locally, but failed to sync to Firebase. Click Done Editing again to retry.', true);
  }).finally(function() {
    _patternEditCommitInFlight = false;
    updateSidebarButtons(Boolean(selectedPatternId));
  });
}

function getStepSyncSignature(step) {
  try {
    return JSON.stringify(normaliseStepForViewer(step || {}));
  } catch (err) {
    console.warn('Failed to build step sync signature:', err);
    return '';
  }
}

function collectFindingIdsFromStepsForSync(steps) {
  var seen = {};
  var ids = [];

  (steps || []).forEach(function(step) {
    var sections = normaliseStepSectionsSafe(step && step.sections, step && (step.richContent || step.rich_content) || []);
    var findings = sections && Array.isArray(sections.dontMissPathology) ? sections.dontMissPathology : [];

    findings.forEach(function(item) {
      if (!item || item.type !== 'subsection') return;
      var findingId = String(item.findingId || '').trim();
      if (!findingId || seen[findingId]) return;
      seen[findingId] = 1;
      ids.push(findingId);
    });
  });

  return ids;
}

function loadFindingsMapForSync(uid, findingIds) {
  var safeUid = String(uid || '').trim();
  var uniqueIds = (findingIds || []).filter(function(id, index, list) {
    return id && list.indexOf(id) === index;
  });

  if (!safeUid || !uniqueIds.length) return Promise.resolve({});

  var refs = uniqueIds.map(function(id) {
    return _findingsRef(safeUid).doc(id);
  });

  function toMap(entries) {
    var out = {};
    (entries || []).forEach(function(entry) {
      if (!entry || !entry.exists || !entry.id || !entry.data) return;
      out[entry.id] = {
        id: entry.id,
        name: String((entry.data && entry.data.name) || '').trim(),
        isRedFinding: Boolean(entry.data && entry.data.isRedFinding),
        content: normaliseRichContent((entry.data && entry.data.content) || [])
      };
    });
    return out;
  }

  if (typeof appDb.getAll === 'function') {
    return appDb.getAll.apply(appDb, refs).then(function() {
      var snapshots = Array.prototype.slice.call(arguments);
      return snapshots.map(function(doc, index) {
        return {
          id: uniqueIds[index],
          exists: Boolean(doc && doc.exists),
          data: doc && doc.exists ? (doc.data() || {}) : null
        };
      });
    }).then(toMap);
  }

  return Promise.all(refs.map(function(ref, index) {
    return ref.get({ source: 'server' }).then(function(doc) {
      return {
        id: uniqueIds[index],
        exists: Boolean(doc && doc.exists),
        data: doc && doc.exists ? (doc.data() || {}) : null
      };
    });
  })).then(toMap);
}

function hydrateServerStepsWithFindings(steps, findingsById) {
  return (steps || []).map(function(step) {
    var nextStep = Object.assign({}, step);
    var sections = normaliseStepSectionsSafe(step && step.sections, step && (step.richContent || step.rich_content) || []);
    var findings = Array.isArray(sections.dontMissPathology) ? sections.dontMissPathology : [];

    sections.dontMissPathology = findings.map(function(item) {
      if (!item || item.type !== 'subsection') return item;
      var findingId = String(item.findingId || '').trim();
      var finding = findingId ? findingsById[findingId] : null;
      if (!finding) return item;
      return Object.assign({}, item, {
        title: finding.name || item.title,
        isRedFinding: Boolean(finding.isRedFinding),
        content: normaliseRichContent(finding.content || [])
      });
    });

    nextStep.sections = sections;
    nextStep.richContent = normaliseRichContent((sections && sections.searchPattern) || nextStep.richContent || nextStep.rich_content || []);
    return nextStep;
  });
}

function loadHydratedPatternStepsFromServer(patternId) {
  var safePatternId = String(patternId || '').trim();
  if (!safePatternId || !_pUid || !appDb) return Promise.resolve(null);

  return _patternsRef(_pUid).doc(safePatternId).get({ source: 'server' }).then(function(snapshot) {
    if (!snapshot || !snapshot.exists) return null;

    var serverPattern = _normalisePatternDoc(snapshot.data() || {});
    var serverSteps = Array.isArray(serverPattern.steps) ? serverPattern.steps : [];
    var findingIds = collectFindingIdsFromStepsForSync(serverSteps);

    if (!findingIds.length) return serverSteps;

    return loadFindingsMapForSync(_pUid, findingIds).then(function(findingsById) {
      return hydrateServerStepsWithFindings(serverSteps, findingsById || {});
    });
  });
}

function queuePatternStepReloadFromFirestore(patternId, stepIndex, expectedStep, attempt) {
  var safePatternId = String(patternId || '').trim();
  var safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : -1;
  if (!safePatternId || safeStepIndex < 0 || !_pUid || !appDb) return;

  var maxAttempts = 8;
  var tryIndex = Number.isInteger(attempt) ? attempt : 0;
  var expectedSignature = getStepSyncSignature(expectedStep);

  loadHydratedPatternStepsFromServer(safePatternId).then(function(serverSteps) {
    serverSteps = Array.isArray(serverSteps) ? serverSteps : [];
    if (!serverSteps[safeStepIndex]) return;

    var serverSignature = getStepSyncSignature(serverSteps[safeStepIndex]);
    if (expectedSignature && serverSignature !== expectedSignature) {
      if (tryIndex >= maxAttempts - 1) return;
      setTimeout(function() {
        queuePatternStepReloadFromFirestore(safePatternId, safeStepIndex, expectedStep, tryIndex + 1);
      }, Math.min(250 * (tryIndex + 1), 1500));
      return;
    }

    var selected = getSelectedPattern();
    if (!selected || String(selected.id || '') !== safePatternId) return;

    selected.steps = serverSteps;
    if (_patternViewerEditMode) {
      _openStepIndices.add(safeStepIndex);
    }
    renderCurrentStep(selected);
  }).catch(function(err) {
    if (tryIndex >= maxAttempts - 1) {
      console.warn('Unable to reload step from Firestore server:', err);
      return;
    }
    setTimeout(function() {
      queuePatternStepReloadFromFirestore(safePatternId, safeStepIndex, expectedStep, tryIndex + 1);
    }, Math.min(250 * (tryIndex + 1), 1500));
  });
}

function queuePatternReloadFromFirestore(patternId, preferredStepIndex, expectedStepsLength, attempt) {
  var safePatternId = String(patternId || '').trim();
  if (!safePatternId || !_pUid || !appDb) return;

  var maxAttempts = 8;
  var tryIndex = Number.isInteger(attempt) ? attempt : 0;
  var expectedLength = Number.isInteger(expectedStepsLength) ? expectedStepsLength : null;

  loadHydratedPatternStepsFromServer(safePatternId).then(function(serverSteps) {
    serverSteps = Array.isArray(serverSteps) ? serverSteps : [];
    if (expectedLength !== null && serverSteps.length !== expectedLength) {
      if (tryIndex >= maxAttempts - 1) return;
      setTimeout(function() {
        queuePatternReloadFromFirestore(safePatternId, preferredStepIndex, expectedLength, tryIndex + 1);
      }, Math.min(250 * (tryIndex + 1), 1500));
      return;
    }

    var selected = getSelectedPattern();
    if (!selected || String(selected.id || '') !== safePatternId) return;

    selected.steps = serverSteps;

    if (serverSteps.length) {
      if (Number.isInteger(preferredStepIndex)) {
        currentStepIndex = Math.max(0, Math.min(preferredStepIndex, serverSteps.length - 1));
      } else {
        currentStepIndex = Math.max(0, Math.min(currentStepIndex, serverSteps.length - 1));
      }
      if (_patternViewerEditMode) {
        _openStepIndices.add(currentStepIndex);
      }
    } else {
      currentStepIndex = 0;
      _openStepIndices = new Set();
    }

    renderCurrentStep(selected);
  }).catch(function(err) {
    if (tryIndex >= maxAttempts - 1) {
      console.warn('Unable to reload pattern from Firestore server:', err);
      return;
    }
    setTimeout(function() {
      queuePatternReloadFromFirestore(safePatternId, preferredStepIndex, expectedLength, tryIndex + 1);
    }, Math.min(250 * (tryIndex + 1), 1500));
  });
}

function normaliseSubsectionEntries(content) {
  const chunks = normaliseRichContent(content);
  const entries = [];

  chunks.forEach((chunk, idx) => {
    if (chunk.type === 'subsection') {
      entries.push({
        title: (chunk.title || '').trim() || `Subsection ${entries.length + 1}`,
        isRedFinding: Boolean(chunk.isRedFinding),
        subsectionId: String(chunk.subsectionId || '').trim(),
        linkMeta: normaliseSectionLinkForViewer(chunk.linkMeta || null),
        content: normaliseRichContent(chunk.content || [])
      });
      return;
    }
    if (chunk.type === 'text' && (chunk.text || '').trim()) {
      entries.push({
        title: `Subsection ${entries.length + 1}`,
        isRedFinding: false,
        subsectionId: '',
        linkMeta: null,
        content: [{ type: 'text', text: chunk.text, bold: Boolean(chunk.bold), color: chunk.color || null }]
      });
      return;
    }
    if (chunk.type === 'image' || chunk.type === 'link') {
      entries.push({
        title: `Subsection ${entries.length + 1}`,
        isRedFinding: false,
        subsectionId: '',
        linkMeta: null,
        content: [chunk]
      });
      return;
    }
    if (idx === chunks.length - 1 && !entries.length) {
      entries.push({
        title: 'Subsection 1',
        isRedFinding: false,
        subsectionId: '',
        linkMeta: null,
        content: []
      });
    }
  });

  return sortSubsectionEntries(entries);
}

function sortSubsectionEntries(entries) {
  return entries.slice().sort((left, right) => {
    const leftTitle = String((left && left.title) || '').trim();
    const rightTitle = String((right && right.title) || '').trim();

    if (!leftTitle && !rightTitle) return 0;
    if (!leftTitle) return 1;
    if (!rightTitle) return -1;

    return leftTitle.localeCompare(rightTitle, undefined, {
      sensitivity: 'base',
      numeric: true
    });
  });
}

function getInlineEditKey(sectionKey, findingId) {
  return `${sectionKey || ''}::${String(findingId || '').trim()}`;
}

function isInlineEditActive(sectionKey, findingId) {
  if (!_activeInlineEdit) return false;
  if (_activeInlineEdit.stepIndex !== currentStepIndex) return false;
  return _activeInlineEdit.key === getInlineEditKey(sectionKey, findingId);
}

function getFindingPanelKey(findingId, stepIndexOverride) {
  var safeFindingId = String(findingId || '').trim();
  if (!safeFindingId) return '';
  var safePatternId = String(selectedPatternId || '').trim();
  var safeStepIndex = typeof stepIndexOverride === 'number' ? stepIndexOverride : currentStepIndex;
  if (!safePatternId || safeStepIndex < 0) return '';
  return [safePatternId, safeStepIndex, safeFindingId].join('::');
}

function setFindingPanelOpen(findingId, isOpen, stepIndexOverride) {
  var key = getFindingPanelKey(findingId, stepIndexOverride);
  if (!key) return;
  if (isOpen) {
    _openFindingPanels.add(key);
  } else {
    _openFindingPanels.delete(key);
  }
}

function isFindingPanelOpen(findingId, stepIndexOverride) {
  var key = getFindingPanelKey(findingId, stepIndexOverride);
  return key ? _openFindingPanels.has(key) : false;
}

function startInlineEdit(sectionKey, findingId, title, content, isMarkedRed) {
  if (sectionKey === 'dontMissPathology') {
    setFindingPanelOpen(findingId, true);
  }
  _activeInlineEdit = {
    key: getInlineEditKey(sectionKey, findingId),
    stepIndex: currentStepIndex,
    sectionKey: sectionKey,
    findingId: String(findingId || '').trim(),
    title: String(title || ''),
    content: normaliseRichContent(content || []),
    isMarkedRed: Boolean(isMarkedRed)
  };
  _inlineEditSaving = false;

  const pattern = getSelectedPattern();
  if (pattern) renderCurrentStep(pattern);
}

function cancelInlineEdit() {
  _activeInlineEdit = null;
  _inlineEditSaving = false;

  const pattern = getSelectedPattern();
  if (pattern) renderCurrentStep(pattern);
}

async function saveInlineEdit(sectionKey, findingId, nextTitle, nextContent, nextIsMarkedRed) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!pattern || !_pUid || !steps[currentStepIndex]) return;

  if (sectionKey === 'dontMissPathology' && !String(nextTitle || '').trim()) {
    showToast('Finding title is required.', true);
    return;
  }

  _inlineEditSaving = true;
  renderCurrentStep(pattern);

  const nextSteps = JSON.parse(JSON.stringify(steps));
  const nextStep = nextSteps[currentStepIndex] || {};
  nextStep.sections = normaliseStepSectionsSafe(nextStep.sections, nextStep.richContent || nextStep.rich_content || []);
  let detachedLiveLink = false;

  function detachWholeStepLink() {
    if (String(nextStep.linkedStepId || '').trim()) {
      nextStep.linkedStepId = '';
      detachedLiveLink = true;
    }
    if (nextStep.linkMeta) {
      nextStep.linkMeta = null;
      detachedLiveLink = true;
    }
  }

  const nextRichContent = Array.isArray(nextContent)
    ? normaliseRichContent(nextContent)
    : (typeof plainTextToRichContent === 'function'
        ? plainTextToRichContent(nextContent)
        : [{ type: 'text', text: String(nextContent || ''), bold: false, color: null }]);

  if (sectionKey === 'searchPattern') {
    detachWholeStepLink();
    if (nextStep.sectionLinks && nextStep.sectionLinks.searchPattern) {
      delete nextStep.sectionLinks.searchPattern;
      detachedLiveLink = true;
    }
    nextStep.sections.searchPattern = nextRichContent;
    nextStep.richContent = normaliseRichContent(nextStep.sections.searchPattern || []);
    nextStep.isRedStep = Boolean(nextIsMarkedRed);
  } else {
    detachWholeStepLink();
    const findings = typeof ensureSubsectionMetadata === 'function'
      ? ensureSubsectionMetadata(nextStep.sections.dontMissPathology || [])
      : normaliseRichContent(nextStep.sections.dontMissPathology || []);
    nextStep.sections.dontMissPathology = findings;

    const finding = typeof findStepSubsectionById === 'function'
      ? findStepSubsectionById(nextStep, findingId)
      : null;
    if (!finding) {
      _inlineEditSaving = false;
      renderCurrentStep(pattern);
      showToast('Finding could not be found.', true);
      return;
    }

    finding.title = String(nextTitle || '').trim();
    finding.isRedFinding = Boolean(nextIsMarkedRed);
    finding.content = nextRichContent;
    if (finding.linkMeta) {
      finding.linkMeta = null;
      detachedLiveLink = true;
    }
  }

  nextSteps[currentStepIndex] = nextStep;

  if (_patternViewerEditMode) {
    pattern.steps = nextSteps;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
    _openStepIndices.add(currentStepIndex);
    renderCurrentStep(pattern);
    markPatternEditDraftDirty(pattern);
    if (detachedLiveLink) {
      showToast((sectionKey === 'searchPattern' ? 'Search pattern' : 'Finding') + ' saved locally. Live link detached; sync runs on Done Editing.');
    } else {
      showToast((sectionKey === 'searchPattern' ? 'Search pattern' : 'Finding') + ' saved locally. Sync runs on Done Editing.');
    }
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    pattern.steps = nextSteps;
    if (sectionKey === 'dontMissPathology' && !_patternViewerEditMode) {
      setFindingPanelOpen(findingId, true);
    }
    if (_patternViewerEditMode) {
      _openStepIndices.add(currentStepIndex);
    }
    _activeInlineEdit = null;
    _inlineEditSaving = false;
    renderCurrentStep(pattern);
    queuePatternStepReloadFromFirestore(pattern.id, currentStepIndex, nextSteps[currentStepIndex], 0);
    if (detachedLiveLink) {
      showToast((sectionKey === 'searchPattern' ? 'Search pattern' : 'Finding') + ' updated. Live link detached so your edits persist.');
    } else {
      showToast(sectionKey === 'searchPattern' ? 'Search pattern updated.' : 'Finding updated.');
    }
  } catch (err) {
    console.error(err);
    _inlineEditSaving = false;
    renderCurrentStep(pattern);
    showToast('Failed to save changes.', true);
  }
}

function renderInlineEditForm(container, options) {
  const wrap = document.createElement('div');
  wrap.className = 'step-inline-edit';
  wrap.dataset.stepIndex = String(Number.isInteger(options && options.stepIndex) ? options.stepIndex : currentStepIndex);
  wrap.dataset.sectionKey = String((options && options.sectionKey) || '');
  wrap.dataset.findingId = String((options && options.findingId) || '');
  const supportsRichInlineEdit = typeof populateRichEditor === 'function'
    && typeof extractRichContent === 'function'
    && typeof bindRichEditorToolbar === 'function';

  let titleInput = null;
  if (options.includeTitle) {
    titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-input step-inline-edit-title';
    titleInput.value = options.title || '';
    titleInput.placeholder = 'Finding title';
    wrap.appendChild(titleInput);
  }

  let redCheckbox = null;
  if (options.redToggleLabel) {
    const redToggle = document.createElement('label');
    redToggle.className = options.includeTitle ? 'subsection-red-row' : 'step-red-checkbox-row';
    redCheckbox = document.createElement('input');
    redCheckbox.type = 'checkbox';
    redCheckbox.className = 'step-inline-red-toggle';
    redCheckbox.checked = Boolean(options.isMarkedRed);
    const redLabel = document.createElement('span');
    redLabel.textContent = options.redToggleLabel;
    redToggle.appendChild(redCheckbox);
    redToggle.appendChild(redLabel);
    wrap.appendChild(redToggle);
  }

  let textarea = null;
  let richEditor = null;

  if (supportsRichInlineEdit) {
    const toolbar = document.createElement('div');
    toolbar.className = 'rich-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', options.includeTitle ? 'Finding text formatting' : 'Search pattern text formatting');
    toolbar.innerHTML = [
      '<button type="button" class="rich-tool" data-rich-action="bold" title="Bold (Ctrl+B)"><b>B</b></button>',
      '<button type="button" class="rich-tool rich-tool-red" data-rich-color="red" title="Red text">A</button>',
      '<button type="button" class="rich-tool rich-tool-green" data-rich-color="green" title="Green text">A</button>',
      '<button type="button" class="rich-tool rich-tool-blue" data-rich-color="blue" title="Blue text">A</button>',
      '<button type="button" class="rich-tool rich-tool-white" data-rich-color="white" title="White text">A</button>',
      '<button type="button" class="rich-tool" data-rich-list="unordered" title="Bulleted list">• List</button>',
      '<button type="button" class="rich-tool" data-rich-list="ordered" title="Numbered list">1. List</button>',
      '<button type="button" class="rich-tool rich-tool-font-size" data-rich-font-size="sm" title="Small font">A-</button>',
      '<button type="button" class="rich-tool rich-tool-font-size" data-rich-font-size="md" title="Normal font">A</button>',
      '<button type="button" class="rich-tool rich-tool-font-size" data-rich-font-size="lg" title="Large font">A+</button>',
      '<button type="button" class="rich-tool" data-rich-action="link" title="Add hyperlink">&#128279; Link</button>',
      '<button type="button" class="rich-tool" data-rich-action="clear" title="Clear formatting">&#x2715; Format</button>',
      '<button type="button" class="rich-tool" data-rich-action="image" title="Paste image from clipboard">&#128247; Image</button>'
    ].join('');
    wrap.appendChild(toolbar);

    richEditor = document.createElement('div');
    richEditor.className = 'rich-editor step-inline-rich-editor';
    richEditor.contentEditable = 'true';
    richEditor.setAttribute('spellcheck', 'true');
    richEditor.setAttribute('aria-label', options.includeTitle ? 'Finding content editor' : 'Search pattern content editor');
    populateRichEditor(richEditor, options.content || []);
    bindRichEditorToolbar(toolbar, richEditor);
    bindInlineRichFontSizeControls(toolbar, richEditor);
    if (typeof attachRichEditorFocusHandlers === 'function') {
      attachRichEditorFocusHandlers(richEditor);
    }
    if (typeof handleRichEditorKeydown === 'function') {
      richEditor.addEventListener('keydown', handleRichEditorKeydown);
    }
    if (typeof handleEditorPaste === 'function') {
      richEditor.addEventListener('paste', handleEditorPaste);
    }
    wrap.appendChild(richEditor);
  } else {
    textarea = document.createElement('textarea');
    textarea.className = 'form-input step-inline-edit-content';
    textarea.rows = options.includeTitle ? 5 : 8;
    textarea.value = typeof richContentToPlainText === 'function'
      ? richContentToPlainText(options.content || [])
      : '';
    textarea.placeholder = options.includeTitle ? 'Finding content' : 'Search pattern content';
    wrap.appendChild(textarea);
  }

  let syncQueued = false;
  function queueLocalDraftSync() {
    if (!_patternViewerEditMode) return;
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(function() {
      syncQueued = false;
      const contentValue = richEditor && typeof extractRichContent === 'function'
        ? extractRichContent(richEditor)
        : (textarea ? textarea.value : '');
      applyPatternViewerInlineDraft({
        stepIndex: Number.isInteger(options && options.stepIndex) ? options.stepIndex : currentStepIndex,
        sectionKey: options.sectionKey,
        findingId: options.findingId,
        title: titleInput ? titleInput.value : '',
        content: contentValue,
        isMarkedRed: redCheckbox ? redCheckbox.checked : false
      });
    });
  }

  if (titleInput) {
    titleInput.addEventListener('input', queueLocalDraftSync);
  }
  if (redCheckbox) {
    redCheckbox.addEventListener('change', queueLocalDraftSync);
  }
  if (richEditor) {
    richEditor.addEventListener('input', queueLocalDraftSync);
  }
  if (textarea) {
    textarea.addEventListener('input', queueLocalDraftSync);
  }

  container.appendChild(wrap);

  if (richEditor) {
    if (typeof setActiveRichEditor === 'function') {
      setActiveRichEditor(richEditor);
    }
    richEditor.focus();
  } else if (textarea) {
    textarea.focus();
  }
}

function renderNestedSubsections(container, content, stepIndex) {
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  const entries = normaliseSubsectionEntries(content).filter(entry => {
    return (entry.title || '').trim() || (entry.content || []).length;
  });
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = 'No subsections yet.';
    container.appendChild(empty);
    return;
  }

  entries.forEach((entry, idx) => {
    const wrap = document.createElement('section');
    wrap.className = 'step-subsection';
    if (entry.isRedFinding) wrap.classList.add('step-subsection-red');
    const isExpanded = isFindingPanelOpen(entry.subsectionId || '', safeStepIndex);
    const isEditing = _patternViewerEditMode && isExpanded;

    const header = document.createElement('div');
    header.className = 'step-subsection-header';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-subsection-toggle';
    btn.setAttribute('aria-expanded', String(isExpanded));
    btn.innerHTML = `
      <span>${entry.title || `Subsection ${idx + 1}`}</span>
      <span class="step-subsection-chevron" aria-hidden="true">${isExpanded ? '▾' : '▸'}</span>
    `;

    const panel = document.createElement('div');
    panel.className = 'step-subsection-panel';
    panel.style.display = isExpanded ? '' : 'none';

    const panelInner = document.createElement('div');
    panelInner.className = 'step-subsection-content';
    if (isEditing) {
      renderInlineEditForm(panelInner, {
        stepIndex: safeStepIndex,
        sectionKey: 'dontMissPathology',
        findingId: entry.subsectionId || '',
        includeTitle: true,
        title: entry.title || '',
        content: entry.content || [],
        isMarkedRed: Boolean(entry.isRedFinding),
        redToggleLabel: 'Show this finding in red in main display'
      });
    } else if ((entry.content || []).length) {
      renderRichContent(panelInner, entry.content);
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      panelInner.appendChild(empty);
    }

    if (_patternViewerEditMode && entry.subsectionId) {
      const actions = document.createElement('div');
      actions.className = 'step-subsection-danger-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.textContent = 'Remove from This Step';
      deleteBtn.title = 'Remove this finding from the current search pattern step';
      deleteBtn.addEventListener('click', function() {
        handleDeletePatternFinding(safeStepIndex, entry.subsectionId, entry.title || 'Finding');
      });

      actions.appendChild(deleteBtn);
      panelInner.appendChild(actions);
    }

    panel.appendChild(panelInner);

    btn.addEventListener('click', () => {
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      const nextOpen = !isOpen;
      setFindingPanelOpen(entry.subsectionId || '', nextOpen, safeStepIndex);
      btn.setAttribute('aria-expanded', String(nextOpen));
      panel.style.display = nextOpen ? '' : 'none';
      const chevron = btn.querySelector('.step-subsection-chevron');
      if (chevron) chevron.textContent = nextOpen ? '▾' : '▸';

      if (_patternViewerEditMode && nextOpen) {
        // Re-render so the opened finding switches into direct edit mode.
        const pattern = getSelectedPattern();
        if (pattern) renderCurrentStep(pattern);
      }
    });

    header.appendChild(btn);
    wrap.appendChild(header);
    wrap.appendChild(panel);
    container.appendChild(wrap);
  });
}

async function handleDeletePatternFinding(stepIndex, findingId, findingTitle) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  const safeFindingId = String(findingId || '').trim();
  if (!pattern || !_pUid || !_patternViewerEditMode || !steps[safeStepIndex] || !safeFindingId) return;

  if (_activeInlineEdit) {
    const discardOk = await showConfirm(
      'Discard Unsaved Edits?',
      'Removing a finding now will discard the current inline edits. Continue?'
    );
    if (!discardOk) return;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }

  const title = String(findingTitle || '').trim() || 'this finding';
  const confirmed = await showConfirm(
    'Remove Finding from Step?',
    'Remove "' + title + '" from this search pattern step? This does not delete it from the Findings tab.'
  );
  if (!confirmed) return;

  const previousSteps = JSON.parse(JSON.stringify(steps));
  const previousInlineEdit = _activeInlineEdit;
  const previousInlineEditSaving = _inlineEditSaving;
  const previousPanelOpen = isFindingPanelOpen(safeFindingId, safeStepIndex);

  const nextSteps = JSON.parse(JSON.stringify(steps));
  const nextStep = nextSteps[safeStepIndex] || {};
  nextStep.sections = normaliseStepSectionsSafe(nextStep.sections, nextStep.richContent || nextStep.rich_content || []);

  const findings = typeof ensureSubsectionMetadata === 'function'
    ? ensureSubsectionMetadata(nextStep.sections.dontMissPathology || [])
    : normaliseRichContent(nextStep.sections.dontMissPathology || []);

  const findingIndex = findings.findIndex(function(item) {
    return item
      && item.type === 'subsection'
      && String(item.subsectionId || '').trim() === safeFindingId;
  });

  if (findingIndex < 0) {
    showToast('Finding could not be found.', true);
    return;
  }

  findings.splice(findingIndex, 1);
  nextStep.sections.dontMissPathology = findings;
  nextStep.richContent = normaliseRichContent(nextStep.sections.searchPattern || []);
  nextSteps[safeStepIndex] = nextStep;

  pattern.steps = nextSteps;
  setFindingPanelOpen(safeFindingId, false, safeStepIndex);
  _activeInlineEdit = null;
  _inlineEditSaving = false;
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Finding removed locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternStepReloadFromFirestore(pattern.id, safeStepIndex, nextSteps[safeStepIndex], 0);
    showToast('Finding removed from this step.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    _activeInlineEdit = previousInlineEdit;
    _inlineEditSaving = previousInlineEditSaving;
    setFindingPanelOpen(safeFindingId, previousPanelOpen, safeStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to delete finding.', true);
  }
}

function renderRichContent(container, richContent) {
  const chunks = normaliseRichContent(richContent);
  if (!chunks.length) return;

  if (typeof populateRichEditor === 'function') {
    container.innerHTML = '';
    const viewer = document.createElement('div');
    viewer.className = 'rich-editor rich-editor-readonly';
    viewer.contentEditable = 'false';
    viewer.setAttribute('aria-readonly', 'true');

    populateRichEditor(viewer, chunks);

    Array.from(viewer.querySelectorAll('a')).forEach(anchor => {
      anchor.classList.add('step-link');
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    });

    Array.from(viewer.querySelectorAll('img')).forEach(img => {
      img.alt = 'Step image';
      img.addEventListener('click', () => openLightbox(img.src));
    });

    container.appendChild(viewer);
    return;
  }

  container.textContent = richContentToPlainText(chunks);
}

function renderSearchPatternContent(container, richContent, isRedStep, stepIndex) {
  if (!_patternViewerEditMode) {
    const chunks = normaliseRichContent(richContent);
    if (chunks.length) {
      renderRichContent(container, chunks);
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      container.appendChild(empty);
    }
    return;
  }

  const layout = document.createElement('div');
  layout.className = 'step-section-inline-layout';

  const body = document.createElement('div');
  body.className = 'step-section-inline-body';

  renderInlineEditForm(body, {
    stepIndex: Number.isInteger(stepIndex) ? stepIndex : currentStepIndex,
    sectionKey: 'searchPattern',
    findingId: '',
    includeTitle: false,
    title: '',
    content: richContent || [],
    isMarkedRed: Boolean(isRedStep),
    redToggleLabel: 'Change color of this step to red in main search pattern display'
  });

  layout.appendChild(body);
  container.appendChild(layout);
}

function clearStepView() {
  document.getElementById('step-empty').style.display = '';
  document.getElementById('step-empty').querySelector('p').textContent = 'Select a pattern to begin.';
  document.getElementById('step-header').style.display = 'none';
  document.getElementById('step-content').style.display = 'none';
  _openStepIndices = new Set();
  updateExpandAllButton(0);
  setPatternViewerEditMode(false, false);
  renderCurrentStepFindings(null, null, -1, 0);
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = 'none';
  stopTimer();
  timerGoalSeconds = null;
  renderGoalStatus();
}

function updatePatternStepAddButton() {
  const btn = document.getElementById('btn-add-pattern-step');
  if (!btn) return;
  const hasPattern = Boolean(getSelectedPattern());
  const visible = _patternViewerEditMode && hasPattern;
  btn.style.display = visible ? '' : 'none';
  btn.disabled = !visible;
}

function makePatternViewerStepId() {
  if (typeof makeStepId === 'function') {
    return makeStepId();
  }
  if (window.crypto && window.crypto.randomUUID) {
    return 'step_' + window.crypto.randomUUID().replace(/-/g, '');
  }
  return 'step_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function buildNewViewerStep() {
  const emptyRich = [{ type: 'text', text: '', bold: false, color: null }];
  return {
    stepTitle: '',
    isRedStep: false,
    stepId: makePatternViewerStepId(),
    linkedStepId: '',
    linkMeta: null,
    sectionLinks: {},
    richContent: emptyRich,
    sections: normaliseStepSectionsSafe(null, emptyRich)
  };
}

async function handleAddPatternStep() {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!pattern || !_pUid || !_patternViewerEditMode) return;

  if (_activeInlineEdit) {
    const discardOk = await showConfirm(
      'Discard Unsaved Edits?',
      'Adding a step now will discard the current inline edits. Continue?'
    );
    if (!discardOk) return;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }

  const previousSteps = steps.slice();
  const previousOpen = new Set(_openStepIndices);
  const previousStepIndex = currentStepIndex;
  const nextSteps = steps.concat([buildNewViewerStep()]);
  const nextStepIndex = nextSteps.length - 1;

  pattern.steps = nextSteps;
  currentStepIndex = nextStepIndex;
  _openStepIndices = new Set([nextStepIndex]);
  rememberStepForPattern(pattern.id, currentStepIndex);
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Step added locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternStepReloadFromFirestore(pattern.id, nextStepIndex, nextSteps[nextStepIndex], 0);
    showToast('Step added.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    currentStepIndex = previousStepIndex;
    _openStepIndices = previousOpen;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to add step.', true);
  }
}

async function handleDeletePatternStep(stepIndex) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  if (!pattern || !_pUid || !_patternViewerEditMode || !steps[safeStepIndex]) return;

  if (_activeInlineEdit) {
    const discardOk = await showConfirm(
      'Discard Unsaved Edits?',
      'Deleting a step now will discard the current inline edits. Continue?'
    );
    if (!discardOk) return;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }

  const stepTitle = getCleanStepTitle((steps[safeStepIndex] && steps[safeStepIndex].stepTitle) || '');
  const confirmTitle = steps.length === 1 ? 'Delete Only Step?' : 'Delete Step?';
  const confirmMessage = steps.length === 1
    ? 'Delete "' + (stepTitle || 'Untitled Step') + '"? This will leave the pattern with no steps.'
    : 'Delete "' + (stepTitle || 'Untitled Step') + '"? This cannot be undone.';

  const confirmed = await showConfirm(confirmTitle, confirmMessage);
  if (!confirmed) return;

  const previousSteps = steps.slice();
  const previousOpen = new Set(_openStepIndices);
  const previousStepIndex = currentStepIndex;
  const previousInlineEdit = _activeInlineEdit;
  const previousInlineEditSaving = _inlineEditSaving;

  const nextSteps = steps.filter(function(_, idx) {
    return idx !== safeStepIndex;
  });

  let nextStepIndex = currentStepIndex;
  if (!nextSteps.length) {
    nextStepIndex = 0;
  } else if (safeStepIndex < currentStepIndex) {
    nextStepIndex = Math.max(0, currentStepIndex - 1);
  } else if (safeStepIndex === currentStepIndex) {
    nextStepIndex = Math.min(safeStepIndex, nextSteps.length - 1);
  }

  const nextOpen = new Set();
  previousOpen.forEach(function(idx) {
    if (idx === safeStepIndex) return;
    nextOpen.add(idx > safeStepIndex ? idx - 1 : idx);
  });

  pattern.steps = nextSteps;
  currentStepIndex = nextStepIndex;
  _openStepIndices = nextOpen;
  rememberStepForPattern(pattern.id, currentStepIndex);
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Step deleted locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternReloadFromFirestore(pattern.id, nextStepIndex, nextSteps.length, 0);
    showToast('Step deleted.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    currentStepIndex = previousStepIndex;
    _openStepIndices = previousOpen;
    _activeInlineEdit = previousInlineEdit;
    _inlineEditSaving = previousInlineEditSaving;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to delete step.', true);
  }
}

function navigateStep(delta, options) {
  const pattern = getSelectedPattern();
  if (!pattern) return;
  const steps = pattern.steps || [];
  if (!steps.length) return;

  var next = currentStepIndex + delta;
  var wrap = Boolean(options && options.wrap);

  if (next < 0 || next >= steps.length) {
    if (!wrap) return;
    if (next < 0) {
      next = steps.length - 1;
    } else {
      next = 0;
    }
  }

  currentStepIndex = next;
  _openStepIndices = new Set([next]);
  renderCurrentStep(pattern);
  focusCurrentStepToggle(next);
}

function initPatternViewControls() {
  const expandAllBtn = document.getElementById('btn-steps-expand-all');
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      const pattern = getSelectedPattern();
      if (!pattern || _accordionMode) return;
      const steps = pattern.steps || [];
      if (!steps.length) return;

      const allOpen = steps.every((_, idx) => _openStepIndices.has(idx));
      if (allOpen) {
        _openStepIndices = new Set();
      } else {
        const next = new Set();
        steps.forEach((_, idx) => next.add(idx));
        _openStepIndices = next;
      }

      renderCurrentStep(pattern);
    });
  }

  const accordionCheckbox = document.getElementById('setting-step-accordion-mode');
  if (accordionCheckbox) {
    accordionCheckbox.checked = _accordionMode;
    accordionCheckbox.addEventListener('change', () => {
      applyAccordionModeState(accordionCheckbox.checked, true);
    });
  }
}

function loadAccordionModeState() {
  _accordionMode = localStorage.getItem(ACCORDION_MODE_STATE_KEY) === '1';
}

function applyAccordionModeState(enabled, persist) {
  _accordionMode = Boolean(enabled);
  if (persist) {
    localStorage.setItem(ACCORDION_MODE_STATE_KEY, _accordionMode ? '1' : '0');
  }

  const accordionCheckbox = document.getElementById('setting-step-accordion-mode');
  if (accordionCheckbox) {
    accordionCheckbox.checked = _accordionMode;
  }

  const pattern = getSelectedPattern();
  if (!_accordionMode || !pattern) {
    updateExpandAllButton(pattern && pattern.steps ? pattern.steps.length : 0);
    return;
  }

  if (_openStepIndices.size > 1) {
    const preferred = _openStepIndices.has(currentStepIndex)
      ? currentStepIndex
      : (_openStepIndices.values().next().value || 0);
    _openStepIndices = new Set([preferred]);
  }

  renderCurrentStep(pattern);
}

function updateExpandAllButton(stepCount) {
  const btn = document.getElementById('btn-steps-expand-all');
  if (!btn) return;

  if (!stepCount) {
    btn.textContent = 'Expand All';
    btn.disabled = true;
    btn.title = 'Select a pattern to expand steps.';
    return;
  }

  if (_accordionMode) {
    btn.textContent = 'Expand All';
    btn.disabled = true;
    btn.title = 'Disable accordion mode in Settings to expand all steps.';
    return;
  }

  const allOpen = Array.from({ length: stepCount }).every((_, idx) => _openStepIndices.has(idx));
  btn.textContent = allOpen ? 'Collapse All' : 'Expand All';
  btn.disabled = false;
  btn.title = allOpen ? 'Collapse every step in this pattern.' : 'Expand every step in this pattern.';
}

// ── Timer ────────────────────────────────────────────────────
function handleStartTimer() {
  const pattern = getSelectedPattern();
  if (!pattern) {
    showToast('Select a pattern before starting the timer.', true);
    return;
  }

  startTimer(pattern);
}

function startTimer(pattern) {
  stopTimer();
  clearYellowStepMarks();
  const patternName = pattern && pattern.name ? pattern.name : '';
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = '';
  document.getElementById('timer-pattern-name').textContent = patternName;
  timerGoalSeconds = normaliseGoalSeconds(pattern && pattern.goalSeconds);
  syncGoalInputFromState();
  timerSeconds = 0;
  timerStartWallTime = Date.now();
  timerRunning = true;
  updateTimerDisplay();
  updateTimerActionButtons();
  timerInterval = setInterval(() => {
    timerSeconds = Math.floor((Date.now() - timerStartWallTime) / 1000);
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  updateTimerActionButtons();
}

function updateTimerDisplay() {
  const timerDisplay = document.getElementById('timer-display');
  timerDisplay.textContent = formatTimerClock(timerSeconds);
  const overGoal = timerGoalSeconds !== null && timerSeconds > timerGoalSeconds;
  timerDisplay.classList.toggle('timer-display-over-goal', overGoal);
  applyTimerGoalTheme();
  renderGoalStatus();
}

function updateTimerActionButtons() {
  const startButton = document.getElementById('btn-start-timer');
  const stopButton = document.getElementById('btn-stop-timer');
  const recordButton = document.getElementById('btn-record-study');
  const hasPattern = Boolean(getSelectedPattern());

  if (startButton) startButton.disabled = !hasPattern || timerRunning;
  if (stopButton) stopButton.disabled = !timerRunning;
  if (recordButton) recordButton.disabled = !hasPattern;
}

function applyTimerGoalTheme() {
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (!timerBar) return;

  timerBar.classList.remove('timer-goal-green', 'timer-goal-yellow', 'timer-goal-red');
  if (timerGoalSeconds === null) return;

  const progress = timerSeconds / timerGoalSeconds;
  if (progress <= (2 / 3)) {
    timerBar.classList.add('timer-goal-green');
    return;
  }

  if (progress <= 1) {
    timerBar.classList.add('timer-goal-yellow');
    return;
  }

  timerBar.classList.add('timer-goal-red');
}

function normaliseGoalSeconds(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function formatTimerClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderGoalStatus() {
  const statusEl = document.getElementById('timer-goal-status');
  if (!statusEl) return;

  if (timerGoalSeconds === null) {
    statusEl.textContent = 'No goal set';
    statusEl.classList.remove('timer-goal-over');
    return;
  }

  if (timerSeconds <= timerGoalSeconds) {
    const remaining = timerGoalSeconds - timerSeconds;
    statusEl.textContent = `Goal ${formatTimerClock(timerGoalSeconds)} • ${formatTimerClock(remaining)} left`;
    statusEl.classList.remove('timer-goal-over');
    return;
  }

  const overBy = timerSeconds - timerGoalSeconds;
  statusEl.textContent = `Goal ${formatTimerClock(timerGoalSeconds)} • over by ${formatTimerClock(overBy)}`;
  statusEl.classList.add('timer-goal-over');
}

function syncGoalInputFromState() {
  const input = document.getElementById('timer-goal-minutes');
  if (!input) return;
  input.value = timerGoalSeconds === null ? '' : String(Math.max(1, Math.round(timerGoalSeconds / 60)));
}

async function saveStudyGoal() {
  const pattern = getSelectedPattern();
  if (!pattern || !_pUid) return;

  const input = document.getElementById('timer-goal-minutes');
  const raw = (input && input.value || '').trim();

  let nextGoalSeconds = null;
  if (raw !== '') {
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      showToast('Goal minutes must be a positive number.', true);
      return;
    }
    nextGoalSeconds = Math.round(minutes * 60);
  }

  try {
    await updatePatternGoalSeconds(_pUid, pattern.id, nextGoalSeconds);
    pattern.goalSeconds = nextGoalSeconds;
    timerGoalSeconds = nextGoalSeconds;
    syncGoalInputFromState();
    updateTimerDisplay();

    if (nextGoalSeconds === null) {
      showToast(`Cleared goal for "${pattern.name}".`);
    } else {
      showToast(`Saved goal for "${pattern.name}": ${formatTimerClock(nextGoalSeconds)}.`);
    }
  } catch (err) {
    console.error(err);
    showToast('Failed to save goal time.', true);
  }
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

  // Attach change handler by cloning node to clear any previous listeners
  const studySelect = document.getElementById('record-rvu-study-select');
  const freshSelect = studySelect.cloneNode(false);
  studySelect.parentNode.replaceChild(freshSelect, studySelect);

  RVUsData.populateSelect(freshSelect).then(() => {
    const idx = RVUsData.findIndex(pendingRecordPatternName);
    if (idx !== -1) {
      freshSelect.value = idx;
      const entry = RVUsData.getEntry(idx);
      if (entry) document.getElementById('record-rvu-input').value = entry.rvu;
    }
    freshSelect.addEventListener('change', () => {
      const entry = RVUsData.getEntry(Number(freshSelect.value));
      if (entry) document.getElementById('record-rvu-input').value = entry.rvu;
    });
  });

  document.getElementById('modal-record').style.display = '';
  setTimeout(() => document.getElementById('record-rvu-input').focus(), 50);
}

async function confirmRecord() {
  const rvu = document.getElementById('record-rvu-input').value;
  document.getElementById('modal-record').style.display = 'none';
  const recordedSeconds = pendingRecordSeconds;
  const pattern = getSelectedPattern();

  try {
    await addStudyLogEntry(_pUid, {
      study:    pendingRecordPatternName,
      seconds:  recordedSeconds,
      duration: formatDuration(recordedSeconds),
      rvu:      rvu !== '' ? rvu : null
    });
    timerSeconds = 0;
    clearYellowStepMarks();
    if (pattern) {
      startTimer(pattern);
      renderCurrentStep(pattern);
    } else {
      updateTimerDisplay();
      updateTimerActionButtons();
    }
    pendingRecordSeconds = 0;
    showToast(`Recorded "${pendingRecordPatternName}" — ${formatDuration(recordedSeconds)}`);
  } catch (err) {
    console.error(err);
    updateTimerActionButtons();
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
  const editBtn = document.getElementById('btn-edit-pattern');
  const hasUnsyncedDraft = hasDirtyPatternEditDraft(selectedPatternId);
  editBtn.disabled = !hasSelection || _patternEditCommitInFlight;
  if (_patternEditCommitInFlight) {
    editBtn.textContent = 'Syncing...';
  } else if (_patternViewerEditMode) {
    editBtn.textContent = 'Done Editing';
  } else if (hasUnsyncedDraft) {
    editBtn.textContent = 'Edit Pattern (Unsynced)';
  } else {
    editBtn.textContent = 'Edit Pattern';
  }
  document.getElementById('btn-delete-pattern').disabled = !hasSelection;
  updatePatternStepAddButton();
}

function flushPatternViewerDraftFromDom() {
  if (!_patternViewerEditMode) return;

  const titleInputs = Array.from(document.querySelectorAll('.step-title-edit-input[data-step-index]'));
  titleInputs.forEach(function(inputEl) {
    const stepIndex = Number(inputEl.dataset.stepIndex);
    if (!Number.isInteger(stepIndex)) return;
    applyPatternViewerStepTitleDraft(stepIndex, inputEl.value);
  });

  const inlineForms = Array.from(document.querySelectorAll('.step-inline-edit[data-step-index][data-section-key]'));
  inlineForms.forEach(function(formEl) {
    const stepIndex = Number(formEl.dataset.stepIndex);
    if (!Number.isInteger(stepIndex)) return;

    const sectionKey = String(formEl.dataset.sectionKey || '');
    if (!sectionKey) return;

    const titleInput = formEl.querySelector('.step-inline-edit-title');
    const redToggle = formEl.querySelector('.step-inline-red-toggle');
    const richEditor = formEl.querySelector('.step-inline-rich-editor');
    const plainEditor = formEl.querySelector('.step-inline-edit-content');
    const contentValue = richEditor && typeof extractRichContent === 'function'
      ? extractRichContent(richEditor)
      : (plainEditor ? plainEditor.value : '');

    applyPatternViewerInlineDraft({
      stepIndex: stepIndex,
      sectionKey: sectionKey,
      findingId: String(formEl.dataset.findingId || ''),
      title: titleInput ? titleInput.value : '',
      content: contentValue,
      isMarkedRed: redToggle ? redToggle.checked : false
    });
  });
}

function setPatternViewerEditMode(enabled, shouldRender) {
  _patternViewerEditMode = Boolean(enabled);
  if (_patternViewerEditMode) {
    const pattern = getSelectedPattern();
    ensurePatternEditDraft(pattern);
    const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
    if (steps.length) {
      currentStepIndex = Math.max(0, Math.min(currentStepIndex, steps.length - 1));
      _openStepIndices = new Set([currentStepIndex]);
    } else {
      _openStepIndices = new Set();
    }
  } else {
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }
  updateSidebarButtons(Boolean(selectedPatternId));
  if (shouldRender && selectedPatternId) {
    const pattern = getSelectedPattern();
    if (pattern) renderCurrentStep(pattern);
  }
}

function togglePatternViewerEditMode() {
  if (_patternEditCommitInFlight) return;
  if (_patternViewerEditMode) {
    flushPatternViewerDraftFromDom();
    setPatternViewerEditMode(false, true);
    commitPatternEditDraftIfNeeded();
    return;
  }
  setPatternViewerEditMode(true, true);
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
function isAnyModalOverlayOpen() {
  var overlays = document.querySelectorAll('.modal-overlay');
  for (var i = 0; i < overlays.length; i += 1) {
    var overlay = overlays[i];
    if (!overlay) continue;
    if (overlay.style && overlay.style.display === 'none') continue;
    var computed = window.getComputedStyle ? window.getComputedStyle(overlay) : null;
    if (computed && computed.display === 'none') continue;
    return true;
  }
  return false;
}

function handleKeydown(e) {
  // Keep modal keyboard behavior self-contained (Tab should move within modal fields).
  if (isAnyModalOverlayOpen()) return;

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
  } else if (e.key === 'Tab') {
    e.preventDefault();
    navigateStep(e.shiftKey ? -1 : 1);
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
        isRedStep:    Boolean(s.is_red_step || s.isRedStep || s.stepColorRed),
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

function normaliseMultilineText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function normaliseListItemContent(item) {
  if (Array.isArray(item)) return normaliseRichContent(item);
  if (item && typeof item === 'object' && Array.isArray(item.content)) {
    return normaliseRichContent(item.content);
  }
  return [];
}

function normaliseRichContent(richContent) {
  if (!Array.isArray(richContent)) return [];

  return richContent.map(chunk => {
    const type = chunk?.type || (chunk?.image_data || chunk?.data ? 'image' : (chunk?.url ? 'link' : ((chunk?.title || chunk?.name) && Array.isArray(chunk?.content) ? 'subsection' : 'text')));

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
        text: normaliseMultilineText(chunk?.text || chunk?.content || chunk?.url || ''),
        url: chunk?.url || ''
      };
    }

    if (type === 'subsection') {
      return {
        type: 'subsection',
        subsectionId: String(chunk?.subsectionId || chunk?.subsection_id || '').trim(),
        findingId: String(chunk?.findingId || chunk?.finding_id || '').trim(),
        title: normaliseMultilineText(chunk?.title || chunk?.name || ''),
        isRedFinding: Boolean(chunk?.isRedFinding || chunk?.is_red_finding || chunk?.findingRed),
        linkMeta: normaliseSectionLinkForViewer(chunk?.linkMeta || chunk?.link_meta || null),
        content: normaliseRichContent(chunk?.content || [])
      };
    }

    if (type === 'list') {
      return {
        type: 'list',
        ordered: Boolean(chunk?.ordered),
        items: Array.isArray(chunk?.items)
          ? chunk.items.map(function(item) {
              return normaliseListItemContent(item);
            })
          : []
      };
    }

    return {
      type: 'text',
      text: normaliseMultilineText(chunk?.text || chunk?.content || ''),
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
