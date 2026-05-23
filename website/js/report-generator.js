// report-generator.js - report drafting workflow tied to current pattern, templates, and AI helpers.

var _reportUid = null;
var _reportTemplates = [];
var _unsubscribeReportTemplates = null;
var _reportLastDraftSections = {};
var _pendingTemplateSelection = '';
var _reportSelectedPatternId = '';
var REPORT_SECTION_FINDINGS = 'Findings';
var REPORT_SECTION_IMPRESSION = 'Impression';

function initReportGenerator(uid) {
  _reportUid = uid;
  bindReportGeneratorEvents();
  subscribeReportTemplateListForSelectedPattern();
  refreshReportPatternContext();

  window.addEventListener('pattern-selection-changed', function() {
    subscribeReportTemplateListForSelectedPattern();
    refreshReportPatternContext();
  });

  window.addEventListener('report-settings-changed', function() {
    applyDefaultSectionsIfNeeded();
  });

  applyDefaultSectionsIfNeeded();
}

function bindReportGeneratorEvents() {
  var importBtn = document.getElementById('btn-report-template-import');
  var importInput = document.getElementById('report-template-import-input');
  var templateSelect = document.getElementById('report-template-select');
  var rulesSourceSelect = document.getElementById('report-rules-source-template-select');
  var templateNameInput = document.getElementById('manual-template-name');
  var templateBodyInput = document.getElementById('manual-template-input');
  var templateRulesInput = document.getElementById('report-template-rules-input');
  var saveManualTemplateBtn = document.getElementById('btn-save-manual-template');
  var deleteManualTemplateBtn = document.getElementById('btn-delete-manual-template');
  var newManualTemplateBtn = document.getElementById('btn-new-manual-template');
  var appendTemplateBtn = document.getElementById('btn-append-template-to-body');
  var applyTemplateRulesBtn = document.getElementById('btn-apply-template-rules');
  var generateBtn = document.getElementById('btn-generate-report');
  var copyBtn = document.getElementById('btn-copy-report');
  var toggleTemplateBtn = document.getElementById('btn-toggle-template-section');
  var toggleRulesBtn = document.getElementById('btn-toggle-rules-section');

  if (importBtn && importInput) {
    importBtn.addEventListener('click', function() {
      importInput.click();
    });
    importInput.addEventListener('change', handleImportReportTemplateFile);
  }

  if (templateSelect) {
    templateSelect.addEventListener('change', handleTemplateSelectionChange);
  }

  if (templateNameInput) {
    templateNameInput.addEventListener('input', handleTemplateEditorChange);
  }

  if (templateBodyInput) {
    templateBodyInput.addEventListener('input', handleTemplateEditorChange);
  }

  if (templateRulesInput) {
    templateRulesInput.addEventListener('input', handleTemplateEditorChange);
  }

  if (rulesSourceSelect) {
    rulesSourceSelect.addEventListener('change', handleRulesSourceSelectionChange);
  }

  if (saveManualTemplateBtn) saveManualTemplateBtn.addEventListener('click', handleSaveManualTemplate);
  if (deleteManualTemplateBtn) deleteManualTemplateBtn.addEventListener('click', handleDeleteManualTemplate);
  if (newManualTemplateBtn) newManualTemplateBtn.addEventListener('click', handleNewManualTemplate);
  if (appendTemplateBtn) appendTemplateBtn.addEventListener('click', handleAppendTemplateToBody);
  if (applyTemplateRulesBtn) applyTemplateRulesBtn.addEventListener('click', handleApplyTemplateRules);
  if (generateBtn) generateBtn.addEventListener('click', handleGenerateReport);
  if (copyBtn) copyBtn.addEventListener('click', handleCopyReportOutput);
  if (toggleTemplateBtn) toggleTemplateBtn.addEventListener('click', handleToggleTemplateSection);
  if (toggleRulesBtn) toggleRulesBtn.addEventListener('click', handleToggleRulesSection);

  // Restore collapse state from localStorage.
  var templateCard = document.querySelector('.report-sidebar-card');
  if (templateCard && localStorage.getItem('reportTemplateSectionCollapsed') === '1') {
    templateCard.classList.add('template-collapsed');
    if (toggleTemplateBtn) {
      toggleTemplateBtn.setAttribute('aria-expanded', 'false');
      toggleTemplateBtn.title = 'Expand template section';
    }
  }

  var rulesCard = document.querySelector('.report-rules-card');
  if (rulesCard && localStorage.getItem('reportRulesSectionCollapsed') === '1') {
    rulesCard.classList.add('template-collapsed');
    if (toggleRulesBtn) {
      toggleRulesBtn.setAttribute('aria-expanded', 'false');
      toggleRulesBtn.title = 'Expand additional rules section';
    }
  }
}

