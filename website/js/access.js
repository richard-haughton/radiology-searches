// access.js — plain script, no modules. Depends on firebase-config.js (appDb, MAIN_DATASET_UID) and app.js
// (showToast, showConfirm).
//
// Two jobs:
//   1. Gate the site: only the owner (MAIN_DATASET_UID) and users the owner approves get in.
//   2. Give each approved user a private copy of the owner's main dataset. Their edits stay in their own
//      users/{uid} tree; "Resync" throws their copy away and copies the main dataset again.

function isMainDatasetOwner(uid) { return !!uid && uid === MAIN_DATASET_UID; }

function _allowedUserRef(uid)   { return appDb.collection('allowedUsers').doc(uid); }
function _accessRequestRef(uid) { return appDb.collection('accessRequests').doc(uid); }
function _syncStateRef(uid)     { return appDb.collection('users').doc(uid).collection('settings').doc('mainSync'); }

// ── Access gate ──────────────────────────────────────────────
// Calls onChange(true|false) now and whenever the owner approves or revokes this user.
function watchAccess(user, onChange) {
  if (isMainDatasetOwner(user.uid)) { onChange(true); return function() {}; }
  return _allowedUserRef(user.uid).onSnapshot(function(snap) {
    onChange(snap.exists);
  }, function(err) {
    console.error('watchAccess error:', err);
    onChange(false);
  });
}

function watchAccessRequest(uid, callback) {
  return _accessRequestRef(uid).onSnapshot(function(snap) {
    callback(snap.exists ? (snap.data() || {}) : null);
  }, function(err) {
    console.error('watchAccessRequest error:', err);
    callback(null);
  });
}

