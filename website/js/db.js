// db.js — plain script, no modules. Depends on firebase-config.js (appDb global).

function _userRef(uid)       { return appDb.collection('users').doc(uid); }
function _patternsRef(uid)   { return _userRef(uid).collection('patterns'); }
function _findingsRef(uid)   { return _userRef(uid).collection('findings'); }
function _studyLogRef(uid)   { return _userRef(uid).collection('studyLog'); }
function _reportTemplatesRef(uid) { return _userRef(uid).collection('reportTemplates'); }
function _now()              { return firebase.firestore.FieldValue.serverTimestamp(); }

var STEP_SECTION_KEYS = ['searchPattern', 'dontMissPathology', 'measurements', 'hyperlinks', 'images'];
var FINDINGS_BATCH_SIZE = 400;

function _normaliseFindingName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _makeFindingId(name) {
  var key = _normaliseFindingName(name);
  if (!key) return '';
  return 'finding_' + key.replace(/\s+/g, '_').slice(0, 120);
}

function _normaliseFindingLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    patternId: String(raw.patternId || '').trim(),
    patternName: String(raw.patternName || '').trim(),
    modality: String(raw.modality || '').trim() || 'Other',
    stepId: String(raw.stepId || '').trim(),
    stepTitle: String(raw.stepTitle || '').trim(),
    subsectionId: String(raw.subsectionId || '').trim()
  };
}

function _makeFindingLinkKey(link) {
  var safe = _normaliseFindingLink(link);
  if (!safe) return '';
  return [safe.patternId, safe.stepId, safe.subsectionId].join('::');
}

function _normaliseContentSignature(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type === 'image') {
    return JSON.stringify({ type: 'image', format: chunk.format || 'png', data: chunk.data || '' });
  }
  if (chunk.type === 'link') {
    return JSON.stringify({ type: 'link', text: chunk.text || '', url: chunk.url || '' });
  }
  if (chunk.type === 'subsection') {
    return JSON.stringify({
      type: 'subsection',
      title: chunk.title || '',
      content: cloneRichContentForStorage(chunk.content || [])
    });
  }
  return JSON.stringify({ type: 'text', text: chunk.text || '', bold: Boolean(chunk.bold), color: chunk.color || null });
}

function _mergeRichContentLists(baseContent, incomingContent) {
  var merged = cloneRichContentForStorage(baseContent || []);
  var seen = {};
  merged.forEach(function(chunk) {
    seen[_normaliseContentSignature(chunk)] = 1;
  });

  cloneRichContentForStorage(incomingContent || []).forEach(function(chunk) {
    var signature = _normaliseContentSignature(chunk);
    if (!signature || seen[signature]) return;
    seen[signature] = 1;
    merged.push(chunk);
  });

  return merged;
}

function _mergeFindingLinks(baseLinks, incomingLinks) {
  var merged = [];
  var seen = {};

  function append(link) {
    var safe = _normaliseFindingLink(link);
    var key = _makeFindingLinkKey(safe);
    if (!safe || !key || seen[key]) return;
    seen[key] = 1;
    merged.push(safe);
  }

  (baseLinks || []).forEach(append);
  (incomingLinks || []).forEach(append);

  merged.sort(function(a, b) {
    if (a.patternName !== b.patternName) return a.patternName.localeCompare(b.patternName);
    if (a.stepTitle !== b.stepTitle) return a.stepTitle.localeCompare(b.stepTitle);
    return a.subsectionId.localeCompare(b.subsectionId);
  });

  return merged;
}

function _modalitiesFromFindingLinks(links) {
  var seen = {};
  var modalities = [];
  (links || []).forEach(function(link) {
    var modality = String((link && link.modality) || 'Other').trim() || 'Other';
    if (seen[modality]) return;
    seen[modality] = 1;
    modalities.push(modality);
  });
  modalities.sort();
  return modalities;
}

function _normaliseFindingDoc(doc) {
  return {
    name: String((doc && doc.name) || '').trim(),
    nameKey: _normaliseFindingName(doc && doc.nameKey ? doc.nameKey : (doc && doc.name)),
    content: cloneRichContentForStorage((doc && doc.content) || []),
    isRedFinding: Boolean(doc && doc.isRedFinding),
    modalities: Array.isArray(doc && doc.modalities) ? doc.modalities.map(function(item) { return String(item || '').trim() || 'Other'; }).filter(Boolean) : [],
    links: Array.isArray(doc && doc.links) ? doc.links.map(_normaliseFindingLink).filter(Boolean) : [],
    createdAt: doc && doc.createdAt ? doc.createdAt : null,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null
  };
}

function _collectFindingIdsFromSteps(steps) {
  var ids = {};
  (steps || []).forEach(function(step) {
    var sections = normaliseStepSections(step && step.sections, step && step.richContent || []);
    (sections.dontMissPathology || []).forEach(function(item) {
      if (!item || item.type !== 'subsection') return;
      var title = String(item.title || '').trim();
      var findingId = String(item.findingId || '').trim() || _makeFindingId(title);
      if (!findingId) return;
      ids[findingId] = 1;
    });
  });
  return Object.keys(ids);
}

