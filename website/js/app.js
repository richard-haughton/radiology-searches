// app.js — plain script, no modules. Depends on firebase-config.js (appAuth global).

// ── Theme (dark / light) ──────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

function initTheme() {
  var stored = localStorage.getItem('theme');
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = stored ? stored === 'dark' : prefersDark;
  applyTheme(dark);

  document.getElementById('btn-theme-toggle').addEventListener('click', function() {
    applyTheme(!document.documentElement.classList.contains('dark'));
  });
}

// ── Toast ─────────────────────────────────────────────────────
var _toastTimer = null;
function showToast(msg, isError) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' toast-error' : '');
  el.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { el.style.display = 'none'; }, 3000);
}

// ── Confirm dialog ────────────────────────────────────────────
function showConfirm(title, body) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-title').textContent = title;
    document.getElementById('modal-confirm-body').textContent = body;
    overlay.style.display = 'flex';

    function onOk()     { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function bgClick(e) { if (e.target === overlay) onCancel(); }
    function cleanup() {
      overlay.style.display = 'none';
      document.getElementById('btn-confirm-ok').removeEventListener('click', onOk);
      document.getElementById('btn-confirm-cancel').removeEventListener('click', onCancel);
      overlay.removeEventListener('click', bgClick);
    }
    document.getElementById('btn-confirm-ok').addEventListener('click', onOk);
    document.getElementById('btn-confirm-cancel').addEventListener('click', onCancel);
    overlay.addEventListener('click', bgClick);
  });
}

// ── Lightbox ──────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').style.display = 'flex';
}
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('lightbox').addEventListener('click', function(e) {
    if (e.target === document.getElementById('lightbox') ||
        e.target === document.getElementById('lightbox-close')) {
      document.getElementById('lightbox').style.display = 'none';
    }
  });
});

// ── Tab switching ─────────────────────────────────────────────
function initTabs() {
  var tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
  var panels  = document.querySelectorAll('.tab-panel');

  function activateTab(btn) {
    if (!btn) return;
    tabBtns.forEach(function(b) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    panels.forEach(function(p) {
      p.classList.remove('active');
      p.style.display = 'none';
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    var target = document.getElementById('panel-' + btn.dataset.tab);
    if (target) { target.classList.add('active'); target.style.display = ''; }
  }

  tabBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      activateTab(btn);
    });
  });
}

// ── Auth ──────────────────────────────────────────────────────
var _modulesInitialised = false;

function showAuthScreen(mode) {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-sign-in').style.display = mode ? 'none' : '';
  document.getElementById('auth-access').style.display = mode ? '' : 'none';
}

// Signed in but not (yet) approved by the owner: show where their request stands.
var _unsubscribeAccessRequest = null;
function showAccessScreen(user) {
  showAuthScreen('access');
  document.getElementById('auth-access-email').textContent = user.email || '';
  var msg = document.getElementById('auth-access-message');
  var btn = document.getElementById('btn-request-access');
  if (_unsubscribeAccessRequest) _unsubscribeAccessRequest();
  _unsubscribeAccessRequest = watchAccessRequest(user.uid, function(req) {
    btn.style.display = req ? 'none' : '';
    if (!req)                         msg.textContent = 'This site is invite-only. Request access and the owner will review it.';
    else if (req.status === 'denied') msg.textContent = 'Your access request was declined.';
    else                              msg.textContent = 'Request sent. You will be let in automatically once the owner approves it.';
  });
  btn.onclick = function() {
    btn.disabled = true;
    requestAccess(user).catch(function(err) {
      msg.textContent = 'Could not send request: ' + (err.message || err);
    }).finally(function() { btn.disabled = false; });
  };
}

function showSeedingScreen(text) {
  showAuthScreen('access');
  document.getElementById('btn-request-access').style.display = 'none';
  document.getElementById('auth-access-message').textContent = text;
}

function showApp(user) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  var avatar = document.getElementById('user-avatar');
  var name   = document.getElementById('user-name');
  if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = 'inline-block'; }
  name.textContent = user.displayName || user.email || '';

  if (!_modulesInitialised) {
    _modulesInitialised = true;
    initTabs();
    initSettings(user.uid);
    initMainDatasetSettings(user.uid);
    initEditor();
    initPatterns(user.uid);
    initSharePatterns(user.uid);
    initNotesSearch(user.uid);
    initStudyLog(user.uid);
    initCalculations();
  }
}

document.addEventListener('DOMContentLoaded', function() {
  initTheme();

  // Hide everything initially via JS (not relying on HTML hidden attribute)
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('modal-confirm').style.display = 'none';
  document.getElementById('modal-record').style.display = 'none';
  document.getElementById('modal-editor').style.display = 'none';
  document.getElementById('modal-edit-log').style.display = 'none';
  document.getElementById('lightbox').style.display = 'none';
  document.getElementById('toast').style.display = 'none';

  document.getElementById('btn-google-sign-in').addEventListener('click', function() {
    var errEl = document.getElementById('auth-error');
    errEl.style.display = 'none';
    var provider = new firebase.auth.GoogleAuthProvider();
    appAuth.signInWithPopup(provider).catch(function(err) {
      errEl.textContent = err.message || 'Sign-in failed.';
      errEl.style.display = 'block';
    });
  });

  document.getElementById('btn-sign-out').addEventListener('click', function() {
    appAuth.signOut();
  });
  document.getElementById('btn-access-sign-out').addEventListener('click', function() {
    appAuth.signOut();
  });

  var unsubscribeAccess = null;
  appAuth.onAuthStateChanged(function(user) {
    if (unsubscribeAccess) { unsubscribeAccess(); unsubscribeAccess = null; }
    if (_unsubscribeAccessRequest) { _unsubscribeAccessRequest(); _unsubscribeAccessRequest = null; }
    if (!user) { showAuthScreen(); return; }

    var hadAccess = false;
    unsubscribeAccess = watchAccess(user, function(allowed) {
      if (!allowed) {
        // Revoked while using the app: drop all live listeners by reloading into the request screen.
        if (hadAccess) { window.location.reload(); return; }
        showAccessScreen(user);
        return;
      }
      if (hadAccess) return;
      hadAccess = true;
      if (_unsubscribeAccessRequest) { _unsubscribeAccessRequest(); _unsubscribeAccessRequest = null; }

      showSeedingScreen('Loading…');
      seedFromMainDatasetIfNew(user.uid, function(done, total) {
        showSeedingScreen('Copying the main dataset into your account… ' + done + ' / ' + total);
      }).catch(function(err) {
        console.error('Initial copy of the main dataset failed:', err);
        showToast('Could not copy the main dataset. You can retry from Settings.', true);
      }).finally(function() { showApp(user); });
    });
  });
});


