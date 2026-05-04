// editor.js — plain script, no modules. Depends on db.js and app.js globals.

// ── State ────────────────────────────────────────────────────
var editorUid = null;
var editingPatternId = null;
var editorSteps = [];
var activeStepIndex = null;
var _allPatternsRef = [];
var _linkStepIndexByKey = {};
var _linkStepIndexByPattern = {};
var _linkKeyDuplicateCounts = {};
var _stepAiUndoSnapshot = null;
var activeStepSectionKey = 'dontMissPathology';
var _stepAiTargetSection = 'dontMissPathology';
var EDITOR_STEP_SECTION_ORDER = ['dontMissPathology', 'measurements', 'hyperlinks', 'images', 'searchPattern'];
var EDITOR_STEP_SECTION_LABELS = {
  dontMissPathology: 'Findings',
  measurements: 'Measurements',
  hyperlinks: 'Hyperlinks',
  images: 'Workflow / Decision Tree',
  searchPattern: 'Search Pattern'
};
var EDITOR_SUBSECTION_SECTION_KEYS = ['dontMissPathology', 'images'];
var LINK_TOKEN_PREFIX = 'ra-link-v1.';

function makeStepId() {
  if (window.crypto && window.crypto.randomUUID) {
    return 'step_' + window.crypto.randomUUID().replace(/-/g, '');
  }
  return 'step_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function ensureStepId(step) {
  if (!step) return '';
  var current = String(step.stepId || '').trim();
  if (current) return current;
  step.stepId = makeStepId();
  return step.stepId;
}

function getStepLinkKey(step) {
  if (!step) return '';
  var linked = String(step.linkedStepId || '').trim();
  if (linked) return linked;
  return String(step.stepId || '').trim();
}

function cloneStepSnapshot(step) {
  var safeStep = step || {};
  var fallback = normaliseRichContent(safeStep.richContent || safeStep.rich_content || []);
  var sections = normaliseStepSectionsForEditor(safeStep.sections, fallback);
  return {
    stepTitle: safeStep.stepTitle || '',
    stepId: String(safeStep.stepId || '').trim() || makeStepId(),
    linkedStepId: String(safeStep.linkedStepId || '').trim(),
    richContent: normaliseRichContent(fallback),
    sections: JSON.parse(JSON.stringify(sections))
  };
}

