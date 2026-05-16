// notes-search.js — plain script, no modules. Depends on db.js, patterns.js and app.js globals.

var _notesSearchUid = null;
var _notesSearchUnsubscribe = null;
var _notesSearchRecords = [];
var _notesSearchIndexReady = false;
var _notesSearchLastResults = [];

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
  var clearBtn = document.getElementById('btn-notes-search-clear');
  if (!input || !clearBtn) return;

  input.removeEventListener('input', handleNotesSearchInput);
  input.addEventListener('input', handleNotesSearchInput);

  clearBtn.removeEventListener('click', clearNotesSearch);
  clearBtn.addEventListener('click', clearNotesSearch);

  bindSearchPreviewModal();
}

function startNotesSearchSubscription() {
  if (!_notesSearchUid) return;
  setNotesSearchStatus('Loading notes index…');

  if (_notesSearchUnsubscribe) {
    _notesSearchUnsubscribe();
    _notesSearchUnsubscribe = null;
  }

  _notesSearchUnsubscribe = subscribePatterns(_notesSearchUid, function(patterns) {
    _notesSearchRecords = buildNotesSearchRecords(patterns || []);
    _notesSearchIndexReady = true;
    var q = getNotesSearchQuery();
    if (!q) {
      setNotesSearchStatus('Indexed ' + _notesSearchRecords.length + ' note blocks across your patterns.');
      renderNotesSearchResults([]);
      return;
    }
    runNotesSearch(q);
  });
}

function getNotesSearchQuery() {
  var input = document.getElementById('notes-search-input');
  return input ? String(input.value || '').trim() : '';
}

function handleNotesSearchInput() {
  var q = getNotesSearchQuery();
  if (!q) {
    _notesSearchLastResults = [];
    if (_notesSearchIndexReady) {
      setNotesSearchStatus('Indexed ' + _notesSearchRecords.length + ' note blocks across your patterns.');
    } else {
      setNotesSearchStatus('Loading notes index…');
    }
    renderNotesSearchResults([]);
    return;
  }
  runNotesSearch(q);
}

function clearNotesSearch() {
  var input = document.getElementById('notes-search-input');
  if (input) input.value = '';
  handleNotesSearchInput();
  if (input) input.focus();
}

function runNotesSearch(query) {
  if (!_notesSearchIndexReady) {
    setNotesSearchStatus('Still indexing notes. Try again in a moment.');
    return;
  }

  var results = searchNotesRecords(query, _notesSearchRecords);
  _notesSearchLastResults = results;

  if (!results.length) {
    setNotesSearchStatus('No note matches found for "' + query + '".');
  } else {
    setNotesSearchStatus('Found ' + results.length + ' note matches for "' + query + '".');
  }

  renderNotesSearchResults(results, query);
}

function setNotesSearchStatus(text) {
  var status = document.getElementById('notes-search-status');
  if (status) status.textContent = text;
}

function buildNotesSearchRecords(patterns) {
  var out = [];
  (patterns || []).forEach(function(pattern) {
    var patternId = String((pattern && pattern.id) || '').trim();
    var patternName = (pattern && pattern.name) || 'Untitled Pattern';
    var steps = (pattern && pattern.steps) || [];

    steps.forEach(function(rawStep, stepIndex) {
      var fallbackRich = normaliseRichContent((rawStep && rawStep.richContent) || (rawStep && rawStep.rich_content) || []);
      var sections = buildSearchSections(rawStep && rawStep.sections, fallbackRich);
      var stepTitle = String((rawStep && rawStep.stepTitle) || '').trim() || ('Step ' + (stepIndex + 1));

      Object.keys(sections).forEach(function(sectionKey) {
        var content = sections[sectionKey] || [];
        var subsectionEntries = splitSubsectionEntries(content);
        if (subsectionEntries.length) {
          subsectionEntries.forEach(function(sub) {
            var text = flattenRichContentToText(sub.content || [], true);
            var title = String(sub.title || '').trim();
            var joined = (title ? title + ' ' : '') + text;
            if (!joined.trim()) return;
            out.push(makeRecord(patternId, patternName, stepIndex, stepTitle, sectionKey, title, joined));
          });
          return;
        }

        var sectionText = flattenRichContentToText(content, true);
        if (!sectionText.trim()) return;
        out.push(makeRecord(patternId, patternName, stepIndex, stepTitle, sectionKey, '', sectionText));
      });
    });
  });

  return out;
}

