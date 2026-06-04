// notes-search.js — plain script, no modules. Depends on db.js, patterns.js and app.js globals.

var _notesSearchUid = null;
var _notesSearchUnsubscribe = null;
var _notesSearchRecords = [];
var _notesSearchIndexReady = false;
var _notesSearchLastResults = [];
var _findingsAddContext = null;
var _findingsCreateContext = null;
var _notesSearchActiveModality = 'All';
var _notesSearchRedOnly = false;

var NOTES_SEARCH_SECTION_LABELS = {
  searchPattern: 'Search Pattern',
  dontMissPathology: 'Findings'
};

var NOTES_SEARCH_STOP_WORDS = {
  a: 1, an: 1, and: 1, are: 1, as: 1, at: 1, be: 1, by: 1, for: 1, from: 1, in: 1,
  into: 1, is: 1, it: 1, of: 1, on: 1, or: 1, that: 1, the: 1, to: 1, with: 1,
  derivation: 1, derivations: 1, related: 1, similar: 1, about: 1
};

function initNotesSearch(userId) {
  _notesSearchUid = userId;
  bindNotesSearchUi();
  startNotesSearchSubscription();
}

function bindNotesSearchUi() {
  var input = document.getElementById('notes-search-input');
  var createBtn = document.getElementById('btn-notes-search-create');
  var redOnly = document.getElementById('notes-search-red-only');
  if (!input) return;

  input.removeEventListener('input', handleNotesSearchInput);
  input.addEventListener('input', handleNotesSearchInput);

  if (createBtn) {
    createBtn.removeEventListener('click', openCreateFindingModal);
    createBtn.addEventListener('click', openCreateFindingModal);
  }

  if (redOnly) {
    redOnly.checked = false;
    redOnly.removeEventListener('change', handleNotesSearchFiltersChange);
    redOnly.addEventListener('change', handleNotesSearchFiltersChange);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.notes-mod-btn'), function(btn) {
    btn.addEventListener('click', function() {
      Array.prototype.forEach.call(document.querySelectorAll('.notes-mod-btn'), function(other) {
        other.classList.remove('active');
      });
      btn.classList.add('active');
      _notesSearchActiveModality = String(btn.dataset.mod || 'All');
      applyNotesSearchFilters();
    });
  });

  bindSearchPreviewModal();
  bindFindingsAddModal();
  bindFindingsCreateModal();
}

function startNotesSearchSubscription() {
  if (!_notesSearchUid) return;
  setNotesSearchStatus('Loading findings index…');

  if (_notesSearchUnsubscribe) {
    _notesSearchUnsubscribe();
    _notesSearchUnsubscribe = null;
  }

  _notesSearchUnsubscribe = subscribeFindings(_notesSearchUid, function(findings) {
    _notesSearchRecords = buildNotesSearchRecords(findings || []);
    _notesSearchIndexReady = true;
    applyNotesSearchFilters();
  });
}

function getNotesSearchQuery() {
  var input = document.getElementById('notes-search-input');
  return input ? String(input.value || '').trim() : '';
}

function handleNotesSearchInput() {
  applyNotesSearchFilters();
}

function handleNotesSearchFiltersChange() {
  var redOnly = document.getElementById('notes-search-red-only');
  _notesSearchRedOnly = Boolean(redOnly && redOnly.checked);
  applyNotesSearchFilters();
}

function clearNotesSearch() {
  var input = document.getElementById('notes-search-input');
  if (input) input.value = '';
  var redOnly = document.getElementById('notes-search-red-only');
  if (redOnly) redOnly.checked = false;
  _notesSearchRedOnly = false;
  _notesSearchActiveModality = 'All';
  Array.prototype.forEach.call(document.querySelectorAll('.notes-mod-btn'), function(btn) {
    btn.classList.toggle('active', String(btn.dataset.mod || '') === 'All');
  });
  applyNotesSearchFilters();
  if (input) input.focus();
}

function applyNotesSearchFilters() {
  var q = getNotesSearchQuery();
  if (!_notesSearchIndexReady) {
    setNotesSearchStatus('Loading findings index…');
    renderNotesSearchResults([], q);
    return;
  }

  var results = q ? searchNotesRecords(q, _notesSearchRecords) : _notesSearchRecords.slice();
  results = filterNotesSearchResults(results);
  _notesSearchLastResults = results;

  setNotesSearchStatus(buildNotesSearchStatus(results.length, _notesSearchRecords.length, q));
  renderNotesSearchResults(results, q);
}

function filterNotesSearchResults(results) {
  return (results || []).filter(function(record) {
    var modalities = Array.isArray(record.modalities) ? record.modalities : [record.modality || 'Other'];
    var matchModality = _notesSearchActiveModality === 'All' || modalities.indexOf(String(_notesSearchActiveModality)) !== -1;
    var matchRed = !_notesSearchRedOnly || Boolean(record.isRedFinding);
    return matchModality && matchRed;
  });
}

function buildNotesSearchStatus(visibleCount, totalCount, query) {
  var parts = [];
  var hasQuery = Boolean(String(query || '').trim());

  if (hasQuery) {
    parts.push('Found ' + visibleCount + ' findings for "' + query + '"');
  } else {
    parts.push('Showing ' + visibleCount + ' findings');
  }

  var activeFilters = [];
  if (_notesSearchActiveModality !== 'All') activeFilters.push(_notesSearchActiveModality);
  if (_notesSearchRedOnly) activeFilters.push('red flagged only');
  if (activeFilters.length) {
    parts.push('with filters: ' + activeFilters.join(', '));
  }

  parts.push('(indexed ' + totalCount + ' total)');
  return parts.join(' ');
}

function runNotesSearch(query) {
  if (!_notesSearchIndexReady) {
    setNotesSearchStatus('Still indexing findings. Try again in a moment.');
    return;
  }

  var results = searchNotesRecords(query, _notesSearchRecords);
  _notesSearchLastResults = results;

  if (!results.length) {
    setNotesSearchStatus('No findings matched "' + query + '".');
  } else {
    setNotesSearchStatus('Found ' + results.length + ' findings for "' + query + '".');
  }

  renderNotesSearchResults(results, query);
}

function setNotesSearchStatus(text) {
  var status = document.getElementById('notes-search-status');
  if (status) status.textContent = text;
}