function _extractFindingsFromSteps(patternId, patternName, modality, steps) {
  var findingsById = {};

  (steps || []).forEach(function(step, stepIndex) {
    if (!step) return;
    var stepId = String(step.stepId || '').trim() || _makeStepId();
    step.stepId = stepId;
    var stepTitle = String(step.stepTitle || '').trim() || ('Step ' + (stepIndex + 1));
    var sections = normaliseStepSections(step.sections, step.richContent || []);

    (sections.dontMissPathology || []).forEach(function(item, itemIndex) {
      if (!item || item.type !== 'subsection') return;
      var title = String(item.title || '').trim();
      var findingId = String(item.findingId || '').trim() || _makeFindingId(title);
      if (!findingId) return;

      item.findingId = findingId;
      item.title = title || ('Findings Section ' + (itemIndex + 1));

      if (!findingsById[findingId]) {
        findingsById[findingId] = {
          id: findingId,
          name: item.title,
          nameKey: _normaliseFindingName(item.title),
          content: cloneRichContentForStorage(item.content || []),
          isRedFinding: Boolean(item.isRedFinding),
          links: []
        };
      } else {
        findingsById[findingId].content = _mergeRichContentLists(findingsById[findingId].content, item.content || []);
        findingsById[findingId].isRedFinding = Boolean(findingsById[findingId].isRedFinding || item.isRedFinding);
      }

      findingsById[findingId].links.push({
        patternId: patternId,
        patternName: patternName,
        modality: modality || 'Other',
        stepId: stepId,
        stepTitle: stepTitle,
        subsectionId: String(item.subsectionId || '').trim() || _makeSubsectionId()
      });
    });

    step.sections = sections;
  });

  return findingsById;
}

function _loadFindingsByIds(uid, ids) {
  var uniqueIds = (ids || []).filter(function(id, index, list) {
    return id && list.indexOf(id) === index;
  });
  if (!uniqueIds.length) return Promise.resolve({});

  var refs = uniqueIds.map(function(id) {
    return _findingsRef(uid).doc(id);
  });

  if (typeof appDb.getAll === 'function') {
    return appDb.getAll.apply(appDb, refs).then(function() {
      var snapshots = Array.prototype.slice.call(arguments);
      return snapshots.map(function(doc, index) {
        return {
          id: uniqueIds[index],
          exists: doc.exists,
          data: doc.exists ? _normaliseFindingDoc(doc.data() || {}) : null
        };
      });
    }).then(function(entries) {
      var out = {};
      entries.forEach(function(entry) {
        if (entry.exists && entry.data) out[entry.id] = entry.data;
      });
      return out;
    });
  }

  return Promise.all(refs.map(function(ref, index) {
    return ref.get().then(function(doc) {
      return { id: uniqueIds[index], exists: doc.exists, data: doc.exists ? _normaliseFindingDoc(doc.data() || {}) : null };
    });
  })).then(function(entries) {
    var out = {};
    entries.forEach(function(entry) {
      if (entry.exists && entry.data) out[entry.id] = entry.data;
    });
    return out;
  });
}

function _replaceArrayContents(target, next) {
  if (!Array.isArray(target)) return;
  target.length = 0;
  (next || []).forEach(function(item) {
    target.push(item);
  });
}

function _buildFindingMutations(patternId, extractedFindings, existingFindings, previousFindingIds) {
  var nextIds = Object.keys(extractedFindings || {});
  var allIds = (previousFindingIds || []).concat(nextIds).filter(function(id, index, list) {
    return id && list.indexOf(id) === index;
  });
  var mutations = [];

  allIds.forEach(function(findingId) {
    var existing = existingFindings[findingId] || null;
    var nextFinding = extractedFindings[findingId] || null;
    var baseLinks = existing ? (existing.links || []).filter(function(link) {
      return String((link && link.patternId) || '') !== String(patternId || '');
    }) : [];

    if (!nextFinding) {
      if (!existing) return;
      if (!baseLinks.length) {
        mutations.push({ type: 'delete', id: findingId });
        return;
      }
      mutations.push({
        type: 'set',
        id: findingId,
        data: {
          name: existing.name || '',
          nameKey: existing.nameKey || _normaliseFindingName(existing.name || ''),
          content: cloneRichContentForStorage(existing.content || []),
          isRedFinding: Boolean(existing.isRedFinding),
          modalities: _modalitiesFromFindingLinks(baseLinks),
          links: baseLinks,
          updatedAt: _now()
        },
        merge: true
      });
      return;
    }

    var mergedLinks = _mergeFindingLinks(baseLinks, nextFinding.links || []);
    var mergedContent = _mergeRichContentLists(existing ? existing.content : [], nextFinding.content || []);
    mutations.push({
      type: 'set',
      id: findingId,
      data: {
        name: nextFinding.name || (existing && existing.name) || '',
        nameKey: nextFinding.nameKey || (existing && existing.nameKey) || _normaliseFindingName(nextFinding.name || ''),
        content: mergedContent,
        isRedFinding: Boolean((existing && existing.isRedFinding) || nextFinding.isRedFinding),
        modalities: _modalitiesFromFindingLinks(mergedLinks),
        links: mergedLinks,
        updatedAt: _now(),
        createdAt: existing && existing.createdAt ? existing.createdAt : _now()
      },
      merge: true
    });
  });

  return mutations;
}