function base64UrlEncode(text) {
  var b64 = window.btoa(unescape(encodeURIComponent(text)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  var b64 = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(window.atob(b64)));
}

function encodeLinkToken(payload) {
  return LINK_TOKEN_PREFIX + base64UrlEncode(JSON.stringify(payload));
}

function parseLinkToken(rawToken) {
  var token = String(rawToken || '').trim();
  if (!token) throw new Error('Enter a link token first.');
  if (token.indexOf(LINK_TOKEN_PREFIX) !== 0) {
    throw new Error('Invalid token format.');
  }
  var encoded = token.slice(LINK_TOKEN_PREFIX.length);
  var decoded = base64UrlDecode(encoded);
  var payload = JSON.parse(decoded);
  if (!payload || payload.v !== 1 || payload.kind !== 'searches-step-link') {
    throw new Error('Unsupported token payload.');
  }
  return payload;
}

function rebuildEditorLinkIndex() {
  _linkStepIndexByKey = {};
  _linkStepIndexByPattern = {};
  _linkKeyDuplicateCounts = {};

  (_allPatternsRef || []).forEach(function(pattern) {
    var patternId = String((pattern && pattern.id) || '');
    _linkStepIndexByPattern[patternId] = [];
    var steps = (pattern && pattern.steps) || [];

    steps.forEach(function(step, idx) {
      var stepClone = cloneStepSnapshot(step);
      var linkKey = getStepLinkKey(stepClone);
      var entry = {
        patternId: patternId,
        patternName: (pattern && pattern.name) || 'Untitled Pattern',
        stepIndex: idx,
        stepId: stepClone.stepId,
        stepTitle: stepClone.stepTitle || ('Step ' + (idx + 1)),
        linkedStepId: String(stepClone.linkedStepId || '').trim(),
        linkKey: linkKey,
        richContent: normaliseRichContent(stepClone.richContent || []),
        sections: normaliseStepSectionsForEditor(stepClone.sections, stepClone.richContent || [])
      };

      _linkStepIndexByPattern[patternId].push(entry);

      if (!linkKey) return;
      if (!_linkStepIndexByKey[linkKey]) {
        _linkStepIndexByKey[linkKey] = entry;
        _linkKeyDuplicateCounts[linkKey] = 1;
      } else {
        _linkKeyDuplicateCounts[linkKey] = (_linkKeyDuplicateCounts[linkKey] || 1) + 1;
      }
    });
  });
}

function setAllPatternsRef(patterns) {
  _allPatternsRef = patterns;
  rebuildEditorLinkIndex();
}

function resolveLinkedStepForEditor(step) {
  if (!step) return step;

  if (step.linkMeta && step.linkMeta.mode === 'snapshot' && step.linkMeta.snapshot) {
    var snapshot = step.linkMeta.snapshot;
    return {
      stepTitle: snapshot.stepTitle || step.stepTitle || '',
      stepId: String(step.stepId || '').trim() || String(snapshot.stepId || '').trim() || makeStepId(),
      linkedStepId: String(step.linkedStepId || '').trim(),
      linkMeta: step.linkMeta,
      richContent: normaliseRichContent(snapshot.richContent || []),
      sections: normaliseStepSectionsForEditor(snapshot.sections, snapshot.richContent || [])
    };
  }

  const linkedStepId = String(step.linkedStepId || '').trim();
  if (!linkedStepId) return step;

  const shared = findLinkedStepDataForEditor(linkedStepId);
  if (!shared) return step;

  return {
    stepTitle: shared.stepTitle,
    stepId: String(step.stepId || '').trim() || makeStepId(),
    linkedStepId,
    linkMeta: step.linkMeta || null,
    richContent: shared.richContent,
    sections: shared.sections
  };
}

function findLinkedStepDataForEditor(linkedStepId) {
  var entry = _linkStepIndexByKey[String(linkedStepId || '').trim()];
  if (!entry) return null;
  return {
    stepTitle: entry.stepTitle || '',
    richContent: normaliseRichContent(entry.richContent || []),
    sections: normaliseStepSectionsForEditor(entry.sections, entry.richContent || [])
  };
}

function getActiveStepSourceOptions() {
  if (activeStepIndex === null) return [];
  return (_allPatternsRef || []).reduce(function(out, pattern) {
    if (!pattern || !pattern.id) return out;
    if (editingPatternId && String(pattern.id) === String(editingPatternId)) return out;
    var steps = _linkStepIndexByPattern[String(pattern.id)] || [];
    steps.forEach(function(entry) {
      out.push(entry);
    });
    return out;
  }, []);
}

function getLinkStatusForStep(step) {
  if (!step) return { tone: 'muted', text: 'No link set for this step.' };
  if (step.linkMeta && step.linkMeta.mode === 'snapshot') {
    var fromLabel = (step.linkMeta.sourcePatternName || 'shared token') + ' / ' + (step.linkMeta.sourceStepTitle || 'Snapshot step');
    return { tone: 'warn', text: 'Snapshot link from ' + fromLabel + '. This does not auto-sync.' };
  }

  var key = String(step.linkedStepId || '').trim();
  if (!key) return { tone: 'muted', text: 'No link set for this step.' };

  var source = _linkStepIndexByKey[key];
  if (!source) return { tone: 'error', text: 'Link key not found in your patterns. Choose a source step or paste a token.' };

  var duplicateCount = _linkKeyDuplicateCounts[key] || 1;
  var duplicateMsg = duplicateCount > 1 ? ' Warning: multiple sources share this key.' : '';
  return {
    tone: duplicateCount > 1 ? 'warn' : 'ok',
    text: 'Live link to ' + source.patternName + ' / ' + source.stepTitle + '.' + duplicateMsg
  };
}

// ── Open editor ──────────────────────────────────────────────
function openEditor(uid, patternId, preferredStepIndex) {
  editorUid = uid;
  editingPatternId = patternId;
  activeStepIndex = null;
  activeStepSectionKey = 'dontMissPathology';
  _stepAiUndoSnapshot = null;

  const overlay = document.getElementById('modal-editor');
  const titleEl = document.getElementById('modal-editor-title');

  if (patternId) {
    // Editing existing: pull data from the patterns cache (passed by patterns.js)
    const pattern = _allPatternsRef.find(p => p.id === patternId);
    if (!pattern) { showToast('Pattern not found.', true); return; }
    titleEl.textContent = 'Edit Pattern';
    document.getElementById('editor-pattern-name').value = pattern.name || '';
    document.getElementById('editor-modality').value = pattern.modality || 'Other';
    editorSteps = JSON.parse(JSON.stringify(pattern.steps || []))
      .map(step => ({
        stepTitle: step.stepTitle || '',
        stepId: ensureStepId(step),
        linkedStepId: step.linkedStepId || '',
        linkMeta: step.linkMeta || null,
        richContent: normaliseRichContent(step.richContent || step.rich_content || []),
        sections: normaliseStepSectionsForEditor(step.sections, step.richContent || step.rich_content || [])
      }));

    if (editorSteps.length) {
      const targetIdx = typeof preferredStepIndex === 'number' ? preferredStepIndex : 0;
      activeStepIndex = Math.max(0, Math.min(targetIdx, editorSteps.length - 1));
      editorSteps[activeStepIndex] = resolveLinkedStepForEditor(editorSteps[activeStepIndex]);
    }
  } else {
    // New pattern
    titleEl.textContent = 'New Pattern';
    document.getElementById('editor-pattern-name').value = '';
    document.getElementById('editor-modality').value = 'CT';
    editorSteps = [];
  }

  renderCreateAiPanel();
  renderStepList();
  renderStepEditPanel();
  overlay.style.display = '';

  // Focus name field
  setTimeout(() => document.getElementById('editor-pattern-name').focus(), 50);
}

// ── Init (called once from app.js) ──────────────────────────
function initEditor() {
  document.getElementById('btn-editor-close').addEventListener('click', closeEditor);
  document.getElementById('btn-editor-cancel').addEventListener('click', closeEditor);
  document.getElementById('modal-editor').addEventListener('click', e => {
    // Don't close on card click, only background
    if (e.target === document.getElementById('modal-editor')) closeEditor();
  });

  document.getElementById('btn-editor-save').addEventListener('click', savePattern);
  document.getElementById('btn-add-step').addEventListener('click', addStep);
}

function closeEditor() {
  document.getElementById('modal-editor').style.display = 'none';
  editorSteps = [];
  activeStepIndex = null;
  activeStepSectionKey = 'dontMissPathology';
  _stepAiTargetSection = 'dontMissPathology';
  _stepAiUndoSnapshot = null;
}

function normaliseStepSectionsForEditor(sections, fallbackRichContent) {
  if (typeof normaliseStepSections === 'function') {
    return normaliseStepSections(sections, normaliseRichContent(fallbackRichContent || []));
  }

  var out = {
    dontMissPathology: [],
    measurements: [],
    hyperlinks: [],
    images: [],
    searchPattern: []
  };

  EDITOR_STEP_SECTION_ORDER.forEach(function(key) {
    out[key] = normaliseRichContent((sections && sections[key]) || []);
  });

  var fallback = normaliseRichContent(fallbackRichContent || []);
  if (!out.searchPattern.length && fallback.length) {
    out.searchPattern = fallback;
  }

  return out;
}

function getCurrentEditorSectionContent(step) {
  if (!step) return [];
  if (!step.sections) {
    step.sections = normaliseStepSectionsForEditor(null, step.richContent || []);
  }
  return step.sections[activeStepSectionKey] || [];
}

function setCurrentEditorSectionContent(step, richContent) {
  if (!step) return;
  if (!step.sections) {
    step.sections = normaliseStepSectionsForEditor(null, step.richContent || []);
  }
  step.sections[activeStepSectionKey] = richContent;
  // Keep legacy field in sync with Search Pattern section for compatibility.
  step.richContent = (step.sections.searchPattern || []).slice();
}

function setActiveStepSection(key) {
  if (EDITOR_STEP_SECTION_ORDER.indexOf(key) === -1) return;
  saveActiveStepToState();
  activeStepSectionKey = key;
  renderStepEditPanel();
}

function isSubsectionSectionKey(key) {
  return EDITOR_SUBSECTION_SECTION_KEYS.indexOf(key) !== -1;
}

function renderCreateAiPanel() {
  const panel = document.getElementById('editor-ai-create-panel');
  if (!panel) return;

  if (editingPatternId) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  panel.style.display = '';

  const sourceOptions = _allPatternsRef
    .map(p => `<option value="${escapeHtml(String(p.id || ''))}">${escapeHtml(p.name || 'Untitled Pattern')}</option>`)
    .join('');

  panel.innerHTML = `
    <div class="editor-ai-grid">
      <label class="form-label">AI Source Patterns (multi-select)
        <select id="editor-ai-source-patterns" class="form-input editor-ai-list" multiple>
          ${sourceOptions}
        </select>
      </label>

      <label class="form-label">Tone
        <select id="editor-ai-tone" class="form-input">
          <option value="concise">Concise</option>
          <option value="teaching">Teaching</option>
          <option value="resident-friendly">Resident-Friendly</option>
        </select>
      </label>
    </div>

    <label class="form-label">AI Generation Prompt
      <textarea id="editor-ai-prompt" class="form-input" rows="3" placeholder="Describe what should be generated or emphasized."></textarea>
    </label>

    <div class="editor-ai-actions">
      <button type="button" class="btn btn-accent btn-sm" id="btn-ai-generate-pattern">Generate Pattern With AI</button>
    </div>
  `;

  document.getElementById('btn-ai-generate-pattern').addEventListener('click', handleAiGeneratePattern);
}

function getSelectedSourcePatternsForAi() {
  const select = document.getElementById('editor-ai-source-patterns');
  if (!select) return [];

  const selectedIds = Array.from(select.selectedOptions || []).map(o => o.value);
  if (!selectedIds.length) return [];

  return _allPatternsRef
    .filter(pattern => selectedIds.includes(String(pattern.id || '')))
    .map(serializePatternForAi);
}

function serializePatternForAi(pattern) {
  const steps = (pattern.steps || []).map(step => ({
    stepTitle: step.stepTitle || '',
    content: richContentToPlainText(step.richContent || step.rich_content || [])
  }));

  return {
    id: pattern.id || '',
    name: pattern.name || '',
    modality: pattern.modality || 'Other',
    steps
  };
}

async function handleAiGeneratePattern() {
  const provider = typeof getSelectedAiProvider === 'function' ? getSelectedAiProvider() : 'openai';
  const model = typeof getSelectedAiModel === 'function' ? getSelectedAiModel() : '';

  if (typeof isAiProviderConfigured === 'function' && !isAiProviderConfigured(provider)) {
    showToast('Configure and save a key for ' + provider + ' in Settings first.', true);
    return;
  }

  const sourcePatterns = getSelectedSourcePatternsForAi();
  if (!sourcePatterns.length) {
    showToast('Select at least one source pattern for AI generation.', true);
    return;
  }

  const tonePreset = (document.getElementById('editor-ai-tone') || {}).value || 'concise';
  const taskPrompt = ((document.getElementById('editor-ai-prompt') || {}).value || '').trim();
  const btn = document.getElementById('btn-ai-generate-pattern');

  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const response = await generatePatternFromAi({
      provider,
      model,
      tonePreset,
      taskPrompt,
      sourcePatterns
    });

    const pattern = response && response.pattern ? response.pattern : null;
    if (!pattern || !Array.isArray(pattern.steps) || !pattern.steps.length) {
      throw new Error('AI did not return a usable pattern.');
    }

    const nextSteps = pattern.steps.map(step => ({
      stepTitle: (step && step.stepTitle) || '',
      linkedStepId: '',
      richContent: plainTextToRichContent((step && step.content) || ''),
      sections: normaliseStepSectionsForEditor(null, plainTextToRichContent((step && step.content) || ''))
    }));

    document.getElementById('editor-pattern-name').value = pattern.name || 'AI Generated Pattern';
    document.getElementById('editor-modality').value = pattern.modality || 'Other';

    editorSteps = nextSteps;
    activeStepIndex = editorSteps.length ? 0 : null;
    renderStepList();
    renderStepEditPanel();
    showToast('AI pattern generated. Review and save when ready.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Failed to generate pattern with AI.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Pattern With AI';
  }
}

// ── Step list rendering ──────────────────────────────────────
function renderStepList() {
  const list = document.getElementById('editor-step-list');
  list.innerHTML = '';

  editorSteps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'editor-step-item' + (i === activeStepIndex ? ' active' : '');
    li.dataset.index = i;

    const hasLiveLink = Boolean(String(step.linkedStepId || '').trim());
    const isSnapshot = Boolean(step.linkMeta && step.linkMeta.mode === 'snapshot');
    const linkedBadge = isSnapshot
      ? ' <span class="step-linked-badge snapshot">[Snapshot]</span>'
      : (hasLiveLink ? ' <span class="step-linked-badge">[Linked]</span>' : '');
    li.innerHTML = `
      <span class="step-item-num">${i + 1}.</span>
      <span class="step-item-title">${escapeHtml(step.stepTitle || 'Untitled step')}${linkedBadge}</span>
      <button class="step-item-del" aria-label="Delete step" data-idx="${i}">&#x2715;</button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('step-item-del')) {
        deleteStep(parseInt(e.target.dataset.idx));
      } else {
        selectStep(i);
      }
    });

    list.appendChild(li);
  });
}

function addStep() {
  // Save current step first
  saveActiveStepToState();

  editorSteps.push({
    stepTitle: `Step ${editorSteps.length + 1}`,
    stepId: makeStepId(),
    richContent: [{ type: 'text', text: '', bold: false, color: null }],
    linkedStepId: '',
    linkMeta: null,
    sections: normaliseStepSectionsForEditor(null, [{ type: 'text', text: '', bold: false, color: null }])
  });
  activeStepIndex = editorSteps.length - 1;
  activeStepSectionKey = 'dontMissPathology';
  renderStepList();
  renderStepEditPanel();
  // scroll step list to bottom
  const list = document.getElementById('editor-step-list');
  list.scrollTop = list.scrollHeight;
}

function deleteStep(idx) {
  editorSteps.splice(idx, 1);
  if (activeStepIndex >= editorSteps.length) {
    activeStepIndex = editorSteps.length - 1;
  }
  if (editorSteps.length === 0) activeStepIndex = null;
  renderStepList();
  renderStepEditPanel();
}

function selectStep(idx) {
  saveActiveStepToState();
  if (editorSteps[idx]) {
    editorSteps[idx] = resolveLinkedStepForEditor(editorSteps[idx]);
  }
  activeStepIndex = idx;
  activeStepSectionKey = 'dontMissPathology';
  renderStepList();
  renderStepEditPanel();
}

// ── Step edit panel ──────────────────────────────────────────
function renderStepEditPanel() {
  const panel = document.getElementById('step-edit-panel');

  if (activeStepIndex === null || !editorSteps[activeStepIndex]) {
    panel.innerHTML = '<p class="step-edit-empty">Select a step to edit, or add a new step.</p>';
    return;
  }

  const step = editorSteps[activeStepIndex];
  ensureStepId(step);
  const sourceOptions = getActiveStepSourceOptions();
  const selectedPatternForLink = (step.linkMeta && step.linkMeta.sourcePatternId)
    ? String(step.linkMeta.sourcePatternId)
    : (sourceOptions.length ? sourceOptions[0].patternId : '');
  const status = getLinkStatusForStep(step);

  panel.innerHTML = `
    <label class="form-label">Step Title
      <input id="step-title-input" type="text" class="form-input" value="${escapeHtml(step.stepTitle || '')}" placeholder="e.g. 1. Aorta">
    </label>

    <div class="step-link-card">
      <label class="form-label">Link To Existing Step (Recommended)
        <div class="step-link-picker-grid">
          <select id="step-link-pattern-select" class="form-input">
            ${sourceOptions.length
              ? sourceOptions
                .map(item => item.patternId)
                .filter((value, index, array) => array.indexOf(value) === index)
                .map(patternId => {
                  const pattern = _allPatternsRef.find(p => String(p.id) === String(patternId));
                  return `<option value="${escapeHtml(String(patternId))}" ${String(patternId) === String(selectedPatternForLink) ? 'selected' : ''}>${escapeHtml((pattern && pattern.name) || 'Untitled Pattern')}</option>`;
                }).join('')
              : '<option value="">No source patterns available</option>'}
          </select>
          <select id="step-link-step-select" class="form-input"></select>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-apply-step-link">Apply Link</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-clear-linked-id">Unlink</button>
        </div>
      </label>

      <label class="form-label">Share Token (Cross-user snapshot)
        <div class="step-link-picker-grid">
          <input id="step-link-token-input" type="text" class="form-input" placeholder="Paste token to import snapshot link">
          <button type="button" class="btn btn-ghost btn-sm" id="btn-import-link-token">Import Token</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-copy-link-token">Copy Token</button>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-generate-linked-id">Generate Key</button>
        </div>
      </label>

      <label class="form-label">Link Key (Advanced)
        <input id="step-linked-id-input" type="text" class="form-input" value="${escapeHtml(step.linkedStepId || '')}" placeholder="Optional legacy/manual key">
      </label>

      <div id="step-link-status" class="step-link-status step-link-status-${status.tone}">${escapeHtml(status.text)}</div>
    </div>

    <div class="form-label">
      <span>Section Content</span>
      <div class="step-section-tabs" id="step-section-tabs">
        ${EDITOR_STEP_SECTION_ORDER.map(key => `
          <button
            type="button"
            class="step-section-tab ${key === activeStepSectionKey ? 'active' : ''}"
            data-section-key="${key}"
          >${EDITOR_STEP_SECTION_LABELS[key] || key}</button>
        `).join('')}
      </div>
      ${activeStepSectionKey === 'hyperlinks' ? `
      <div class="link-manager">
        <div id="link-rows" class="link-rows"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-add-link-row">+ Add Link</button>
      </div>
      ` : isSubsectionSectionKey(activeStepSectionKey) ? `
      <div class="subsection-manager">
        <div id="subsection-rows" class="subsection-rows"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-add-subsection-row">+ Add Subsection</button>
      </div>
      ` : `
      <div>
        <div class="rich-toolbar">
          <button type="button" class="rich-tool" id="tool-bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" class="rich-tool rich-tool-red" id="tool-red" title="Red text">A</button>
          <button type="button" class="rich-tool rich-tool-green" id="tool-green" title="Green text">A</button>
          <button type="button" class="rich-tool rich-tool-blue" id="tool-blue" title="Blue text">A</button>
          <button type="button" class="rich-tool" id="tool-clear" title="Clear formatting">&#x2715; Format</button>
          <button type="button" class="rich-tool" id="tool-image" title="Paste image from clipboard">&#128247; Image</button>
          <button type="button" class="rich-tool" id="tool-move-up" title="Move step up">&#8593; Up</button>
          <button type="button" class="rich-tool" id="tool-move-down" title="Move step down">&#8595; Down</button>
        </div>
        <div id="rich-editor" class="rich-editor" contenteditable="true" spellcheck="true"></div>
      </div>
      `}
    </div>

    ${activeStepSectionKey === 'hyperlinks' ? '' : `
    <div class="step-ai-card">
      <label class="form-label">AI Target Section
        <select id="step-ai-section" class="form-input">
          ${EDITOR_STEP_SECTION_ORDER.map(key => key !== 'hyperlinks' ? `<option value="${key}">${EDITOR_STEP_SECTION_LABELS[key] || key}</option>` : '').join('')}
        </select>
      </label>

      <label class="form-label">AI Instruction
        <textarea id="step-ai-prompt" class="form-input" rows="2" placeholder="Example: Add pitfalls and common mimics."></textarea>
      </label>
      <div class="step-ai-row">
        <label class="form-label" style="min-width:180px; flex:1;">Tone
          <select id="step-ai-tone" class="form-input">
            <option value="concise">Concise</option>
            <option value="teaching">Teaching</option>
            <option value="resident-friendly">Resident-Friendly</option>
          </select>
        </label>
      </div>
      <div class="step-ai-row">
        <button type="button" class="btn btn-ghost btn-sm" id="btn-ai-rewrite-step">Rewrite Section With AI</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-ai-append-step">Append To Section With AI</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-ai-undo-step" ${_stepAiUndoSnapshot ? '' : 'disabled'}>Undo AI Change</button>
      </div>
    </div>
    `}
  `;

  // Section tabs — always present
  Array.from(document.querySelectorAll('.step-section-tab')).forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveStepSection(btn.dataset.sectionKey);
    });
  });

  document.getElementById('btn-generate-linked-id').addEventListener('click', generateLinkedStepId);
  document.getElementById('btn-clear-linked-id').addEventListener('click', clearLinkedStepId);
  document.getElementById('btn-apply-step-link').addEventListener('click', applyLinkFromPicker);
  document.getElementById('btn-import-link-token').addEventListener('click', importLinkToken);
  document.getElementById('btn-copy-link-token').addEventListener('click', copyLinkToken);
  document.getElementById('step-link-pattern-select').addEventListener('change', populateStepLinkStepSelect);
  document.getElementById('step-linked-id-input').addEventListener('input', function() {
    saveActiveStepToState();
    updateStepLinkStatus();
    renderStepList();
  });
  populateStepLinkStepSelect();
  updateStepLinkStatus();

  if (activeStepSectionKey === 'hyperlinks') {
    renderLinkRows(step);
    document.getElementById('btn-add-link-row').addEventListener('click', addLinkRow);
  } else if (isSubsectionSectionKey(activeStepSectionKey)) {
    renderSubsectionRows(step);
    document.getElementById('btn-add-subsection-row').addEventListener('click', addSubsectionRow);
  } else {
    // Populate rich editor from richContent
    const editor = document.getElementById('rich-editor');
    editor.contentEditable = 'true';
    editor.setAttribute('spellcheck', 'true');
    populateRichEditor(editor, getCurrentEditorSectionContent(step));

    // Toolbar handlers
    document.getElementById('tool-bold').addEventListener('click', () => execFormat('bold'));
    document.getElementById('tool-red').addEventListener('click', () => execColor('red'));
    document.getElementById('tool-green').addEventListener('click', () => execColor('green'));
    document.getElementById('tool-blue').addEventListener('click', () => execColor('blue'));
    document.getElementById('tool-clear').addEventListener('click', execRemoveFormat);
    document.getElementById('tool-image').addEventListener('click', handlePasteImageFromClipboard);
    document.getElementById('tool-move-up').addEventListener('click', () => moveStep(-1));
    document.getElementById('tool-move-down').addEventListener('click', () => moveStep(1));
    const aiSectionSelect = document.getElementById('step-ai-section');
    if (aiSectionSelect) {
      aiSectionSelect.value = _stepAiTargetSection;
      aiSectionSelect.addEventListener('change', function() {
        _stepAiTargetSection = this.value;
      });
    }

    document.getElementById('btn-ai-rewrite-step').addEventListener('click', () => handleAiStepModify('rewrite'));
    document.getElementById('btn-ai-append-step').addEventListener('click', () => handleAiStepModify('append'));
    document.getElementById('btn-ai-undo-step').addEventListener('click', undoLastAiStepChange);

    // Keyboard shortcut for bold
    editor.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        execFormat('bold');
      }
    });

    // Handle image paste
    editor.addEventListener('paste', handleEditorPaste);

    // Focus editor
    editor.focus();
  }
}

function setStepAiButtonsBusy(isBusy, mode) {
  const rewriteBtn = document.getElementById('btn-ai-rewrite-step');
  const appendBtn = document.getElementById('btn-ai-append-step');
  if (!rewriteBtn || !appendBtn) return;

  rewriteBtn.disabled = isBusy;
  appendBtn.disabled = isBusy;

  if (isBusy && mode === 'rewrite') rewriteBtn.textContent = 'Rewriting...';
  if (isBusy && mode === 'append') appendBtn.textContent = 'Appending...';
  if (!isBusy) {
    rewriteBtn.textContent = 'Rewrite Step With AI';
    appendBtn.textContent = 'Append To Step With AI';
  }
}

async function handleAiStepModify(mode) {
  saveActiveStepToState();
  if (activeStepIndex === null || !editorSteps[activeStepIndex]) return;

  const provider = typeof getSelectedAiProvider === 'function' ? getSelectedAiProvider() : 'openai';
  const model = typeof getSelectedAiModel === 'function' ? getSelectedAiModel() : '';

  if (typeof isAiProviderConfigured === 'function' && !isAiProviderConfigured(provider)) {
    showToast('Configure and save a key for ' + provider + ' in Settings first.', true);
    return;
  }

  const step = editorSteps[activeStepIndex];
  const taskPrompt = ((document.getElementById('step-ai-prompt') || {}).value || '').trim();
  const tonePreset = (document.getElementById('step-ai-tone') || {}).value || 'concise';
  const aiTargetSection = _stepAiTargetSection || 'dontMissPathology';

  if (!taskPrompt && mode === 'append') {
    showToast('Add an AI instruction before append.', true);
    return;
  }

  if (String(step.linkedStepId || '').trim()) {
    const okLinked = await showConfirm(
      'Linked Step Warning',
      'This step has a Linked Step ID. Saving changes may propagate this content to other patterns using the same link.'
    );
    if (!okLinked) return;
  }

  const originalSnapshot = JSON.parse(JSON.stringify(step));
  setStepAiButtonsBusy(true, mode);

  try {
    // Get content from the target section, not the current display section
    const targetSectionContent = step.sections && step.sections[aiTargetSection]
      ? step.sections[aiTargetSection]
      : (aiTargetSection === 'searchPattern' ? step.richContent : []);

    const response = await modifyStepWithAi({
      provider,
      model,
      mode,
      tonePreset,
      taskPrompt,
      stepTitle: step.stepTitle || '',
      stepContent: richContentToPlainText(targetSectionContent),
      targetSection: aiTargetSection
    });

    const nextStep = response && response.step ? response.step : null;
    const nextText = nextStep ? String(nextStep.content || '') : '';
    if (!nextText.trim()) {
      throw new Error('AI did not return updated step content.');
    }

    const preview = nextText.length > 280 ? (nextText.slice(0, 280) + '...') : nextText;
    const okApply = await showConfirm('Apply AI Update', 'Apply this AI result to the current step?\n\nPreview:\n' + preview);
    if (!okApply) return;

    _stepAiUndoSnapshot = {
      index: activeStepIndex,
      step: originalSnapshot
    };

    // Apply AI result to the target section, not the currently displayed section
    const updatedStep = editorSteps[activeStepIndex];
    updatedStep.stepTitle = (nextStep.stepTitle || step.stepTitle || '').trim();
    
    if (!updatedStep.sections) {
      updatedStep.sections = normaliseStepSectionsForEditor(null, updatedStep.richContent || []);
    }
    updatedStep.sections[aiTargetSection] = plainTextToRichContent(nextText);
    
    // Also keep searchPattern in sync with richContent for compatibility
    if (aiTargetSection === 'searchPattern') {
      updatedStep.richContent = plainTextToRichContent(nextText).slice();
    }

    renderStepList();
    renderStepEditPanel();
    showToast('AI update applied.');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'AI step update failed.', true);
  } finally {
    setStepAiButtonsBusy(false, mode);
  }
}

function undoLastAiStepChange() {
  if (!_stepAiUndoSnapshot) return;
  if (typeof _stepAiUndoSnapshot.index !== 'number') return;
  if (!_stepAiUndoSnapshot.step) return;

  editorSteps[_stepAiUndoSnapshot.index] = JSON.parse(JSON.stringify(_stepAiUndoSnapshot.step));
  activeStepIndex = _stepAiUndoSnapshot.index;
  _stepAiUndoSnapshot = null;

  renderStepList();
  renderStepEditPanel();
  showToast('Undid AI step change.');
}

// ── Rich editor: populate from richContent ───────────────────
function populateRichEditor(editor, richContent) {
  const chunks = normaliseRichContent(richContent);
  editor.innerHTML = '';
  let currentLine = null;

  const flush = () => {
    if (currentLine) { editor.appendChild(currentLine); currentLine = null; }
  };

  chunks.forEach(chunk => {
    if (chunk.type === 'image') {
      if (!chunk.data) return;
      flush();
      const img = document.createElement('img');
      img.src = `data:image/${chunk.format || 'png'};base64,${chunk.data}`;
      img.alt = 'Embedded image';
      img.style.cursor = 'pointer';
      editor.appendChild(img);
    } else if (chunk.type === 'link') {
      if (!currentLine) { currentLine = document.createElement('div'); }
      var href = sanitiseEditorLinkUrl(chunk.url || '');
      var label = chunk.text || chunk.url || '';
      if (!href || !label) return;
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.textContent = label;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      currentLine.appendChild(anchor);
      currentLine.appendChild(document.createTextNode(' '));
    } else {
      const text = chunk.text || '';
      if (!currentLine) { currentLine = document.createElement('div'); }

      // Preserve imported newlines exactly in the editable surface.
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        if (chunk.bold || chunk.color) {
          const span = document.createElement('span');
          span.textContent = part;
          if (chunk.bold) span.style.fontWeight = '700';
          if (chunk.color === 'red')   { span.style.color = '#c0392b'; span.dataset.color = 'red'; }
          if (chunk.color === 'green') { span.style.color = '#1a7a4a'; span.dataset.color = 'green'; }
          if (chunk.color === 'blue')  { span.style.color = '#1a5c9e'; span.dataset.color = 'blue'; }
          currentLine.appendChild(span);
        } else {
          currentLine.appendChild(document.createTextNode(part));
        }

        if (i < parts.length - 1) {
          currentLine.appendChild(document.createElement('br'));
        }
      }
    }
  });
  flush();
}

// ── Rich editor: extract richContent ─────────────────────────
function extractRichContent(editor) {
  const chunks = [];

  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text) chunks.push({ type: 'text', text, bold: false, color: null });
    } else if (node.nodeName === 'IMG') {
      const src = node.src || '';
      const match = src.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        chunks.push({ type: 'image', format: match[1], data: match[2] });
      }
    } else if (node.nodeName === 'A') {
      const url = node.getAttribute('href') || '';
      const text = node.textContent || url;
      if (url || text) {
        chunks.push({ type: 'link', text, url: sanitiseEditorLinkUrl(url) });
      }
    } else if (node.nodeName === 'SPAN' || node.nodeName === 'B' || node.nodeName === 'STRONG') {
      const bold = node.style.fontWeight === '700' || node.nodeName === 'B' || node.nodeName === 'STRONG';
      const color = node.dataset.color || null;
      const text = node.textContent;
      chunks.push({ type: 'text', text, bold, color });
    } else if (node.nodeName === 'BR') {
      chunks.push({ type: 'text', text: '\n', bold: false, color: null });
    } else {
      node.childNodes.forEach(processNode);
      // Add newline after block elements
      if (['DIV', 'P', 'LI'].includes(node.nodeName) && node !== editor) {
        chunks.push({ type: 'text', text: '\n', bold: false, color: null });
      }
    }
  }

  editor.childNodes.forEach(processNode);

  // Remove trailing newlines
  while (chunks.length && chunks[chunks.length - 1].text === '\n') {
    chunks.pop();
  }

  return chunks;
}

// ── Save active step data back to state ──────────────────────
function saveActiveStepToState() {
  if (activeStepIndex === null) return;
  const titleInput = document.getElementById('step-title-input');
  const linkedIdInput = document.getElementById('step-linked-id-input');
  if (!titleInput) return;

  const activeStep = editorSteps[activeStepIndex];
  ensureStepId(activeStep);
  activeStep.stepTitle = titleInput.value;
  activeStep.linkedStepId = linkedIdInput ? linkedIdInput.value.trim() : '';

  if (!activeStep.linkedStepId && activeStep.linkMeta && activeStep.linkMeta.mode === 'internal') {
    activeStep.linkMeta = null;
  }

  if (activeStepSectionKey === 'hyperlinks') {
    const rows = document.querySelectorAll('.link-row');
    const links = [];
    rows.forEach(row => {
      const text = ((row.querySelector('.link-text-input') || {}).value || '').trim();
      const rawUrl = ((row.querySelector('.link-url-input') || {}).value || '').trim();
      const url = sanitiseEditorLinkUrl(rawUrl);
      if (url) {
        links.push({ type: 'link', text: text || url, url });
      }
    });
    setCurrentEditorSectionContent(activeStep, links);
  } else if (isSubsectionSectionKey(activeStepSectionKey)) {
    const rows = document.querySelectorAll('.subsection-row');
    const subsections = [];
    rows.forEach(row => {
      const title = ((row.querySelector('.subsection-title-input') || {}).value || '').trim();
      const rowEditor = row.querySelector('.subsection-rich-editor');
      const content = rowEditor ? extractRichContent(rowEditor) : [];
      if (!title && !hasAnyRichContent(content)) return;
      subsections.push({
        type: 'subsection',
        title: title || `Subsection ${subsections.length + 1}`,
        content: content
      });
    });
    setCurrentEditorSectionContent(activeStep, subsections);
  } else {
    const editor = document.getElementById('rich-editor');
    if (!editor) return;
    setCurrentEditorSectionContent(activeStep, extractRichContent(editor));
  }
}

// ── Hyperlink row management ─────────────────────────────────
function renderLinkRows(step) {
  const container = document.getElementById('link-rows');
  if (!container) return;
  container.innerHTML = '';
  const links = (getCurrentEditorSectionContent(step) || []).filter(c => c.type === 'link');
  links.forEach(link => container.appendChild(createLinkRow(link.text || '', link.url || '')));
}

function createLinkRow(text, url) {
  const row = document.createElement('div');
  row.className = 'link-row';
  row.innerHTML = `
    <input type="text" class="form-input link-text-input" value="${escapeHtml(text)}" placeholder="Label (e.g. Radiopaedia)">
    <input type="url" class="form-input link-url-input" value="${escapeHtml(url)}" placeholder="https://...">
    <button type="button" class="btn btn-ghost btn-sm link-del-btn" aria-label="Remove link">&#x2715;</button>
  `;
  row.querySelector('.link-del-btn').addEventListener('click', () => row.remove());
  return row;
}

function addLinkRow() {
  const container = document.getElementById('link-rows');
  if (!container) return;
  const row = createLinkRow('', '');
  container.appendChild(row);
  row.querySelector('.link-url-input').focus();
}

function hasAnyRichContent(content) {
  const chunks = normaliseRichContent(content || []);
  return chunks.some(chunk => {
    if (chunk.type === 'image') return Boolean(chunk.data);
    if (chunk.type === 'link') return Boolean((chunk.url || '').trim() || (chunk.text || '').trim());
    if (chunk.type === 'subsection') return Boolean((chunk.title || '').trim()) || hasAnyRichContent(chunk.content || []);
    return Boolean((chunk.text || '').trim());
  });
}

function getSubsectionRowsFromContent(content) {
  const chunks = normaliseRichContent(content || []);
  const rows = [];

  chunks.forEach(chunk => {
    if (chunk.type === 'subsection') {
      rows.push({
        title: (chunk.title || '').trim(),
        content: normaliseRichContent(chunk.content || [])
      });
      return;
    }
    if (chunk.type === 'text' && (chunk.text || '').trim()) {
      rows.push({
        title: `Subsection ${rows.length + 1}`,
        content: [{ type: 'text', text: chunk.text, bold: Boolean(chunk.bold), color: chunk.color || null }]
      });
      return;
    }
    if (chunk.type === 'image' || chunk.type === 'link') {
      rows.push({
        title: `Subsection ${rows.length + 1}`,
        content: [chunk]
      });
    }
  });

  return rows;
}

function renderSubsectionRows(step) {
  const container = document.getElementById('subsection-rows');
  if (!container) return;
  container.innerHTML = '';

  const rows = getSubsectionRowsFromContent(getCurrentEditorSectionContent(step));
  rows.forEach(item => container.appendChild(createSubsectionRow(item.title || '', item.content || [])));

  if (!rows.length) {
    container.appendChild(createSubsectionRow('', []));
  }
}

function createSubsectionRow(title, content) {
  const row = document.createElement('div');
  row.className = 'subsection-row';
  row.innerHTML = `
    <input type="text" class="form-input subsection-title-input" value="${escapeHtml(title)}" placeholder="Subsection title">
    <div class="rich-editor subsection-rich-editor" contenteditable="true" spellcheck="true"></div>
    <button type="button" class="btn btn-ghost btn-sm subsection-del-btn" aria-label="Remove subsection">&#x2715;</button>
  `;

  const rowEditor = row.querySelector('.subsection-rich-editor');
  populateRichEditor(rowEditor, content || []);
  rowEditor.addEventListener('paste', handleEditorPaste);

  row.querySelector('.subsection-del-btn').addEventListener('click', () => row.remove());
  return row;
}

function addSubsectionRow() {
  const container = document.getElementById('subsection-rows');
  if (!container) return;
  const row = createSubsectionRow('', []);
  container.appendChild(row);
  row.querySelector('.subsection-title-input').focus();
}

function generateLinkedStepId() {
  const input = document.getElementById('step-linked-id-input');
  if (!input) return;
  input.value = makeStepId();
  if (activeStepIndex !== null && editorSteps[activeStepIndex]) {
    const step = editorSteps[activeStepIndex];
    step.linkMeta = {
      mode: 'internal',
      sourcePatternId: editingPatternId || '',
      sourcePatternName: (document.getElementById('editor-pattern-name') || {}).value || 'Current Pattern',
      sourceStepId: String(step.stepId || '').trim(),
      sourceStepTitle: step.stepTitle || 'Current Step',
      tokenVersion: 1
    };
  }
  saveActiveStepToState();
  updateStepLinkStatus();
  renderStepList();
}

function clearLinkedStepId() {
  const input = document.getElementById('step-linked-id-input');
  const tokenInput = document.getElementById('step-link-token-input');
  if (input) input.value = '';
  if (tokenInput) tokenInput.value = '';
  if (activeStepIndex !== null && editorSteps[activeStepIndex]) {
    editorSteps[activeStepIndex].linkMeta = null;
  }
  saveActiveStepToState();
  updateStepLinkStatus();
  renderStepList();
}

function getSourceEntriesForPattern(patternId) {
  var selected = String(patternId || '');
  if (!selected) return [];
  return (_linkStepIndexByPattern[selected] || []).slice();
}

function populateStepLinkStepSelect() {
  var patternSelect = document.getElementById('step-link-pattern-select');
  var stepSelect = document.getElementById('step-link-step-select');
  if (!patternSelect || !stepSelect) return;

  var entries = getSourceEntriesForPattern(patternSelect.value);
  stepSelect.innerHTML = '';
  if (!entries.length) {
    stepSelect.innerHTML = '<option value="">No source steps found</option>';
    return;
  }

  entries.forEach(function(entry) {
    var option = document.createElement('option');
    option.value = String(entry.stepId || '');
    option.textContent = 'Step ' + (entry.stepIndex + 1) + ': ' + (entry.stepTitle || 'Untitled Step');
    stepSelect.appendChild(option);
  });
}

function updateStepLinkStatus() {
  if (activeStepIndex === null || !editorSteps[activeStepIndex]) return;
  var statusEl = document.getElementById('step-link-status');
  if (!statusEl) return;
  var status = getLinkStatusForStep(editorSteps[activeStepIndex]);
  statusEl.className = 'step-link-status step-link-status-' + status.tone;
  statusEl.textContent = status.text;
}

function findSourceEntryByStepId(stepId) {
  var target = String(stepId || '').trim();
  if (!target) return null;
  var patterns = Object.keys(_linkStepIndexByPattern || {});
  for (var i = 0; i < patterns.length; i++) {
    var entries = _linkStepIndexByPattern[patterns[i]] || [];
    for (var j = 0; j < entries.length; j++) {
      if (String(entries[j].stepId || '').trim() === target) {
        return entries[j];
      }
    }
  }
  return null;
}

function applyLinkFromPicker() {
  if (activeStepIndex === null || !editorSteps[activeStepIndex]) return;
  var patternSelect = document.getElementById('step-link-pattern-select');
  var stepSelect = document.getElementById('step-link-step-select');
  if (!patternSelect || !stepSelect) return;

  var sourceEntry = findSourceEntryByStepId(stepSelect.value);
  if (!sourceEntry) {
    showToast('Select a valid source step first.', true);
    return;
  }

  var targetStep = editorSteps[activeStepIndex];
  var linkKey = String(sourceEntry.linkKey || '').trim();
  if (!linkKey) {
    showToast('This source step has no usable link key yet.', true);
    return;
  }

  targetStep.linkedStepId = linkKey;
  targetStep.linkMeta = {
    mode: 'internal',
    sourcePatternId: sourceEntry.patternId,
    sourcePatternName: sourceEntry.patternName,
    sourceStepId: sourceEntry.stepId,
    sourceStepTitle: sourceEntry.stepTitle,
    tokenVersion: 1
  };

  targetStep.stepTitle = sourceEntry.stepTitle || targetStep.stepTitle;
  targetStep.richContent = normaliseRichContent(sourceEntry.richContent || []);
  targetStep.sections = normaliseStepSectionsForEditor(sourceEntry.sections, sourceEntry.richContent || []);

  var linkedIdInput = document.getElementById('step-linked-id-input');
  if (linkedIdInput) linkedIdInput.value = linkKey;

  saveActiveStepToState();
  updateStepLinkStatus();
  renderStepList();
  renderStepEditPanel();
  showToast('Linked step applied.');
}

function makeLinkTokenPayload(step) {
  var safeStep = cloneStepSnapshot(step);
  var linkKey = getStepLinkKey(safeStep);
  return {
    v: 1,
    kind: 'searches-step-link',
    source: {
      linkedStepId: String(safeStep.linkedStepId || '').trim() || linkKey,
      stepId: String(safeStep.stepId || '').trim(),
      patternId: editingPatternId || '',
      patternName: ((document.getElementById('editor-pattern-name') || {}).value || '').trim() || 'Unnamed Pattern',
      stepTitle: safeStep.stepTitle || ''
    },
    snapshot: {
      stepTitle: safeStep.stepTitle || '',
      stepId: safeStep.stepId,
      linkedStepId: String(safeStep.linkedStepId || '').trim() || linkKey,
      richContent: normaliseRichContent(safeStep.richContent || []),
      sections: normaliseStepSectionsForEditor(safeStep.sections, safeStep.richContent || [])
    }
  };
}

async function copyLinkToken() {
  if (activeStepIndex === null || !editorSteps[activeStepIndex]) return;
  saveActiveStepToState();
  var step = editorSteps[activeStepIndex];
  var token = encodeLinkToken(makeLinkTokenPayload(step));

  try {
    await navigator.clipboard.writeText(token);
    showToast('Link token copied.');
  } catch (err) {
    var tokenInput = document.getElementById('step-link-token-input');
    if (tokenInput) {
      tokenInput.value = token;
      tokenInput.select();
    }
    showToast('Clipboard blocked. Token is shown for manual copy.', true);
  }
}

function importLinkToken() {
  if (activeStepIndex === null || !editorSteps[activeStepIndex]) return;
  var tokenInput = document.getElementById('step-link-token-input');
  var rawToken = tokenInput ? tokenInput.value : '';

  try {
    var payload = parseLinkToken(rawToken);
    var targetStep = editorSteps[activeStepIndex];
    var source = payload.source || {};
    var snapshot = payload.snapshot || {};
    var key = String(source.linkedStepId || source.stepId || '').trim();

    var sourceEntry = key ? (_linkStepIndexByKey[key] || findSourceEntryByStepId(source.stepId || '')) : null;
    if (sourceEntry) {
      targetStep.linkedStepId = String(sourceEntry.linkKey || key).trim();
      targetStep.linkMeta = {
        mode: 'internal',
        sourcePatternId: sourceEntry.patternId,
        sourcePatternName: sourceEntry.patternName,
        sourceStepId: sourceEntry.stepId,
        sourceStepTitle: sourceEntry.stepTitle,
        tokenVersion: 1
      };
      targetStep.stepTitle = sourceEntry.stepTitle || targetStep.stepTitle;
      targetStep.richContent = normaliseRichContent(sourceEntry.richContent || []);
      targetStep.sections = normaliseStepSectionsForEditor(sourceEntry.sections, sourceEntry.richContent || []);
      showToast('Token resolved to a live link in this account.');
    } else {
      targetStep.linkedStepId = '';
      targetStep.linkMeta = {
        mode: 'snapshot',
        sourcePatternId: String(source.patternId || '').trim(),
        sourcePatternName: String(source.patternName || '').trim(),
        sourceStepId: String(source.stepId || '').trim(),
        sourceStepTitle: String(source.stepTitle || '').trim(),
        tokenVersion: 1,
        snapshot: {
          stepTitle: snapshot.stepTitle || targetStep.stepTitle || '',
          stepId: String(snapshot.stepId || '').trim() || makeStepId(),
          linkedStepId: String(snapshot.linkedStepId || '').trim(),
          richContent: normaliseRichContent(snapshot.richContent || []),
          sections: normaliseStepSectionsForEditor(snapshot.sections, snapshot.richContent || [])
        }
      };
      targetStep.stepTitle = targetStep.linkMeta.snapshot.stepTitle || targetStep.stepTitle;
      targetStep.richContent = normaliseRichContent(targetStep.linkMeta.snapshot.richContent || []);
      targetStep.sections = normaliseStepSectionsForEditor(targetStep.linkMeta.snapshot.sections, targetStep.linkMeta.snapshot.richContent || []);
      showToast('Snapshot link imported from token.');
    }

    var linkedIdInput = document.getElementById('step-linked-id-input');
    if (linkedIdInput) linkedIdInput.value = targetStep.linkedStepId || '';

    saveActiveStepToState();
    updateStepLinkStatus();
    renderStepList();
    renderStepEditPanel();
  } catch (err) {
    showToast(err.message || 'Invalid link token.', true);
  }
}

// ── Move step ────────────────────────────────────────────────
function moveStep(delta) {
  if (activeStepIndex === null) return;
  const newIdx = activeStepIndex + delta;
  if (newIdx < 0 || newIdx >= editorSteps.length) return;

  saveActiveStepToState();
  [editorSteps[activeStepIndex], editorSteps[newIdx]] = [editorSteps[newIdx], editorSteps[activeStepIndex]];
  activeStepIndex = newIdx;
  renderStepList();
  renderStepEditPanel();
}

// ── Save pattern to Firestore ────────────────────────────────
async function savePattern() {
  saveActiveStepToState();

  const name     = document.getElementById('editor-pattern-name').value.trim();
  const modality = document.getElementById('editor-modality').value;

  if (!name) {
    showToast('Please enter a pattern name.', true);
    document.getElementById('editor-pattern-name').focus();
    return;
  }

  const btn = document.getElementById('btn-editor-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const stepsForStorage = await prepareStepsForStorage(editorSteps);

    if (editingPatternId) {
      await updatePattern(editorUid, editingPatternId, { name, modality, steps: stepsForStorage });
      const updatedCount = await propagateLinkedSteps(editorUid, editingPatternId, stepsForStorage, _allPatternsRef);
      if (updatedCount > 0) {
        showToast(`Pattern updated. Synced linked steps in ${updatedCount} pattern(s).`);
      } else {
        showToast('Pattern updated.');
      }
      if (typeof rememberStepForPattern === 'function') {
        rememberStepForPattern(editingPatternId, activeStepIndex);
      }
    } else {
      const newPatternId = await createPattern(editorUid, { name, modality, steps: stepsForStorage });
      const updatedCount = await propagateLinkedSteps(editorUid, newPatternId, stepsForStorage, _allPatternsRef);
      if (updatedCount > 0) {
        showToast(`Pattern created. Synced linked steps in ${updatedCount} pattern(s).`);
      } else {
        showToast('Pattern created.');
      }
    }
    closeEditor();
  } catch (err) {
    console.error(err);
    const message = String(err && err.message ? err.message : err || '');
    if (/exceeds the maximum allowed size|cannot be written because its size/i.test(message)) {
      showToast('Failed to save: pattern is still too large. Try fewer/smaller images in this step.', true);
    } else {
      showToast('Failed to save: ' + message, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Pattern';
  }
}

async function prepareStepsForStorage(steps) {
  const srcSteps = Array.isArray(steps) ? steps : [];
  const out = [];

  for (const step of srcSteps) {
    ensureStepId(step);
    const normalizedSections = normaliseStepSectionsForEditor(step && step.sections, step && step.richContent || []);
    const compressedSections = {};

    for (const key of EDITOR_STEP_SECTION_ORDER) {
      compressedSections[key] = await compressRichContentForStorage(normalizedSections[key] || []);
    }

    // Keep legacy field lightweight to avoid duplicating large image payloads.
    const legacySearchPattern = (compressedSections.searchPattern || []).filter(function(chunk) {
      return chunk && chunk.type !== 'image' && chunk.type !== 'subsection';
    });

    out.push({
      stepTitle: (step && step.stepTitle) || '',
      stepId: String((step && step.stepId) || '').trim() || makeStepId(),
      linkedStepId: (step && step.linkedStepId) || '',
      linkMeta: (step && step.linkMeta) ? JSON.parse(JSON.stringify(step.linkMeta)) : null,
      sections: compressedSections,
      richContent: legacySearchPattern
    });
  }

  return out;
}

async function compressRichContentForStorage(richContent) {
  const chunks = normaliseRichContent(richContent || []);
  const out = [];

  for (const chunk of chunks) {
    if (!chunk) continue;

    if (chunk.type === 'image') {
      if (!chunk.data) continue;
      let data = chunk.data;
      let format = chunk.format || 'png';
      try {
        data = await compressBase64ImageForStorage(data, format);
        format = 'jpeg';
      } catch (e) {
        // Keep original chunk if compression fails.
      }
      out.push({ type: 'image', format: format, data: data });
      continue;
    }

    if (chunk.type === 'subsection') {
      out.push({
        type: 'subsection',
        title: chunk.title || '',
        content: await compressRichContentForStorage(chunk.content || [])
      });
      continue;
    }

    if (chunk.type === 'link') {
      const url = sanitiseEditorLinkUrl(chunk.url || '');
      if (!url && !(chunk.text || '').trim()) continue;
      out.push({ type: 'link', text: chunk.text || url, url: url });
      continue;
    }

    out.push({
      type: 'text',
      text: chunk.text || '',
      bold: Boolean(chunk.bold),
      color: chunk.color || null
    });
  }

  return out;
}

function compressBase64ImageForStorage(base64Data, format) {
  return new Promise(function(resolve, reject) {
    const img = new Image();
    img.onload = function() {
      const MAX = 1024;
      let w = img.width;
      let h = img.height;

      if (w > MAX || h > MAX) {
        if (w > h) {
          h = Math.round((h * MAX) / w);
          w = MAX;
        } else {
          w = Math.round((w * MAX) / h);
          h = MAX;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      const pieces = dataUrl.split(',');
      if (pieces.length < 2) {
        reject(new Error('Image compression failed'));
        return;
      }
      resolve(pieces[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/' + (format || 'png') + ';base64,' + base64Data;
  });
}

// ── Formatting helpers ───────────────────────────────────────
function execFormat(cmd) {
  document.execCommand(cmd, false, null);
}

function execColor(color) {
  const colorMap = { red: '#c0392b', green: '#1a7a4a', blue: '#1a5c9e' };
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;

  // Wrap selection in a span with data-color
  const range = sel.getRangeAt(0);
  const span = document.createElement('span');
  span.style.color = colorMap[color];
  span.dataset.color = color;
  range.surroundContents(span);
  sel.removeAllRanges();
}

function execRemoveFormat() {
  document.execCommand('removeFormat', false, null);
  // Also strip any color spans we added
  const editor = document.getElementById('rich-editor');
  if (!editor) return;
  editor.querySelectorAll('[data-color]').forEach(span => {
    span.removeAttribute('data-color');
    span.style.color = '';
  });
}

function addHyperlinkToSelection() {
  const editor = document.getElementById('rich-editor');
  if (!editor) return;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    showToast('Select text first to add a hyperlink.', true);
    return;
  }

  const existing = findParentAnchor(selection.anchorNode);
  const existingHref = existing ? (existing.getAttribute('href') || '') : '';
  const input = window.prompt('Enter hyperlink URL', existingHref || 'https://');
  if (input === null) return;
  const href = sanitiseEditorLinkUrl(input);
  if (!href) {
    showToast('Enter a valid URL.', true);
    return;
  }

  document.execCommand('createLink', false, href);
  selection.removeAllRanges();
  editor.focus();
}

function removeHyperlinkFromSelection() {
  const editor = document.getElementById('rich-editor');
  if (!editor) return;
  document.execCommand('unlink', false, null);
  editor.focus();
}

function findParentAnchor(node) {
  let current = node;
  while (current && current !== document.body) {
    if (current.nodeName === 'A') return current;
    current = current.parentNode;
  }
  return null;
}

function sanitiseEditorLinkUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw)) return raw;
  if (/^tel:/i.test(raw)) return raw;
  return 'https://' + raw;
}

// ── Image paste ──────────────────────────────────────────────
async function handlePasteImageFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const mimeType of item.types) {
        if (mimeType.startsWith('image/')) {
          const blob = await item.getType(mimeType);
          insertImageBlob(blob);
          return;
        }
      }
    }
    showToast('No image found in clipboard.', true);
  } catch {
    showToast('Could not read clipboard. Use Ctrl+V to paste directly into the editor.', true);
  }
}

function handleEditorPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const targetEditor = e.currentTarget && e.currentTarget.classList && e.currentTarget.classList.contains('rich-editor')
    ? e.currentTarget
    : document.getElementById('rich-editor');
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      insertImageBlob(blob, targetEditor);
      return;
    }
  }
}

function insertImageBlob(blob, targetEditor) {
  const reader = new FileReader();
  reader.onload = ev => {
    const editor = targetEditor || document.getElementById('rich-editor');
    if (!editor) return;
    const img = document.createElement('img');
    img.src = ev.target.result;
    img.style.cursor = 'pointer';

    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(img);
    }
  };
  reader.readAsDataURL(blob);
}

// ── Utility ──────────────────────────────────────────────────
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
        title: chunk?.title || chunk?.name || '',
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

function richContentToPlainText(richContent) {
  const chunks = normaliseRichContent(richContent);
  if (!chunks.length) return '';

  return chunks.map(chunk => {
    if (chunk.type === 'image') return '[image]';
    return chunk.text || '';
  }).join('');
}

function plainTextToRichContent(text) {
  const input = String(text || '').replace(/\r\n/g, '\n');
  if (!input) {
    return [{ type: 'text', text: '', bold: false, color: null }];
  }

  return [{ type: 'text', text: input, bold: false, color: null }];
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
