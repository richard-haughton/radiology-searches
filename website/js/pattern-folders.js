// pattern-folders.js — custom folders for the Search Patterns list. Plain script, no modules.
// Depends on db.js (folder persistence) and patterns.js (allPatterns, filteredPatterns, activeModality,
// selectedPatternId, _pUid, applyFilters, openPatternListMenu, renderPatternListMenu,
// updatePatternListSelection).
//
// A folder is just a label the user files patterns under, so it lives in its own settings doc rather than
// on the patterns: filing a pattern never rewrites it, and shared/exported patterns are unaffected.
// A pattern can be filed in any number of folders at once. The list itself stays flat; a dropdown above it
// narrows it to one folder (or to patterns in no folder), the same way the modality buttons narrow it.

var _patternFolders = [];               // [{ id, name }] in creation order
var _patternFolderAssignments = {};     // patternId -> [folderId, ...]
var _patternFoldersLoaded = false;
var _activeFolderFilter = 'all';        // FOLDER_FILTER_ALL | FOLDER_FILTER_UNFILED | folderId; per device, not synced
var _unsubscribePatternFolders = null;
var _patternFolderEventsBound = false;

var PATTERN_FOLDER_FILTER_KEY = 'patternFolderFilter';
var FOLDER_FILTER_ALL = 'all';
var FOLDER_FILTER_UNFILED = '__unfiled__';
var PATTERN_FOLDER_NAME_MAX = 40;

// ── State ────────────────────────────────────────────────────
function initPatternFolders(uid) {
  _patternFoldersLoaded = false;
  loadFolderFilterState();
  bindPatternFolderEvents();
  renderPatternFolderSelect();

  if (typeof _unsubscribePatternFolders === 'function') _unsubscribePatternFolders();
  _unsubscribePatternFolders = subscribePatternFolders(uid, function(state) {
    _patternFolders = state.folders;
    _patternFolderAssignments = state.assignments;
    _patternFoldersLoaded = true;

    // The folder being viewed may have just been deleted (here or on another device).
    const viewingFolder = _activeFolderFilter !== FOLDER_FILTER_ALL;
    if (!isValidFolderFilter(_activeFolderFilter)) setActiveFolderFilter(FOLDER_FILTER_ALL);

    renderPatternFolderSelect();
    if (viewingFolder) {
      // Membership decides what the list shows, so re-filter. The open pattern stays in the list even if
      // this change just took it out of the folder being viewed, so unticking a box never yanks the reader
      // off the pattern they are on; it drops out the next time the filters change.
      applyFilters({ keepSelected: true });
    } else {
      renderPatternTree();
    }
    renderPatternListMenu(); // keeps an open pattern's folder checkboxes live as they're checked/unchecked
  });
}

function getPatternFolderIds(patternId) {
  return _patternFolderAssignments[patternId] || [];
}

function patternHasFolder(patternId, folderId) {
  return getPatternFolderIds(patternId).indexOf(folderId) !== -1;
}

function getPatternFolderById(folderId) {
  return _patternFolders.find(function(folder) { return folder.id === folderId; }) || null;
}

// ── Folder filter ────────────────────────────────────────────
function loadFolderFilterState() {
  try {
    _activeFolderFilter = localStorage.getItem(PATTERN_FOLDER_FILTER_KEY) || FOLDER_FILTER_ALL;
  } catch (err) {
    _activeFolderFilter = FOLDER_FILTER_ALL; // storage unavailable — start on everything
  }
}

// A saved choice only makes sense while its folder exists. Until the folders have loaded there is nothing
// to check it against, so it is trusted (and the list waits, see patternMatchesFolderFilter).
function isValidFolderFilter(filter) {
  if (filter === FOLDER_FILTER_ALL) return true;
  if (!_patternFoldersLoaded) return true;
  if (filter === FOLDER_FILTER_UNFILED) return _patternFolders.length > 0;
  return Boolean(getPatternFolderById(filter));
}