function _commitPatternAndFindingMutations(uid, patternRef, patternPayload, findingMutations, isCreate) {
  var ops = (findingMutations || []).slice();
  ops.push({ type: isCreate ? 'createPattern' : 'updatePattern', ref: patternRef, data: patternPayload });

  function commitChunk(index) {
    if (index >= ops.length) return Promise.resolve();
    var slice = ops.slice(index, index + FINDINGS_BATCH_SIZE);
    var batch = appDb.batch();

    slice.forEach(function(op) {
      if (op.type === 'delete') {
        batch.delete(_findingsRef(uid).doc(op.id));
        return;
      }
      if (op.type === 'set') {
        batch.set(_findingsRef(uid).doc(op.id), op.data, { merge: op.merge !== false });
        return;
      }
      if (op.type === 'createPattern') {
        batch.set(op.ref, op.data);
        return;
      }
      if (op.type === 'updatePattern') {
        batch.update(op.ref, op.data);
      }
    });

    return batch.commit().then(function() {
      return commitChunk(index + FINDINGS_BATCH_SIZE);
    });
  }

  return commitChunk(0);
}

function _hydratePatternsWithFindings(patterns, findingsById) {
  return (patterns || []).map(function(pattern) {
    var nextPattern = Object.assign({}, pattern);
    nextPattern.steps = (pattern.steps || []).map(function(step) {
      var nextStep = Object.assign({}, step);
      var sections = cloneStepSectionsForStorage(step && step.sections, step && step.richContent || []);
      sections.dontMissPathology = (sections.dontMissPathology || []).map(function(item) {
        if (!item || item.type !== 'subsection') return item;
        var findingId = String(item.findingId || '').trim();
        var finding = findingId ? findingsById[findingId] : null;
        if (!finding) return item;
        return Object.assign({}, item, {
          findingId: findingId,
          title: finding.name || item.title,
          isRedFinding: Boolean(finding.isRedFinding),
          content: cloneRichContentForStorage(finding.content || [])
        });
      });
      nextStep.sections = sections;
      nextStep.richContent = cloneRichContentForStorage(sections.searchPattern || nextStep.richContent || []);
      return nextStep;
    });
    return nextPattern;
  });
}

function _makeStepId() {
  return 'step_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function _makeSubsectionId() {
  return 'sub_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function _normaliseGoalSeconds(rawGoalSeconds, rawGoalMinutes) {
  var fromSeconds = Number(rawGoalSeconds);
  if (Number.isFinite(fromSeconds) && fromSeconds > 0) return Math.round(fromSeconds);

  var fromMinutes = Number(rawGoalMinutes);
  if (Number.isFinite(fromMinutes) && fromMinutes > 0) return Math.round(fromMinutes * 60);

  return null;
}

function _normaliseLinkMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var mode = raw.mode === 'snapshot' ? 'snapshot' : 'internal';
  var out = {
    mode: mode,
    sourcePatternId: String(raw.sourcePatternId || '').trim(),
    sourcePatternName: String(raw.sourcePatternName || '').trim(),
    sourceStepId: String(raw.sourceStepId || '').trim(),
    sourceStepTitle: String(raw.sourceStepTitle || '').trim(),
    tokenVersion: Number(raw.tokenVersion || 1)
  };

  if (mode === 'snapshot' && raw.snapshot && typeof raw.snapshot === 'object') {
    var snapshotRich = Array.isArray(raw.snapshot.richContent) ? raw.snapshot.richContent : [];
    out.snapshot = {
      stepTitle: String(raw.snapshot.stepTitle || '').trim(),
      stepId: String(raw.snapshot.stepId || '').trim() || _makeStepId(),
      linkedStepId: String(raw.snapshot.linkedStepId || '').trim(),
      richContent: cloneRichContentForStorage(snapshotRich),
      sections: cloneStepSectionsForStorage(raw.snapshot.sections, snapshotRich)
    };
  }

  return out;
}

function _normaliseSectionLinkMeta(raw) {
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

function _normaliseSectionLinks(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.searchPattern) {
    var link = _normaliseSectionLinkMeta(raw.searchPattern);
    if (link && link.sourceStepId) out.searchPattern = link;
  }
  return out;
}

function _getStepLinkIds(step) {
  var ids = [];
  var primary = String((step && step.stepId) || '').trim();
  var legacy = String((step && step.linkedStepId) || '').trim();
  if (primary) ids.push(primary);
  if (legacy && ids.indexOf(legacy) === -1) ids.push(legacy);
  return ids;
}

