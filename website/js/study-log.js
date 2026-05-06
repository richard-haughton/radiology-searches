// study-log.js — plain script, no modules. Depends on db.js and app.js globals.

// ── State ────────────────────────────────────────────────────
var _slUid = null;
var allEntries = [];
var filteredEntries = [];
var selectedLogId = null;
var sortCol = 'timestamp';
var sortDir = 'desc';
var activeRange = 'all';

// ── Init ─────────────────────────────────────────────────────
function initStudyLog(userId) {
  _slUid = userId;

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
  document.getElementById('btn-edit-log-entry').addEventListener('click', handleEditEntry);
  document.getElementById('btn-delete-log-entry').addEventListener('click', handleDeleteEntry);
}

// ── Filter & sort ─────────────────────────────────────────────
function applyRangeAndSort() {
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  let filtered = [...allEntries];

  if (activeRange === 'today') {
    filtered = filtered.filter(e => e.date === today);
  } else if (activeRange === '7d') {
    filtered = filtered.filter(e => e.date >= sevenDaysAgo);
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
  const todayStr = new Date().toISOString().split('T')[0];
  const todayRvu = allEntries
    .filter(e => e.date === todayStr)
    .reduce((s, e) => s + (e.rvu || 0), 0);
  const badge = document.getElementById('rvu-today-badge');
  if (todayRvu > 0) {
    badge.textContent = `${todayRvu.toFixed(1)} RVU today`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  const summaryEl = document.getElementById('log-summary');
  summaryEl.innerHTML = `
    <div class="log-stat"><span class="log-stat-value">${total}</span><span class="log-stat-label">Studies</span></div>
    <div class="log-stat"><span class="log-stat-value">${formatDuration(secs)}</span><span class="log-stat-label">Total Time</span></div>
    <div class="log-stat"><span class="log-stat-value">${rvuSum.toFixed(2)}</span><span class="log-stat-label">Total RVU</span></div>
  `;
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

    selectedLogId = null;
    document.getElementById('btn-edit-log-entry').disabled = true;
    showToast('Entry updated.');
  } catch (err) {
    console.error(err);
    showToast('Failed to update entry: ' + (err.message || err), true);
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
      e.date || '',
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