function setActiveFolderFilter(filter) {
  _activeFolderFilter = filter;
  try {
    if (filter === FOLDER_FILTER_ALL) localStorage.removeItem(PATTERN_FOLDER_FILTER_KEY);
    else localStorage.setItem(PATTERN_FOLDER_FILTER_KEY, filter);
  } catch (err) {
    // Storage unavailable (private mode) — the choice just won't survive a reload.
  }

  const select = document.getElementById('pattern-folder-select');
  if (select && select.value !== filter) select.value = filter;
  updateFolderActionsButton();
}

// Used by applyFilters. While the folders are still loading a saved folder choice can't be applied, so the
// list shows nothing rather than flashing every pattern (and starting a timer on the wrong one).
function patternMatchesFolderFilter(patternId) {
  if (_activeFolderFilter === FOLDER_FILTER_ALL) return true;
  if (!_patternFoldersLoaded) return false;
  const folderIds = getPatternFolderIds(patternId);
  return _activeFolderFilter === FOLDER_FILTER_UNFILED
    ? folderIds.length === 0
    : folderIds.indexOf(_activeFolderFilter) !== -1;
}

function renderPatternFolderSelect() {
  const select = document.getElementById('pattern-folder-select');
  if (!select) return;

  const counts = {};
  let unfiled = 0;
  allPatterns.forEach(function(pattern) {
    const folderIds = getPatternFolderIds(pattern.id);
    if (!folderIds.length) unfiled += 1;
    folderIds.forEach(function(folderId) { counts[folderId] = (counts[folderId] || 0) + 1; });
  });

  select.innerHTML = '';
  const addOption = function(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };
  addOption(FOLDER_FILTER_ALL, 'All patterns');
  _patternFolders.forEach(function(folder) {
    addOption(folder.id, folder.name + ' (' + (counts[folder.id] || 0) + ')');
  });
  if (_patternFolders.length) addOption(FOLDER_FILTER_UNFILED, 'Unfiled (' + unfiled + ')');
  if (!_patternFoldersLoaded && _activeFolderFilter !== FOLDER_FILTER_ALL) {
    addOption(_activeFolderFilter, 'Loading folders…'); // the saved choice, until its folder arrives
  }

  select.value = _activeFolderFilter;
  select.disabled = !_patternFolders.length;
  updateFolderActionsButton();
}

// Rename/Delete only make sense for a real folder, not "All patterns" or "Unfiled".
function updateFolderActionsButton() {
  const button = document.getElementById('btn-folder-actions');
  if (button) button.hidden = !getPatternFolderById(_activeFolderFilter);
}