function buildNotesSearchRecords(findings) {
  var out = [];
  (findings || []).forEach(function(finding) {
    var title = String((finding && finding.name) || '').trim();
    var content = normaliseRichContent((finding && finding.content) || []);
    var contentText = flattenRichContentToText(content, true);
    var links = Array.isArray(finding && finding.links) ? finding.links.slice() : [];
    var modalities = Array.isArray(finding && finding.modalities) ? finding.modalities.slice() : [];
    var searchParts = [title, contentText].concat(modalities);
    links.forEach(function(link) {
      searchParts.push(String((link && link.patternName) || ''));
      searchParts.push(String((link && link.stepTitle) || ''));
      searchParts.push(String((link && link.modality) || ''));
    });
    var searchText = searchParts.filter(Boolean).join(' ');
    if (!searchText.trim()) return;
    out.push(makeRecord(String((finding && finding.id) || '').trim(), title, modalities, contentText, searchText, content, Boolean(finding && finding.isRedFinding), links));
  });

  return out;
}

function makeRecord(findingId, title, modalities, contentText, searchText, content, isRedFinding, links) {
  var normalText = normaliseSearchText(searchText);
  var tokens = tokeniseForSearch(normalText);
  var tokenSet = {};
  var stems = {};
  var linkedPatternNamesText = buildLinkedPatternNamesText(links);
  var linkedPatternTokens = {};
  var linkedPatternStems = {};

  tokens.forEach(function(token) {
    tokenSet[token] = 1;
    var variants = getTokenVariants(token);
    variants.forEach(function(v) {
      stems[v] = 1;
    });
  });

  tokeniseForSearch(linkedPatternNamesText).forEach(function(token) {
    linkedPatternTokens[token] = 1;
    getTokenVariants(token).forEach(function(v) {
      linkedPatternStems[v] = 1;
    });
  });

  var primaryLink = (links && links[0]) ? links[0] : null;
  return {
    findingId: findingId,
    patternId: primaryLink ? String(primaryLink.patternId || '').trim() : '',
    patternName: primaryLink ? (primaryLink.patternName || '') : '',
    modality: primaryLink ? (primaryLink.modality || 'Other') : ((modalities && modalities[0]) || 'Other'),
    modalities: modalities || [],
    stepId: primaryLink ? String(primaryLink.stepId || '').trim() : '',
    stepIndex: -1,
    stepTitle: primaryLink ? (primaryLink.stepTitle || '') : '',
    sectionKey: 'dontMissPathology',
    sectionLabel: NOTES_SEARCH_SECTION_LABELS.dontMissPathology,
    subsectionTitle: title || '',
    subsectionId: primaryLink ? String(primaryLink.subsectionId || '').trim() : '',
    isRedFinding: Boolean(isRedFinding),
    content: normaliseRichContent(content || []),
    contentText: contentText || '',
    text: searchText || contentText || '',
    links: links || [],
    linkedPatternNamesText: linkedPatternNamesText,
    linkedPatternTokens: linkedPatternTokens,
    linkedPatternStems: linkedPatternStems,
    normalText: normalText,
    tokens: tokenSet,
    stems: stems
  };
}

function buildLinkedPatternNamesText(links) {
  var names = [];
  var seen = {};

  (links || []).forEach(function(link) {
    var name = String((link && link.patternName) || '').trim();
    if (!name) return;
    var key = normaliseSearchText(name);
    if (!key || seen[key]) return;
    seen[key] = 1;
    names.push(name);
  });

  return normaliseSearchText(names.join(' '));
}

function buildSearchSections(sections, fallbackRich) {
  if (typeof normaliseStepSections === 'function') {
    return normaliseStepSections(sections, fallbackRich || []);
  }

  var out = {
    searchPattern: [],
    dontMissPathology: []
  };

  var keys = Object.keys(out);
  keys.forEach(function(key) {
    out[key] = normaliseRichContent((sections && sections[key]) || []);
  });

  if (!out.searchPattern.length && Array.isArray(fallbackRich) && fallbackRich.length) {
    out.searchPattern = fallbackRich.slice();
  }

  // Migrate old section format to subsections within dontMissPathology
  if (sections) {
    var legacySections = [];
    var measurementContent = normaliseRichContent((sections.measurements) || []);
    var hyperlinkContent = normaliseRichContent((sections.hyperlinks) || []);
    var imageContent = normaliseRichContent((sections.images) || []);

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

function splitSubsectionEntries(content) {
  var chunks = normaliseRichContent(content || []);
  var entries = [];
  chunks.forEach(function(chunk) {
    if (chunk.type === 'subsection') {
      entries.push({
        title: String(chunk.title || chunk.name || '').trim(),
        subsectionId: String(chunk.subsectionId || '').trim(),
        isRedFinding: Boolean(chunk.isRedFinding),
        content: normaliseRichContent(chunk.content || [])
      });
    }
  });
  return entries;
}

function flattenRichContentToText(content, includeLinks) {
  var out = [];
  normaliseRichContent(content || []).forEach(function(chunk) {
    if (!chunk) return;

    if (chunk.type === 'text') {
      if (chunk.text) out.push(String(chunk.text));
      return;
    }

    if (chunk.type === 'link') {
      if (includeLinks) {
        if (chunk.text) out.push(String(chunk.text));
        if (chunk.url) out.push(String(chunk.url));
      }
      return;
    }

    if (chunk.type === 'subsection') {
      if (chunk.title) out.push(String(chunk.title));
      var nested = flattenRichContentToText(chunk.content || [], includeLinks);
      if (nested) out.push(nested);
      return;
    }
  });

  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function normaliseSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokeniseForSearch(text) {
  var raw = String(text || '').match(/[a-z0-9]+/g) || [];
  return raw.filter(function(token) {
    return token.length > 1;
  });
}

function stemToken(token) {
  var t = String(token || '').trim();
  if (!t) return '';

  var rules = [
    ['izations', 7], ['ization', 6], ['ations', 6], ['ation', 5],
    ['ments', 5], ['ment', 4], ['ings', 4], ['ing', 3],
    ['edly', 4], ['edly', 4], ['ed', 3], ['ers', 4], ['er', 3],
    ['ies', 3], ['es', 3], ['s', 3], ['ly', 3]
  ];

  for (var i = 0; i < rules.length; i++) {
    var suffix = rules[i][0];
    var minLen = rules[i][1];
    if (t.length > minLen && t.endsWith(suffix)) {
      if (suffix === 'ies') return t.slice(0, -3) + 'y';
      return t.slice(0, -suffix.length);
    }
  }

  return t;
}

function getTokenVariants(token) {
  var t = String(token || '').trim();
  if (!t) return [];

  var variants = {};
  variants[t] = 1;

  var stem = stemToken(t);
  if (stem && stem.length >= 3) variants[stem] = 1;

  if (t.length > 3 && t.endsWith('s')) variants[t.slice(0, -1)] = 1;
  if (t.length > 3 && t.endsWith('es')) variants[t.slice(0, -2)] = 1;
  if (t.length > 4 && t.endsWith('ed')) variants[t.slice(0, -2)] = 1;
  if (t.length > 5 && t.endsWith('ing')) variants[t.slice(0, -3)] = 1;

  // Handles forms like herniated/herniation/herniations -> herniat.
  if (t.length > 6) {
    var base = t
      .replace(/(ations|ation|ated|ates|ate)$/g, '')
      .replace(/(ically|ical)$/g, '');
    if (base.length >= 4) variants[base] = 1;
  }

  return Object.keys(variants);
}

function getQueryTerms(query) {
  var tokens = tokeniseForSearch(normaliseSearchText(query));
  var terms = [];
  tokens.forEach(function(token) {
    if (NOTES_SEARCH_STOP_WORDS[token]) return;
    var variants = getTokenVariants(token);
    terms.push({
      token: token,
      variants: variants.length ? variants : [token]
    });
  });
  return terms;
}

function searchNotesRecords(query, records) {
  var normalQuery = normaliseSearchText(query);
  if (!normalQuery) return [];

  var queryTerms = getQueryTerms(query);
  if (!queryTerms.length) {
    queryTerms = [{ token: normalQuery, variants: [normalQuery] }];
  }

  var scored = [];
  (records || []).forEach(function(record) {
    var score = scoreRecordMatch(record, normalQuery, queryTerms);
    if (score <= 0) return;
    scored.push({ record: record, score: score });
  });

  scored.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.record.subsectionTitle || '').localeCompare(String(b.record.subsectionTitle || ''));
  });

  return scored.slice(0, 120).map(function(item) { return item.record; });
}

