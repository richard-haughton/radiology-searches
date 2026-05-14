// share-patterns.js — plain script, no modules. Depends on db.js, app.js globals.

// ── State ────────────────────────────────────────────────────
var _shareUid = null;
var userPatterns = [];
var sharedPatterns = [];
var filteredSharedPatterns = [];
var sharedPatternMap = {};
var activeDiscoverModality = 'All';
var _unsubscribeSharedPatterns = null;

// ── Init ─────────────────────────────────────────────────────
function initSharePatterns(userId) {
  _shareUid = userId;

  // Load user's own patterns for sharing dropdown
  subscribePatterns(_shareUid, patterns => {
    userPatterns = patterns;
    updateSharePatternSelect();
  });

  // Subscribe to all shared patterns
  _unsubscribeSharedPatterns = subscribeSharedPatterns(patterns => {
    sharedPatterns = patterns;
    sharedPatternMap = {};
    patterns.forEach(p => {
      sharedPatternMap[p.patternId] = p;
    });
    updateSharedPatternsList();
    applyShareFilters();
  });

  // Event listeners for share section
  document.getElementById('share-pattern-select').addEventListener('change', e => {
    const hasValue = e.target.value !== '';
    document.getElementById('btn-share-pattern').disabled = !hasValue;
  });

  document.getElementById('btn-share-pattern').addEventListener('click', () => {
    const patternId = document.getElementById('share-pattern-select').value;
    if (patternId) {
      sharePattern(patternId);
    }
  });

  // Event listeners for discover section
  document.getElementById('share-filter-input').addEventListener('input', applyShareFilters);

  document.querySelectorAll('.discover-mod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.discover-mod-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeDiscoverModality = btn.dataset.mod;
      applyShareFilters();
    });
  });
}

// ── Update Share Pattern Select ──────────────────────────────
function updateSharePatternSelect() {
  const select = document.getElementById('share-pattern-select');
  const currentValue = select.value;
  
  // Keep the placeholder option
  const options = select.querySelectorAll('option');
  for (let i = options.length - 1; i > 0; i--) {
    options[i].remove();
  }

  userPatterns.forEach(pattern => {
    const option = document.createElement('option');
    option.value = pattern.id;
    option.textContent = pattern.name + ' (' + pattern.modality + ')';
    select.appendChild(option);
  });

  select.value = currentValue;
}

// ── Share Pattern ────────────────────────────────────────────
function sharePattern(patternId) {
  const pattern = userPatterns.find(p => p.id === patternId);
  if (!pattern) {
    showToast('Pattern not found.', true);
    return;
  }

  // Check if already shared
  if (sharedPatternMap[patternId]) {
    showToast('This pattern is already shared.', true);
    return;
  }

  // Create share doc
  const shareDoc = {
    patternId: patternId,
    patternName: pattern.name,
    modality: pattern.modality,
    authorId: _shareUid,
    authorName: document.getElementById('user-name').textContent || 'Anonymous',
    sharedAt: firebase.firestore.FieldValue.serverTimestamp(),
    importCount: 0
  };

  appDb.collection('sharedPatterns').add(shareDoc)
    .then(() => {
      showToast('Pattern shared successfully!');
      document.getElementById('share-pattern-select').value = '';
      document.getElementById('btn-share-pattern').disabled = true;
    })
    .catch(err => {
      console.error('Error sharing pattern:', err);
      showToast('Error sharing pattern: ' + err.message, true);
    });
}

// ── Update Shared Patterns List ──────────────────────────────
function updateSharedPatternsList() {
  const container = document.getElementById('share-list-container');
  
  const userSharedPatterns = sharedPatterns.filter(p => p.authorId === _shareUid);
  
  if (userSharedPatterns.length === 0) {
    container.innerHTML = '<p class="share-empty">No shared patterns yet.</p>';
    return;
  }

  container.innerHTML = userSharedPatterns.map(share => `
    <div class="share-item">
      <div class="share-item-header">
        <h4>${escapeHtml(share.patternName)}</h4>
        <span class="share-badge">${escapeHtml(share.modality)}</span>
      </div>
      <p class="share-item-meta">Shared on ${formatDate(share.sharedAt)} • ${share.importCount} imports</p>
      <div class="share-item-actions">
        <button class="btn btn-ghost btn-sm" onclick="unsharePattern('${share.patternId}')">Unshare</button>
      </div>
    </div>
  `).join('');
}