// ── Rendering ────────────────────────────────────────────────
function renderPatternTree() {
  const tree = document.getElementById('pattern-tree');
  if (!tree) return;

  const scrollTop = tree.scrollTop;
  tree.innerHTML = '';

  if (!filteredPatterns.length) {
    const empty = document.createElement('p');
    empty.className = 'pattern-list-empty';
    empty.textContent = getEmptyPatternListMessage();
    tree.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');
  filteredPatterns.forEach(function(pattern) { list.appendChild(buildPatternListItem(pattern)); });
  tree.appendChild(list);
  tree.scrollTop = scrollTop;
  updatePatternListSelection();
}

function getEmptyPatternListMessage() {
  if (!_patternFoldersLoaded && _activeFolderFilter !== FOLDER_FILTER_ALL) return 'Loading folders…';
  if (!allPatterns.length) return 'No patterns yet.';

  // Only the folder itself is narrowing the list (no text or modality filter on top of it): say so.
  const filterInput = document.getElementById('pattern-filter');
  const otherFilters = activeModality !== 'All' || Boolean(filterInput && filterInput.value.trim());
  if (!otherFilters && _activeFolderFilter === FOLDER_FILTER_UNFILED) return 'Every pattern is filed in a folder.';
  if (!otherFilters && _activeFolderFilter !== FOLDER_FILTER_ALL) {
    return 'No patterns in this folder yet — use ⋯ on a pattern to add it here.';
  }
  return 'No patterns match your filter.';
}

function buildPatternListItem(pattern) {
  const item = document.createElement('li');
  item.className = 'pattern-list-item';
  item.dataset.patternId = pattern.id;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'pattern-list-item-main';
  main.title = pattern.name;
  const name = document.createElement('span');
  name.className = 'pattern-list-item-name';
  name.textContent = pattern.name;
  main.appendChild(name);
  if (pattern.modality) {
    const mod = document.createElement('span');
    mod.className = 'pattern-list-item-mod';
    mod.textContent = pattern.modality;
    main.appendChild(mod);
  }

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'pattern-list-item-more';
  more.setAttribute('aria-label', 'Pattern actions for ' + pattern.name);
  more.textContent = '⋯';

  item.appendChild(main);
  item.appendChild(more);
  return item;
}

function scrollSelectedPatternIntoView() {
  const tree = document.getElementById('pattern-tree');
  const selected = tree && tree.querySelector('.pattern-list-item.is-selected');
  if (selected && typeof selected.scrollIntoView === 'function') selected.scrollIntoView({ block: 'nearest' });
}

// ── Interaction ──────────────────────────────────────────────
// Pattern rows (select, ⋯, right-click) are handled in patterns.js; this covers the folder dropdown and its
// buttons, and arrow-key movement through the list.
function bindPatternFolderEvents() {
  if (_patternFolderEventsBound) return;
  const select = document.getElementById('pattern-folder-select');
  const tree = document.getElementById('pattern-tree');
  if (!select || !tree) return;
  _patternFolderEventsBound = true;

  select.addEventListener('change', function() {
    setActiveFolderFilter(select.value);
    applyFilters();
  });

  document.getElementById('btn-new-folder').addEventListener('click', function() { createPatternFolder(); });

  document.getElementById('btn-folder-actions').addEventListener('click', function(e) {
    const folder = getPatternFolderById(_activeFolderFilter);
    if (!folder) return;
    e.stopPropagation(); // the document-level click handler would immediately hide the menu again
    const rect = e.currentTarget.getBoundingClientRect();
    showFolderContextMenu(rect.right, rect.bottom, folder.id);
  });

  tree.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.prototype.slice.call(tree.querySelectorAll('.pattern-list-item-main'));
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
}

// ── Menus ────────────────────────────────────────────────────
function showFolderContextMenu(clientX, clientY, folderId) {
  if (!getPatternFolderById(folderId)) return;
  openPatternListMenu(clientX, clientY, [
    { label: 'Rename Folder', onSelect: function() { return renamePatternFolder(folderId); } },
    { label: 'Delete Folder', danger: true, onSelect: function() { return deletePatternFolder(folderId); } }
  ]);
}

// The folders block of a pattern's ⋯ menu, ready to splice between its other actions. Each folder is a
// checkbox (keepOpen) so several can be picked in one visit to the menu.
function buildPatternFolderMenuItems(patternId) {
  const currentFolderIds = getPatternFolderIds(patternId);
  const items = [{ divider: true }, { heading: 'Folders' }];

  _patternFolders.forEach(function(folder) {
    items.push({
      label: folder.name,
      choice: true,
      checked: currentFolderIds.indexOf(folder.id) !== -1,
      keepOpen: true,
      onSelect: function() { return togglePatternFolder(patternId, folder.id); }
    });
  });
  items.push({ label: '+ New Folder…', onSelect: function() { return createPatternFolder(patternId); } });
  if (currentFolderIds.length) {
    items.push({ label: 'Remove from All Folders', keepOpen: true, onSelect: function() { return clearPatternFolders(patternId); } });
  }
  items.push({ divider: true });
  return items;
}

// ── Actions ──────────────────────────────────────────────────
function makePatternFolderId() {
  return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Returns the cleaned name, or null after telling the user why it can't be used.
function promptForFolderName(message, currentName, ignoreFolderId) {
  const raw = window.prompt(message, currentName || '');
  if (raw === null) return null;

  const name = String(raw).trim().replace(/\s+/g, ' ');
  if (!name) {
    showToast('Folder name cannot be blank.', true);
    return null;
  }
  if (name.length > PATTERN_FOLDER_NAME_MAX) {
    showToast('Folder names can be up to ' + PATTERN_FOLDER_NAME_MAX + ' characters.', true);
    return null;
  }
  const taken = _patternFolders.some(function(folder) {
    return folder.id !== ignoreFolderId && folder.name.toLowerCase() === name.toLowerCase();
  });
  if (taken) {
    showToast('A folder named "' + name + '" already exists.', true);
    return null;
  }
  return name;
}

// Creates a folder; when patternId is given, files that pattern into it in the same write.
async function createPatternFolder(patternId) {
  if (!_pUid) return;
  const name = promptForFolderName('New folder name');
  if (!name) return;

  const folder = { id: makePatternFolderId(), name: name };
  const changes = {};
  if (patternId) changes[patternId] = getPatternFolderIds(patternId).concat([folder.id]);

  try {
    await savePatternFolders(_pUid, _patternFolders.concat([folder]), changes);
    showToast(patternId ? 'Added to "' + name + '".' : 'Folder "' + name + '" created.');
  } catch (err) {
    console.error(err);
    showToast('Failed to create folder.', true);
  }
}

async function renamePatternFolder(folderId) {
  const folder = getPatternFolderById(folderId);
  if (!_pUid || !folder) return;

  const name = promptForFolderName('Rename folder', folder.name, folderId);
  if (!name || name === folder.name) return;

  try {
    await savePatternFolders(_pUid, _patternFolders.map(function(item) {
      return item.id === folderId ? { id: item.id, name: name } : item;
    }));
    showToast('Folder renamed.');
  } catch (err) {
    console.error(err);
    showToast('Failed to rename folder.', true);
  }
}

async function deletePatternFolder(folderId) {
  const folder = getPatternFolderById(folderId);
  if (!_pUid || !folder) return;

  // Every pattern filed in this folder, including any not currently loaded, loses just this one
  // membership — a pattern filed in this folder and another stays filed in the other.
  const released = {};
  Object.keys(_patternFolderAssignments).forEach(function(patternId) {
    const ids = _patternFolderAssignments[patternId];
    if (ids.indexOf(folderId) === -1) return;
    released[patternId] = ids.filter(function(id) { return id !== folderId; });
  });
  const count = allPatterns.filter(function(pattern) { return pattern.id in released; }).length;

  const detail = count
    ? 'The ' + (count === 1 ? 'pattern' : count + ' patterns') + ' inside will stay in your library.'
    : 'It is empty.';
  const ok = await showConfirm('Delete Folder', 'Delete the folder "' + folder.name + '"? ' + detail);
  if (!ok) return;

  try {
    await savePatternFolders(_pUid, _patternFolders.filter(function(item) { return item.id !== folderId; }), released);
    showToast('Folder deleted.');
  } catch (err) {
    console.error(err);
    showToast('Failed to delete folder.', true);
  }
}

// The folder checkbox in a pattern's ⋯ menu: adds or removes just that one membership.
async function togglePatternFolder(patternId, folderId) {
  if (!_pUid || !patternId) return;
  const folder = getPatternFolderById(folderId);
  if (!folder) return;

  const current = getPatternFolderIds(patternId);
  const adding = current.indexOf(folderId) === -1;
  const next = adding ? current.concat([folderId]) : current.filter(function(id) { return id !== folderId; });

  const changes = {};
  changes[patternId] = next;
  try {
    await savePatternFolderAssignments(_pUid, changes);
  } catch (err) {
    console.error(err);
    showToast('Failed to update folder.', true);
  }
}

async function clearPatternFolders(patternId) {
  if (!_pUid || !patternId || !getPatternFolderIds(patternId).length) return;
  const changes = {};
  changes[patternId] = [];
  try {
    await savePatternFolderAssignments(_pUid, changes);
  } catch (err) {
    console.error(err);
    showToast('Failed to update folder.', true);
  }
}

// Used by pattern duplication to give the copy the same folder memberships as the original.
async function setPatternFolders(patternId, folderIds) {
  if (!_pUid || !patternId) return;
  const changes = {};
  changes[patternId] = folderIds.slice();
  try {
    await savePatternFolderAssignments(_pUid, changes);
  } catch (err) {
    console.error(err);
  }
}