function normaliseSubsectionChunk(chunk) {
  var content = Array.isArray(chunk && chunk.content) ? chunk.content : [];
  return {
    type: 'subsection',
    subsectionId: String((chunk && (chunk.subsectionId || chunk.subsection_id)) || '').trim() || _makeSubsectionId(),
    findingId: String((chunk && (chunk.findingId || chunk.finding_id)) || '').trim(),
    title: (chunk && (chunk.title || chunk.name)) || '',
    isRedFinding: Boolean(chunk && (chunk.isRedFinding || chunk.is_red_finding || chunk.findingRed)),
    linkMeta: _normaliseSectionLinkMeta(chunk && (chunk.linkMeta || chunk.link_meta)),
    content: cloneRichContentForStorage(content)
  };
}

function normaliseStepSections(sections, fallbackRichContent) {
  var source = sections || {};
  var out = {};
  STEP_SECTION_KEYS.forEach(function(key) {
    var raw = source[key];
    if (!Array.isArray(raw)) raw = [];
    out[key] = raw.map(function(chunk) {
      var type = chunk && chunk.type
        ? chunk.type
        : ((chunk && (chunk.image_data || chunk.data)) ? 'image' : ((chunk && chunk.url) ? 'link' : ((chunk && (chunk.title || chunk.name) && Array.isArray(chunk.content)) ? 'subsection' : 'text')));
      if (type === 'image') {
        return {
          type: 'image',
          format: (chunk && (chunk.format || chunk.image_format)) || 'png',
          data: (chunk && (chunk.data || chunk.image_data)) || ''
        };
      }
      if (type === 'link') {
        return {
          type: 'link',
          text: (chunk && (chunk.text || chunk.content || chunk.url)) || '',
          url: (chunk && chunk.url) || ''
        };
      }
      if (type === 'subsection') {
        return normaliseSubsectionChunk(chunk);
      }
      return {
        type: 'text',
        text: (chunk && (chunk.text || chunk.content)) || '',
        bold: Boolean(chunk && chunk.bold),
        color: (chunk && chunk.color) || null
      };
    });
  });

  // Preserve legacy content by using it as the default Search Pattern section.
  if (!out.searchPattern.length && Array.isArray(fallbackRichContent) && fallbackRichContent.length) {
    out.searchPattern = cloneRichContentForStorage(fallbackRichContent);
  }

  return out;
}

function cloneStepSectionsForStorage(sections, fallbackRichContent) {
  var normalised = normaliseStepSections(sections, fallbackRichContent);
  var out = {};
  STEP_SECTION_KEYS.forEach(function(key) {
    out[key] = cloneRichContentForStorage(normalised[key]);
  });
  return out;
}

function _normalisePatternDoc(doc) {
  var rawSteps = doc.steps;
  var rawTemplateUsageCounts = (doc && doc.reportConfig && doc.reportConfig.templateUsageCounts && typeof doc.reportConfig.templateUsageCounts === 'object')
    ? doc.reportConfig.templateUsageCounts
    : {};
  var templateUsageCounts = {};

  Object.keys(rawTemplateUsageCounts).forEach(function(templateId) {
    var safeTemplateId = String(templateId || '').trim();
    var count = Number(rawTemplateUsageCounts[templateId]);
    if (!safeTemplateId || !Number.isFinite(count) || count <= 0) return;
    templateUsageCounts[safeTemplateId] = Math.floor(count);
  });

  // Legacy imports may store steps in alternate fields or JSON strings.
  if (!rawSteps && doc.steps_json) rawSteps = doc.steps_json;
  if (typeof rawSteps === 'string') {
    try { rawSteps = JSON.parse(rawSteps); }
    catch (e) { rawSteps = []; }
  }
  if (!Array.isArray(rawSteps)) rawSteps = [];

  var steps = rawSteps.map(function(step) {
    var rawRich = step.richContent || step.rich_content || [];
    if (typeof rawRich === 'string') {
      try { rawRich = JSON.parse(rawRich); }
      catch (e) { rawRich = []; }
    }
    if (!Array.isArray(rawRich)) rawRich = [];

    var richContent = rawRich.map(function(chunk) {
      var type = chunk && chunk.type
        ? chunk.type
        : ((chunk && (chunk.image_data || chunk.data)) ? 'image' : ((chunk && chunk.url) ? 'link' : ((chunk && (chunk.title || chunk.name) && Array.isArray(chunk.content)) ? 'subsection' : 'text')));
      if (type === 'image') {
        return {
          type: 'image',
          format: (chunk && (chunk.format || chunk.image_format)) || 'png',
          data: (chunk && (chunk.data || chunk.image_data)) || ''
        };
      }
      if (type === 'link') {
        return {
          type: 'link',
          text: (chunk && (chunk.text || chunk.content || chunk.url)) || '',
          url: (chunk && chunk.url) || ''
        };
      }
      if (type === 'subsection') {
        return normaliseSubsectionChunk(chunk);
      }
      return {
        type: 'text',
        text: (chunk && (chunk.text || chunk.content)) || '',
        bold: Boolean(chunk && chunk.bold),
        color: (chunk && chunk.color) || null
      };
    });

    return {
      stepTitle: (step && (step.stepTitle || step.step_title)) || '',
      isRedStep: Boolean(step && (step.isRedStep || step.is_red_step || step.stepColorRed)),
      stepId: String((step && (step.stepId || step.step_id)) || '').trim() || _makeStepId(),
      richContent: richContent,
      linkedStepId: (step && (step.linkedStepId || step.linked_step_id)) || '',
      linkMeta: _normaliseLinkMeta(step && (step.linkMeta || step.link_meta)),
      sectionLinks: _normaliseSectionLinks(step && (step.sectionLinks || step.section_links)),
      sections: normaliseStepSections(step && step.sections, richContent)
    };
  });

  return {
    reportConfig: (doc && doc.reportConfig && typeof doc.reportConfig === 'object') ? {
      selectedTemplateId: String(doc.reportConfig.selectedTemplateId || '').trim(),
      selectedTemplateName: String(doc.reportConfig.selectedTemplateName || '').trim(),
      sectionOrder: Array.isArray(doc.reportConfig.sectionOrder) ? doc.reportConfig.sectionOrder.slice() : [],
      templateUsageCounts: templateUsageCounts
    } : null,
    name: doc.name || doc.pattern_name || '',
    modality: doc.modality || 'Other',
    steps: steps,
    goalSeconds: _normaliseGoalSeconds(doc.goalSeconds, doc.goalMinutes),
    updatedAt: doc.updatedAt || null
  };
}

