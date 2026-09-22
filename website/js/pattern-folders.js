// pattern-folders.js — custom folders for the Search Patterns list. Plain script, no modules.
// Depends on db.js (folder persistence) and patterns.js (allPatterns, filteredPatterns, activeModality,
// selectedPatternId, _pUid, openPatternListMenu, updatePatternListSelection).
//
// A folder is just a label the user files patterns under, so it lives in its own settings doc rather than
// on the patterns: filing a pattern never rewrites it, and shared/exported patterns are unaffected.
// A pattern can be filed in any number of folders at once (it shows once per folder it's in); a pattern
// in none of them shows under "Unfiled" (once any folder exists).

var _patternFolders = [];               // [{ id, name }] in creation order
var _patternFolderAssignments = {};     // patternId -> [folderId, ...]
var _foldersCollapsed = {};             // folderId | UNFILED_GROUP_KEY -> true; per device, not synced
var _unsubscribePatternFolders = null;
var _patternTreeEventsBound = false;
var _draggingPatternId = null;

var PATTERN_FOLDERS_COLLAPSED_KEY = 'patternFoldersCollapsed';
var UNFILED_GROUP_KEY = '__unfiled__';
var PATTERN_FOLDER_NAME_MAX = 40;

// ── State ────────────────────────────────────────────────────
function initPatternFolders(uid) {
  loadFoldersCollapsedState();
  bindPatternTreeEvents();

  if (typeof _unsubscribePatternFolders === 'function') _unsubscribePatternFolders();
  _unsubscribePatternFolders = subscribePatternFolders(uid, function(state) {
    _patternFolders = state.folders;
    _patternFolderAssignments = state.assignments;
    renderPatternTree(); // tree only — a folder change must not reload the open pattern
    renderPatternListMenu(); // keeps an open pattern's folder checkboxes live as they're checked/unchecked
  });
}

function loadFoldersCollapsedState() {
  _foldersCollapsed = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PATTERN_FOLDERS_COLLAPSED_KEY) || '[]');
    if (Array.isArray(parsed)) parsed.forEach(function(key) { _foldersCollapsed[String(key)] = true; });
  } catch (err) {
    // Unreadable saved state — start with every folder open.
  }
}

function setFolderCollapsed(key, collapsed) {
  if (collapsed) _foldersCollapsed[key] = true;
  else delete _foldersCollapsed[key];
  try {
    localStorage.setItem(PATTERN_FOLDERS_COLLAPSED_KEY, JSON.stringify(Object.keys(_foldersCollapsed)));
  } catch (err) {
    // Storage unavailable (private mode) — the state just won't survive a reload.
  }
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

// The list narrows by text and modality; while it does, folders auto-open and empty ones drop away so
// every match is visible and the folder state the user saved is left alone.
function isPatternFilterActive() {
  const input = document.getElementById('pattern-filter');
  return activeModality !== 'All' || Boolean(input && input.value.trim());
}

// filteredPatterns split into display groups: folders in creation order, then Unfiled.
// With no folders at all the list stays flat, exactly as it was before folders existed.
function getPatternTreeGroups() {
  if (!_patternFolders.length) {
    return filteredPatterns.length ? [{ key: null, folder: null, patterns: filteredPatterns }] : [];
  }

  const filtering = isPatternFilterActive();
  const byFolder = {};
  const unfiled = [];
  filteredPatterns.forEach(function(pattern) {
    const folderIds = getPatternFolderIds(pattern.id);
    if (folderIds.length) {
      folderIds.forEach(function(folderId) { (byFolder[folderId] = byFolder[folderId] || []).push(pattern); });
    } else {
      unfiled.push(pattern);
    }
  });

  const groups = [];
  _patternFolders.forEach(function(folder) {
    const patterns = byFolder[folder.id] || [];
    if (filtering && !patterns.length) return;
    groups.push({ key: folder.id, folder: folder, patterns: patterns });
  });
  // Unfiled stays even when empty (unless filtering) so there is always somewhere to drop a pattern back out.
  if (unfiled.length || !filtering) groups.push({ key: UNFILED_GROUP_KEY, folder: null, patterns: unfiled });
  return groups;
}

// Patterns in the order the list shows them, once each — what "the first pattern" means once folders
// reorder things, even though a pattern filed in several folders occupies a row in each of them.
function getDisplayedPatterns() {
  const seen = new Set();
  const out = [];
  getPatternTreeGroups().forEach(function(group) {
    group.patterns.forEach(function(pattern) {
      if (seen.has(pattern.id)) return;
      seen.add(pattern.id);
      out.push(pattern);
    });
  });
  return out;
}

// ── Rendering ────────────────────────────────────────────────
function renderPatternTree() {
  const tree = document.getElementById('pattern-tree');
  if (!tree) return;

  const scrollTop = tree.scrollTop;
  tree.innerHTML = '';

  const groups = getPatternTreeGroups();
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'pattern-list-empty';
    empty.textContent = allPatterns.length ? 'No patterns match your filter.' : 'No patterns yet.';
    tree.appendChild(empty);
    return;
  }

  const filtering = isPatternFilterActive();
  groups.forEach(function(group) { tree.appendChild(buildPatternTreeGroup(group, filtering)); });
  tree.scrollTop = scrollTop;
  updatePatternListSelection();
}

