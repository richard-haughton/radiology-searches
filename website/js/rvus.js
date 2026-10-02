// ── RVU study data loader ─────────────────────────────────────
// Loads rvus.json once and exposes helpers for populating dropdowns.

const RVUsData = (() => {
  let _entries = null;      // null = not loaded, [] = loaded (may be empty on error)
  let _loadPromise = null;
  let _warnedOnce = false;

  async function load() {
    if (_entries !== null) return _entries;
    if (_loadPromise) return _loadPromise;

    _loadPromise = fetch('downloads/rvus.json')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        _entries = data
          .filter(e =>
            e.description && typeof e.description === 'string' &&
            typeof e.rvu === 'number' && isFinite(e.rvu)
          )
          .sort((a, b) => a.description.localeCompare(b.description));
        console.log(`[RVUs] Loaded ${_entries.length} entries.`);
        return _entries;
      })
      .catch(err => {
        console.warn('[RVUs] Failed to load rvus.json:', err);
        _entries = [];
        return _entries;
      });

    return _loadPromise;
  }

  /** Populate a <select> element with study options.
   *  Prepends a blank placeholder option.
   *  @param {HTMLSelectElement} selectEl
   */
  async function populateSelect(selectEl) {
    const entries = await load();

    // Clear existing options
    selectEl.innerHTML = '';

    // Blank placeholder
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Select a study —';
    selectEl.appendChild(placeholder);

    if (!entries.length) {
      if (!_warnedOnce) {
        _warnedOnce = true;
        if (typeof showToast === 'function') {
          showToast('RVU study list unavailable; enter RVU manually.', false);
        }
      }
      return;
    }

    entries.forEach((entry, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;                           // index into _entries array
      opt.textContent = labelFor(entry);
      opt.dataset.rvu = entry.rvu;
      selectEl.appendChild(opt);
    });
  }

  /** Display label for an entry; also stored on patterns as `rvuStudy`. */
  function labelFor(entry) {
    if (!entry) return '';
    const modSuffix = entry.mod ? ` [Mod: ${entry.mod}]` : '';
    const catSuffix = entry.category ? ` — ${entry.category}` : '';
    return `${entry.description}${modSuffix}${catSuffix}`;
  }

  /** Index of the entry whose label equals `label`, or -1. Some labels repeat with different
   *  RVUs (distinct CPT codes share a short description), so `rvu` picks the right one. */
  function findIndexByLabel(label, rvu) {
    if (!_entries || !label) return -1;
    const exact = _entries.findIndex(e => labelFor(e) === label && Number(e.rvu) === Number(rvu));
    return exact !== -1 ? exact : _entries.findIndex(e => labelFor(e) === label);
  }

  /** Return the entry at a given index (from option.value). */
  function getEntry(idx) {
    if (!_entries) return null;
    return _entries[idx] ?? null;
  }

  /** Try to find the best-matching index for a study name string.
   *  Returns the index or -1.
   */
  function findIndex(studyName) {
    if (!_entries || !studyName) return -1;
    const needle = studyName.trim().toLowerCase();
    // Exact match first
    let i = _entries.findIndex(e => e.description.toLowerCase() === needle);
    if (i !== -1) return i;
    // Partial match fallback
    i = _entries.findIndex(e => e.description.toLowerCase().includes(needle) ||
                                needle.includes(e.description.toLowerCase()));
    return i;
  }

  return { load, populateSelect, getEntry, findIndex, labelFor, findIndexByLabel };
})();