function handleToggleTemplateSection() {
  var card = document.querySelector('.report-sidebar-card');
  var btn = document.getElementById('btn-toggle-template-section');
  if (!card) return;
  var collapsed = card.classList.toggle('template-collapsed');
  localStorage.setItem('reportTemplateSectionCollapsed', collapsed ? '1' : '0');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.title = collapsed ? 'Expand template section' : 'Collapse template section';
  }
}

function handleToggleRulesSection() {
  var card = document.querySelector('.report-rules-card');
  var btn = document.getElementById('btn-toggle-rules-section');
  if (!card) return;
  var collapsed = card.classList.toggle('template-collapsed');
  localStorage.setItem('reportRulesSectionCollapsed', collapsed ? '1' : '0');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.title = collapsed ? 'Expand additional rules section' : 'Collapse additional rules section';
  }
}

function subscribeReportTemplateListForSelectedPattern() {
  if (!_reportUid) return;

  var pattern = getSelectedPatternForReport();
  var patternId = String((pattern && pattern.id) || '').trim();
  _reportSelectedPatternId = patternId;

  // If already subscribed to all templates, just re-render with new pattern context
  if (_unsubscribeReportTemplates) {
    renderReportTemplateOptions();
    renderRulesSourceTemplateOptions();
    refreshReportPatternContext();
    return;
  }

  if (typeof subscribeAllReportTemplates !== 'function') return;

  _unsubscribeReportTemplates = subscribeAllReportTemplates(_reportUid, function(templates) {
    _reportTemplates = Array.isArray(templates) ? templates : [];
    renderReportTemplateOptions();
    renderRulesSourceTemplateOptions();
    refreshReportPatternContext();
  });
}

function renderReportTemplateOptions() {
  var select = document.getElementById('report-template-select');
  if (!select) return;

  var selected = String(_pendingTemplateSelection || select.value || '').trim();

  var patternTemplates = _reportTemplates.filter(function(t) {
    return t.patternId === _reportSelectedPatternId && _reportSelectedPatternId;
  }).slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
  var otherTemplates = _reportTemplates.filter(function(t) {
    return t.patternId !== _reportSelectedPatternId || !_reportSelectedPatternId;
  }).slice().sort(function(a, b) { return a.name.localeCompare(b.name); });

  function makeOption(template) {
    return '<option value="' + escapeHtmlAttr(template.id) + '">' + escapeHtmlText(template.name) + '</option>';
  }

  var html = '<option value="">No template</option>';

  if (patternTemplates.length) {
    html += '<optgroup label="This pattern">';
    patternTemplates.forEach(function(t) { html += makeOption(t); });
    html += '</optgroup>';
  }

  if (otherTemplates.length) {
    html += '<optgroup label="All templates">';
    otherTemplates.forEach(function(t) { html += makeOption(t); });
    html += '</optgroup>';
  }

  select.innerHTML = html;

  var hasSelected = selected && _reportTemplates.some(function(item) { return item.id === selected; });
  if (hasSelected) {
    select.value = selected;
    _pendingTemplateSelection = '';
  } else {
    select.value = '';
  }

  populateTemplateEditorFromSelection();
}