// ── Patterns ─────────────────────────────────────────────────
function subscribePatterns(uid, callback) {
  var latestPatterns = [];
  var latestFindings = {};
  var patternsReady = false;
  var findingsReady = false;

  function emit() {
    if (!patternsReady || !findingsReady) return;
    callback(_hydratePatternsWithFindings(latestPatterns, latestFindings));
  }

  var unsubscribePatterns = _patternsRef(uid).orderBy('name').onSnapshot(function(snap) {
    latestPatterns = snap.docs.map(function(d) {
      return Object.assign({ id: d.id }, _normalisePatternDoc(d.data() || {}));
    });
    patternsReady = true;
    emit();
  }, function(err) { console.error('subscribePatterns error:', err); });

  var unsubscribeFindings = subscribeFindings(uid, function(findings) {
    latestFindings = {};
    (findings || []).forEach(function(finding) {
      latestFindings[String((finding && finding.id) || '').trim()] = finding;
    });
    findingsReady = true;
    emit();
  });

  return function() {
    if (typeof unsubscribePatterns === 'function') unsubscribePatterns();
    if (typeof unsubscribeFindings === 'function') unsubscribeFindings();
  };
}

function subscribeFindings(uid, callback) {
  if (!uid) { callback([]); return function() {}; }
  return _findingsRef(uid).orderBy('nameKey').onSnapshot(function(snap) {
    var findings = snap.docs.map(function(d) {
      return Object.assign({ id: d.id }, _normaliseFindingDoc(d.data() || {}));
    });
    callback(findings);
  }, function(err) {
    console.error('subscribeFindings error:', err);
  });
}

function createPattern(uid, data) {
  var goalSeconds = _normaliseGoalSeconds(data.goalSeconds, data.goalMinutes);
  var ref = _patternsRef(uid).doc();
  var patternId = ref.id;
  var rawSteps = Array.isArray(data.steps) ? data.steps : [];
  var workingSteps = JSON.parse(JSON.stringify(rawSteps));
  var extractedFindings = _extractFindingsFromSteps(patternId, data.name, data.modality || 'Other', workingSteps);
  var findingIds = Object.keys(extractedFindings);

  return _loadFindingsByIds(uid, findingIds).then(function(existingFindings) {
    var findingMutations = _buildFindingMutations(patternId, extractedFindings, existingFindings, []);
    var payload = {
      name: data.name,
      modality: data.modality || 'Other',
      steps: workingSteps,
      reportConfig: data.reportConfig && typeof data.reportConfig === 'object' ? data.reportConfig : null,
      goalSeconds: goalSeconds,
      updatedAt: _now()
    };

    _replaceArrayContents(rawSteps, workingSteps);
    return _commitPatternAndFindingMutations(uid, ref, payload, findingMutations, true).then(function() {
      return patternId;
    });
  });
}