function requestAccess(user) {
  return _accessRequestRef(user.uid).set({
    email: user.email || '',
    name: user.displayName || '',
    photoURL: user.photoURL || '',
    status: 'pending',
    requestedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// ── Owner: approve / deny / revoke ───────────────────────────
function subscribeAccessRequests(callback, onError) {
  return appDb.collection('accessRequests').onSnapshot(function(snap) {
    callback(snap.docs.map(function(d) { return Object.assign({ uid: d.id }, d.data()); }));
  }, function(err) {
    console.error('subscribeAccessRequests error:', err);
    if (onError) onError(err);
  });
}

function subscribeAllowedUsers(callback, onError) {
  return appDb.collection('allowedUsers').onSnapshot(function(snap) {
    callback(snap.docs.map(function(d) { return Object.assign({ uid: d.id }, d.data()); }));
  }, function(err) {
    console.error('subscribeAllowedUsers error:', err);
    if (onError) onError(err);
  });
}

function approveAccess(req) {
  var batch = appDb.batch();
  batch.set(_allowedUserRef(req.uid), {
    email: req.email || '',
    name: req.name || '',
    approvedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.delete(_accessRequestRef(req.uid));
  return batch.commit();
}

function denyAccess(uid) {
  return _accessRequestRef(uid).update({ status: 'denied' });
}

function revokeAccess(uid) {
  return _allowedUserRef(uid).delete();
}

// ── Main dataset copy ────────────────────────────────────────
// Only the collections that make up the shared dataset. Study log, AI settings (API keys) and step
// timings are personal and never copied or overwritten.
var MAIN_SYNC_COLLECTIONS = ['patterns', 'findings', 'reportTemplates'];
var MAIN_SYNC_MAX_OPS = 200;
var MAIN_SYNC_MAX_BYTES = 4 * 1024 * 1024; // stay well under Firestore's 10 MiB request limit

function loadMainSyncState(uid) {
  return _syncStateRef(uid).get().then(function(snap) { return snap.exists ? (snap.data() || {}) : null; });
}

function _approxDocBytes(data) {
  try { return JSON.stringify(data).length; } catch (e) { return 100000; }
}

function _commitOpsInChunks(ops, onProgress) {
  var chunks = [];
  var current = [];
  var bytes = 0;
  ops.forEach(function(op) {
    var size = op.data ? _approxDocBytes(op.data) : 200;
    if (current.length && (current.length >= MAIN_SYNC_MAX_OPS || bytes + size > MAIN_SYNC_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  });
  if (current.length) chunks.push(current);

  var done = 0;
  return chunks.reduce(function(p, chunk) {
    return p.then(function() {
      var batch = appDb.batch();
      chunk.forEach(function(op) {
        if (op.type === 'delete') batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      return batch.commit().then(function() {
        done += chunk.length;
        if (onProgress) onProgress(done, ops.length);
      });
    });
  }, Promise.resolve());
}

// Replaces the user's patterns, findings, report templates and folders with the main dataset's.
// Document ids are kept, so study-log links and step timings for the same patterns still line up.
function resyncWithMainDataset(uid, onProgress) {
  if (!uid) return Promise.reject(new Error('Missing user id.'));
  if (isMainDatasetOwner(uid)) return Promise.reject(new Error('You own the main dataset.'));

  var mainUser = appDb.collection('users').doc(MAIN_DATASET_UID);
  var myUser = appDb.collection('users').doc(uid);

  var reads = [];
  MAIN_SYNC_COLLECTIONS.forEach(function(name) {
    reads.push(mainUser.collection(name).get({ source: 'server' }));
    reads.push(myUser.collection(name).get({ source: 'server' }));
  });
  reads.push(mainUser.collection('settings').doc('patternFolders').get({ source: 'server' }));

  return Promise.all(reads).then(function(results) {
    var ops = [];
    MAIN_SYNC_COLLECTIONS.forEach(function(name, i) {
      var mainSnap = results[i * 2];
      var mySnap = results[i * 2 + 1];
      var mainIds = {};
      mainSnap.docs.forEach(function(d) {
        mainIds[d.id] = true;
        ops.push({ type: 'set', ref: myUser.collection(name).doc(d.id), data: d.data() });
      });
      mySnap.docs.forEach(function(d) {
        if (!mainIds[d.id]) ops.push({ type: 'delete', ref: myUser.collection(name).doc(d.id) });
      });
    });

    var foldersSnap = results[results.length - 1];
    var folders = foldersSnap.exists ? (foldersSnap.data() || {}) : {};
    ops.push({
      type: 'set',
      ref: myUser.collection('settings').doc('patternFolders'),
      data: { folders: folders.folders || [], assignments: folders.assignments || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }
    });
    ops.push({
      type: 'set',
      ref: _syncStateRef(uid),
      data: { lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp(), source: MAIN_DATASET_UID }
    });

    return _commitOpsInChunks(ops, onProgress);
  });
}

// First sign-in for an approved user: if they have never synced and have nothing of their own, copy the
// main dataset in so they start with it. Anyone who already has data is left alone.
function seedFromMainDatasetIfNew(uid, onProgress) {
  if (isMainDatasetOwner(uid)) return Promise.resolve(false);
  return loadMainSyncState(uid).then(function(state) {
    if (state) return false;
    return appDb.collection('users').doc(uid).collection('patterns').limit(1).get({ source: 'server' }).then(function(snap) {
      if (!snap.empty) return false;
      return resyncWithMainDataset(uid, onProgress).then(function() { return true; });
    });
  });
}

// ── Settings UI ──────────────────────────────────────────────
function _escapeAccessHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function _formatSyncTime(ts) {
  if (!ts || typeof ts.toDate !== 'function') return 'never';
  return ts.toDate().toLocaleString();
}

function initMainDatasetSettings(uid) {
  var ownerCard = document.getElementById('settings-access-card');
  var syncCard = document.getElementById('settings-main-sync-card');

  if (isMainDatasetOwner(uid)) {
    syncCard.style.display = 'none';
    ownerCard.style.display = '';
    _initAccessAdmin();
    return;
  }

  ownerCard.style.display = 'none';
  syncCard.style.display = '';

  var status = document.getElementById('main-sync-status');
  var btn = document.getElementById('btn-main-resync');

  function refreshStatus() {
    loadMainSyncState(uid).then(function(state) {
      status.textContent = 'Last synced with the main dataset: ' + _formatSyncTime(state && state.lastSyncedAt);
    }).catch(function() { status.textContent = 'Last synced with the main dataset: unknown'; });
  }
  refreshStatus();

  btn.addEventListener('click', function() {
    showConfirm(
      'Resync with main dataset?',
      'This replaces your search patterns, findings, report templates and folders with the current main dataset. ' +
      'Any edits or patterns you added will be lost. Your study log and AI settings are kept.'
    ).then(function(ok) {
      if (!ok) return;
      btn.disabled = true;
      status.textContent = 'Resyncing…';
      resyncWithMainDataset(uid, function(done, total) {
        status.textContent = 'Resyncing… ' + done + ' / ' + total;
      }).then(function() {
        showToast('Resynced with the main dataset.');
        refreshStatus();
      }).catch(function(err) {
        console.error('Resync failed:', err);
        showToast('Resync failed: ' + (err.message || err), true);
        refreshStatus();
      }).finally(function() { btn.disabled = false; });
    });
  });
}

function _initAccessAdmin() {
  var pendingEl = document.getElementById('access-pending-list');
  var allowedEl = document.getElementById('access-allowed-list');

  function row(person, actionsHtml) {
    var label = _escapeAccessHtml(person.name || person.email || person.uid);
    var sub = person.name && person.email ? '<span class="access-row-sub">' + _escapeAccessHtml(person.email) + '</span>' : '';
    return '<li class="access-row" data-uid="' + _escapeAccessHtml(person.uid) + '">' +
      '<span class="access-row-name">' + label + sub + '</span>' +
      '<span class="access-row-actions">' + actionsHtml + '</span></li>';
  }

  function showError(el) {
    return function(err) {
      el.innerHTML = '<li class="access-empty access-error">Could not load: ' + _escapeAccessHtml(err.message || err) + '</li>';
    };
  }
  pendingEl.innerHTML = allowedEl.innerHTML = '<li class="access-empty">Loading…</li>';

  var requestsById = {};
  subscribeAccessRequests(function(requests) {
    requestsById = {};
    requests.forEach(function(r) { requestsById[r.uid] = r; });
    var pending = requests.filter(function(r) { return r.status === 'pending'; });
    var denied = requests.filter(function(r) { return r.status === 'denied'; });
    if (!pending.length && !denied.length) {
      pendingEl.innerHTML = '<li class="access-empty">No access requests.</li>';
      return;
    }
    pendingEl.innerHTML =
      pending.map(function(r) {
        return row(r, '<button class="btn btn-accent btn-sm" data-act="approve">Approve</button>' +
                      '<button class="btn btn-ghost btn-sm" data-act="deny">Deny</button>');
      }).join('') +
      denied.map(function(r) {
        return row(r, '<span class="access-denied-tag">Denied</span>' +
                      '<button class="btn btn-ghost btn-sm" data-act="approve">Approve</button>');
      }).join('');
  }, showError(pendingEl));

  subscribeAllowedUsers(function(users) {
    allowedEl.innerHTML = users.length
      ? users.map(function(u) { return row(u, '<button class="btn btn-danger btn-sm" data-act="revoke">Revoke</button>'); }).join('')
      : '<li class="access-empty">Nobody else has access yet.</li>';
  }, showError(allowedEl));

  function onAction(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var uid = btn.closest('.access-row').dataset.uid;
    var act = btn.dataset.act;
    var work;
    if (act === 'approve') work = approveAccess(requestsById[uid] || { uid: uid });
    else if (act === 'deny') work = denyAccess(uid);
    else if (act === 'revoke') {
      work = showConfirm('Revoke access?', 'This user will be signed out of the site immediately. Their own copy of the data is kept.')
        .then(function(ok) { return ok ? revokeAccess(uid) : null; });
    }
    btn.disabled = true;
    Promise.resolve(work).catch(function(err) {
      showToast('Could not update access: ' + (err.message || err), true);
    }).finally(function() { btn.disabled = false; });
  }
  pendingEl.addEventListener('click', onAction);
  allowedEl.addEventListener('click', onAction);
}