function scoreRecordMatch(record, normalQuery, queryTerms) {
  if (!record || !record.normalText) return 0;

  var text = record.normalText;
  var patternText = String(record.linkedPatternNamesText || '');
  var matchedTerms = 0;
  var patternMatchedTerms = 0;
  var score = 0;
  var hasDirectPatternMatch = false;

  if (text.indexOf(normalQuery) !== -1) {
    score += 24;
  }
  if (patternText && patternText.indexOf(normalQuery) !== -1) {
    hasDirectPatternMatch = true;
    score += 36;
  }

  queryTerms.forEach(function(term) {
    var hasMatch = false;
    var hasPatternMatch = false;

    term.variants.forEach(function(v) {
      if (!v) return;
      if (record.tokens[v]) {
        hasMatch = true;
        score += 10;
        return;
      }

      if (record.stems[v]) {
        hasMatch = true;
        score += 8;
        return;
      }

      if (record.linkedPatternTokens && record.linkedPatternTokens[v]) {
        hasPatternMatch = true;
        score += 12;
        return;
      }

      if (record.linkedPatternStems && record.linkedPatternStems[v]) {
        hasPatternMatch = true;
        score += 10;
        return;
      }

      if (v.length >= 4 && text.indexOf(v) !== -1) {
        hasMatch = true;
        score += 4;
        return;
      }

      if (v.length >= 4 && patternText.indexOf(v) !== -1) {
        hasPatternMatch = true;
        score += 6;
      }
    });

    if (hasMatch) matchedTerms++;
    if (hasPatternMatch) patternMatchedTerms++;
  });

  // Require at least one meaningful term and strong coverage for multi-term queries.
  if (!matchedTerms && !patternMatchedTerms && !hasDirectPatternMatch) return 0;
  if (
    queryTerms.length > 1 &&
    matchedTerms < Math.max(1, queryTerms.length - 1) &&
    patternMatchedTerms < queryTerms.length &&
    !hasDirectPatternMatch
  ) return 0;

  if (record.sectionKey === 'dontMissPathology') score += 2;
  if (record.subsectionTitle) score += 1;
  if (record.isRedFinding) score += 1;
  if (record.contentText && normaliseSearchText(record.contentText).indexOf(normalQuery) !== -1) score += 8;
  if (record.links && record.links.length > 1) score += 1;
  if (hasDirectPatternMatch) score += 8;

  return score;
}