function renderRulesSourceTemplateOptions() {
  var select = document.getElementById('report-rules-source-template-select');
  if (!select) return;

  var selectedValue = String(select.value || '').trim();
  var patternTemplates = _reportTemplates.filter(function(t) {
    return t.patternId === _reportSelectedPatternId && _reportSelectedPatternId;
  }).slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
  var otherTemplates = _reportTemplates.filter(function(t) {
    return t.patternId !== _reportSelectedPatternId || !_reportSelectedPatternId;
  }).slice().sort(function(a, b) { return a.name.localeCompare(b.name); });

  function makeOption(template) {
    var label = template.name;
    if (!String(template.rulesText || '').trim()) label += ' (no rules)';
    return '<option value="' + escapeHtmlAttr(template.id) + '">' + escapeHtmlText(label) + '</option>';
  }

  var html = '<option value="">Select a template with saved rules</option>';
  if (patternTemplates.length) {
    html += '<optgroup label="This pattern">';
    patternTemplates.forEach(function(t) { html += makeOption(t); });
    html += '</optgroup>';
  }
  if (otherTemplates.length) {
    html += '<optgroup label="All templates">';
    otherTemplates.forEach(function(t) { html += makeOption(t); });
    html += '</optgroup>';
  }

  select.innerHTML = html;
  if (selectedValue && _reportTemplates.some(function(item) { return item.id === selectedValue; })) {
    select.value = selectedValue;
  } else {
    select.value = '';
  }

  updateCollapsedRulesPreview();
}

function getEffectiveTemplateRulesText() {
  var rulesEl = document.getElementById('report-template-rules-input');
  var editorRulesText = rulesEl ? String(rulesEl.value || '').trim() : '';
  if (editorRulesText) return editorRulesText;

  var selectedTemplate = getSelectedTemplate();
  if (selectedTemplate && String(selectedTemplate.rulesText || '').trim()) {
    return String(selectedTemplate.rulesText || '').trim();
  }

  return '';
}

function updateCollapsedRulesPreview() {
  var previewEl = document.getElementById('report-rules-collapsed-preview');
  if (!previewEl) return;

  var rulesText = getEffectiveTemplateRulesText();
  var summary = rulesText || 'No template-specific rules are currently applied.';
  var singleLineSummary = summary.replace(/\s+/g, ' ').trim();

  previewEl.textContent = singleLineSummary;
  previewEl.title = summary;
}

function getSelectedPatternForReport() {
  if (typeof getSelectedPattern === 'function') return getSelectedPattern();
  return null;
}

function getPatternReportConfig(pattern) {
  return (pattern && pattern.reportConfig && typeof pattern.reportConfig === 'object') ? pattern.reportConfig : {};
}

function getPatternTemplateUsageCounts(pattern) {
  var cfg = getPatternReportConfig(pattern);
  var rawCounts = (cfg.templateUsageCounts && typeof cfg.templateUsageCounts === 'object') ? cfg.templateUsageCounts : {};
  var counts = {};

  Object.keys(rawCounts).forEach(function(templateId) {
    var safeTemplateId = String(templateId || '').trim();
    var count = Number(rawCounts[templateId]);
    if (!safeTemplateId || !Number.isFinite(count) || count <= 0) return;
    counts[safeTemplateId] = Math.floor(count);
  });

  return counts;
}

function getMostUsedTemplateIdForPattern(pattern) {
  var patternId = String((pattern && pattern.id) || '').trim();
  if (!patternId) return '';

  var counts = getPatternTemplateUsageCounts(pattern);
  var patternTemplates = _reportTemplates.filter(function(template) {
    return template && template.patternId === patternId;
  });
  var bestTemplateId = '';
  var bestTemplateName = '';
  var bestCount = 0;

  patternTemplates.forEach(function(template) {
    var templateId = String((template && template.id) || '').trim();
    var templateName = String((template && template.name) || '').trim();
    var count = Number(counts[templateId] || 0);
    if (count > bestCount) {
      bestTemplateId = templateId;
      bestTemplateName = templateName;
      bestCount = count;
      return;
    }
    if (count === bestCount && count > 0 && templateName.localeCompare(bestTemplateName) < 0) {
      bestTemplateId = templateId;
      bestTemplateName = templateName;
    }
  });

  return bestTemplateId;
}

