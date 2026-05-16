// db.js — plain script, no modules. Depends on firebase-config.js (appDb global).

function _userRef(uid)       { return appDb.collection('users').doc(uid); }
function _patternsRef(uid)   { return _userRef(uid).collection('patterns'); }
function _studyLogRef(uid)   { return _userRef(uid).collection('studyLog'); }
function _reportTemplatesRef(uid) { return _userRef(uid).collection('reportTemplates'); }
function _now()              { return firebase.firestore.FieldValue.serverTimestamp(); }

var STEP_SECTION_KEYS = ['searchPattern', 'dontMissPathology', 'measurements', 'hyperlinks', 'images'];

function _makeStepId() {
  return 'step_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
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
    title: (chunk && (chunk.title || chunk.name)) || '',
    boxType: String((chunk && chunk.boxType) || '').trim(),
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
      stepId: String((step && (step.stepId || step.step_id)) || '').trim() || _makeStepId(),
      richContent: richContent,
      linkedStepId: (step && (step.linkedStepId || step.linked_step_id)) || '',
      linkMeta: _normaliseLinkMeta(step && (step.linkMeta || step.link_meta)),
      sections: normaliseStepSections(step && step.sections, richContent)
    };
  });

  var reportConfig = (doc && doc.reportConfig && typeof doc.reportConfig === 'object') ? doc.reportConfig : {};

  return {
    name: doc.name || doc.pattern_name || '',
    modality: doc.modality || 'Other',
    steps: steps,
    reportConfig: {
      selectedTemplateId: String(reportConfig.selectedTemplateId || ''),
      selectedTemplateName: String(reportConfig.selectedTemplateName || ''),
      sectionOrder: Array.isArray(reportConfig.sectionOrder)
        ? reportConfig.sectionOrder.map(function(item) { return String(item || '').trim(); }).filter(Boolean)
        : []
    },
    updatedAt: doc.updatedAt || null
  };
}

// ── Patterns ─────────────────────────────────────────────────
function subscribePatterns(uid, callback) {
  return _patternsRef(uid).orderBy('name').onSnapshot(function(snap) {
    var patterns = snap.docs.map(function(d) {
      return Object.assign({ id: d.id }, _normalisePatternDoc(d.data() || {}));
    });
    callback(patterns);
  }, function(err) { console.error('subscribePatterns error:', err); });
}

function createPattern(uid, data) {
  return _patternsRef(uid).add({
    name: data.name,
    modality: data.modality || 'Other',
    steps: data.steps || [],
    updatedAt: _now()
  }).then(function(ref) { return ref.id; });
}