function renderNotesSearchResults(results, query) {
  var wrap = document.getElementById('notes-search-results');
  if (!wrap) return;

  wrap.innerHTML = '';
  if (!results || !results.length) {
    var empty = document.createElement('p');
    empty.className = 'notes-search-empty';
    empty.textContent = query ? 'No matching findings yet.' : 'No findings available yet.';
    wrap.appendChild(empty);
    return;
  }

  results.forEach(function(result) {
    var row = document.createElement('article');
    row.className = 'notes-result-card' + (result.isRedFinding ? ' finding-red' : '');

    var header = document.createElement('div');
    header.className = 'notes-result-head';

    var title = document.createElement('h3');
    title.className = 'notes-result-title';
    title.textContent = result.subsectionTitle || result.stepTitle;

    var badge = document.createElement('span');
    badge.className = 'notes-result-badge' + (result.isRedFinding ? ' finding-red' : '');
    badge.textContent = result.isRedFinding ? 'Red finding' : 'Finding';

    header.appendChild(title);
    header.appendChild(badge);

    var metaWrap = document.createElement('div');
    metaWrap.className = 'notes-result-meta-wrap';

    var meta = document.createElement('p');
    meta.className = 'notes-result-meta';
    meta.textContent = describeFindingLinks(result);
    metaWrap.appendChild(meta);

    var linkDetails = buildFindingLinkDetails(result);
    if (linkDetails.length) {
      meta.classList.add('is-hoverable');
      meta.setAttribute('tabindex', '0');
      meta.setAttribute('title', linkDetails.join('\n'));

      var popup = document.createElement('div');
      popup.className = 'notes-result-links-popup';

      var popupTitle = document.createElement('div');
      popupTitle.className = 'notes-result-links-popup-title';
      popupTitle.textContent = 'Linked studies';
      popup.appendChild(popupTitle);

      var popupList = document.createElement('ul');
      popupList.className = 'notes-result-links-list';
      linkDetails.forEach(function(detail) {
        var item = document.createElement('li');
        item.textContent = detail;
        popupList.appendChild(item);
      });
      popup.appendChild(popupList);
      metaWrap.appendChild(popup);
    }

    var snippet = document.createElement('p');
    snippet.className = 'notes-result-snippet';
    snippet.innerHTML = highlightSnippetForQuery(result.contentText || result.text, query);

    var actions = document.createElement('div');
    actions.className = 'notes-result-actions';

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-accent btn-sm';
    addBtn.textContent = 'Add to Search Pattern';
    addBtn.addEventListener('click', function() {
      openFindingsAddModal(result);
    });

    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-ghost btn-sm';
    openBtn.textContent = 'Preview';
    openBtn.addEventListener('click', function() {
      openSearchResultPreview(result);
    });

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.disabled = !result.findingId;
    deleteBtn.addEventListener('click', function() {
      handleDeleteFinding(result);
    });

    actions.appendChild(deleteBtn);
    actions.appendChild(addBtn);
    actions.appendChild(openBtn);

    row.appendChild(header);
    row.appendChild(metaWrap);
    row.appendChild(snippet);
    row.appendChild(actions);

    wrap.appendChild(row);
  });
}

function getPatternsWithSteps() {
  return (typeof allPatterns !== 'undefined' ? allPatterns : []).filter(function(pattern) {
    return pattern && Array.isArray(pattern.steps) && pattern.steps.length;
  });
}

function getPatternById(patternId) {
  return (typeof allPatterns !== 'undefined' ? allPatterns : []).find(function(pattern) {
    return String((pattern && pattern.id) || '') === String(patternId || '');
  }) || null;
}

function resolveStepIndexForPattern(pattern, stepId, fallbackIndex) {
  if (!pattern || !Array.isArray(pattern.steps) || !pattern.steps.length) return -1;
  var targetStepId = String(stepId || '').trim();
  if (targetStepId) {
    var exactIndex = pattern.steps.findIndex(function(step) {
      return String((step && step.stepId) || '') === targetStepId;
    });
    if (exactIndex >= 0) return exactIndex;
  }
  if (Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < pattern.steps.length) {
    return fallbackIndex;
  }
  return 0;
}

function resolveFindingsCreateSourceContext(sourceContext) {
  var fallbackPatternId = (typeof selectedPatternId !== 'undefined' && selectedPatternId)
    ? String(selectedPatternId)
    : '';
  var fallbackStepIndex = (typeof currentStepIndex === 'number') ? currentStepIndex : 0;

  var requestedPatternId = String((sourceContext && sourceContext.patternId) || fallbackPatternId || '');
  var requestedStepIndex = Number.isInteger(sourceContext && sourceContext.stepIndex)
    ? sourceContext.stepIndex
    : fallbackStepIndex;

  var pattern = getPatternById(requestedPatternId);
  if (!pattern || !Array.isArray(pattern.steps) || !pattern.steps.length) return null;

  var stepIndex = resolveStepIndexForPattern(pattern, '', requestedStepIndex);
  if (stepIndex < 0) return null;
  var step = pattern.steps[stepIndex] || {};

  return {
    patternId: String(pattern.id || ''),
    patternName: pattern.name || 'Untitled Pattern',
    stepId: String(step.stepId || ''),
    stepTitle: String(step.stepTitle || '').trim() || 'Untitled Step',
    stepIndex: stepIndex
  };
}

function updateFindingsCreateStatusForSelection() {
  var statusEl = document.getElementById('findings-create-status');
  var patternSelect = document.getElementById('findings-create-pattern-select');
  var stepSelect = document.getElementById('findings-create-step-select');
  if (!statusEl) return;

  if (!_findingsCreateContext) {
    statusEl.textContent = 'Select a pattern step before creating a finding.';
    return;
  }

  var base = 'This finding will be created in the current step: '
    + _findingsCreateContext.patternName
    + ' | Step '
    + (_findingsCreateContext.stepIndex + 1)
    + ': '
    + _findingsCreateContext.stepTitle
    + '.';

  var additionalPattern = getPatternById(patternSelect && patternSelect.value);
  var additionalStepId = String((stepSelect && stepSelect.value) || '').trim();
  if (!additionalPattern || !additionalStepId) {
    statusEl.textContent = base + ' You can optionally add it to one additional step below.';
    return;
  }

  var additionalStepIndex = resolveStepIndexForPattern(additionalPattern, additionalStepId, -1);
  var additionalStep = additionalPattern.steps[additionalStepIndex] || null;
  if (!additionalStep) {
    statusEl.textContent = base + ' You can optionally add it to one additional step below.';
    return;
  }

  var additionalStepTitle = String((additionalStep && additionalStep.stepTitle) || '').trim() || 'Untitled Step';
  statusEl.textContent = base
    + ' It will also be added to: '
    + (additionalPattern.name || 'Untitled Pattern')
    + ' | Step '
    + (additionalStepIndex + 1)
    + ': '
    + additionalStepTitle
    + '.';
}

function bindFindingsAddModal() {
  var modal = document.getElementById('modal-findings-add');
  var closeBtn = document.getElementById('btn-findings-add-close');
  var cancelBtn = document.getElementById('btn-findings-add-cancel');
  var applyBtn = document.getElementById('btn-findings-add-apply');
  var patternSelect = document.getElementById('findings-add-pattern-select');
  if (closeBtn) closeBtn.addEventListener('click', closeFindingsAddModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeFindingsAddModal);
  if (applyBtn) applyBtn.addEventListener('click', applyFindingToSelectedStep);
  if (patternSelect) patternSelect.addEventListener('change', populateFindingsAddStepSelect);
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeFindingsAddModal();
    });
  }
}