function buildPatternTreeGroup(group, filtering) {
  const section = document.createElement('section');
  section.className = 'pattern-folder';
  const foldered = group.key !== null;
  const collapsed = foldered && !filtering && Boolean(_foldersCollapsed[group.key]);

  if (foldered) {
    section.dataset.groupKey = group.key;
    section.classList.toggle('is-collapsed', collapsed);
    section.appendChild(buildPatternFolderHead(group, collapsed, filtering));
  }

  const items = document.createElement('ul');
  items.className = 'pattern-folder-items';
  const draggable = foldered && canDragPatterns();
  group.patterns.forEach(function(pattern) { items.appendChild(buildPatternListItem(pattern, draggable)); });
  if (!group.patterns.length) {
    const empty = document.createElement('li');
    empty.className = 'pattern-list-empty pattern-folder-empty';
    empty.textContent = group.folder
      ? 'No patterns yet — use ⋯ on a pattern to move it here.'
      : 'Every pattern is filed in a folder.';
    items.appendChild(empty);
  }
  section.appendChild(items);
  return section;
}

function buildPatternFolderHead(group, collapsed, filtering) {
  const head = document.createElement('div');
  head.className = 'pattern-folder-head';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pattern-folder-toggle';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  if (filtering) toggle.setAttribute('aria-disabled', 'true'); // matches stay open while filtering

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('class', 'pattern-folder-chevron');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.setAttribute('stroke-width', '2.6');
  chevron.setAttribute('stroke-linecap', 'round');
  chevron.setAttribute('stroke-linejoin', 'round');
  chevron.setAttribute('aria-hidden', 'true');
  const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevronPath.setAttribute('d', 'M6 9l6 6 6-6');
  chevron.appendChild(chevronPath);

  const name = document.createElement('span');
  name.className = 'pattern-folder-name';
  name.textContent = group.folder ? group.folder.name : 'Unfiled';

  const count = document.createElement('span');
  count.className = 'pattern-folder-count';
  count.textContent = String(group.patterns.length);

  toggle.appendChild(chevron);
  toggle.appendChild(name);
  toggle.appendChild(count);
  head.appendChild(toggle);

  if (group.folder) { // "Unfiled" is not a real folder — nothing to rename or delete
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'pattern-folder-more';
    more.setAttribute('aria-label', 'Folder actions for ' + group.folder.name);
    more.textContent = '⋯';
    head.appendChild(more);
  }
  return head;
}