function updatePattern(uid, patternId, data) {
  var rawSteps = Array.isArray(data.steps) ? data.steps : [];
  var workingSteps = JSON.parse(JSON.stringify(rawSteps));
  var patternRef = _patternsRef(uid).doc(patternId);

  return patternRef.get().then(function(existingDoc) {
    var existingPattern = existingDoc.exists ? _normalisePatternDoc(existingDoc.data() || {}) : { steps: [] };
    var extractedFindings = _extractFindingsFromSteps(patternId, data.name, data.modality || 'Other', workingSteps);
    var previousFindingIds = _collectFindingIdsFromSteps(existingPattern.steps || []);
    var nextFindingIds = Object.keys(extractedFindings || {});
    var allFindingIds = previousFindingIds.concat(nextFindingIds).filter(function(id, index, list) {
      return id && list.indexOf(id) === index;
    });

    return _loadFindingsByIds(uid, allFindingIds).then(function(existingFindings) {
      var payload = {
        name: data.name,
        modality: data.modality || 'Other',
        steps: workingSteps,
        reportConfig: data.reportConfig && typeof data.reportConfig === 'object' ? data.reportConfig : null,
        updatedAt: _now()
      };
      if (Object.prototype.hasOwnProperty.call(data, 'goalSeconds') || Object.prototype.hasOwnProperty.call(data, 'goalMinutes')) {
        payload.goalSeconds = _normaliseGoalSeconds(data.goalSeconds, data.goalMinutes);
      }

      var findingMutations = _buildFindingMutations(patternId, extractedFindings, existingFindings, previousFindingIds);
      _replaceArrayContents(rawSteps, workingSteps);
      return _commitPatternAndFindingMutations(uid, patternRef, payload, findingMutations, false);
    });
  });
}

function updatePatternGoalSeconds(uid, patternId, goalSeconds) {
  var normalisedGoal = _normaliseGoalSeconds(goalSeconds, null);
  return _patternsRef(uid).doc(patternId).update({
    goalSeconds: normalisedGoal,
    updatedAt: _now()
  });
}

function updatePatternReportConfig(uid, patternId, reportConfig) {
  return _patternsRef(uid).doc(patternId).update({
    reportConfig: reportConfig && typeof reportConfig === 'object' ? reportConfig : null,
    updatedAt: _now()
  });
}

function cloneRichContentForStorage(richContent) {
  return (richContent || []).map(function(chunk) {
    if (chunk && chunk.type === 'image') {
      return {
        type: 'image',
        format: chunk.format || 'png',
        data: chunk.data || ''
      };
    }
    if (chunk && chunk.type === 'link') {
      return {
        type: 'link',
        text: chunk.text || chunk.url || '',
        url: chunk.url || ''
      };
    }
    if (chunk && chunk.type === 'subsection') {
      return normaliseSubsectionChunk(chunk);
    }
    return {
      type: 'text',
      text: (chunk && chunk.text) || '',
      bold: Boolean(chunk && chunk.bold),
      color: (chunk && chunk.color) || null
    };
  });
}