function openFindingsAddModal(result) {
  if (!result) return;
  var modal = document.getElementById('modal-findings-add');
  var sourceEl = document.getElementById('findings-add-source');
  var patternSelect = document.getElementById('findings-add-pattern-select');
  var redEl = document.getElementById('findings-add-red');
  var statusEl = document.getElementById('findings-add-status');
  if (!modal || !sourceEl || !patternSelect || !redEl || !statusEl) return;

  _findingsAddContext = result;
  sourceEl.textContent = 'Finding: ' + (result.subsectionTitle || result.stepTitle) + '\n' + describeFindingLinks(result);
  redEl.checked = Boolean(result.isRedFinding);
  statusEl.textContent = '';

  var patternsWithSteps = getPatternsWithSteps();

  patternSelect.innerHTML = '';
  patternsWithSteps.forEach(function(pattern) {
    var option = document.createElement('option');
    option.value = String(pattern.id || '');
    option.textContent = pattern.name || 'Untitled Pattern';
    patternSelect.appendChild(option);
  });

  if (!patternsWithSteps.length) {
    statusEl.textContent = 'No target patterns with steps are available yet.';
  } else if (typeof selectedPatternId !== 'undefined' && selectedPatternId) {
    patternSelect.value = String(selectedPatternId);
  }

  populateFindingsAddStepSelect();
  modal.style.display = '';
}

function closeFindingsAddModal() {
  _findingsAddContext = null;
  var modal = document.getElementById('modal-findings-add');
  if (modal) modal.style.display = 'none';
}

function populateFindingsAddStepSelect() {
  var patternSelect = document.getElementById('findings-add-pattern-select');
  var stepSelect = document.getElementById('findings-add-step-select');
  var statusEl = document.getElementById('findings-add-status');
  if (!patternSelect || !stepSelect || !statusEl) return;

  var pattern = (typeof allPatterns !== 'undefined' ? allPatterns : []).find(function(item) {
    return String((item && item.id) || '') === String(patternSelect.value || '');
  });

  stepSelect.innerHTML = '';
  if (!pattern || !Array.isArray(pattern.steps) || !pattern.steps.length) {
    stepSelect.innerHTML = '<option value="">No target steps available</option>';
    statusEl.textContent = 'Select a pattern with at least one step.';
    return;
  }

  (pattern.steps || []).forEach(function(step, index) {
    var option = document.createElement('option');
    option.value = String((step && step.stepId) || '');
    option.textContent = 'Step ' + (index + 1) + ': ' + (String((step && step.stepTitle) || '').trim() || 'Untitled Step');
    stepSelect.appendChild(option);
  });

  if (typeof selectedPatternId !== 'undefined' && String(selectedPatternId || '') === String(pattern.id || '') && typeof currentStepIndex === 'number' && pattern.steps[currentStepIndex]) {
    stepSelect.value = String((pattern.steps[currentStepIndex] && pattern.steps[currentStepIndex].stepId) || '');
  }

  statusEl.textContent = 'The finding will be added to the selected step\'s Findings section.';
}

function bindFindingsCreateModal() {
  var modal = document.getElementById('modal-findings-create');
  var closeBtn = document.getElementById('btn-findings-create-close');
  var cancelBtn = document.getElementById('btn-findings-create-cancel');
  var applyBtn = document.getElementById('btn-findings-create-apply');
  var patternSelect = document.getElementById('findings-create-pattern-select');
  var stepSelect = document.getElementById('findings-create-step-select');
  var contentEl = document.getElementById('findings-create-content');
  var toolbarEl = document.getElementById('findings-create-toolbar');
  if (closeBtn) closeBtn.addEventListener('click', closeCreateFindingModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCreateFindingModal);
  if (applyBtn) applyBtn.addEventListener('click', applyCreatedFindingToSelectedStep);
  if (patternSelect) patternSelect.addEventListener('change', populateFindingsCreateStepSelect);
  if (stepSelect) stepSelect.addEventListener('change', updateFindingsCreateStatusForSelection);
  if (toolbarEl && contentEl && typeof bindRichEditorToolbar === 'function') {
    bindRichEditorToolbar(toolbarEl, contentEl);

    // Keep tab flow inside the create modal: toolbar -> editor.
    toolbarEl.addEventListener('keydown', function(e) {
      if (e.key !== 'Tab' || e.shiftKey) return;
      e.preventDefault();
      if (typeof setActiveRichEditor === 'function') {
        setActiveRichEditor(contentEl);
      }
      contentEl.focus();
    });
  }
  if (contentEl && typeof attachRichEditorFocusHandlers === 'function') {
    attachRichEditorFocusHandlers(contentEl);
  }
  if (contentEl && typeof handleRichEditorKeydown === 'function') {
    contentEl.addEventListener('keydown', handleRichEditorKeydown);
  }
  if (contentEl && typeof handleEditorPaste === 'function') {
    contentEl.addEventListener('paste', handleEditorPaste);
  }
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeCreateFindingModal();
    });
  }
}

function openCreateFindingModal(sourceContext) {
  var modal = document.getElementById('modal-findings-create');
  var titleEl = document.getElementById('findings-create-title');
  var contentEl = document.getElementById('findings-create-content');
  var redEl = document.getElementById('findings-create-red');
  var patternSelect = document.getElementById('findings-create-pattern-select');
  var statusEl = document.getElementById('findings-create-status');
  if (!modal || !titleEl || !contentEl || !redEl || !patternSelect || !statusEl) return;

  _findingsCreateContext = resolveFindingsCreateSourceContext(sourceContext);

  var patternsWithSteps = getPatternsWithSteps();
  patternSelect.innerHTML = '<option value="">No additional location</option>';
  patternsWithSteps.forEach(function(pattern) {
    var option = document.createElement('option');
    option.value = String(pattern.id || '');
    option.textContent = pattern.name || 'Untitled Pattern';
    patternSelect.appendChild(option);
  });

  titleEl.value = '';
  if (typeof populateRichEditor === 'function') {
    populateRichEditor(contentEl, []);
  } else {
    contentEl.innerHTML = '';
  }
  redEl.checked = false;

  populateFindingsCreateStepSelect();
  modal.style.display = '';
  if (typeof setActiveRichEditor === 'function') {
    setActiveRichEditor(contentEl);
  }
  titleEl.focus();
}

