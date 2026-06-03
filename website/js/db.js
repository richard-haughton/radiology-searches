// db.js — plain script, no modules. Depends on firebase-config.js (appDb global).

function _userRef(uid)       { return appDb.collection('users').doc(uid); }
function _patternsRef(uid)   { return _userRef(uid).collection('patterns'); }
function _findingsRef(uid)   { return _userRef(uid).collection('findings'); }
function _studyLogRef(uid)   { return _userRef(uid).collection('studyLog'); }
function _reportTemplatesRef(uid) { return _userRef(uid).collection('reportTemplates'); }
function _now()              { return firebase.firestore.FieldValue.serverTimestamp(); }

function stripStepTitleNumbering(title) {
  var raw = String(title || '').trim();
  if (!raw) return '';
  return raw.replace(/^(?:step\s+\d+|\d+)\s*[.)\-:]?\s*/i, '').trim();
}

var STEP_SECTION_KEYS = ['searchPattern', 'dontMissPathology', 'measurements', 'hyperlinks', 'images'];
var FINDINGS_BATCH_SIZE = 400;
var FIRESTORE_WRITE_COOLDOWN_MS = 30000;
var _firestoreWriteBlockedUntil = 0;

function _isFirestoreWriteOverloadError(err) {
  if (!err) return false;
  var code = String(err.code || '').toLowerCase();
  if (code === 'resource-exhausted') return true;
  var msg = String(err.message || err || '').toLowerCase();
  if (msg.indexOf('write stream exhausted') >= 0) return true;
  if (msg.indexOf('queued writes') >= 0) return true;
  if (msg.indexOf('maximum allowed queued writes') >= 0) return true;
  if (msg.indexOf('resource exhausted') >= 0) return true;
  return false;
}

function _makeFirestoreWriteCooldownError(waitMs) {
  var ms = Math.max(0, Number(waitMs) || 0);
  var err = new Error('Firestore write queue is overloaded. Please retry in ' + (Math.ceil(ms / 1000) || 1) + 's.');
  err.code = 'resource-exhausted';
  err.retryAfterMs = ms;
  err.isWriteCooldown = true;
  return err;
}

function _runFirestoreWrite(workFn) {
  var now = Date.now();
  if (_firestoreWriteBlockedUntil > now) {
    return Promise.reject(_makeFirestoreWriteCooldownError(_firestoreWriteBlockedUntil - now));
  }
  return Promise.resolve().then(function() {
    return workFn();
  }).catch(function(err) {
    if (_isFirestoreWriteOverloadError(err)) {
      _firestoreWriteBlockedUntil = Date.now() + FIRESTORE_WRITE_COOLDOWN_MS;
    }
    throw err;
  });
}

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

function _isFindingStudyLink(link) {
  var safe = _normaliseFindingLink(link);
  return Boolean(safe && safe.patternId && safe.stepId && safe.subsectionId);
}

function _filterFindingStudyLinks(links) {
  return (links || []).map(_normaliseFindingLink).filter(function(link) {
    return _isFindingStudyLink(link);
  });
}