function buildPatternReportConfig(pattern, template, options) {
  var cfg = getPatternReportConfig(pattern);
  var counts = getPatternTemplateUsageCounts(pattern);
  var selectedTemplateId = template ? String(template.id || '').trim() : '';
  var selectedTemplateName = template ? String(template.name || '').trim() : '';
  var sectionOrder = getRequestedReportSections();

  if (options && options.incrementUsage && selectedTemplateId) {
    counts[selectedTemplateId] = Number(counts[selectedTemplateId] || 0) + 1;
  }

  return {
    selectedTemplateId: selectedTemplateId || String(cfg.selectedTemplateId || '').trim(),
    selectedTemplateName: selectedTemplateName || String(cfg.selectedTemplateName || '').trim(),
    sectionOrder: sectionOrder.length ? sectionOrder : (Array.isArray(cfg.sectionOrder) ? cfg.sectionOrder.slice() : []),
    templateUsageCounts: counts
  };
}

function persistPatternTemplateUsage(pattern, template, options) {
  if (!pattern || !_reportUid || typeof updatePatternReportConfig !== 'function') {
    return Promise.resolve();
  }
  return updatePatternReportConfig(_reportUid, pattern.id, buildPatternReportConfig(pattern, template, options));
}

function refreshReportPatternContext() {
  var contextEl = document.getElementById('report-pattern-context');
  var templateSelectEl = document.getElementById('report-template-select');

  var pattern = getSelectedPatternForReport();
  if (!contextEl || !templateSelectEl) return;

  if (!pattern) {
    contextEl.textContent = 'No search pattern selected. Select one in Search Patterns to attach report context.';
    return;
  }

  contextEl.textContent = pattern.name + ' (' + (pattern.modality || 'Other') + ')';

  var cfg = getPatternReportConfig(pattern);
  var templateId = String(cfg.selectedTemplateId || '').trim();
  var hasConfiguredTemplate = templateId && _reportTemplates.some(function(item) {
    return item.id === templateId && item.patternId === pattern.id;
  });
  var preferredTemplateId = hasConfiguredTemplate ? templateId : getMostUsedTemplateIdForPattern(pattern);

  // Only auto-select the configured template when the dropdown is currently blank.
  // Do not override a template the user has already selected or is editing.
  if (preferredTemplateId && !templateSelectEl.value) {
    templateSelectEl.value = preferredTemplateId;
    _pendingTemplateSelection = preferredTemplateId;
    populateTemplateEditorFromSelection();
  }
}

function getReportSettingsSnapshotSafe() {
  if (typeof getReportGeneratorSettings === 'function') {
    return getReportGeneratorSettings();
  }
  return {
    defaultSections: ['Findings', 'Impression'],
    globalRulesText: ''
  };
}

function getReportLanguageMode() {
  var select = document.getElementById('report-findings-language-mode');
  var mode = select ? String(select.value || '').trim() : '';
  if (mode === 'keep' || mode === 'omit') return mode;
  return 'improve';
}

function getReportImpressionMode() {
  var select = document.getElementById('report-impression-mode');
  var mode = select ? String(select.value || '').trim() : '';
  if (mode === 'expound' || mode === 'omit') return mode;
  return 'concise';
}

function getRequestedReportSections() {
  var sections = [];
  if (getReportLanguageMode() !== 'omit') sections.push(REPORT_SECTION_FINDINGS);
  if (getReportImpressionMode() !== 'omit') sections.push(REPORT_SECTION_IMPRESSION);
  return sections;
}

function escapeHtmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeHtmlAttr(value) {
  return escapeHtmlText(value).replace(/`/g, '&#096;');
}

function getSelectedTemplate() {
  var select = document.getElementById('report-template-select');
  var templateId = select ? String(select.value || '').trim() : '';
  if (!templateId) return null;
  return _reportTemplates.find(function(item) { return item.id === templateId; }) || null;
}

function getTemplateEditorState() {
  var nameEl = document.getElementById('manual-template-name');
  var bodyEl = document.getElementById('manual-template-input');
  var rulesEl = document.getElementById('report-template-rules-input');
  return {
    name: nameEl ? String(nameEl.value || '').trim() : '',
    body: bodyEl ? String(bodyEl.value || '').trim() : '',
    rulesText: rulesEl ? String(rulesEl.value || '').trim() : ''
  };
}

function getManualTemplateText() {
  var inputEl = document.getElementById('manual-template-input');
  return inputEl ? String(inputEl.value || '').trim() : '';
}

function populateTemplateEditorFromSelection() {
  var selected = getSelectedTemplate();
  var nameEl = document.getElementById('manual-template-name');
  var bodyEl = document.getElementById('manual-template-input');
  var rulesEl = document.getElementById('report-template-rules-input');

  if (!nameEl || !bodyEl || !rulesEl) return;

  if (!selected) {
    nameEl.value = '';
    bodyEl.value = '';
    rulesEl.value = '';
    updateCollapsedRulesPreview();
    return;
  }

  nameEl.value = selected.name || '';
  bodyEl.value = selected.body || '';
  rulesEl.value = selected.rulesText || '';
  updateCollapsedRulesPreview();
}

function handleTemplateSelectionChange() {
  var select = document.getElementById('report-template-select');
  _pendingTemplateSelection = select ? String(select.value || '').trim() : '';
  populateTemplateEditorFromSelection();
}

function handleTemplateEditorChange() {
  var selected = getSelectedTemplate();
  if (selected) {
    _pendingTemplateSelection = selected.id;
  }
  updateCollapsedRulesPreview();
}

function handleRulesSourceSelectionChange() {
  var select = document.getElementById('report-rules-source-template-select');
  var selectedId = select ? String(select.value || '').trim() : '';
  if (!selectedId) return;
}

function setSelectedTemplateById(templateId) {
  var select = document.getElementById('report-template-select');
  var value = String(templateId || '').trim();
  if (!select || !value) return;
  select.value = value;
  _pendingTemplateSelection = value;
  populateTemplateEditorFromSelection();
}

function setReportStatus(text, isError) {
  var el = document.getElementById('report-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--danger)' : '';
}

function stripRtfToText(raw) {
  var text = String(raw || '');
  // Convert common escaped paragraph/line breaks first.
  text = text.replace(/\\par[d]?\b/gi, '\n');
  text = text.replace(/\\line\b/gi, '\n');
  // Decode hex escapes like \'e9.
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, function(_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
  // Remove control words and escaped braces/backslashes.
  text = text.replace(/\\[a-z]+-?\d* ?/gi, '');
  text = text.replace(/\\([{}\\])/g, '$1');
  // Remove remaining braces from groups.
  text = text.replace(/[{}]/g, '');
  // Normalize whitespace.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function flattenRichContent(items) {
  var chunks = Array.isArray(items) ? items : [];
  var lines = [];
  chunks.forEach(function(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.type === 'text') {
      if (chunk.text) lines.push(String(chunk.text));
      return;
    }
    if (chunk.type === 'link') {
      var text = String(chunk.text || chunk.url || '').trim();
      var url = String(chunk.url || '').trim();
      lines.push(text + (url ? ' (' + url + ')' : ''));
      return;
    }
    if (chunk.type === 'image') {
      lines.push('[Image]');
      return;
    }
    if (chunk.type === 'subsection') {
      var title = String(chunk.title || '').trim();
      if (title) lines.push(title + ':');
      lines.push(flattenRichContent(chunk.content || []));
    }
  });
  return lines.filter(Boolean).join('\n');
}

function flattenPatternForReport(pattern) {
  if (!pattern) return '';
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  var lines = [];
  var imageEntries = [];
  var MAX_IMAGE_COUNT = 8;
  var MAX_IMAGE_DATA_CHARS = 1600;

  function captureImageContext(chunk, stepTitle, sectionName, ordinal) {
    if (!chunk || chunk.type !== 'image') return;
    if (imageEntries.length >= MAX_IMAGE_COUNT) return;

    var format = String(chunk.format || 'png').trim() || 'png';
    var data = String(chunk.data || '').trim();
    if (!data) return;

    var dataUrl = 'data:image/' + format + ';base64,' + data;
    var truncated = false;
    if (dataUrl.length > MAX_IMAGE_DATA_CHARS) {
      dataUrl = dataUrl.slice(0, MAX_IMAGE_DATA_CHARS);
      truncated = true;
    }

    imageEntries.push({
      stepTitle: stepTitle,
      sectionName: sectionName,
      imageIndex: ordinal,
      format: format,
      dataUrl: dataUrl,
      truncated: truncated
    });
  }

  function flattenRichContentWithImages(items, sectionName, stepTitle, imageCounterRef) {
    var chunks = Array.isArray(items) ? items : [];
    var localLines = [];
    chunks.forEach(function(chunk) {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.type === 'text') {
        if (chunk.text) localLines.push(String(chunk.text));
        return;
      }
      if (chunk.type === 'link') {
        var linkText = String(chunk.text || chunk.url || '').trim();
        var url = String(chunk.url || '').trim();
        localLines.push(linkText + (url ? ' (' + url + ')' : ''));
        return;
      }
      if (chunk.type === 'image') {
        imageCounterRef.count += 1;
        captureImageContext(chunk, stepTitle, sectionName, imageCounterRef.count);
        localLines.push('[Image ' + imageCounterRef.count + ']');
        return;
      }
      if (chunk.type === 'subsection') {
        var title = String(chunk.title || '').trim();
        if (title) localLines.push(title + ':');
        localLines.push(flattenRichContentWithImages(chunk.content || [], sectionName, stepTitle, imageCounterRef));
      }
    });
    return localLines.filter(Boolean).join('\n');
  }

  steps.forEach(function(step, idx) {
    var title = String((step && step.stepTitle) || '').trim() || ('Step ' + (idx + 1));
    var sections = (step && step.sections && typeof step.sections === 'object') ? step.sections : {};
    var imageCounter = { count: 0 };
    var findings = flattenRichContentWithImages(sections.dontMissPathology || [], 'Findings', title, imageCounter);
    var searchPattern = flattenRichContentWithImages(sections.searchPattern || step.richContent || [], 'Search Pattern', title, imageCounter);

    lines.push('[' + title + ']');
    if (searchPattern) lines.push('Search Pattern:\n' + searchPattern);
    if (findings) lines.push('Findings:\n' + findings);
    lines.push('');
  });

  if (imageEntries.length) {
    lines.push('IMAGE CONTEXT (search pattern images included for AI context):');
    imageEntries.forEach(function(entry, index) {
      lines.push(
        'Image ' + (index + 1) +
        ' | step=' + entry.stepTitle +
        ' | section=' + entry.sectionName +
        ' | ordinal=' + entry.imageIndex +
        ' | format=' + entry.format +
        ' | truncated=' + (entry.truncated ? 'yes' : 'no') +
        ' | dataUrl=' + entry.dataUrl
      );
    });
  }

  return lines.join('\n').trim();
}

function renderDraftSections(sections) {
  var orderedKeys = Object.keys(sections || {});
  var output = orderedKeys.map(function(key) {
    return key.toUpperCase() + ':\n' + String(sections[key] || '').trim();
  }).join('\n\n');
  var outEl = document.getElementById('report-output');
  if (outEl) outEl.value = output;
}

async function handleGenerateReport() {
  var findingsEl = document.getElementById('report-findings-input');
  if (!findingsEl) return;

  var findings = String(findingsEl.value || '').trim();
  var settings = getReportSettingsSnapshotSafe();
  var pattern = getSelectedPatternForReport();
  var template = getSelectedTemplate();
  var templateState = getTemplateEditorState();
  var findingsLanguageMode = getReportLanguageMode();
  var impressionMode = getReportImpressionMode();
  var requestedSections = getRequestedReportSections();

  if (!requestedSections.length) {
    setReportStatus('Enable at least one output section before generating a report.', true);
    return;
  }

  setReportStatus('Generating report...');

  try {
    var result = await generateRadiologyReportWithAi({
      provider: typeof getSelectedAiProvider === 'function' ? getSelectedAiProvider() : 'openai',
      model: typeof getSelectedAiModel === 'function' ? getSelectedAiModel() : '',
      findings: findings,
      sectionOrder: requestedSections,
      findingsLanguageMode: findingsLanguageMode,
      impressionMode: impressionMode,
      templateText: templateState.body || (template ? template.body : ''),
      templateRulesText: templateState.rulesText || (template ? template.rulesText : ''),
      globalRulesText: String(settings.globalRulesText || '')
    });

    _reportLastDraftSections = result.sections || {};
    renderDraftSections(_reportLastDraftSections);
    await persistPatternTemplateUsage(pattern, template, { incrementUsage: true });
    setReportStatus('Draft generated.');
    if (typeof showToast === 'function') showToast('Report draft generated.');
  } catch (err) {
    setReportStatus((err && err.message) || 'Failed to generate report.', true);
    if (typeof showToast === 'function') showToast((err && err.message) || 'Failed to generate report.', true);
  }
}

async function handleImportReportTemplateFile(e) {
  var input = e && e.target ? e.target : null;
  var file = input && input.files && input.files[0] ? input.files[0] : null;
  if (!file || !_reportUid || typeof upsertReportTemplate !== 'function') return;

  var lowerName = String(file.name || '').toLowerCase();
  var isTxt = lowerName.endsWith('.txt');
  var isRtf = lowerName.endsWith('.rtf');
  if (!isTxt && !isRtf) {
    setReportStatus('Only .rtf and .txt templates are supported.', true);
    if (typeof showToast === 'function') showToast('Only .rtf and .txt templates are supported.', true);
    if (input) input.value = '';
    return;
  }

  try {
    var raw = await file.text();
    var name = file.name.replace(/\.[^.]+$/, '');
    var body = isRtf ? stripRtfToText(raw) : raw;

    if (!_reportSelectedPatternId) {
      setReportStatus('Select a search pattern before importing a template.', true);
      if (typeof showToast === 'function') showToast('Select a search pattern before importing a template.', true);
      return;
    }

    var templateId = await upsertReportTemplate(_reportUid, '', {
      name: name,
      body: body,
      patternId: _reportSelectedPatternId
    });
    if (templateId) setSelectedTemplateById(templateId);
    setReportStatus('Template imported (' + (isRtf ? 'RTF parsed' : 'TXT') + ').');
    if (typeof showToast === 'function') showToast('Template imported.');
  } catch (err) {
    setReportStatus((err && err.message) || 'Failed to import template.', true);
    if (typeof showToast === 'function') showToast((err && err.message) || 'Failed to import template.', true);
  } finally {
    if (input) input.value = '';
  }
}

async function handleSavePatternReportConfig() {
  var pattern = getSelectedPatternForReport();
  var template = getSelectedTemplate();

  if (!pattern || !_reportUid || typeof updatePatternReportConfig !== 'function') {
    setReportStatus('Select a search pattern first.', true);
    return;
  }

  try {
    await persistPatternTemplateUsage(pattern, template, { incrementUsage: false });
    setReportStatus('Pattern report config saved.');
    if (typeof showToast === 'function') showToast('Pattern report config saved.');
  } catch (err) {
    setReportStatus((err && err.message) || 'Failed to save pattern report config.', true);
    if (typeof showToast === 'function') showToast((err && err.message) || 'Failed to save pattern report config.', true);
  }
}

function handleCopyReportOutput() {
  var outputEl = document.getElementById('report-output');
  if (!outputEl) return;

  var text = String(outputEl.value || '').trim();
  if (!text) {
    setReportStatus('No report text to copy.', true);
    return;
  }

  if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      setReportStatus('Report copied to clipboard.');
      if (typeof showToast === 'function') showToast('Report copied.');
    }).catch(function() {
      setReportStatus('Failed to copy report.', true);
    });
    return;
  }

  outputEl.focus();
  outputEl.select();
  try {
    document.execCommand('copy');
    setReportStatus('Report copied to clipboard.');
    if (typeof showToast === 'function') showToast('Report copied.');
  } catch (err) {
    setReportStatus('Failed to copy report.', true);
  }
}

function handleSaveManualTemplate() {
  if (!_reportUid || typeof upsertReportTemplate !== 'function') return;

  if (!_reportSelectedPatternId) {
    setReportStatus('Select a search pattern before saving a template.', true);
    return;
  }

  var templateState = getTemplateEditorState();
  if (!templateState.body) {
    setReportStatus('Please enter template text before saving.', true);
    return;
  }

  var selected = getSelectedTemplate();
  var templateId = selected ? selected.id : '';
  var templateName = templateState.name || (selected ? selected.name : '') || 'Manual Template';

  upsertReportTemplate(_reportUid, templateId, {
    name: templateName,
    body: templateState.body,
    rulesText: templateState.rulesText,
    patternId: _reportSelectedPatternId
  })
    .then(function(savedTemplateId) {
      if (savedTemplateId) setSelectedTemplateById(savedTemplateId);
      setReportStatus(templateId ? 'Template updated.' : 'Template saved.');
      if (typeof showToast === 'function') showToast('Manual template saved.');
      // Also persist the selected template on the pattern
      var pattern = getSelectedPatternForReport();
      var effectiveTemplateId = String(savedTemplateId || templateId || '').trim();
      var effectiveTemplate = effectiveTemplateId
        ? (_reportTemplates.find(function(item) { return item.id === effectiveTemplateId; }) || {
            id: effectiveTemplateId,
            name: templateName
          })
        : null;
      if (pattern) {
        persistPatternTemplateUsage(pattern, effectiveTemplate, { incrementUsage: false }).catch(function() {});
      }
    })
    .catch(function(err) {
      setReportStatus((err && err.message) || 'Failed to save manual template.', true);
      if (typeof showToast === 'function') showToast((err && err.message) || 'Failed to save manual template.', true);
    });
}

function handleAppendTemplateToBody() {
  var selected = getSelectedTemplate();
  if (!selected || !selected.body) {
    setReportStatus('Select a template to append.', true);
    return;
  }
  var bodyEl = document.getElementById('manual-template-input');
  if (!bodyEl) return;
  var current = String(bodyEl.value || '');
  bodyEl.value = current ? current.trimEnd() + '\n\n' + selected.body : selected.body;
  handleTemplateEditorChange();
}

function handleNewManualTemplate() {
  var select = document.getElementById('report-template-select');
  var nameInput = document.getElementById('manual-template-name');
  var bodyInput = document.getElementById('manual-template-input');
  var rulesInput = document.getElementById('report-template-rules-input');
  if (select) select.value = '';
  if (nameInput) nameInput.value = '';
  if (bodyInput) bodyInput.value = '';
  if (rulesInput) rulesInput.value = '';
  _pendingTemplateSelection = '';
  handleTemplateEditorChange();
  if (nameInput) nameInput.focus();
}

function handleApplyTemplateRules() {
  var sourceSelect = document.getElementById('report-rules-source-template-select');
  var rulesInput = document.getElementById('report-template-rules-input');
  var sourceId = sourceSelect ? String(sourceSelect.value || '').trim() : '';
  if (!sourceId || !rulesInput) {
    setReportStatus('Select a template with saved rules first.', true);
    return;
  }

  var sourceTemplate = _reportTemplates.find(function(item) { return item.id === sourceId; }) || null;
  if (!sourceTemplate || !String(sourceTemplate.rulesText || '').trim()) {
    setReportStatus('The selected template does not have saved rules.', true);
    return;
  }

  rulesInput.value = String(sourceTemplate.rulesText || '');
  handleTemplateEditorChange();
  setReportStatus('Rules copied from "' + sourceTemplate.name + '". Save this template to persist them.');
}

async function handleDeleteManualTemplate() {
  var selected = getSelectedTemplate();
  if (!selected || !_reportUid || typeof deleteReportTemplate !== 'function') {
    setReportStatus('Select a template to delete.', true);
    return;
  }

  var confirmed = true;
  if (typeof showConfirm === 'function') {
    confirmed = await showConfirm('Delete template?', 'Delete "' + selected.name + '"? This cannot be undone.');
  } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    confirmed = window.confirm('Delete "' + selected.name + '"? This cannot be undone.');
  }

  if (!confirmed) return;

  try {
    await deleteReportTemplate(_reportUid, selected.id);
    _pendingTemplateSelection = '';
    var select = document.getElementById('report-template-select');
    if (select) select.value = '';
    populateTemplateEditorFromSelection();
    setReportStatus('Template deleted.');
    if (typeof showToast === 'function') showToast('Template deleted.');
  } catch (err) {
    setReportStatus((err && err.message) || 'Failed to delete template.', true);
    if (typeof showToast === 'function') showToast((err && err.message) || 'Failed to delete template.', true);
  }
}