function closeCreateFindingModal() {
  _findingsCreateContext = null;
  var modal = document.getElementById('modal-findings-create');
  if (modal) modal.style.display = 'none';
}

function populateFindingsCreateStepSelect() {
  var patternSelect = document.getElementById('findings-create-pattern-select');
  var stepSelect = document.getElementById('findings-create-step-select');
  if (!patternSelect || !stepSelect) return;

  var pattern = getPatternById(patternSelect.value);

  stepSelect.innerHTML = '';
  if (!patternSelect.value) {
    stepSelect.disabled = true;
    stepSelect.innerHTML = '<option value="">No additional step selected</option>';
    updateFindingsCreateStatusForSelection();
    return;
  }

  if (!pattern || !Array.isArray(pattern.steps) || !pattern.steps.length) {
    stepSelect.disabled = true;
    stepSelect.innerHTML = '<option value="">No additional steps available</option>';
    updateFindingsCreateStatusForSelection();
    return;
  }

  stepSelect.disabled = false;
  stepSelect.innerHTML = '<option value="">Select additional step (optional)</option>';

  (pattern.steps || []).forEach(function(step, index) {
    var option = document.createElement('option');
    option.value = String((step && step.stepId) || '');
    option.textContent = 'Step ' + (index + 1) + ': ' + (String((step && step.stepTitle) || '').trim() || 'Untitled Step');
    stepSelect.appendChild(option);
  });
  updateFindingsCreateStatusForSelection();
}

function buildFindingContentFromText(text, isRedFinding) {
  var value = String(text || '').trim();
  if (!value) return [];
  return buildFindingContentFromRichContent([{ type: 'text', text: value, bold: false, color: null }], isRedFinding);
}

function buildFindingContentFromRichContent(content, isRedFinding) {
  var rich = normaliseRichContent(content || []);
  if (!rich.length) return [];

  return rich.map(function(chunk) {
    if (!chunk || chunk.type !== 'text') return chunk;
    if (!isRedFinding || chunk.color) return chunk;
    return Object.assign({}, chunk, { color: 'red' });
  });
}

async function applyCreatedFindingToSelectedStep() {
  if (!_notesSearchUid) return;

  var titleEl = document.getElementById('findings-create-title');
  var contentEl = document.getElementById('findings-create-content');
  var redEl = document.getElementById('findings-create-red');
  var patternSelect = document.getElementById('findings-create-pattern-select');
  var stepSelect = document.getElementById('findings-create-step-select');
  var applyBtn = document.getElementById('btn-findings-create-apply');
  var statusEl = document.getElementById('findings-create-status');
  if (!titleEl || !contentEl || !redEl || !patternSelect || !stepSelect || !applyBtn || !statusEl) return;

  var title = String(titleEl.value || '').trim();
  var content = typeof extractRichContent === 'function'
    ? extractRichContent(contentEl)
    : buildFindingContentFromText(String(contentEl.textContent || '').trim(), false);
  var hasContent = typeof hasAnyRichContent === 'function'
    ? hasAnyRichContent(content)
    : Boolean(String(contentEl.textContent || '').trim());
  var isRedFinding = Boolean(redEl.checked);
  if (!title) {
    statusEl.textContent = 'Finding title is required.';
    titleEl.focus();
    return;
  }
  if (!hasContent) {
    statusEl.textContent = 'Finding content is required.';
    if (typeof setActiveRichEditor === 'function') setActiveRichEditor(contentEl);
    contentEl.focus();
    return;
  }
  if (!_findingsCreateContext) {
    statusEl.textContent = 'Unable to resolve the current step for this finding.';
    return;
  }

  var primaryPattern = getPatternById(_findingsCreateContext.patternId);
  if (!primaryPattern) {
    statusEl.textContent = 'Current pattern is no longer available. Refresh and try again.';
    return;
  }

  var primaryIndex = resolveStepIndexForPattern(primaryPattern, _findingsCreateContext.stepId, _findingsCreateContext.stepIndex);
  if (primaryIndex < 0 || !primaryPattern.steps[primaryIndex]) {
    statusEl.textContent = 'Current step is no longer available. Refresh and try again.';
    return;
  }

  var additionalPatternId = String(patternSelect.value || '').trim();
  var additionalStepId = String(stepSelect.value || '').trim();
  if (additionalPatternId && !additionalStepId) {
    statusEl.textContent = 'Select an additional step or choose no additional location.';
    return;
  }

  var targets = [{
    patternId: String(primaryPattern.id || ''),
    stepId: String((primaryPattern.steps[primaryIndex] && primaryPattern.steps[primaryIndex].stepId) || ''),
    stepIndex: primaryIndex,
    isPrimary: true
  }];

  if (additionalPatternId && additionalStepId) {
    var additionalPattern = getPatternById(additionalPatternId);
    if (!additionalPattern) {
      statusEl.textContent = 'Select a valid additional pattern.';
      return;
    }
    var additionalIndex = resolveStepIndexForPattern(additionalPattern, additionalStepId, -1);
    if (additionalIndex < 0 || !additionalPattern.steps[additionalIndex]) {
      statusEl.textContent = 'Select a valid additional step.';
      return;
    }

    var primaryTarget = targets[0];
    var resolvedAdditionalStepId = String((additionalPattern.steps[additionalIndex] && additionalPattern.steps[additionalIndex].stepId) || additionalStepId);
    var isDuplicateTarget = String(primaryTarget.patternId) === String(additionalPattern.id || '')
      && String(primaryTarget.stepId || '') === String(resolvedAdditionalStepId || '');

    if (!isDuplicateTarget) {
      targets.push({
        patternId: String(additionalPattern.id || ''),
        stepId: resolvedAdditionalStepId,
        stepIndex: additionalIndex,
        isPrimary: false
      });
    }
  }

  applyBtn.disabled = true;
  applyBtn.textContent = 'Creating...';
  statusEl.textContent = targets.length > 1 ? 'Saving finding to multiple steps...' : 'Saving finding...';

  try {
    var stepsByPatternId = {};

    targets.forEach(function(target) {
      var pattern = getPatternById(target.patternId);
      if (!pattern) return;

      if (!stepsByPatternId[target.patternId]) {
        stepsByPatternId[target.patternId] = {
          pattern: pattern,
          steps: JSON.parse(JSON.stringify(pattern.steps || []))
        };
      }

      var entry = stepsByPatternId[target.patternId];
      var stepIndex = resolveStepIndexForPattern({ steps: entry.steps }, target.stepId, target.stepIndex);
      if (stepIndex < 0 || !entry.steps[stepIndex]) {
        throw new Error('A selected step no longer exists. Refresh and try again.');
      }

      var targetStep = entry.steps[stepIndex] || {};
      targetStep.sections = buildSearchSections(targetStep.sections, normaliseRichContent(targetStep.richContent || targetStep.rich_content || []));
      targetStep.sections.dontMissPathology = normaliseRichContent(targetStep.sections.dontMissPathology || []);
      targetStep.sections.dontMissPathology.push({
        type: 'subsection',
        title: title,
        isRedFinding: isRedFinding,
        content: buildFindingContentFromRichContent(content, isRedFinding)
      });
      targetStep.richContent = normaliseRichContent(targetStep.sections.searchPattern || []);
      entry.steps[stepIndex] = targetStep;
    });

    var patternIdsToUpdate = Object.keys(stepsByPatternId);
    for (var i = 0; i < patternIdsToUpdate.length; i++) {
      var patternId = patternIdsToUpdate[i];
      var entry = stepsByPatternId[patternId];
      var preparedSteps = typeof prepareStepsForStorage === 'function'
        ? await prepareStepsForStorage(entry.steps)
        : entry.steps;

      await updatePattern(_notesSearchUid, entry.pattern.id, {
        name: entry.pattern.name || 'Untitled Pattern',
        modality: entry.pattern.modality || 'Other',
        goalSeconds: entry.pattern.goalSeconds,
        reportConfig: entry.pattern.reportConfig || null,
        steps: preparedSteps
      });

      entry.pattern.steps = preparedSteps;
    }

    if (typeof setAllPatternsRef === 'function' && typeof allPatterns !== 'undefined') {
      setAllPatternsRef(allPatterns);
    }

    showToast(targets.length > 1
      ? 'Finding created in current step and additional step.'
      : 'Finding created in current step.');
    closeCreateFindingModal();
  } catch (err) {
    console.error(err);
    statusEl.textContent = String((err && err.message) || err || 'Failed to create finding.');
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = 'Create Finding';
  }
}