function makeRecord(patternId, patternName, stepIndex, stepTitle, sectionKey, subsectionTitle, text) {
  var normalText = normaliseSearchText(text);
  var tokens = tokeniseForSearch(normalText);
  var tokenSet = {};
  var stems = {};

  tokens.forEach(function(token) {
    tokenSet[token] = 1;
    var variants = getTokenVariants(token);
    variants.forEach(function(v) {
      stems[v] = 1;
    });
  });

  return {
    patternId: patternId,
    patternName: patternName,
    stepIndex: stepIndex,
    stepTitle: stepTitle,
    sectionKey: sectionKey,
    sectionLabel: NOTES_SEARCH_SECTION_LABELS[sectionKey] || sectionKey,
    subsectionTitle: subsectionTitle || '',
    text: text,
    normalText: normalText,
    tokens: tokenSet,
    stems: stems
  };
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
        title: 'Measurements',
        content: measurementContent
      });
    }
    if (hyperlinkContent && hyperlinkContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Hyperlinks',
        content: hyperlinkContent
      });
    }
    if (imageContent && imageContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Workflow / Decision Tree',
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
        boxType: String(chunk.boxType || '').trim(),
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
    if (a.record.patternName !== b.record.patternName) {
      return a.record.patternName.localeCompare(b.record.patternName);
    }
    return a.record.stepIndex - b.record.stepIndex;
  });

  return scored.slice(0, 120).map(function(item) { return item.record; });
}

function scoreRecordMatch(record, normalQuery, queryTerms) {
  if (!record || !record.normalText) return 0;

  var text = record.normalText;
  var matchedTerms = 0;
  var score = 0;

  if (text.indexOf(normalQuery) !== -1) {
    score += 24;
  }

  queryTerms.forEach(function(term) {
    var hasMatch = false;

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

      if (v.length >= 4 && text.indexOf(v) !== -1) {
        hasMatch = true;
        score += 4;
      }
    });

    if (hasMatch) matchedTerms++;
  });

  // Require at least one meaningful term and strong coverage for multi-term queries.
  if (!matchedTerms) return 0;
  if (queryTerms.length > 1 && matchedTerms < Math.max(1, queryTerms.length - 1)) return 0;

  if (record.sectionKey === 'dontMissPathology') score += 2;
  if (record.subsectionTitle) score += 1;

  return score;
}

function renderNotesSearchResults(results, query) {
  var wrap = document.getElementById('notes-search-results');
  if (!wrap) return;

  wrap.innerHTML = '';
  if (!results || !results.length) {
    var empty = document.createElement('p');
    empty.className = 'notes-search-empty';
    empty.textContent = query ? 'No matching notes yet.' : 'Type in the box above to search your notes.';
    wrap.appendChild(empty);
    return;
  }

  results.forEach(function(result) {
    var row = document.createElement('article');
    row.className = 'notes-result-card';

    var header = document.createElement('div');
    header.className = 'notes-result-head';

    var title = document.createElement('h3');
    title.className = 'notes-result-title';
    title.textContent = result.patternName;

    var badge = document.createElement('span');
    badge.className = 'notes-result-badge';
    badge.textContent = result.sectionLabel;

    header.appendChild(title);
    header.appendChild(badge);

    var meta = document.createElement('p');
    meta.className = 'notes-result-meta';
    var subsection = result.subsectionTitle ? (' | ' + result.subsectionTitle) : '';
    meta.textContent = 'Step ' + (result.stepIndex + 1) + ': ' + result.stepTitle + subsection;

    var snippet = document.createElement('p');
    snippet.className = 'notes-result-snippet';
    snippet.innerHTML = highlightSnippetForQuery(result.text, query);

    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-accent btn-sm';
    openBtn.textContent = 'Preview';
    openBtn.addEventListener('click', function() {
      openSearchResultPreview(result);
    });

    row.appendChild(header);
    row.appendChild(meta);
    row.appendChild(snippet);
    row.appendChild(openBtn);

    wrap.appendChild(row);
  });
}

function openSearchResultPreview(result) {
  if (!result || !result.patternId) return;

  var modal = document.getElementById('modal-search-preview');
  var titleEl = document.getElementById('modal-search-preview-title');
  var metaEl = modal && modal.querySelector('.search-preview-step-meta');
  var bodyEl = document.getElementById('search-preview-body');
  if (!modal || !titleEl || !bodyEl) return;

  // Populate header
  titleEl.textContent = result.patternName || 'Pattern';
  if (metaEl) {
    var subsection = result.subsectionTitle ? (' — ' + result.subsectionTitle) : '';
    metaEl.textContent = 'Step ' + (result.stepIndex + 1) + ': ' + result.stepTitle + subsection;
  }

  // Render step content
  bodyEl.innerHTML = '';
  var pattern = (typeof allPatterns !== 'undefined' ? allPatterns : []).find(function(p) {
    return String((p && p.id) || '') === String(result.patternId);
  });
  var step = pattern && (pattern.steps || [])[result.stepIndex];
  if (step && typeof renderStepSections === 'function') {
    renderStepSections(bodyEl, step);
  } else {
    var fallback = document.createElement('p');
    fallback.style.color = 'var(--ink-soft)';
    fallback.textContent = result.text || 'No content available.';
    bodyEl.appendChild(fallback);
  }

  // Wire the "Open in Patterns Tab" button
  var openTabBtn = document.getElementById('btn-search-preview-open-tab');
  if (openTabBtn) {
    openTabBtn.onclick = function() {
      closeSearchResultPreview();
      if (typeof openPatternAtStepFromSearch === 'function') {
        openPatternAtStepFromSearch(result.patternId, result.stepIndex);
      } else if (typeof loadPattern === 'function') {
        loadPattern(result.patternId, result.stepIndex);
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