function _areStepsEquivalent(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function propagateLinkedSteps(uid, sourcePatternId, sourceSteps, allPatterns) {
  var linkedMap = {};
  var sourceStepMap = {};
  var sourceFindingMap = {};

  (sourceSteps || []).forEach(function(step) {
    var linkIds = _getStepLinkIds(step);
    var stepId = String((step && step.stepId) || '').trim() || _makeStepId();

    var sharedData = {
      stepTitle: (step && step.stepTitle) || '',
      isRedStep: Boolean(step && step.isRedStep),
      stepId: stepId,
      richContent: cloneRichContentForStorage(step && step.richContent),
      sections: cloneStepSectionsForStorage(step && step.sections, step && step.richContent),
      linkMeta: _normaliseLinkMeta(step && step.linkMeta),
      sectionLinks: _normaliseSectionLinks(step && step.sectionLinks)
    };

    sourceStepMap[stepId] = sharedData;

    var findings = (sharedData.sections && sharedData.sections.dontMissPathology) || [];
    findings.forEach(function(item) {
      if (!item || item.type !== 'subsection') return;
      var subsectionId = String(item.subsectionId || '').trim();
      if (!subsectionId) return;
      sourceFindingMap[subsectionId] = {
        subsectionId: subsectionId,
        title: item.title || '',
        isRedFinding: Boolean(item.isRedFinding),
        content: cloneRichContentForStorage(item.content || []),
        sourceStepId: stepId,
        sourceStepTitle: sharedData.stepTitle || ''
      };
    });

    if (!linkIds.length) return;

    linkIds.forEach(function(linkId) {
      linkedMap[linkId] = sharedData;
    });
  });

  var linkedIds = Object.keys(linkedMap);
  var sourceStepIds = Object.keys(sourceStepMap);
  var sourceFindingIds = Object.keys(sourceFindingMap);
  if (!linkedIds.length && !sourceStepIds.length && !sourceFindingIds.length) return Promise.resolve(0);

  var patternsToUpdate = [];
  (allPatterns || []).forEach(function(pattern) {
    if (!pattern || pattern.id === sourcePatternId) return;

    var steps = pattern.steps || [];
    var changed = false;
    var newSteps = steps.map(function(step) {
      var currentKey = String((step && step.linkedStepId) || '').trim();
      var stepId = String((step && step.stepId) || '').trim();
      var nextStep = Object.assign({}, step, {
        stepId: stepId || _makeStepId(),
        sectionLinks: _normaliseSectionLinks(step && step.sectionLinks)
      });

      if (currentKey && linkedMap[currentKey]) {
        var shared = linkedMap[currentKey];
        nextStep = Object.assign({}, nextStep, {
          stepTitle: shared.stepTitle,
          isRedStep: Boolean(shared.isRedStep),
          stepId: String((nextStep && nextStep.stepId) || '').trim() || shared.stepId || _makeStepId(),
          richContent: cloneRichContentForStorage(shared.richContent),
          linkedStepId: String((step && step.linkedStepId) || '').trim() || currentKey,
          linkMeta: _normaliseLinkMeta(step && step.linkMeta) || shared.linkMeta || null,
          sections: cloneStepSectionsForStorage(shared.sections, shared.richContent)
        });
      }

      var nextSections = cloneStepSectionsForStorage(nextStep.sections, nextStep.richContent || []);
      var nextSectionLinks = _normaliseSectionLinks(nextStep.sectionLinks);

      var searchPatternLink = nextSectionLinks.searchPattern;
      if (searchPatternLink && searchPatternLink.sourceStepId && sourceStepMap[searchPatternLink.sourceStepId]) {
        var sourceStep = sourceStepMap[searchPatternLink.sourceStepId];
        nextSections.searchPattern = cloneRichContentForStorage((sourceStep.sections && sourceStep.sections.searchPattern) || []);
        nextStep.richContent = cloneRichContentForStorage(nextSections.searchPattern);
      }

      var findings = cloneRichContentForStorage(nextSections.dontMissPathology || []);
      findings = findings.map(function(item) {
        if (!item || item.type !== 'subsection') return item;
        var linkMeta = _normaliseSectionLinkMeta(item.linkMeta);
        if (!linkMeta || !linkMeta.sourceSubsectionId || !sourceFindingMap[linkMeta.sourceSubsectionId]) {
          return item;
        }
        var sourceFinding = sourceFindingMap[linkMeta.sourceSubsectionId];
        return Object.assign({}, item, {
          title: sourceFinding.title || item.title,
          isRedFinding: Boolean(sourceFinding.isRedFinding),
          content: cloneRichContentForStorage(sourceFinding.content || []),
          linkMeta: Object.assign({}, linkMeta, {
            sourceStepId: sourceFinding.sourceStepId,
            sourceStepTitle: sourceFinding.sourceStepTitle,
            sourceSubsectionTitle: sourceFinding.title || linkMeta.sourceSubsectionTitle || ''
          })
        });
      });
      nextSections.dontMissPathology = findings;
      nextStep.sections = nextSections;
      nextStep.sectionLinks = nextSectionLinks;

      var sameTitle = (step.stepTitle || '') === nextStep.stepTitle;
      var sameRed = Boolean(step && step.isRedStep) === Boolean(nextStep && nextStep.isRedStep);
      var sameRich = JSON.stringify(step.richContent || []) === JSON.stringify(nextStep.richContent || []);
      var sameSections = JSON.stringify(normaliseStepSections(step.sections, step.richContent || [])) === JSON.stringify(nextStep.sections || {});
      var sameSectionLinks = JSON.stringify(_normaliseSectionLinks(step && step.sectionLinks)) === JSON.stringify(nextStep.sectionLinks || {});
      if (!sameTitle || !sameRed || !sameRich || !sameSections || !sameSectionLinks) changed = true;

      return nextStep;
    });

    if (changed && !_areStepsEquivalent(steps, newSteps)) {
      patternsToUpdate.push({ id: pattern.id, steps: newSteps });
    }
  });

  if (!patternsToUpdate.length) return Promise.resolve(0);

  var CHUNK = 400;
  function commitChunk(i) {
    if (i >= patternsToUpdate.length) return Promise.resolve();
    var chunk = patternsToUpdate.slice(i, i + CHUNK);
    var batch = appDb.batch();
    chunk.forEach(function(item) {
      batch.update(_patternsRef(uid).doc(item.id), {
        steps: item.steps,
        updatedAt: _now()
      });
    });
    return batch.commit().then(function() { return commitChunk(i + CHUNK); });
  }

  return commitChunk(0).then(function() { return patternsToUpdate.length; });
}

function deletePattern(uid, patternId) {
  return _patternsRef(uid).doc(patternId).delete();
}

// ── Report Templates ─────────────────────────────────────────
function _normaliseReportTemplateDoc(doc) {
  return {
    name: String((doc && doc.name) || '').trim(),
    body: String((doc && doc.body) || ''),
    rulesText: String((doc && doc.rulesText) || ''),
    patternId: String((doc && doc.patternId) || '').trim(),
    createdAt: doc && doc.createdAt ? doc.createdAt : null,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null
  };
}

function subscribeReportTemplates(uid, patternId, callback) {
  var scopedPatternId = String(patternId || '').trim();
  if (!scopedPatternId) {
    callback([]);
    return function() {};
  }

  return _reportTemplatesRef(uid)
    .where('patternId', '==', scopedPatternId)
    .onSnapshot(function(snap) {
      var templates = snap.docs.map(function(d) {
        return Object.assign({ id: d.id }, _normaliseReportTemplateDoc(d.data() || {}));
      });
      templates.sort(function(a, b) {
        var aMs = (a && a.updatedAt && typeof a.updatedAt.toMillis === 'function') ? a.updatedAt.toMillis() : 0;
        var bMs = (b && b.updatedAt && typeof b.updatedAt.toMillis === 'function') ? b.updatedAt.toMillis() : 0;
        return bMs - aMs;
      });
      callback(templates);
    }, function(err) {
      console.error('subscribeReportTemplates error:', err);
    });
}

function subscribeAllReportTemplates(uid, callback) {
  if (!uid) { callback([]); return function() {}; }
  return _reportTemplatesRef(uid)
    .onSnapshot(function(snap) {
      var templates = snap.docs.map(function(d) {
        return Object.assign({ id: d.id }, _normaliseReportTemplateDoc(d.data() || {}));
      });
      templates.sort(function(a, b) {
        var aMs = (a && a.updatedAt && typeof a.updatedAt.toMillis === 'function') ? a.updatedAt.toMillis() : 0;
        var bMs = (b && b.updatedAt && typeof b.updatedAt.toMillis === 'function') ? b.updatedAt.toMillis() : 0;
        return bMs - aMs;
      });
      callback(templates);
    }, function(err) {
      console.error('subscribeAllReportTemplates error:', err);
    });
}

function upsertReportTemplate(uid, templateId, data) {
  var payload = {
    name: String(data && data.name || '').trim(),
    body: String(data && data.body || ''),
    rulesText: String(data && data.rulesText || ''),
    patternId: String(data && data.patternId || '').trim(),
    updatedAt: _now()
  };

  if (!payload.patternId) {
    throw new Error('Report template must be saved for a selected pattern.');
  }

  if (templateId) {
    return _reportTemplatesRef(uid).doc(templateId).set(payload, { merge: true }).then(function() {
      return templateId;
    });
  }

  payload.createdAt = _now();
  return _reportTemplatesRef(uid).add(payload).then(function(ref) {
    return ref.id;
  });
}

function deleteReportTemplate(uid, templateId) {
  return _reportTemplatesRef(uid).doc(templateId).delete();
}

// ── Study Log ─────────────────────────────────────────────────
function subscribeStudyLog(uid, callback) {
  return _studyLogRef(uid).orderBy('timestamp', 'desc').onSnapshot(function(snap) {
    var entries = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
    callback(entries);
  }, function(err) { console.error('subscribeStudyLog error:', err); });
}

function addStudyLogEntry(uid, data) {
  var today = new Date().toISOString().split('T')[0];
  return _studyLogRef(uid).add({
    study: data.study,
    seconds: data.seconds,
    duration: data.duration,
    rvu: (data.rvu !== null && data.rvu !== undefined && data.rvu !== '') ? Number(data.rvu) : null,
    timestamp: _now(),
    date: today
  }).then(function(ref) { return ref.id; });
}

function deleteStudyLogEntry(uid, logId) {
  return _studyLogRef(uid).doc(logId).delete();
}

function updateStudyLogEntry(uid, logId, data) {
  var updateData = {
    study: data.study,
    seconds: data.seconds,
    duration: data.duration,
    rvu: (data.rvu !== null && data.rvu !== undefined && data.rvu !== '') ? Number(data.rvu) : null
  };
  return _studyLogRef(uid).doc(logId).update(updateData);
}

// ── Batch imports ─────────────────────────────────────────────
function batchImportPatterns(uid, patterns, onProgress) {
  var ref = _patternsRef(uid);
  var CHUNK = 400;
  var done = 0;

  function nextChunk(i) {
    if (i >= patterns.length) return Promise.resolve();
    var chunk = patterns.slice(i, i + CHUNK);
    var batch = appDb.batch();
    chunk.forEach(function(p) {
      var docRef = ref.doc();
      batch.set(docRef, {
        name: p.name,
        modality: p.modality || 'Other',
        steps: p.steps || [],
        goalSeconds: _normaliseGoalSeconds(p.goalSeconds, p.goalMinutes),
        updatedAt: firebase.firestore.Timestamp.now()
      });
    });
    return batch.commit().then(function() {
      done += chunk.length;
      if (onProgress) onProgress(done, patterns.length);
      return nextChunk(i + CHUNK);
    });
  }
  return nextChunk(0);
}

function batchImportStudyLog(uid, rows, onProgress) {
  var ref = _studyLogRef(uid);
  var CHUNK = 400;
  var done = 0;

  function nextChunk(i) {
    if (i >= rows.length) return Promise.resolve();
    var chunk = rows.slice(i, i + CHUNK);
    var batch = appDb.batch();
    chunk.forEach(function(row) {
      var docRef = ref.doc();
      var ts;
      try { ts = firebase.firestore.Timestamp.fromDate(new Date(row.timestamp)); }
      catch (e) { ts = firebase.firestore.Timestamp.now(); }
      batch.set(docRef, {
        study: row.study || '',
        seconds: Number(row.seconds) || 0,
        duration: row.duration || '',
        rvu: (row.rvu !== '' && row.rvu != null) ? Number(row.rvu) : null,
        date: row.date || '',
        timestamp: ts
      });
    });
    return batch.commit().then(function() {
      done += chunk.length;
      if (onProgress) onProgress(done, rows.length);
      return nextChunk(i + CHUNK);
    });
  }
  return nextChunk(0);
}