async function applyFindingToSelectedStep() {
  if (!_findingsAddContext || !_notesSearchUid) return;

  var patternSelect = document.getElementById('findings-add-pattern-select');
  var stepSelect = document.getElementById('findings-add-step-select');
  var redEl = document.getElementById('findings-add-red');
  var applyBtn = document.getElementById('btn-findings-add-apply');
  var statusEl = document.getElementById('findings-add-status');
  if (!patternSelect || !stepSelect || !redEl || !applyBtn || !statusEl) return;

  var targetPattern = (typeof allPatterns !== 'undefined' ? allPatterns : []).find(function(pattern) {
    return String((pattern && pattern.id) || '') === String(patternSelect.value || '');
  });
  if (!targetPattern) {
    statusEl.textContent = 'Select a valid target pattern.';
    return;
  }

  var targetSteps = JSON.parse(JSON.stringify(targetPattern.steps || []));
  var targetIndex = targetSteps.findIndex(function(step) {
    return String((step && step.stepId) || '') === String(stepSelect.value || '');
  });
  if (targetIndex < 0) {
    statusEl.textContent = 'Select a valid target step.';
    return;
  }

  var isRedFinding = Boolean(redEl.checked);

  var nextText = buildFindingInsertText(_findingsAddContext);
  if (!nextText) {
    statusEl.textContent = 'This finding has no text to add.';
    return;
  }

  applyBtn.disabled = true;
  applyBtn.textContent = 'Adding...';
  statusEl.textContent = 'Saving target step...';

  try {
    var targetStep = targetSteps[targetIndex] || {};
    targetStep.sections = buildSearchSections(targetStep.sections, normaliseRichContent(targetStep.richContent || targetStep.rich_content || []));
    targetStep.sections.dontMissPathology = normaliseRichContent(targetStep.sections.dontMissPathology || []);
    targetStep.sections.dontMissPathology.push({
      type: 'subsection',
      title: String(_findingsAddContext.subsectionTitle || _findingsAddContext.stepTitle || 'Finding').trim() || 'Finding',
      isRedFinding: isRedFinding,
      content: buildFindingContentFromText(nextText, isRedFinding)
    });
    targetStep.richContent = normaliseRichContent(targetStep.sections.searchPattern || []);
    targetSteps[targetIndex] = targetStep;

    var preparedSteps = typeof prepareStepsForStorage === 'function'
      ? await prepareStepsForStorage(targetSteps)
      : targetSteps;

    await updatePattern(_notesSearchUid, targetPattern.id, {
      name: targetPattern.name || 'Untitled Pattern',
      modality: targetPattern.modality || 'Other',
      goalSeconds: targetPattern.goalSeconds,
      steps: preparedSteps
    });

    targetPattern.steps = preparedSteps;
    if (typeof setAllPatternsRef === 'function' && typeof allPatterns !== 'undefined') {
      setAllPatternsRef(allPatterns);
    }

    showToast('Added finding to ' + (targetPattern.name || 'pattern') + '.');
    closeFindingsAddModal();
  } catch (err) {
    console.error(err);
    statusEl.textContent = String((err && err.message) || err || 'Failed to add finding.');
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = 'Add Finding';
  }
}

async function handleDeleteFinding(result) {
  if (!_notesSearchUid || !result || !result.findingId) return;

  var title = String(result.subsectionTitle || result.stepTitle || 'this finding').trim() || 'this finding';
  var confirmed = true;
  if (typeof showConfirm === 'function') {
    confirmed = await showConfirm('Delete Finding', 'Delete "' + title + '" from all linked studies? This cannot be undone.');
  }
  if (!confirmed) return;

  try {
    await deleteFinding(_notesSearchUid, result.findingId);
    showToast('Finding deleted.');
  } catch (err) {
    console.error(err);
    showToast(String((err && err.message) || err || 'Failed to delete finding.'), true);
  }
}

