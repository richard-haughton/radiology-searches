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
var _preferredStepIndex = null;
var _openStepIndices = new Set();
var _draggingPatternStepIndex = null;
var _patternViewerEditMode = false;
var _activeInlineEdit = null;
var _inlineEditSaving = false;
var _accordionMode = false;
var STEP_SECTION_ORDER = ['searchPattern', 'dontMissPathology'];
var STEP_SECTION_LABELS = {
  dontMissPathology: 'Findings',
  searchPattern: 'Search Pattern'
};
var ACCORDION_MODE_STATE_KEY = 'patternStepAccordionMode';
var SECTION_WITH_SUBSECTIONS_KEYS = ['dontMissPathology'];
var STEP_SECTIONS_STATE_KEY = 'patternStepSectionsState';
var _stepSectionsOpenState = {
  searchPattern: true,
  dontMissPathology: false
};

// ── Init ─────────────────────────────────────────────────────
function initPatterns(userId) {
  _pUid = userId;

  initPatternSidebarToggle();
  loadStepSectionsOpenState();
  loadAccordionModeState();
  initPatternViewControls();

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
  document.getElementById('btn-record-study').addEventListener('click', openRecordModal);
  document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);
  document.getElementById('btn-save-study-goal').addEventListener('click', saveStudyGoal);
  document.getElementById('timer-goal-minutes').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveStudyGoal();
    }
  });

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
    _openStepIndices = new Set([currentStepIndex]);
  } else {
    currentStepIndex = 0;
    _openStepIndices = steps.length ? new Set([0]) : new Set();
  }
  updateSidebarButtons(true);

  // Reset timer
  stopTimer();
  timerSeconds = 0;
  startTimer(pattern);

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
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    contentEl.style.display = 'none';
    emptyEl.querySelector('p').textContent = 'This pattern has no steps yet.';
    return;
  }

  emptyEl.style.display = 'none';
  headerEl.style.display = '';
  contentEl.style.display = '';

  document.getElementById('step-counter').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  document.getElementById('step-title').textContent = 'Select a step to view details';
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
    title.textContent = step.stepTitle || `Untitled Step ${idx + 1}`;

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
    renderStepSections(panelInner, step);
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

  const activeItem = list.querySelector(`[data-step-index="${currentStepIndex}"]`);
  if (activeItem && _openStepIndices.has(currentStepIndex)) {
    requestAnimationFrame(() => {
      activeItem.scrollIntoView({ block: 'nearest' });
    });
  }

  if (_openStepIndices.has(steps.length - 1) && timerRunning) {
    stopTimer();
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
  const nextCurrentStepIndex = order.indexOf(previousCurrentStepIndex);

  pattern.steps = nextSteps;
  _openStepIndices = remapOpenStepIndices(order, previousOpenIndices);
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

  if (step.linkMeta && step.linkMeta.mode === 'snapshot' && step.linkMeta.snapshot) {
    const snapshot = step.linkMeta.snapshot;
    return {
      stepTitle: snapshot.stepTitle || step.stepTitle || '',
      isRedStep: Boolean(snapshot.isRedStep || step.isRedStep),
      richContent: normaliseRichContent(snapshot.richContent || []),
      linkedStepId: String(step.linkedStepId || '').trim(),
      stepId: String(step.stepId || '').trim() || String(snapshot.stepId || '').trim(),
      linkMeta: step.linkMeta,
      sections: normaliseStepSectionsSafe(snapshot.sections, snapshot.richContent || [])
    };
  }

  const linkedStepId = String(step.linkedStepId || '').trim();
  if (!linkedStepId) return resolveSectionLinksForViewer(normaliseStepForViewer(step));

  const shared = findLinkedStepData(linkedStepId);
  if (!shared) return resolveSectionLinksForViewer(normaliseStepForViewer(step));

  return resolveSectionLinksForViewer({
    stepTitle: shared.stepTitle,
    isRedStep: Boolean(shared.isRedStep),
    richContent: shared.richContent,
    linkedStepId,
    sectionLinks: normaliseSectionLinksForViewer(step.sectionLinks),
    sections: shared.sections
  });
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

function resolveSectionLinksForViewer(step) {
  const resolved = normaliseStepForViewer(step);
  resolved.sectionLinks = normaliseSectionLinksForViewer(resolved.sectionLinks);

  const searchPatternLink = resolved.sectionLinks.searchPattern;
  if (searchPatternLink && searchPatternLink.sourceStepId) {
    const sourceStep = findLinkedStepData(searchPatternLink.sourceStepId);
    if (sourceStep && sourceStep.sections) {
      resolved.sections.searchPattern = normaliseRichContent(sourceStep.sections.searchPattern || []);
      resolved.richContent = normaliseRichContent(resolved.sections.searchPattern || []);
    }
  }

  const findings = normaliseRichContent(resolved.sections.dontMissPathology || []).map(item => {
    if (!item || item.type !== 'subsection' || !item.linkMeta || !item.linkMeta.sourceSubsectionId) return item;
    const sourceStep = findLinkedStepData(item.linkMeta.sourceStepId || '');
    const sourceSub = findSubsectionByIdForViewer(sourceStep, item.linkMeta.sourceSubsectionId);
    if (!sourceSub) return item;
    return Object.assign({}, item, {
      title: sourceSub.title || item.title,
      isRedFinding: Boolean(sourceSub.isRedFinding),
      content: normaliseRichContent(sourceSub.content || [])
    });
  });
  resolved.sections.dontMissPathology = findings;

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
    stepTitle: (step && step.stepTitle) || '',
    isRedStep: Boolean(step && (step.isRedStep || step.is_red_step || step.stepColorRed)),
    richContent: fallback,
    stepId: (step && step.stepId) || '',
    linkedStepId: (step && step.linkedStepId) || '',
    linkMeta: (step && step.linkMeta) || null,
    sectionLinks: normaliseSectionLinksForViewer(step && step.sectionLinks),
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
    if (key === 'searchPattern') {
      renderSearchPatternContent(panelInner, content);
    } else if (content.length) {
      if (SECTION_WITH_SUBSECTIONS_KEYS.indexOf(key) !== -1) {
        renderNestedSubsections(panelInner, content);
      } else {
        renderRichContent(panelInner, content);
      }
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      panelInner.appendChild(empty);
    }

    if (key === 'dontMissPathology' && _patternViewerEditMode) {
      const actions = document.createElement('div');
      actions.className = 'step-section-actions';

      const addFindingBtn = document.createElement('button');
      addFindingBtn.type = 'button';
      addFindingBtn.className = 'btn btn-ghost step-section-action-btn';
      addFindingBtn.textContent = 'Add Finding';
      addFindingBtn.addEventListener('click', function() {
        if (typeof openCreateFindingModal === 'function') {
          openCreateFindingModal();
        } else {
          showToast('Finding creation is unavailable right now.', true);
        }
      });

      actions.appendChild(addFindingBtn);
      panelInner.appendChild(actions);
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

function startInlineEdit(sectionKey, findingId, title, content) {
  _activeInlineEdit = {
    key: getInlineEditKey(sectionKey, findingId),
    stepIndex: currentStepIndex,
    sectionKey: sectionKey,
    findingId: String(findingId || '').trim(),
    title: String(title || ''),
    content: normaliseRichContent(content || [])
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

async function saveInlineEdit(sectionKey, findingId, nextTitle, nextContent) {
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

  const nextRichContent = Array.isArray(nextContent)
    ? normaliseRichContent(nextContent)
    : (typeof plainTextToRichContent === 'function'
        ? plainTextToRichContent(nextContent)
        : [{ type: 'text', text: String(nextContent || ''), bold: false, color: null }]);

  if (sectionKey === 'searchPattern') {
    nextStep.sections.searchPattern = nextRichContent;
    nextStep.richContent = normaliseRichContent(nextStep.sections.searchPattern || []);
  } else {
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
    finding.content = nextRichContent;
  }

  nextSteps[currentStepIndex] = nextStep;

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    pattern.steps = nextSteps;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
    renderCurrentStep(pattern);
    showToast(sectionKey === 'searchPattern' ? 'Search pattern updated.' : 'Finding updated.');
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

  const actions = document.createElement('div');
  actions.className = 'step-inline-edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-accent btn-sm';
  saveBtn.textContent = _inlineEditSaving ? 'Saving...' : 'Save';
  saveBtn.disabled = _inlineEditSaving;
  saveBtn.addEventListener('click', function() {
    const contentValue = richEditor && typeof extractRichContent === 'function'
      ? extractRichContent(richEditor)
      : (textarea ? textarea.value : '');
    saveInlineEdit(
      options.sectionKey,
      options.findingId,
      titleInput ? titleInput.value : '',
      contentValue
    );
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.disabled = _inlineEditSaving;
  cancelBtn.addEventListener('click', cancelInlineEdit);

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);
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

function renderNestedSubsections(container, content) {
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
    const isEditing = isInlineEditActive('dontMissPathology', entry.subsectionId || '');

    const header = document.createElement('div');
    header.className = 'step-subsection-header';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-subsection-toggle';
    btn.setAttribute('aria-expanded', String(isEditing));
    btn.innerHTML = `
      <span>${entry.title || `Subsection ${idx + 1}`}</span>
      <span class="step-subsection-chevron" aria-hidden="true">${isEditing ? '▾' : '▸'}</span>
    `;

    const panel = document.createElement('div');
    panel.className = 'step-subsection-panel';
    panel.style.display = isEditing ? '' : 'none';

    const panelInner = document.createElement('div');
    panelInner.className = 'step-subsection-content';
    if (isEditing) {
      renderInlineEditForm(panelInner, {
        sectionKey: 'dontMissPathology',
        findingId: entry.subsectionId || '',
        includeTitle: true,
        title: entry.title || '',
        content: entry.content || []
      });
    } else if ((entry.content || []).length) {
      renderRichContent(panelInner, entry.content);
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      panelInner.appendChild(empty);
    }

    panel.appendChild(panelInner);
    btn.addEventListener('click', () => {
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      const nextOpen = !isOpen;
      btn.setAttribute('aria-expanded', String(nextOpen));
      panel.style.display = nextOpen ? '' : 'none';
      const chevron = btn.querySelector('.step-subsection-chevron');
      if (chevron) chevron.textContent = nextOpen ? '▾' : '▸';
    });

    if (_patternViewerEditMode) {
      const modifyBtn = document.createElement('button');
      modifyBtn.type = 'button';
      modifyBtn.className = 'btn btn-ghost btn-sm step-inline-modify-btn';
      modifyBtn.textContent = isEditing ? 'Editing' : 'Modify';
      modifyBtn.disabled = _inlineEditSaving;
      modifyBtn.addEventListener('click', () => {
        if (isEditing) return;
        startInlineEdit('dontMissPathology', entry.subsectionId || '', entry.title || '', entry.content || []);
      });
      header.appendChild(modifyBtn);
    }
    header.appendChild(btn);
    wrap.appendChild(header);
    wrap.appendChild(panel);
    container.appendChild(wrap);
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
        if (chunk.color === 'red') span.classList.add('rich-red');
        if (chunk.color === 'green') span.classList.add('rich-green');
        if (chunk.color === 'blue') span.classList.add('rich-blue');
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

function renderSearchPatternContent(container, richContent) {
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
  const isEditing = isInlineEditActive('searchPattern', '');

  const modifyBtn = document.createElement('button');
  modifyBtn.type = 'button';
  modifyBtn.className = 'btn btn-ghost btn-sm step-inline-modify-btn';
  modifyBtn.textContent = isEditing ? 'Editing' : 'Modify';
  modifyBtn.disabled = _inlineEditSaving;
  modifyBtn.addEventListener('click', () => {
    if (isEditing) return;
    startInlineEdit('searchPattern', '', '', richContent || []);
  });

  const body = document.createElement('div');
  body.className = 'step-section-inline-body';
  const chunks = normaliseRichContent(richContent);

  if (isEditing) {
    renderInlineEditForm(body, {
      sectionKey: 'searchPattern',
      findingId: '',
      includeTitle: false,
      title: '',
      content: richContent || []
    });
  } else if (chunks.length) {
    renderRichContent(body, chunks);
  } else {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = 'No content yet.';
    body.appendChild(empty);
  }

  layout.appendChild(modifyBtn);
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
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = 'none';
  stopTimer();
  timerGoalSeconds = null;
  renderGoalStatus();
  setPatternViewerEditMode(false, false);
}

function navigateStep(delta) {
  const pattern = getSelectedPattern();
  if (!pattern) return;
  const steps = pattern.steps || [];
  const next = currentStepIndex + delta;
  if (next < 0 || next >= steps.length) return;
  currentStepIndex = next;
  _openStepIndices = new Set([next]);
  renderCurrentStep(pattern);

  const toggle = document.querySelector(`.step-item[data-step-index="${next}"] .step-item-toggle`);
  if (toggle) {
    toggle.focus({ preventScroll: true });
  }
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
function startTimer(pattern) {
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
  timerInterval = setInterval(() => {
    timerSeconds = Math.floor((Date.now() - timerStartWallTime) / 1000);
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
}

function updateTimerDisplay() {
  const timerDisplay = document.getElementById('timer-display');
  timerDisplay.textContent = formatTimerClock(timerSeconds);
  const overGoal = timerGoalSeconds !== null && timerSeconds > timerGoalSeconds;
  timerDisplay.classList.toggle('timer-display-over-goal', overGoal);
  renderGoalStatus();
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

  try {
    await addStudyLogEntry(_pUid, {
      study:    pendingRecordPatternName,
      seconds:  recordedSeconds,
      duration: formatDuration(recordedSeconds),
      rvu:      rvu !== '' ? rvu : null
    });
    timerSeconds = 0;
    updateTimerDisplay();
    pendingRecordSeconds = 0;
    showToast(`Recorded "${pendingRecordPatternName}" — ${formatDuration(recordedSeconds)}`);
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
  const editBtn = document.getElementById('btn-edit-pattern');
  editBtn.disabled = !hasSelection;
  editBtn.textContent = _patternViewerEditMode ? 'Done Editing' : 'Edit Pattern';
  document.getElementById('btn-delete-pattern').disabled = !hasSelection;
}

function setPatternViewerEditMode(enabled, shouldRender) {
  _patternViewerEditMode = Boolean(enabled);
  if (!_patternViewerEditMode) {
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
  setPatternViewerEditMode(!_patternViewerEditMode, true);
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
        text: chunk?.text || chunk?.content || chunk?.url || '',
        url: chunk?.url || ''
      };
    }

    if (type === 'subsection') {
      return {
        type: 'subsection',
        subsectionId: String(chunk?.subsectionId || chunk?.subsection_id || '').trim(),
        title: chunk?.title || chunk?.name || '',
        isRedFinding: Boolean(chunk?.isRedFinding || chunk?.is_red_finding || chunk?.findingRed),
        linkMeta: normaliseSectionLinkForViewer(chunk?.linkMeta || chunk?.link_meta || null),
        content: normaliseRichContent(chunk?.content || [])
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
