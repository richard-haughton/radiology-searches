// study-log.js — plain script, no modules. Depends on db.js and app.js globals.

// ── State ────────────────────────────────────────────────────
var _slUid = null;
var allEntries = [];
var filteredEntries = [];
var selectedLogId = null;
var sortCol = 'timestamp';
var sortDir = 'desc';
var activeRange = 'all';
var _editBlankSiblingIds = []; // other blank-RVU entries of the study being edited

// ── Init ─────────────────────────────────────────────────────
function initStudyLog(userId) {
  _slUid = userId;
  RVUsData.load(); // warm the RVU table so name-matched auto-fill works on the first record

  subscribeStudyLog(_slUid, function(entries) {
    allEntries = entries;
    applyRangeAndSort();
  });

  // Filter buttons
  document.querySelectorAll('.log-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range;
      applyRangeAndSort();
    });
  });

  // Sort headers
  document.querySelectorAll('.log-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = col === 'timestamp' ? 'desc' : 'asc';
      }
      applyRangeAndSort();
    });
  });

  // Actions
  document.getElementById('btn-export-log').addEventListener('click', exportCsv);
  document.getElementById('btn-import-log').addEventListener('click', () => {
    document.getElementById('import-log-input').click();
  });
  document.getElementById('import-log-input').addEventListener('change', handleImportCsv);
  document.getElementById('btn-fill-log-rvus').addEventListener('click', fillBlankRvusFromPatterns);
  document.getElementById('btn-edit-log-entry').addEventListener('click', handleEditEntry);
  document.getElementById('btn-delete-log-entry').addEventListener('click', handleDeleteEntry);
}