function buildFindingInsertText(result) {
  if (!result) return '';
  var title = String(result.subsectionTitle || '').trim();
  var body = flattenRichContentToText(result.content || [], true).trim();
  if (!body) body = String(result.text || '').trim();
  if (title && body) return title + ': ' + body;
  return title || body;
}

function appendTextToRichContent(existingContent, text, isRedFinding) {
  var existing = normaliseRichContent(existingContent || []);
  var prefix = flattenRichContentToText(existing, true).trim() ? '\n\n' : '';
  existing.push({
    type: 'text',
    text: prefix + String(text || '').trim(),
    bold: false,
    color: isRedFinding ? 'red' : null
  });
  return existing;
}

function openSearchResultPreview(result) {
  if (!result) return;

  var resolved = resolveFindingPreviewLink(result);
  if (!resolved || !resolved.patternId) return;

  var modal = document.getElementById('modal-search-preview');
  var titleEl = document.getElementById('modal-search-preview-title');
  var metaEl = modal && modal.querySelector('.search-preview-step-meta');
  var bodyEl = document.getElementById('search-preview-body');
  if (!modal || !titleEl || !bodyEl) return;

  // Populate header
  titleEl.textContent = result.subsectionTitle || 'Finding';
  if (metaEl) {
    metaEl.textContent = (resolved.patternName || 'Pattern') + ' | Step ' + (resolved.stepIndex + 1) + ': ' + resolved.stepTitle;
  }

  // Render finding content for the selected search result.
  bodyEl.innerHTML = '';
  var findingContent = normaliseRichContent((result && result.content) || []);
  if (findingContent.length && typeof renderRichContent === 'function') {
    renderRichContent(bodyEl, findingContent);
  } else {
    var fallback = document.createElement('p');
    fallback.style.color = 'var(--ink-soft)';
    fallback.textContent = String(result.contentText || result.text || '').trim() || 'No finding content available.';
    bodyEl.appendChild(fallback);
  }

  // Wire the "Open in Patterns Tab" button
  var openTabBtn = document.getElementById('btn-search-preview-open-tab');
  if (openTabBtn) {
    openTabBtn.onclick = function() {
      closeSearchResultPreview();
      if (typeof openPatternAtStepFromSearch === 'function') {
        openPatternAtStepFromSearch(resolved.patternId, resolved.stepIndex);
      } else if (typeof loadPattern === 'function') {
        loadPattern(resolved.patternId, resolved.stepIndex);
      }
      var targetTab = document.querySelector('.tab-btn[data-tab="patterns"]');
      if (targetTab) targetTab.click();
    };
  }

  modal.style.display = '';
}

function closeSearchResultPreview() {
  var modal = document.getElementById('modal-search-preview');
  if (modal) modal.style.display = 'none';
}

function bindSearchPreviewModal() {
  var closeBtn = document.getElementById('btn-search-preview-close');
  var closeFooterBtn = document.getElementById('btn-search-preview-close-footer');
  var modal = document.getElementById('modal-search-preview');
  if (closeBtn) closeBtn.addEventListener('click', closeSearchResultPreview);
  if (closeFooterBtn) closeFooterBtn.addEventListener('click', closeSearchResultPreview);
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeSearchResultPreview();
    });
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeSearchResultPreview();
  });
}

function describeFindingLinks(result) {
  var links = Array.isArray(result && result.links) ? result.links : [];
  if (!links.length) {
    return 'Standalone finding';
  }
  if (links.length === 1) {
    var only = links[0];
    return (only.patternName || 'Pattern') + ' | ' + (only.modality || 'Other') + ' | ' + (only.stepTitle || 'Step');
  }
  var patternNames = {};
  links.forEach(function(link) {
    patternNames[String((link && link.patternName) || '').trim() || 'Pattern'] = 1;
  });
  return 'Linked in ' + links.length + ' steps across ' + Object.keys(patternNames).length + ' patterns';
}

function buildFindingLinkDetails(result) {
  var links = Array.isArray(result && result.links) ? result.links : [];
  var seen = {};
  var details = [];

  links.forEach(function(link) {
    var patternName = String((link && link.patternName) || '').trim() || 'Pattern';
    var modality = String((link && link.modality) || '').trim() || 'Other';
    var stepTitle = String((link && link.stepTitle) || '').trim() || 'Step';
    var detail = patternName + ' | ' + modality + ' | ' + stepTitle;
    if (seen[detail]) return;
    seen[detail] = 1;
    details.push(detail);
  });

  return details;
}

function resolveFindingPreviewLink(result) {
  var links = Array.isArray(result && result.links) ? result.links : [];
  if (!links.length) return null;

  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var pattern = (typeof allPatterns !== 'undefined' ? allPatterns : []).find(function(item) {
      return String((item && item.id) || '') === String((link && link.patternId) || '');
    });
    if (!pattern) continue;
    var steps = pattern.steps || [];
    for (var j = 0; j < steps.length; j++) {
      if (String((steps[j] && steps[j].stepId) || '') === String((link && link.stepId) || '')) {
        return {
          patternId: String(link.patternId || ''),
          patternName: link.patternName || pattern.name || 'Pattern',
          stepId: String(link.stepId || ''),
          stepIndex: j,
          stepTitle: link.stepTitle || (steps[j] && steps[j].stepTitle) || 'Step'
        };
      }
    }
  }

  return null;
}

function highlightSnippetForQuery(text, query) {
  var plain = String(text || '').trim();
  if (!plain) return '';

  var maxLen = 320;
  var clipped = plain.length > maxLen ? (plain.slice(0, maxLen) + '...') : plain;
  var safe = escapeHtml(clipped);

  var tokens = getQueryTerms(query || '').map(function(t) { return t.token; });
  if (!tokens.length) return safe;

  var seen = {};
  tokens = tokens.filter(function(t) {
    if (!t || t.length < 3 || seen[t]) return false;
    seen[t] = 1;
    return true;
  });
  if (!tokens.length) return safe;

  var pattern = new RegExp('\\b(' + tokens.map(escapeRegExp).join('|') + '[a-z0-9]*)', 'ig');
  return safe.replace(pattern, '<mark>$1</mark>');
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
