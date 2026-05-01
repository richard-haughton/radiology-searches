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
  var tabBtns = document.querySelectorAll('.tab-btn');
  var panels  = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
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
    });
  });
}

// ── Auth ──────────────────────────────────────────────────────
var _modulesInitialised = false;

function showAuthScreen() {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
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
    initEditor();
    initPatterns(user.uid);
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
    _modulesInitialised = false;
    appAuth.signOut();
  });

  appAuth.onAuthStateChanged(function(user) {
    if (user) { showApp(user); }
    else      { showAuthScreen(); }
  });
});


