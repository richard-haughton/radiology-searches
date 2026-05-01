// db.js — plain script, no modules. Depends on firebase-config.js (appDb global).

function _userRef(uid)       { return appDb.collection('users').doc(uid); }
function _patternsRef(uid)   { return _userRef(uid).collection('patterns'); }
function _studyLogRef(uid)   { return _userRef(uid).collection('studyLog'); }
function _now()              { return firebase.firestore.FieldValue.serverTimestamp(); }

var STEP_SECTION_KEYS = ['searchPattern', 'notes', 'dontMissPathology', 'measurements', 'images', 'hyperlinks'];

function normaliseStepSections(sections, fallbackRichContent) {
  var source = sections || {};
  var out = {};
  STEP_SECTION_KEYS.forEach(function(key) {
    var raw = source[key];
    if (!Array.isArray(raw)) raw = [];
    out[key] = raw.map(function(chunk) {
      var type = chunk && chunk.type
        ? chunk.type
        : ((chunk && (chunk.image_data || chunk.data)) ? 'image' : ((chunk && chunk.url) ? 'link' : 'text'));
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
      var type = chunk && chunk.type ? chunk.type : ((chunk && (chunk.image_data || chunk.data)) ? 'image' : 'text');
      if (type === 'image') {
        return {
          type: 'image',
          format: (chunk && (chunk.format || chunk.image_format)) || 'png',
          data: (chunk && (chunk.data || chunk.image_data)) || ''
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
      stepTitle: (step && (step.stepTitle || step.step_title)) || '',
      richContent: richContent,
      linkedStepId: (step && (step.linkedStepId || step.linked_step_id)) || '',
      sections: normaliseStepSections(step && step.sections, richContent)
    };
  });

  return {
    name: doc.name || doc.pattern_name || '',
    modality: doc.modality || 'Other',
    steps: steps,
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
    var linkedStepId = String((step && step.linkedStepId) || '').trim();
    if (!linkedStepId) return;
    linkedMap[linkedStepId] = {
      stepTitle: (step && step.stepTitle) || '',
      richContent: cloneRichContentForStorage(step && step.richContent),
      sections: cloneStepSectionsForStorage(step && step.sections, step && step.richContent)
    };
  });

  var linkedIds = Object.keys(linkedMap);
  if (!linkedIds.length) return Promise.resolve(0);

  var patternsToUpdate = [];
  (allPatterns || []).forEach(function(pattern) {
    if (!pattern || pattern.id === sourcePatternId) return;

    var steps = pattern.steps || [];
    var changed = false;
    var newSteps = steps.map(function(step) {
      var linkedStepId = String((step && step.linkedStepId) || '').trim();
      if (!linkedStepId || !linkedMap[linkedStepId]) return step;

      var shared = linkedMap[linkedStepId];
      var nextStep = Object.assign({}, step, {
        stepTitle: shared.stepTitle,
        richContent: cloneRichContentForStorage(shared.richContent),
        linkedStepId: linkedStepId,
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