function _hasFindingStudyLinks(links) {
  return _filterFindingStudyLinks(links).length > 0;
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
  if (chunk.type === 'list') {
    return JSON.stringify({
      type: 'list',
      ordered: Boolean(chunk.ordered),
      items: (chunk.items || []).map(function(item) {
        return _normaliseListItemContent(item);
      })
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
  var links = _filterFindingStudyLinks(doc && doc.links);
  return {
    name: String((doc && doc.name) || '').trim(),
    nameKey: _normaliseFindingName(doc && doc.nameKey ? doc.nameKey : (doc && doc.name)),
    content: cloneRichContentForStorage((doc && doc.content) || []),
    isRedFinding: Boolean(doc && doc.isRedFinding),
    modalities: _modalitiesFromFindingLinks(links),
    links: links,
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
    var stepTitle = stripStepTitleNumbering(step && step.stepTitle) || ('Step ' + (stepIndex + 1));
    var sections = normaliseStepSections(step.sections, step.richContent || []);

    (sections.dontMissPathology || []).forEach(function(item, itemIndex) {
      if (!item || item.type !== 'subsection') return;
      var title = String(item.title || '').trim();
      var findingId = String(item.findingId || '').trim() || _makeFindingId(title);
      if (!findingId) return;
      var subsectionId = String(item.subsectionId || '').trim() || _makeSubsectionId();

      item.findingId = findingId;
      item.subsectionId = subsectionId;
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
        // Overwrite semantics: latest occurrence in this save payload wins.
        findingsById[findingId].name = item.title;
        findingsById[findingId].nameKey = _normaliseFindingName(item.title);
        findingsById[findingId].content = cloneRichContentForStorage(item.content || []);
        findingsById[findingId].isRedFinding = Boolean(item.isRedFinding);
      }

      findingsById[findingId].links.push({
        patternId: patternId,
        patternName: patternName,
        modality: modality || 'Other',
        stepId: stepId,
        stepTitle: stepTitle,
        subsectionId: subsectionId
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

function _normaliseListItemContent(item) {
  if (Array.isArray(item)) return cloneRichContentForStorage(item);
  if (item && typeof item === 'object' && Array.isArray(item.content)) {
    return cloneRichContentForStorage(item.content);
  }
  return [];
}

function _isFirestoreDocumentSizeError(err) {
  if (!err) return false;
  var msg = String((err && err.message) || err || '').toLowerCase();
  if (msg.indexOf('exceeds the maximum allowed size') >= 0) return true;
  if (msg.indexOf('maximum allowed size of 1,048,576') >= 0) return true;
  if (msg.indexOf('document too large') >= 0) return true;
  return false;
}

function _buildLeanPatternStepsForStorage(steps) {
  var cloned = JSON.parse(JSON.stringify(steps || []));
  return cloned.map(function(step) {
    var nextStep = Object.assign({}, step);
    var sections = cloneStepSectionsForStorage(nextStep.sections, nextStep.richContent || []);
    sections.dontMissPathology = (sections.dontMissPathology || []).map(function(item) {
      if (!item || item.type !== 'subsection') return item;
      return Object.assign({}, item, {
        content: []
      });
    });
    nextStep.sections = sections;
    nextStep.richContent = cloneRichContentForStorage(sections.searchPattern || []);
    return nextStep;
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
          updatedAt: _now(),
          createdAt: existing && existing.createdAt ? existing.createdAt : _now()
        },
        merge: false
      });
      return;
    }

    var mergedLinks = _mergeFindingLinks(baseLinks, nextFinding.links || []);
    mutations.push({
      type: 'set',
      id: findingId,
      data: {
        name: nextFinding.name || (existing && existing.name) || '',
        nameKey: nextFinding.nameKey || (existing && existing.nameKey) || _normaliseFindingName(nextFinding.name || ''),
        content: cloneRichContentForStorage(nextFinding.content || []),
        isRedFinding: Boolean(nextFinding.isRedFinding),
        modalities: _modalitiesFromFindingLinks(mergedLinks),
        links: mergedLinks,
        updatedAt: _now(),
        createdAt: existing && existing.createdAt ? existing.createdAt : _now()
      },
      merge: false
    });
  });

  return mutations;
}

function _commitPatternAndFindingMutations(uid, patternRef, patternPayload, findingMutations, isCreate) {
  var ops = (findingMutations || []).slice();
  ops.push({ type: isCreate ? 'createPattern' : 'updatePattern', ref: patternRef, data: patternPayload });

  return _commitFindingOps(uid, ops);
}

function _commitFindingOps(uid, ops) {
  var queuedOps = (ops || []).slice();

  function commitChunk(index) {
    if (index >= queuedOps.length) return Promise.resolve();
    var slice = queuedOps.slice(index, index + FINDINGS_BATCH_SIZE);
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
        return;
      }
      if (op.type === 'deletePattern') {
        batch.delete(op.ref);
      }
    });

    return _runFirestoreWrite(function() { return batch.commit(); }).then(function() {
      return commitChunk(index + FINDINGS_BATCH_SIZE);
    });
  }

  return commitChunk(0);
}

function _deleteFindingDocs(uid, findingIds) {
  var uniqueIds = (findingIds || []).filter(function(id, index, list) {
    return id && list.indexOf(id) === index;
  });
  if (!uniqueIds.length) return Promise.resolve();

  var ops = uniqueIds.map(function(id) {
    return { type: 'delete', id: id };
  });

  return _commitFindingOps(uid, ops);
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

function _stripLinkedStepData(step) {
  if (!step || typeof step !== 'object') return step;

  var nextStep = Object.assign({}, step);
  nextStep.linkedStepId = '';
  nextStep.linkMeta = null;
  nextStep.sectionLinks = {};

  var sections = normaliseStepSections(nextStep.sections, nextStep.richContent || []);
  sections.dontMissPathology = (sections.dontMissPathology || []).map(function(item) {
    if (!item || item.type !== 'subsection') return item;
    return Object.assign({}, item, {
      linkMeta: null
    });
  });

  nextStep.sections = sections;
  return nextStep;
}

function _stripLinkedStepDataList(steps) {
  return (steps || []).map(_stripLinkedStepData);
}

function _sanitizeStepTitles(steps) {
  (steps || []).forEach(function(step) {
    if (!step || typeof step !== 'object') return;
    step.stepTitle = stripStepTitleNumbering(step.stepTitle || '');
  });
  return steps || [];
}

function _prepareStepsForFirestore(steps) {
  return (steps || []).map(function(step) {
    if (!step || typeof step !== 'object') return step;
    var nextStep = Object.assign({}, step);
    var sections = cloneStepSectionsForStorage(nextStep.sections, nextStep.richContent || []);
    nextStep.sections = sections;
    nextStep.richContent = cloneRichContentForStorage(sections.searchPattern || nextStep.richContent || []);
    return nextStep;
  });
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
      if (type === 'list') {
        return {
          type: 'list',
          ordered: Boolean(chunk && chunk.ordered),
          items: Array.isArray(chunk && chunk.items)
            ? chunk.items.map(function(item) {
                return _normaliseListItemContent(item);
              })
            : []
        };
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
      if (type === 'list') {
        return {
          type: 'list',
          ordered: Boolean(chunk && chunk.ordered),
          items: Array.isArray(chunk && chunk.items)
            ? chunk.items.map(function(item) {
                return _normaliseListItemContent(item);
              })
            : []
        };
      }
      return {
        type: 'text',
        text: (chunk && (chunk.text || chunk.content)) || '',
        bold: Boolean(chunk && chunk.bold),
        color: (chunk && chunk.color) || null
      };
    });

    return {
      stepTitle: stripStepTitleNumbering(step && (step.stepTitle || step.step_title)),
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
    var findings = [];
    snap.docs.forEach(function(d) {
      var finding = _normaliseFindingDoc(d.data() || {});
      findings.push(Object.assign({ id: d.id }, finding));
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
  var workingSteps = _stripLinkedStepDataList(JSON.parse(JSON.stringify(rawSteps)));
  _sanitizeStepTitles(workingSteps);
  var extractedFindings = _extractFindingsFromSteps(patternId, data.name, data.modality || 'Other', workingSteps);
  var firestoreSteps = _prepareStepsForFirestore(workingSteps);
  var findingIds = Object.keys(extractedFindings);

  return _loadFindingsByIds(uid, findingIds).then(function(existingFindings) {
    var findingMutations = _buildFindingMutations(patternId, extractedFindings, existingFindings, []);
    var payload = {
      name: data.name,
      modality: data.modality || 'Other',
      steps: firestoreSteps,
      reportConfig: data.reportConfig && typeof data.reportConfig === 'object' ? data.reportConfig : null,
      goalSeconds: goalSeconds,
      updatedAt: _now()
    };

    _replaceArrayContents(rawSteps, firestoreSteps);
    return _commitPatternAndFindingMutations(uid, ref, payload, findingMutations, true).then(function() {
      return patternId;
    });
  });
}

function updatePattern(uid, patternId, data) {
  var rawSteps = Array.isArray(data.steps) ? data.steps : [];
  var workingSteps = _stripLinkedStepDataList(JSON.parse(JSON.stringify(rawSteps)));
  _sanitizeStepTitles(workingSteps);
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
      var firestoreSteps = _prepareStepsForFirestore(workingSteps);
      var payload = {
        name: data.name,
        modality: data.modality || 'Other',
        steps: firestoreSteps,
        reportConfig: data.reportConfig && typeof data.reportConfig === 'object' ? data.reportConfig : null,
        updatedAt: _now()
      };
      if (Object.prototype.hasOwnProperty.call(data, 'goalSeconds') || Object.prototype.hasOwnProperty.call(data, 'goalMinutes')) {
        payload.goalSeconds = _normaliseGoalSeconds(data.goalSeconds, data.goalMinutes);
      }

      var findingMutations = _buildFindingMutations(patternId, extractedFindings, existingFindings, previousFindingIds);
      _replaceArrayContents(rawSteps, firestoreSteps);

      function commitWithFallback(currentPayload, hasRetriedSlim) {
        return _commitPatternAndFindingMutations(uid, patternRef, currentPayload, findingMutations, false).catch(function(err) {
          if (hasRetriedSlim || !_isFirestoreDocumentSizeError(err)) {
            throw err;
          }

          var leanSteps = _buildLeanPatternStepsForStorage(workingSteps);
          var leanPayload = Object.assign({}, currentPayload, {
            steps: leanSteps
          });

          console.warn('Pattern document exceeded size limit; retrying save with lean embedded findings payload for pattern', patternId);
          return _commitPatternAndFindingMutations(uid, patternRef, leanPayload, findingMutations, false);
        });
      }

      return commitWithFallback(payload, false);
    });
  });
}

