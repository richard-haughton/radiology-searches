// report-generator.js - report drafting workflow tied to current pattern, templates, and AI helpers.

var _reportUid = null;
var _reportTemplates = [];
var _unsubscribeReportTemplates = null;
var _reportLastDraftSections = {};

function initReportGenerator(uid) {
  _reportUid = uid;
  bindReportGeneratorEvents();
  subscribeReportTemplateList();
  refreshReportPatternContext();

  window.addEventListener('pattern-selection-changed', function() {
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
  var savePatternBtn = document.getElementById('btn-save-pattern-report-config');
  var generateBtn = document.getElementById('btn-generate-report');
  var copyBtn = document.getElementById('btn-copy-report');

  if (importBtn && importInput) {
    importBtn.addEventListener('click', function() {
      importInput.click();
    });
    importInput.addEventListener('change', handleImportReportTemplateFile);
  }

  if (savePatternBtn) savePatternBtn.addEventListener('click', handleSavePatternReportConfig);
  if (generateBtn) generateBtn.addEventListener('click', handleGenerateReport);
  if (copyBtn) copyBtn.addEventListener('click', handleCopyReportOutput);
}

function subscribeReportTemplateList() {
  if (!_reportUid || typeof subscribeReportTemplates !== 'function') return;
  if (_unsubscribeReportTemplates) {
    _unsubscribeReportTemplates();
    _unsubscribeReportTemplates = null;
  }

  _unsubscribeReportTemplates = subscribeReportTemplates(_reportUid, function(templates) {
    _reportTemplates = Array.isArray(templates) ? templates : [];
    renderReportTemplateOptions();
    refreshReportPatternContext();
  });
}

function renderReportTemplateOptions() {
  var select = document.getElementById('report-template-select');
  if (!select) return;

  var selected = String(select.value || '').trim();
  var options = ['<option value="">No template</option>'];
  _reportTemplates.forEach(function(template) {
    options.push('<option value="' + escapeHtmlAttr(template.id) + '">' + escapeHtmlText(template.name) + '</option>');
  });
  select.innerHTML = options.join('');

  var hasSelected = selected && _reportTemplates.some(function(item) { return item.id === selected; });
  select.value = hasSelected ? selected : '';
}

function getSelectedPatternForReport() {
  if (typeof getSelectedPattern === 'function') return getSelectedPattern();
  return null;
}

function refreshReportPatternContext() {
  var contextEl = document.getElementById('report-pattern-context');
  var sectionOrderEl = document.getElementById('report-section-order');
  var templateSelectEl = document.getElementById('report-template-select');

  var pattern = getSelectedPatternForReport();
  if (!contextEl || !sectionOrderEl || !templateSelectEl) return;

  if (!pattern) {
    contextEl.textContent = 'No search pattern selected. Select one in Search Patterns to attach report context.';
    if (!sectionOrderEl.value.trim()) applyDefaultSectionsIfNeeded();
    return;
  }

  contextEl.textContent = pattern.name + ' (' + (pattern.modality || 'Other') + ')';

  var cfg = (pattern.reportConfig && typeof pattern.reportConfig === 'object') ? pattern.reportConfig : {};

  if (Array.isArray(cfg.sectionOrder) && cfg.sectionOrder.length) {
    sectionOrderEl.value = cfg.sectionOrder.join(', ');
  } else if (!sectionOrderEl.value.trim()) {
    applyDefaultSectionsIfNeeded();
  }

  var templateId = String(cfg.selectedTemplateId || '').trim();
  if (templateId) templateSelectEl.value = templateId;
}

function parseSectionOrderInput(raw, fallback) {
  var items = String(raw || '').split(',').map(function(item) { return item.trim(); }).filter(Boolean);
  if (items.length) return items;
  if (Array.isArray(fallback) && fallback.length) return fallback.slice();
  return ['Findings', 'Impression'];
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

function applyDefaultSectionsIfNeeded() {
  var sectionInput = document.getElementById('report-section-order');
  if (!sectionInput) return;
  if (sectionInput.value && sectionInput.value.trim()) return;

  var settings = getReportSettingsSnapshotSafe();
  var sections = Array.isArray(settings.defaultSections) && settings.defaultSections.length
    ? settings.defaultSections
    : ['Findings', 'Impression'];
  sectionInput.value = sections.join(', ');
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
  var sectionOrderEl = document.getElementById('report-section-order');
  if (!findingsEl || !sectionOrderEl) return;

  var findings = String(findingsEl.value || '').trim();
  if (!findings) {
    setReportStatus('Please enter findings before generating.', true);
    return;
  }

  var settings = getReportSettingsSnapshotSafe();
  var pattern = getSelectedPatternForReport();
  var template = getSelectedTemplate();
  var sections = parseSectionOrderInput(sectionOrderEl.value, settings.defaultSections);

  setReportStatus('Generating report...');

  try {
    var result = await generateRadiologyReportWithAi({
      provider: typeof getSelectedAiProvider === 'function' ? getSelectedAiProvider() : 'openai',
      model: typeof getSelectedAiModel === 'function' ? getSelectedAiModel() : '',
      findings: findings,
      sectionOrder: sections,
      templateText: template ? template.body : '',
      globalRulesText: String(settings.globalRulesText || '')
    });

    _reportLastDraftSections = result.sections || {};
    renderDraftSections(_reportLastDraftSections);
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

    await upsertReportTemplate(_reportUid, '', { name: name, body: body });
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
  var sectionOrderEl = document.getElementById('report-section-order');
  var template = getSelectedTemplate();

  if (!pattern || !_reportUid || typeof updatePatternReportConfig !== 'function') {
    setReportStatus('Select a search pattern first.', true);
    return;
  }

  if (!sectionOrderEl) return;

  try {
    await updatePatternReportConfig(_reportUid, pattern.id, {
      selectedTemplateId: template ? template.id : '',
      selectedTemplateName: template ? template.name : '',
      sectionOrder: parseSectionOrderInput(sectionOrderEl.value, ['Findings', 'Impression'])
    });
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