// ── Unshare Pattern ──────────────────────────────────────────
function unsharePattern(patternId) {
  const share = sharedPatterns.find(p => p.patternId === patternId && p.authorId === _shareUid);
  if (!share) {
    showToast('Share record not found.', true);
    return;
  }

  appDb.collection('sharedPatterns').doc(share.docId).delete()
    .then(() => {
      showToast('Pattern unshared.');
    })
    .catch(err => {
      console.error('Error unsharing pattern:', err);
      showToast('Error unsharing pattern: ' + err.message, true);
    });
}

// ── Apply Share Filters ──────────────────────────────────────
function applyShareFilters() {
  const filterText = document.getElementById('share-filter-input').value.toLowerCase();
  
  filteredSharedPatterns = sharedPatterns.filter(p => {
    const matchModality = activeDiscoverModality === 'All' || p.modality === activeDiscoverModality;
    const matchText = !filterText || 
      p.patternName.toLowerCase().includes(filterText) ||
      (p.authorName && p.authorName.toLowerCase().includes(filterText));
    return matchModality && matchText;
  });

  updateDiscoverList();
}

// ── Update Discover List ─────────────────────────────────────
function updateDiscoverList() {
  const container = document.getElementById('discover-list-container');
  
  if (filteredSharedPatterns.length === 0) {
    container.innerHTML = '<p class="discover-empty">No shared patterns found.</p>';
    return;
  }

  container.innerHTML = filteredSharedPatterns.map(share => {
    const isOwnPattern = share.authorId === _shareUid;
    const alreadyImported = userPatterns.some(p => p.id === share.patternId);
    
    return `
      <div class="discover-item">
        <div class="discover-item-header">
          <div>
            <h4>${escapeHtml(share.patternName)}</h4>
            <p class="discover-item-author">by ${escapeHtml(share.authorName || 'Anonymous')}</p>
          </div>
          <span class="share-badge">${escapeHtml(share.modality)}</span>
        </div>
        <p class="discover-item-meta">Shared on ${formatDate(share.sharedAt)} • ${share.importCount} imports</p>
        <div class="discover-item-actions">
          ${isOwnPattern ? 
            '<p class="discover-note">(Your pattern)</p>' :
            `<button class="btn btn-accent btn-sm" onclick="importSharedPattern('${share.patternId}', '${escapeAttr(share.patternName)}')" ${alreadyImported ? 'disabled' : ''}>
              ${alreadyImported ? 'Already Imported' : 'Import Pattern'}
            </button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

// ── Import Shared Pattern ────────────────────────────────────
function importSharedPattern(patternId, patternName) {
  // Get the shared pattern document
  const sharedPattern = sharedPatterns.find(p => p.patternId === patternId);
  if (!sharedPattern) {
    showToast('Pattern not found.', true);
    return;
  }

  // Check if already imported
  if (userPatterns.some(p => p.id === patternId)) {
    showToast('You already have this pattern.', true);
    return;
  }

  // Get the original pattern from the author's collection
  appDb.collection('users').doc(sharedPattern.authorId)
    .collection('patterns').doc(patternId).get()
    .then(doc => {
      if (!doc.exists) {
        showToast('Original pattern not found.', true);
        return;
      }

      const originalPattern = doc.data();
      
      // Copy pattern to current user's patterns
      return appDb.collection('users').doc(_shareUid)
        .collection('patterns').doc(patternId).set(originalPattern);
    })
    .then(() => {
      // Increment import count
      return appDb.collection('sharedPatterns').doc(sharedPattern.docId)
        .update({
          importCount: (sharedPattern.importCount || 0) + 1
        });
    })
    .then(() => {
      showToast('Pattern imported successfully!');
      applyShareFilters();
    })
    .catch(err => {
      console.error('Error importing pattern:', err);
      showToast('Error importing pattern: ' + err.message, true);
    });
}

// ── Subscribe to Shared Patterns ─────────────────────────────
function subscribeSharedPatterns(callback) {
  return appDb.collection('sharedPatterns')
    .orderBy('sharedAt', 'desc')
    .onSnapshot(
      snapshot => {
        const patterns = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          patterns.push({
            docId: doc.id,
            ...data,
            sharedAt: data.sharedAt ? data.sharedAt.toDate() : new Date()
          });
        });
        callback(patterns);
      },
      err => {
        console.error('Error subscribing to shared patterns:', err);
      }
    );
}

// ── Utilities ────────────────────────────────────────────────
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#x27;');
}

function formatDate(date) {
  if (!date) return 'Unknown';
  if (typeof date === 'string') date = new Date(date);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  if (days < 30) return Math.floor(days / 7) + ' weeks ago';
  if (days < 365) return Math.floor(days / 30) + ' months ago';
  return Math.floor(days / 365) + ' years ago';
}