function updatePatternGoalSeconds(uid, patternId, goalSeconds) {
  var normalisedGoal = _normaliseGoalSeconds(goalSeconds, null);
  return _runFirestoreWrite(function() {
    return _patternsRef(uid).doc(patternId).update({
      goalSeconds: normalisedGoal,
      updatedAt: _now()
    });
  });
}

function updatePatternReportConfig(uid, patternId, reportConfig) {
  return _runFirestoreWrite(function() {
    return _patternsRef(uid).doc(patternId).update({
      reportConfig: reportConfig && typeof reportConfig === 'object' ? reportConfig : null,
      updatedAt: _now()
    });
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
    if (chunk && chunk.type === 'list') {
      return {
        type: 'list',
        ordered: Boolean(chunk.ordered),
        items: Array.isArray(chunk.items)
          ? chunk.items.map(function(item) {
              return {
                content: _normaliseListItemContent(item)
              };
            })
          : []
      };
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
      stepTitle: stripStepTitleNumbering(step && step.stepTitle),
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
    return _runFirestoreWrite(function() { return batch.commit(); }).then(function() { return commitChunk(i + CHUNK); });
  }

  return commitChunk(0).then(function() { return patternsToUpdate.length; });
}

function deletePattern(uid, patternId) {
  var patternRef = _patternsRef(uid).doc(patternId);
  return patternRef.get().then(function(existingDoc) {
    if (!existingDoc.exists) return;
    var existingPattern = _normalisePatternDoc(existingDoc.data() || {});
    var previousFindingIds = _collectFindingIdsFromSteps(existingPattern.steps || []);
    return _loadFindingsByIds(uid, previousFindingIds).then(function(existingFindings) {
      var findingMutations = _buildFindingMutations(patternId, {}, existingFindings, previousFindingIds);
      findingMutations.push({ type: 'deletePattern', ref: patternRef });
      return _commitFindingOps(uid, findingMutations);
    });
  });
}

function deleteFinding(uid, findingId) {
  var safeFindingId = String(findingId || '').trim();
  if (!uid || !safeFindingId) return Promise.resolve(0);

  var findingRef = _findingsRef(uid).doc(safeFindingId);
  return findingRef.get().then(function(findingDoc) {
    if (!findingDoc.exists) return 0;

    var finding = _normaliseFindingDoc(findingDoc.data() || {});
    var linkedPatternIds = (finding.links || []).map(function(link) {
      return String((link && link.patternId) || '').trim();
    }).filter(function(id, index, list) {
      return id && list.indexOf(id) === index;
    });

    function removeFromPattern(index, deletedCount) {
      if (index >= linkedPatternIds.length) return Promise.resolve(deletedCount);
      var patternId = linkedPatternIds[index];
      var patternRef = _patternsRef(uid).doc(patternId);
      return patternRef.get().then(function(patternDoc) {
        if (!patternDoc.exists) return removeFromPattern(index + 1, deletedCount);

        var pattern = _normalisePatternDoc(patternDoc.data() || {});
        var nextSteps = JSON.parse(JSON.stringify(pattern.steps || []));
        var changed = false;

        nextSteps.forEach(function(step) {
          var sections = normaliseStepSections(step && step.sections, step && step.richContent || []);
          var current = sections.dontMissPathology || [];
          var filtered = current.filter(function(item) {
            if (!item || item.type !== 'subsection') return true;
            return String(item.findingId || '').trim() !== safeFindingId;
          });
          if (filtered.length !== current.length) {
            sections.dontMissPathology = filtered;
            step.sections = sections;
            step.richContent = cloneRichContentForStorage(sections.searchPattern || []);
            changed = true;
          }
        });

        if (!changed) return removeFromPattern(index + 1, deletedCount);

        return updatePattern(uid, patternId, {
          name: pattern.name || 'Untitled Pattern',
          modality: pattern.modality || 'Other',
          goalSeconds: pattern.goalSeconds,
          reportConfig: pattern.reportConfig || null,
          steps: nextSteps
        }).then(function() {
          return removeFromPattern(index + 1, deletedCount + 1);
        });
      });
    }

    return removeFromPattern(0, 0).then(function(deletedCount) {
      return findingRef.get().then(function(finalDoc) {
        if (!finalDoc.exists) return deletedCount;
        var finalFinding = _normaliseFindingDoc(finalDoc.data() || {});
        if (_hasFindingStudyLinks(finalFinding.links)) return deletedCount;
        return findingRef.delete().then(function() {
          return deletedCount;
        });
      });
    });
  });
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
    return _runFirestoreWrite(function() {
      return _reportTemplatesRef(uid).doc(templateId).set(payload, { merge: true });
    }).then(function() {
      return templateId;
    });
  }

  payload.createdAt = _now();
  return _runFirestoreWrite(function() {
    return _reportTemplatesRef(uid).add(payload);
  }).then(function(ref) {
    return ref.id;
  });
}

function deleteReportTemplate(uid, templateId) {
  return _runFirestoreWrite(function() {
    return _reportTemplatesRef(uid).doc(templateId).delete();
  });
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
  return _runFirestoreWrite(function() {
    return _studyLogRef(uid).add({
      study: data.study,
      seconds: data.seconds,
      duration: data.duration,
      rvu: (data.rvu !== null && data.rvu !== undefined && data.rvu !== '') ? Number(data.rvu) : null,
      timestamp: _now(),
      date: today
    });
  }).then(function(ref) { return ref.id; });
}

function deleteStudyLogEntry(uid, logId) {
  return _runFirestoreWrite(function() {
    return _studyLogRef(uid).doc(logId).delete();
  });
}

function updateStudyLogEntry(uid, logId, data) {
  var updateData = {
    study: data.study,
    seconds: data.seconds,
    duration: data.duration,
    rvu: (data.rvu !== null && data.rvu !== undefined && data.rvu !== '') ? Number(data.rvu) : null
  };
  return _runFirestoreWrite(function() {
    return _studyLogRef(uid).doc(logId).update(updateData);
  });
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
    return _runFirestoreWrite(function() { return batch.commit(); }).then(function() {
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
    return _runFirestoreWrite(function() { return batch.commit(); }).then(function() {
      done += chunk.length;
      if (onProgress) onProgress(done, rows.length);
      return nextChunk(i + CHUNK);
    });
  }
  return nextChunk(0);
}