// ── Filter & sort ─────────────────────────────────────────────
function applyRangeAndSort() {
  const today = localDateKey();
  const sevenDaysAgo = localDateKey(new Date(Date.now() - 7 * 86400000));

  let filtered = [...allEntries];

  if (activeRange === 'today') {
    filtered = filtered.filter(e => entryDateKey(e) === today);
  } else if (activeRange === '7d') {
    filtered = filtered.filter(e => entryDateKey(e) >= sevenDaysAgo);
  }

  // Sort
  filtered.sort((a, b) => {
    let av, bv;
    switch (sortCol) {
      case 'study':    av = a.study || ''; bv = b.study || ''; break;
      case 'duration': av = a.seconds || 0; bv = b.seconds || 0; break;
      case 'rvu':      av = a.rvu ?? -Infinity; bv = b.rvu ?? -Infinity; break;
      case 'timestamp':
      default:
        av = a.timestamp?.seconds ?? 0;
        bv = b.timestamp?.seconds ?? 0;
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  filteredEntries = filtered;
  renderTable();
  renderSummary();
  updateSortIcons();
}

// Local calendar day of an entry, from its timestamp. The stored `date` field was written as a UTC
// date on older entries, so it is only a fallback (e.g. a just-added entry whose server timestamp
// hasn't come back yet).
function entryDateKey(entry) {
  const ts = entry.timestamp?.toDate?.();
  return ts ? localDateKey(ts) : (entry.date || '');
}

// ── Table rendering ───────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById('log-tbody');
  const empty = document.getElementById('log-empty');
  tbody.innerHTML = '';

  if (!filteredEntries.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  filteredEntries.forEach(entry => {
    const tr = document.createElement('tr');
    if (entry.id === selectedLogId) tr.classList.add('selected');
    tr.dataset.id = entry.id;

    const ts = entry.timestamp?.toDate?.() || null;
    const tsStr = ts
      ? ts.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : entry.date || '';

    const rvuStr = entry.rvu != null ? entry.rvu.toFixed(2) : '—';

    tr.innerHTML = `
      <td>${escapeHtml(entry.study || '')}</td>
      <td>${escapeHtml(entry.duration || '')}</td>
      <td>${rvuStr}</td>
      <td>${tsStr}</td>
    `;

    tr.addEventListener('click', () => {
      selectedLogId = entry.id;
      document.querySelectorAll('#log-tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      document.getElementById('btn-edit-log-entry').disabled = false;
      document.getElementById('btn-delete-log-entry').disabled = false;
    });

    tbody.appendChild(tr);
  });
}

function renderSummary() {
  const total  = filteredEntries.length;
  const secs   = filteredEntries.reduce((s, e) => s + (e.seconds || 0), 0);
  const rvuSum = filteredEntries.reduce((s, e) => s + (e.rvu || 0), 0);

  // Update header RVU badge (today's RVU, always)
  const todayRvu = getTodayStudyLogTotals().rvu;
  const badge = document.getElementById('rvu-today-badge');
  if (todayRvu > 0) {
    badge.textContent = `${todayRvu.toFixed(1)} RVU today`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  if (typeof renderTimedFullscreenStats === 'function') renderTimedFullscreenStats();

  const summaryEl = document.getElementById('log-summary');
  summaryEl.innerHTML = `
    <div class="log-stat"><span class="log-stat-value">${total}</span><span class="log-stat-label">Studies</span></div>
    <div class="log-stat"><span class="log-stat-value">${formatDuration(secs)}</span><span class="log-stat-label">Total Time</span></div>
    <div class="log-stat"><span class="log-stat-value">${rvuSum.toFixed(2)}</span><span class="log-stat-label">Total RVU</span></div>
  `;
}

// Today's studies and RVU regardless of the Log tab's range filter (header badge, full-screen read).
function getTodayStudyLogTotals() {
  const todayStr = localDateKey();
  const todays = allEntries.filter(e => entryDateKey(e) === todayStr);
  return {
    count: todays.length,
    rvu: todays.reduce((s, e) => s + (e.rvu || 0), 0)
  };
}

// RVU of the most recent entry for `study` that has one (allEntries is newest-first), or null.
function getLastLoggedRvu(study) {
  if (!study) return null;
  const entry = allEntries.find(e => e.study === study && e.rvu != null && Number.isFinite(Number(e.rvu)));
  return entry ? Number(entry.rvu) : null;
}

function updateSortIcons() {
  document.querySelectorAll('.log-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortCol) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ── Delete entry ──────────────────────────────────────────────
async function handleDeleteEntry() {
  if (!selectedLogId) return;
  const entry = allEntries.find(e => e.id === selectedLogId);
  const ok = await showConfirm('Delete Entry', `Delete "${entry?.study || selectedLogId}"?`);
  if (!ok) return;

  try {
    await deleteStudyLogEntry(_slUid, selectedLogId);
    selectedLogId = null;
    document.getElementById('btn-delete-log-entry').disabled = true;
    showToast('Entry deleted.');
  } catch (err) {
    console.error(err);
    showToast('Failed to delete entry.', true);
  }
}

// ── Edit entry ────────────────────────────────────────────────
function handleEditEntry() {
  if (!selectedLogId) return;
  const entry = allEntries.find(e => e.id === selectedLogId);
  if (!entry) return;

  // Populate edit modal with current values
  document.getElementById('edit-log-study').value = entry.study || '';
  document.getElementById('edit-log-duration').value = entry.duration || '';
  document.getElementById('edit-log-seconds').value = entry.seconds || 0;
  document.getElementById('edit-log-rvu').value = entry.rvu != null ? entry.rvu : '';

  // Offer to copy this RVU onto every other entry of the same study that has none.
  _editBlankSiblingIds = allEntries
    .filter(e => e.id !== entry.id && e.study === entry.study && e.rvu == null)
    .map(e => e.id);
  const n = _editBlankSiblingIds.length;
  document.getElementById('edit-log-rvu-apply-all').checked = false;
  document.getElementById('edit-log-rvu-apply-all-label').textContent =
    `Also apply this RVU to ${n} other "${entry.study || ''}" ${n === 1 ? 'entry' : 'entries'} with no RVU`;
  document.getElementById('edit-log-rvu-apply-all-wrap').style.display = n ? '' : 'none';

  // Populate RVU study dropdown and preselect if matching
  const studySelectOrig = document.getElementById('edit-log-rvu-study-select');
  const freshSelect = studySelectOrig.cloneNode(false);
  studySelectOrig.parentNode.replaceChild(freshSelect, studySelectOrig);

  RVUsData.populateSelect(freshSelect).then(() => {
    const idx = RVUsData.findIndex(entry.study || '');
    if (idx !== -1) {
      freshSelect.value = idx;
      // Only auto-fill RVU if entry had none
      if (entry.rvu == null || entry.rvu === '') {
        const rvuEntry = RVUsData.getEntry(idx);
        if (rvuEntry) document.getElementById('edit-log-rvu').value = rvuEntry.rvu;
      }
    }
    freshSelect.addEventListener('change', () => {
      const rvuEntry = RVUsData.getEntry(Number(freshSelect.value));
      if (rvuEntry) document.getElementById('edit-log-rvu').value = rvuEntry.rvu;
    });
  });

  // Show modal
  const modal = document.getElementById('modal-edit-log');
  modal.style.display = 'flex';

  // Handle save
  const saveHandler = async () => {
    await saveEditedEntry();
    cleanupEditModal();
  };

  // Handle cancel
  const cancelHandler = () => {
    cleanupEditModal();
  };

  // Handle background click
  const bgClickHandler = (e) => {
    if (e.target === modal) {
      cancelHandler();
    }
  };

  // Cleanup function
  function cleanupEditModal() {
    modal.style.display = 'none';
    document.getElementById('btn-edit-log-confirm').removeEventListener('click', saveHandler);
    document.getElementById('btn-edit-log-cancel').removeEventListener('click', cancelHandler);
    modal.removeEventListener('click', bgClickHandler);
  }

  // Attach listeners
  document.getElementById('btn-edit-log-confirm').addEventListener('click', saveHandler);
  document.getElementById('btn-edit-log-cancel').addEventListener('click', cancelHandler);
  modal.addEventListener('click', bgClickHandler);

  // Focus on first input
  document.getElementById('edit-log-study').focus();
}

async function saveEditedEntry() {
  if (!selectedLogId) return;

  const study = document.getElementById('edit-log-study').value.trim();
  const duration = document.getElementById('edit-log-duration').value.trim();
  const secondsStr = document.getElementById('edit-log-seconds').value.trim();
  const rvu = document.getElementById('edit-log-rvu').value.trim();

  if (!study) {
    showToast('Study name is required.', true);
    document.getElementById('edit-log-study').focus();
    return;
  }

  const seconds = secondsStr ? parseInt(secondsStr, 10) : 0;
  if (isNaN(seconds) || seconds < 0) {
    showToast('Seconds must be a non-negative number.', true);
    document.getElementById('edit-log-seconds').focus();
    return;
  }

  try {
    await updateStudyLogEntry(_slUid, selectedLogId, {
      study: study,
      duration: duration,
      seconds: seconds,
      rvu: rvu ? parseFloat(rvu) : null
    });

    const applyToSiblings = rvu && _editBlankSiblingIds.length &&
      document.getElementById('edit-log-rvu-apply-all').checked;
    if (applyToSiblings) {
      await batchUpdateStudyLogRvu(_slUid, _editBlankSiblingIds.map(id => ({ id, rvu: parseFloat(rvu) })));
    }

    selectedLogId = null;
    document.getElementById('btn-edit-log-entry').disabled = true;
    showToast(applyToSiblings
      ? `Entry updated; RVU also applied to ${_editBlankSiblingIds.length} more.`
      : 'Entry updated.');
  } catch (err) {
    console.error(err);
    showToast('Failed to update entry: ' + (err.message || err), true);
  }
}

// ── Fill blank RVUs ───────────────────────────────────────────
// Backfills entries with no RVU from the default RVU saved on the pattern of the same name.
// Studies whose pattern has no default are left alone (and listed) — no guessing from names.
async function fillBlankRvusFromPatterns() {
  const blanks = allEntries.filter(e => e.rvu == null);
  if (!blanks.length) { showToast('Every entry already has an RVU.'); return; }

  const defaults = {};
  (typeof allPatterns !== 'undefined' ? allPatterns : []).forEach(p => {
    if (p && p.name && p.rvu != null && !(p.name in defaults)) defaults[p.name] = Number(p.rvu);
  });

  const updates = [];
  const filledStudies = new Set();
  const missing = {};
  blanks.forEach(e => {
    const study = e.study || '';
    if (study in defaults) {
      updates.push({ id: e.id, rvu: defaults[study] });
      filledStudies.add(study);
    } else {
      missing[study] = (missing[study] || 0) + 1;
    }
  });

  const missingNames = Object.keys(missing).sort((a, b) => missing[b] - missing[a]);
  const missingCount = blanks.length - updates.length;
  const missingText = missingCount
    ? `${missingCount} ${missingCount === 1 ? 'entry has' : 'entries have'} no pattern default (` +
      missingNames.slice(0, 5).map(n => `${n || '(unnamed)'} ×${missing[n]}`).join(', ') +
      (missingNames.length > 5 ? `, +${missingNames.length - 5} more` : '') +
      '). Set a default RVU in the pattern editor, or use Edit Selected.'
    : '';

  if (!updates.length) { showToast('Nothing to fill. ' + missingText, true); return; }

  const ok = await showConfirm('Fill Blank RVUs',
    `Fill ${updates.length} ${updates.length === 1 ? 'entry' : 'entries'} across ${filledStudies.size} ` +
    `${filledStudies.size === 1 ? 'study' : 'studies'} using each pattern's default RVU?` +
    (missingText ? ' ' + missingText : ''),
    'Fill RVUs');
  if (!ok) return;

  try {
    await batchUpdateStudyLogRvu(_slUid, updates);
    showToast(`Filled RVU on ${updates.length} ${updates.length === 1 ? 'entry' : 'entries'}.`);
  } catch (err) {
    console.error(err);
    showToast('Failed to fill RVUs: ' + (err.message || err), true);
  }
}

// ── Export CSV ────────────────────────────────────────────────
function exportCsv() {
  if (!filteredEntries.length) { showToast('No entries to export.'); return; }

  const header = 'timestamp,date,study,seconds,duration,rvu\n';
  const rows = filteredEntries.map(e => {
    const ts = e.timestamp?.toDate?.()?.toISOString?.() || e.date || '';
    return [
      ts,
      entryDateKey(e),
      csvEsc(e.study || ''),
      e.seconds ?? '',
      csvEsc(e.duration || ''),
      e.rvu ?? ''
    ].join(',');
  });

  const csv = header + rows.join('\n');
  downloadText(csv, 'study_log.csv', 'text/csv');
  showToast('CSV exported.');
}

// ── Import CSV ────────────────────────────────────────────────
async function handleImportCsv(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const text = await file.text();
  const rows = parseCsv(text);

  if (!rows.length) { showToast('No rows found in CSV.', true); return; }

  const ok = await showConfirm('Import CSV', `Import ${rows.length} row(s) from "${file.name}"?`);
  if (!ok) return;

  try {
    await batchImportStudyLog(_slUid, rows, (done, total) => {
      if (done === total) showToast(`Imported ${total} entries.`);
    });
  } catch (err) {
    console.error(err);
    showToast('Import failed: ' + (err.message || err), true);
  }
}

// ── CSV parse ─────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = (cols[j] || '').trim(); });
    if (row.study) rows.push(row);
  }

  return rows;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += c; }
  }
  result.push(current);
  return result;
}

// ── Utility ──────────────────────────────────────────────────
function formatDuration(totalSeconds) {
  if (!totalSeconds) return '0m 00s';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function csvEsc(str) {
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