function updatePattern(uid, patternId, data) {
  return _patternsRef(uid).doc(patternId).update({
    name: data.name,
    modality: data.modality || 'Other',
    steps: data.steps || [],
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
  (sourceSteps || []).forEach(function(step) {
    var linkIds = _getStepLinkIds(step);
    if (!linkIds.length) return;

    var sharedData = {
      stepTitle: (step && step.stepTitle) || '',
      stepId: String((step && step.stepId) || '').trim() || _makeStepId(),
      richContent: cloneRichContentForStorage(step && step.richContent),
      sections: cloneStepSectionsForStorage(step && step.sections, step && step.richContent),
      linkMeta: _normaliseLinkMeta(step && step.linkMeta)
    };

    linkIds.forEach(function(linkId) {
      linkedMap[linkId] = sharedData;
    });
  });

  var linkedIds = Object.keys(linkedMap);
  if (!linkedIds.length) return Promise.resolve(0);

  var patternsToUpdate = [];
  (allPatterns || []).forEach(function(pattern) {
    if (!pattern || pattern.id === sourcePatternId) return;

    var steps = pattern.steps || [];
    var changed = false;
    var newSteps = steps.map(function(step) {
      var currentKey = String((step && step.linkedStepId) || '').trim();
      if (!currentKey || !linkedMap[currentKey]) return step;

      var shared = linkedMap[currentKey];
      var nextStep = Object.assign({}, step, {
        stepTitle: shared.stepTitle,
        stepId: String((step && step.stepId) || '').trim() || shared.stepId || _makeStepId(),
        richContent: cloneRichContentForStorage(shared.richContent),
        linkedStepId: String((step && step.linkedStepId) || '').trim() || currentKey,
        linkMeta: _normaliseLinkMeta(step && step.linkMeta) || shared.linkMeta || null,
        sections: cloneStepSectionsForStorage(shared.sections, shared.richContent)
      });

      var sameTitle = (step.stepTitle || '') === nextStep.stepTitle;
      var sameRich = JSON.stringify(step.richContent || []) === JSON.stringify(nextStep.richContent || []);
      var sameSections = JSON.stringify(normaliseStepSections(step.sections, step.richContent || [])) === JSON.stringify(nextStep.sections || {});
      if (!sameTitle || !sameRich || !sameSections) changed = true;

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

function _normaliseReportSectionsArray(input, fallback) {
  var base = Array.isArray(input) ? input : [];
  var cleaned = base
    .map(function(item) { return String(item || '').trim(); })
    .filter(Boolean);
  if (cleaned.length) return cleaned;
  return Array.isArray(fallback) && fallback.length ? fallback.slice() : ['Findings', 'Impression'];
}

function _normaliseReportSettings(raw) {
  var src = raw && typeof raw === 'object' ? raw : {};
  return {
    defaultSections: _normaliseReportSectionsArray(src.defaultSections, ['Findings', 'Impression']),
    globalRulesText: String(src.globalRulesText || ''),
    updatedAt: src.updatedAt || null
  };
}

function getUserReportSettings(uid) {
  return _userRef(uid).get().then(function(doc) {
    var data = doc && doc.exists ? (doc.data() || {}) : {};
    return _normaliseReportSettings(data.reportSettings || {});
  });
}

function saveUserReportSettings(uid, settings) {
  var cleaned = _normaliseReportSettings(settings || {});
  return _userRef(uid).set({
    reportSettings: {
      defaultSections: cleaned.defaultSections,
      globalRulesText: cleaned.globalRulesText,
      updatedAt: _now()
    }
  }, { merge: true });
}

function subscribeReportTemplates(uid, callback) {
  return _reportTemplatesRef(uid).orderBy('name').onSnapshot(function(snap) {
    var templates = snap.docs.map(function(doc) {
      var data = doc.data() || {};
      return {
        id: doc.id,
        name: String(data.name || '').trim() || 'Untitled Template',
        body: String(data.body || ''),
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
      };
    });
    callback(templates);
  }, function(err) {
    console.error('subscribeReportTemplates error:', err);
  });
}

function upsertReportTemplate(uid, templateId, data) {
  var payload = {
    name: String((data && data.name) || '').trim() || 'Untitled Template',
    body: String((data && data.body) || ''),
    updatedAt: _now()
  };

  if (templateId) {
    return _reportTemplatesRef(uid).doc(templateId).set(payload, { merge: true }).then(function() {
      return templateId;
    });
  }

  payload.createdAt = _now();
  return _reportTemplatesRef(uid).add(payload).then(function(ref) { return ref.id; });
}

function deleteReportTemplate(uid, templateId) {
  return _reportTemplatesRef(uid).doc(templateId).delete();
}

function updatePatternReportConfig(uid, patternId, config) {
  var incoming = config && typeof config === 'object' ? config : {};
  return _patternsRef(uid).doc(patternId).set({
    reportConfig: {
      selectedTemplateId: String(incoming.selectedTemplateId || ''),
      selectedTemplateName: String(incoming.selectedTemplateName || ''),
      sectionOrder: _normaliseReportSectionsArray(incoming.sectionOrder, [])
    },
    updatedAt: _now()
  }, { merge: true });
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