function buildPatternListItem(pattern, draggable) {
  const item = document.createElement('li');
  item.className = 'pattern-list-item';
  item.dataset.patternId = pattern.id;
  if (draggable) item.draggable = true;

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

// Touch screens can't HTML5-drag (and long-press there means something else); they use the ⋯ menu.
function canDragPatterns() {
  return Boolean(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
}

// When something outside the list opens a pattern (a Findings search result), make sure a row for it is
// on screen: unfold every folder it sits in (it may be filed in several), then scroll to the first.
function revealPatternInTree(patternId) {
  const keys = getPatternFolderIds(patternId);
  (keys.length ? keys : [UNFILED_GROUP_KEY]).forEach(function(key) {
    if (_foldersCollapsed[key]) setFolderCollapsed(key, false);
  });
}

function scrollSelectedPatternIntoView() {
  const tree = document.getElementById('pattern-tree');
  const selected = tree && tree.querySelector('.pattern-list-item.is-selected');
  if (selected && typeof selected.scrollIntoView === 'function') selected.scrollIntoView({ block: 'nearest' });
}

// ── Interaction ──────────────────────────────────────────────
// Pattern rows (select, ⋯, right-click) are handled in patterns.js; this covers the folder headers,
// drag-and-drop between folders, and arrow-key movement.
function bindPatternTreeEvents() {
  const tree = document.getElementById('pattern-tree');
  if (!tree || _patternTreeEventsBound) return;
  _patternTreeEventsBound = true;

  tree.addEventListener('click', function(e) {
    const section = e.target.closest('.pattern-folder');
    const groupKey = section && section.dataset.groupKey;
    if (!groupKey) return;

    const more = e.target.closest('.pattern-folder-more');
    if (more) {
      e.stopPropagation(); // the document-level click handler would immediately hide the menu again
      const rect = more.getBoundingClientRect();
      showFolderContextMenu(rect.right, rect.bottom, groupKey);
      return;
    }

    const toggle = e.target.closest('.pattern-folder-toggle');
    if (!toggle || isPatternFilterActive()) return;
    const collapsed = !section.classList.contains('is-collapsed');
    setFolderCollapsed(groupKey, collapsed);
    section.classList.toggle('is-collapsed', collapsed); // in place, so keyboard focus stays on the header
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  tree.addEventListener('contextmenu', function(e) {
    const head = e.target.closest('.pattern-folder-head');
    const section = head && head.closest('.pattern-folder');
    const folderId = section && section.dataset.groupKey;
    if (!folderId || folderId === UNFILED_GROUP_KEY) return;
    e.preventDefault();
    showFolderContextMenu(e.clientX, e.clientY, folderId);
  });

  tree.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.prototype.filter.call(
      tree.querySelectorAll('.pattern-folder-toggle, .pattern-list-item-main'),
      function(el) { return el.offsetParent !== null; } // skip rows inside collapsed folders
    );
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const next = rows[index + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });

  tree.addEventListener('dragstart', function(e) {
    const item = e.target.closest && e.target.closest('.pattern-list-item');
    if (!item || !item.dataset.patternId) return;
    _draggingPatternId = item.dataset.patternId;
    item.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _draggingPatternId); // Firefox won't start a drag without data
    }
  });

  tree.addEventListener('dragover', function(e) {
    const section = _draggingPatternId && e.target.closest('.pattern-folder');
    if (!section || !section.dataset.groupKey) return;
    e.preventDefault(); // marks this a valid drop target
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!section.classList.contains('is-drop-target')) {
      clearPatternDropTargets();
      section.classList.add('is-drop-target');
    }
  });

  tree.addEventListener('drop', function(e) {
    const section = _draggingPatternId && e.target.closest('.pattern-folder');
    const groupKey = section && section.dataset.groupKey;
    if (!groupKey) return;
    e.preventDefault();
    const patternId = _draggingPatternId;
    endPatternDrag();
    // Dropping onto a folder adds it to that folder alongside any others it's already in; dropping onto
    // Unfiled is the one drag gesture that means "take it out of everything" (checkboxes handle the rest).
    if (groupKey === UNFILED_GROUP_KEY) clearPatternFolders(patternId);
    else addPatternToFolder(patternId, groupKey);
  });

  tree.addEventListener('dragend', endPatternDrag);
}

function clearPatternDropTargets() {
  document.querySelectorAll('#pattern-tree .is-drop-target').forEach(function(el) {
    el.classList.remove('is-drop-target');
  });
}

function endPatternDrag() {
  _draggingPatternId = null;
  clearPatternDropTargets();
  document.querySelectorAll('#pattern-tree .is-dragging').forEach(function(el) {
    el.classList.remove('is-dragging');
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
    setFolderCollapsed(folder.id, false);
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
    setFolderCollapsed(folderId, false); // drop its saved collapsed flag
    showToast('Folder deleted.');
  } catch (err) {
    console.error(err);
    showToast('Failed to delete folder.', true);
  }
}

// Adds one folder membership without disturbing any others the pattern already has.
async function addPatternToFolder(patternId, folderId) {
  if (!_pUid || !patternId || patternHasFolder(patternId, folderId)) return;
  const folder = getPatternFolderById(folderId);
  if (!folder) return;

  const changes = {};
  changes[patternId] = getPatternFolderIds(patternId).concat([folderId]);
  try {
    setFolderCollapsed(folderId, false); // so the pattern is visible where it landed
    await savePatternFolderAssignments(_pUid, changes);
    showToast('Added to "' + folder.name + '".');
  } catch (err) {
    console.error(err);
    showToast('Failed to add pattern to folder.', true);
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
  if (adding) setFolderCollapsed(folderId, false);

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
