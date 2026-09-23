// patterns.js — plain script, no modules. Depends on db.js, editor.js, app.js globals.

// ── State ────────────────────────────────────────────────────
var _pUid = null;
var allPatterns = [];
var filteredPatterns = [];
var selectedPatternId = null;
var currentStepIndex = 0;
var timerInterval = null;
var timerSeconds = 0;
var timerStartWallTime = null;
var timerRunning = false;
var timerGoalSeconds = null;
var _timerMode = 'timed';

var _voiceModeEnabled = false;
var _voiceSpeed = 1;
var _voiceVolume = 1;
var _timerActiveStepKey = '';
var _timerStepEnteredAtSeconds = 0;
var _timerActivePatternId = '';
var _timerActiveStepIndex = -1;
var _autoAdvancePaused = false;
var _timerPaused = false;          // true while the clock itself is frozen (full-screen "tap to pause")
var _timerPausedAtWall = 0;
var _stepTimingsCache = {}; // stepId -> {count, totalSeconds}
var _stepTimingsPatternId = null; // which pattern _stepTimingsCache currently reflects
var activeModality = 'All';
var pendingRecordPatternName = '';
var pendingRecordSeconds = 0;
var _unsubscribePatterns = null;
var _patternSidebarCollapsed = false;
var _findingsPanelCollapsed = false;
var _findingsPanelWidth = 360;
var _findingsPanelResizing = false;
var _findingsPanelResizeBound = false;
var _preferredStepIndex = null;
var _openStepIndices = new Set();
var _draggingPatternStepIndex = null;
var _patternViewerEditMode = false;
var _activeInlineEdit = null;
var _inlineEditSaving = false;
var _stepTitleSaveInFlight = {};
var _patternEditDraft = null;
var _patternEditCommitInFlight = false;
var _openFindingPanels = new Set();
var _draggingPatternFinding = null;
var _accordionMode = false;
var _patternListContextMenu = null;
var _patternListMenuState = null;
var STEP_SECTION_ORDER = ['searchPattern', 'dontMissPathology'];
var STEP_MAIN_SECTION_ORDER = ['searchPattern'];
var STEP_SECTION_LABELS = {
  dontMissPathology: 'Findings',
  searchPattern: 'Search Pattern'
};
var ACCORDION_MODE_STATE_KEY = 'patternStepAccordionMode';
var SECTION_WITH_SUBSECTIONS_KEYS = ['dontMissPathology'];
var STEP_SECTIONS_STATE_KEY = 'patternStepSectionsState';
var INLINE_EDITOR_FONT_SIZE_KEY = 'patternInlineEditorFontSize';
var TIMER_GOAL_MODE_STATE_KEY = 'patternTimerGoalMode';
var TIMER_VOICE_MODE_STATE_KEY = 'patternTimerVoiceMode';
var TIMER_VOICE_SPEED_STATE_KEY = 'patternTimerVoiceSpeed';
var TIMER_VOICE_SPEED_MIN = 0.5;
var TIMER_VOICE_SPEED_MAX = 2;
var TIMER_VOICE_SPEED_DEFAULT = 1;
var TIMER_VOICE_VOLUME_STATE_KEY = 'patternTimerVoiceVolume';
var TIMER_VOICE_VOLUME_MIN = 0;
var TIMER_VOICE_VOLUME_MAX = 3;
var TIMER_VOICE_VOLUME_DEFAULT = 1;
var PATTERN_SYNC_TIMEOUT_MS = 60000;
var _stepSectionsOpenState = {
  searchPattern: true,
  dontMissPathology: false
};
var _inlineToolbarOffsetBound = false;
var _inlineEditorFontSize = 'md';
var _yellowMarkedStepKeys = new Set();

function getCleanStepTitle(title) {
  if (typeof stripStepTitleNumbering === 'function') {
    return stripStepTitleNumbering(title);
  }
  var raw = String(title || '').trim();
  if (!raw) return '';
  return raw.replace(/^(?:step\s+\d+|\d+)\s*[.)\-:]?\s*/i, '').trim();
}

function syncInlineToolbarOffset() {
  const viewer = document.getElementById('step-viewer');
  const header = document.getElementById('step-header');
  const content = document.getElementById('step-content');
  if (!viewer || !header || !content) return;

  const viewerRect = viewer.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const visibleHeaderHeight = Math.max(0, headerRect.bottom - viewerRect.top);
  const toolbarOffset = Math.max(0, Math.round(visibleHeaderHeight + 8));
  content.style.setProperty('--inline-toolbar-offset', toolbarOffset + 'px');
}

function bindInlineToolbarOffsetSync() {
  if (_inlineToolbarOffsetBound) return;
  const viewer = document.getElementById('step-viewer');
  if (!viewer) return;

  viewer.addEventListener('scroll', syncInlineToolbarOffset, { passive: true });
  window.addEventListener('resize', syncInlineToolbarOffset);
  _inlineToolbarOffsetBound = true;
}

function normaliseInlineEditorFontSize(size) {
  var value = String(size || '').trim().toLowerCase();
  if (value === 'sm' || value === 'md' || value === 'lg') return value;
  return 'md';
}

function loadInlineEditorFontSizePreference() {
  var saved = localStorage.getItem(INLINE_EDITOR_FONT_SIZE_KEY);
  _inlineEditorFontSize = normaliseInlineEditorFontSize(saved || 'md');
}

function updateInlineFontSizeButtons(toolbar, size) {
  if (!toolbar) return;
  Array.prototype.forEach.call(toolbar.querySelectorAll('[data-rich-font-size]'), function(btn) {
    var selected = String(btn.getAttribute('data-rich-font-size') || '') === size;
    btn.classList.toggle('is-selected', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function applyInlineEditorFontSize(editor, size) {
  if (!editor) return;
  var safeSize = normaliseInlineEditorFontSize(size);
  editor.classList.remove('font-size-sm', 'font-size-md', 'font-size-lg');
  editor.classList.add('font-size-' + safeSize);
}

function bindInlineRichFontSizeControls(toolbar, editor) {
  if (!toolbar || !editor) return;

  var safeSize = normaliseInlineEditorFontSize(_inlineEditorFontSize);
  applyInlineEditorFontSize(editor, safeSize);
  updateInlineFontSizeButtons(toolbar, safeSize);

  Array.prototype.forEach.call(toolbar.querySelectorAll('[data-rich-font-size]'), function(btn) {
    btn.addEventListener('click', function() {
      var nextSize = normaliseInlineEditorFontSize(btn.getAttribute('data-rich-font-size'));
      _inlineEditorFontSize = nextSize;
      localStorage.setItem(INLINE_EDITOR_FONT_SIZE_KEY, nextSize);
      applyInlineEditorFontSize(editor, nextSize);
      updateInlineFontSizeButtons(toolbar, nextSize);
      editor.focus();
    });
  });
}

function normaliseTimerMode(value) {
  var mode = String(value || '').trim().toLowerCase();
  if (mode === 'walkthrough') return mode;
  return 'timed';
}

function loadTimerPreferences() {
  _timerMode = normaliseTimerMode(localStorage.getItem(TIMER_GOAL_MODE_STATE_KEY));
  _voiceModeEnabled = localStorage.getItem(TIMER_VOICE_MODE_STATE_KEY) === '1';
  _voiceSpeed = normaliseVoiceSpeed(localStorage.getItem(TIMER_VOICE_SPEED_STATE_KEY));
  _voiceVolume = normaliseVoiceVolume(localStorage.getItem(TIMER_VOICE_VOLUME_STATE_KEY));
}

function normaliseVoiceSpeed(value) {
  if (value === null || value === undefined || value === '') return TIMER_VOICE_SPEED_DEFAULT;
  var n = Number(value);
  if (!Number.isFinite(n)) return TIMER_VOICE_SPEED_DEFAULT;
  return Math.max(TIMER_VOICE_SPEED_MIN, Math.min(TIMER_VOICE_SPEED_MAX, n));
}

function normaliseVoiceVolume(value) {
  if (value === null || value === undefined || value === '') return TIMER_VOICE_VOLUME_DEFAULT;
  var n = Number(value);
  if (!Number.isFinite(n)) return TIMER_VOICE_VOLUME_DEFAULT;
  return Math.max(TIMER_VOICE_VOLUME_MIN, Math.min(TIMER_VOICE_VOLUME_MAX, n));
}

var STEP_GOAL_DEFAULT_SECONDS = 60;

// Steps with no goal explicitly set default to 1 minute, so Timed mode pacing works out of the
// box without per-step setup — this only affects the value used at runtime/display, it never
// writes the default back into storage (an unset step stays unset until the user overrides it).
function getEffectiveStepGoalSeconds(step) {
  var explicit = step ? normaliseGoalSeconds(step.goalSeconds) : null;
  return explicit === null ? STEP_GOAL_DEFAULT_SECONDS : explicit;
}

function computeTotalGoalSeconds(pattern) {
  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  return steps.reduce(function(sum, step) {
    return sum + getEffectiveStepGoalSeconds(step);
  }, 0);
}

function renderTotalGoalDisplay(pattern) {
  var el = document.getElementById('step-total-goal');
  if (!el) return;

  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  if (_timerMode !== 'timed' || !steps.length) {
    el.textContent = '';
    return;
  }

  el.textContent = 'Total goal ' + formatTimerClock(computeTotalGoalSeconds(pattern));
}

// Each step carries its own goal time now (replacing the old whole-pattern goal divided evenly
// across steps), so this depends on which step is currently active, not just the pattern.
function getCurrentStepGoalSeconds(pattern, mode) {
  var safeMode = normaliseTimerMode(mode);
  if (!pattern || safeMode !== 'timed') return null;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  var step = steps[currentStepIndex];
  if (!step) return null;
  return getEffectiveStepGoalSeconds(step);
}

function syncTimerControlsFromState() {
  var modeSelect = document.getElementById('timer-mode-select');
  var voiceToggle = document.getElementById('timer-voice-mode');
  var voiceSpeedInput = document.getElementById('timer-voice-speed');
  var voiceSpeedValue = document.getElementById('timer-voice-speed-value');
  var voiceVolumeInput = document.getElementById('timer-voice-volume');
  var voiceVolumeValue = document.getElementById('timer-voice-volume-value');

  if (modeSelect) {
    modeSelect.value = _timerMode;
  }
  if (voiceToggle) {
    voiceToggle.checked = _voiceModeEnabled;
  }
  if (voiceSpeedInput && document.activeElement !== voiceSpeedInput) {
    voiceSpeedInput.value = String(_voiceSpeed);
  }
  if (voiceSpeedValue) {
    voiceSpeedValue.textContent = _voiceSpeed.toFixed(1) + 'x';
  }
  if (voiceVolumeInput && document.activeElement !== voiceVolumeInput) {
    voiceVolumeInput.value = String(_voiceVolume);
  }
  if (voiceVolumeValue) {
    voiceVolumeValue.textContent = Math.round(_voiceVolume * 100) + '%';
  }

  // The full-screen read is a Timed-mode feature (auto-advance + goal pacing); CSS decides whether the
  // current screen size actually shows it.
  var fullscreenBtn = document.getElementById('btn-timer-fullscreen');
  if (fullscreenBtn) {
    fullscreenBtn.hidden = _timerMode !== 'timed';
  }
}

function getActiveStepAnnouncement(step, stepIndex) {
  var safeIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  var title = step && getCleanStepTitle(step.stepTitle);
  return title ? title : ('Step ' + String(safeIndex + 1));
}

// ── AI-augmented step voice announcements ───────────────────
var _stepAnnouncementSpeechToken = 0;
var _voiceAudioEl = null;        // one long-lived <audio> element reused for every announcement
var _voiceGainNode = null;       // Web Audio gain (desktop-only loudness boost), wired once to _voiceAudioEl
var _voiceAudioContext = null;
var _voiceAudioUnlocked = false;
var _voiceSpeechUnlocked = false;
var _voiceAnnouncementCache = new Map(); // announcement text -> Promise<data URL> (also serves as prefetch cache)
var VOICE_ANNOUNCEMENT_CACHE_MAX = 40;
var STEP_ANNOUNCEMENT_TTS_INSTRUCTIONS = 'Speak clearly and naturally, like a calm colleague stating a checklist item during a live read. Brief, natural pacing, not robotic.';
var VOICE_SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

function isTouchPrimaryDevice() {
  return Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

// A plain <audio>/<utterance> volume is hard-capped at 1.0 (100%) by spec — setting it higher
// throws. To go louder than that on desktop, AI-voice audio is routed through a Web Audio gain
// node instead, which can amplify the signal past its native level (at the cost of possible
// clipping at extreme settings). Phones skip this path on purpose: iOS/Android suspend the
// AudioContext outside a user gesture, and audio routed through a suspended context plays as
// silence — hardware volume is the right control there. The browser-voice fallback has no boost
// path either, so it stays capped at 100%.
function ensureVoiceAudioContext() {
  if (isTouchPrimaryDevice()) return null;
  if (_voiceAudioContext) return _voiceAudioContext;
  var Ctor = window.AudioContext || window.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    _voiceAudioContext = new Ctor();
  } catch (err) {
    _voiceAudioContext = null;
  }
  return _voiceAudioContext;
}

// AudioContexts start (or get auto-suspended back to) "suspended" until resumed from within a
// genuine user gesture — call this from direct click/input handlers (the Voice toggle, the volume
// slider) so it's already unlocked by the time an auto-advance-triggered announcement needs it.
function resumeVoiceAudioContextFromUserGesture() {
  var ctx = ensureVoiceAudioContext();
  if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    ctx.resume().catch(function() { /* ignore — falls back to capped native volume */ });
  }
}

function getVoiceAudioElement() {
  if (_voiceAudioEl) return _voiceAudioEl;
  var el = new Audio();
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  _voiceAudioEl = el;
  return el;
}

function applyVoiceVolumeToPlayback() {
  if (_voiceGainNode) {
    _voiceGainNode.gain.value = _voiceVolume; // can exceed 1.0 — actual amplification, not just native volume
  } else if (_voiceAudioEl) {
    _voiceAudioEl.volume = Math.min(1, _voiceVolume);
  }
}

// Mobile browsers (iOS Safari especially) only let a media element play programmatically if that
// same element was first started from inside a real tap. Announcements fire from a timer, after
// an async network round trip, so they are never "in" a gesture — without this unlock the audio
// silently fails and the browser-voice fallback is blocked too. The one long-lived element is
// played (silent clip) on the first tap, after which it can be reused freely for real speech.
function unlockVoiceOutput() {
  resumeVoiceAudioContextFromUserGesture();

  if (!_voiceAudioUnlocked) {
    var el = getVoiceAudioElement();
    if (el.paused) { // never clobber an announcement that is already playing
      try {
        setAnnouncementAudioSession('ambient'); // the silent clip must mix in, not interrupt the user's music
        el.src = VOICE_SILENT_WAV;
        var playing = el.play();
        if (playing && typeof playing.then === 'function') {
          playing.then(function() {
            _voiceAudioUnlocked = true;
            el.pause();
            setAnnouncementAudioSession('auto');
          }).catch(function() {
            setAnnouncementAudioSession('auto'); // not a usable gesture — the next tap retries
          });
        } else {
          _voiceAudioUnlocked = true;
        }
      } catch (err) { /* retry on next gesture */ }
    }
  }

  if (!_voiceSpeechUnlocked && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function') {
    try {
      var warmup = new SpeechSynthesisUtterance(' ');
      warmup.volume = 0;
      window.speechSynthesis.speak(warmup);
      _voiceSpeechUnlocked = true;
    } catch (err) { /* retry on next gesture */ }
  }
}

function bindVoiceUnlockOnGesture() {
  var handler = function() {
    if (!_voiceModeEnabled) return;
    if (_voiceAudioUnlocked && _voiceSpeechUnlocked) return;
    unlockVoiceOutput();
  };
  ['touchend', 'click', 'keydown'].forEach(function(type) {
    document.addEventListener(type, handler, { passive: true });
  });
}

// Sharing the phone's audio with a music app. Each announcement should take over from the music for its
// couple of seconds and then hand back, rather than just ducking it. Safari's Audio Session API lets a
// page ask for that ('transient-solo': interrupt other audio, let it resume when we finish); 'auto' hands
// control back. Browsers without the API keep their own default behavior, which the page can't change.
function setAnnouncementAudioSession(type) {
  if (!isTouchPrimaryDevice()) return;
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch (err) {
    // Unsupported value on this browser — default audio behavior applies.
  }
}

function stopStepAnnouncementAudio() {
  _stepAnnouncementSpeechToken += 1; // invalidate any announcement request currently in flight
  setAnnouncementAudioSession('auto');
  if (_voiceAudioEl) {
    try { _voiceAudioEl.pause(); } catch (err) { /* already stopped */ }
    _voiceAudioEl.onended = null;
    _voiceAudioEl.onerror = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function speakActiveStepWithBrowserTts(text, token) {
  if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
  if (token !== undefined && token !== _stepAnnouncementSpeechToken) return;
  window.speechSynthesis.cancel();
  var utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = _voiceSpeed;
  utterance.pitch = 1;
  utterance.volume = Math.min(1, _voiceVolume); // browser TTS has no boost path — capped at 100%
  // Mobile Chrome/Safari drop an utterance queued in the same tick as cancel(), so give it a beat.
  var finished = function() {
    if (token === undefined || token === _stepAnnouncementSpeechToken) setAnnouncementAudioSession('auto');
  };
  utterance.onend = finished;
  utterance.onerror = finished;
  setTimeout(function() {
    if (token !== undefined && token !== _stepAnnouncementSpeechToken) return;
    setAnnouncementAudioSession('transient-solo');
    window.speechSynthesis.speak(utterance);
  }, 60);
}

// Fetches (or reuses) synthesized audio for a phrase. Keeping the in-flight promise in the cache
// means prefetching the next step and then speaking it never triggers two paid TTS calls.
function getStepAnnouncementAudio(text) {
  var cached = _voiceAnnouncementCache.get(text);
  if (cached) return cached;

  var pending = synthesizeAiVoiceSpeech(text, { instructions: STEP_ANNOUNCEMENT_TTS_INSTRUCTIONS });
  _voiceAnnouncementCache.set(text, pending);
  pending.catch(function() { _voiceAnnouncementCache.delete(text); });

  if (_voiceAnnouncementCache.size > VOICE_ANNOUNCEMENT_CACHE_MAX) {
    _voiceAnnouncementCache.delete(_voiceAnnouncementCache.keys().next().value);
  }
  return pending;
}

// Synthesizing the next step's phrase while the current one is being read removes the network delay
// (noticeable on cellular) between "step changes" and "voice speaks".
function prefetchNextStepAnnouncement(stepIndex) {
  if (!_voiceModeEnabled || typeof synthesizeAiVoiceSpeech !== 'function') return;
  var pattern = getSelectedPattern();
  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  var nextIndex = (Number.isInteger(stepIndex) ? stepIndex : currentStepIndex) + 1;
  if (nextIndex >= steps.length) return;
  var text = getActiveStepAnnouncement(steps[nextIndex], nextIndex);
  if (text) getStepAnnouncementAudio(text).catch(function() { /* prefetch is best-effort */ });
}

// Reads the step name aloud using AI-quality TTS when the "Voice" toggle is on, falling back to
// the browser's built-in voice if AI synthesis is unavailable or fails. Guards against overlapping
// announcements (e.g. quickly stepping through several steps) with a generation token, same
// technique as the old voice navigator used for its speech.
async function speakActiveStep(step, stepIndex) {
  if (!_voiceModeEnabled) return;

  var text = getActiveStepAnnouncement(step, stepIndex);
  if (!text) return;

  stopStepAnnouncementAudio();
  var myToken = _stepAnnouncementSpeechToken;

  if (typeof synthesizeAiVoiceSpeech !== 'function') {
    speakActiveStepWithBrowserTts(text, myToken);
    return;
  }

  try {
    var dataUrl = await getStepAnnouncementAudio(text);
    if (myToken !== _stepAnnouncementSpeechToken) return;

    var audio = getVoiceAudioElement();
    audio.onended = null;
    audio.onerror = null;
    audio.src = dataUrl;
    // Assigning src resets the playback rate to the default, so set both.
    audio.defaultPlaybackRate = _voiceSpeed;
    audio.playbackRate = _voiceSpeed;

    var audioCtx = ensureVoiceAudioContext();
    if (audioCtx && !_voiceGainNode) {
      try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        // A media element can only ever be wired into Web Audio once, so this happens a single time.
        var source = audioCtx.createMediaElementSource(audio);
        var gainNode = audioCtx.createGain();
        source.connect(gainNode).connect(audioCtx.destination);
        _voiceGainNode = gainNode;
      } catch (err) {
        _voiceGainNode = null; // Web Audio routing failed — fall back to capped native volume
      }
    }
    audio.volume = _voiceGainNode ? 1 : Math.min(1, _voiceVolume);
    applyVoiceVolumeToPlayback();

    audio.onended = function() {
      if (myToken === _stepAnnouncementSpeechToken) setAnnouncementAudioSession('auto'); // hand back to the music
    };
    audio.onerror = function() {
      if (myToken === _stepAnnouncementSpeechToken) speakActiveStepWithBrowserTts(text, myToken);
    };
    setAnnouncementAudioSession('transient-solo');
    await audio.play();
    if (myToken !== _stepAnnouncementSpeechToken) {
      try { audio.pause(); } catch (err) { /* already stopped */ }
      return;
    }
    prefetchNextStepAnnouncement(stepIndex);
  } catch (err) {
    setAnnouncementAudioSession('auto');
    if (err && err.name === 'NotAllowedError') {
      notifyVoiceBlockedOnce();
    } else {
      console.error('AI step announcement playback failed, falling back to browser voice:', err);
    }
    if (myToken === _stepAnnouncementSpeechToken) speakActiveStepWithBrowserTts(text, myToken);
  }
}

// If the browser still refuses audio (e.g. the page was reloaded with Voice already on and nothing has
// been tapped yet), say so once instead of failing silently; the next tap unlocks it.
var _voiceBlockedNoticeShown = false;
function notifyVoiceBlockedOnce() {
  if (_voiceBlockedNoticeShown) return;
  _voiceBlockedNoticeShown = true;
  showToast('Voice is blocked until you tap the screen once.', true);
}

function handleActiveStepChanged(pattern, stepIndex, step, options) {
  var safePattern = pattern || getSelectedPattern();
  var safeIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  var safeStep = step || null;
  var safePatternId = safePattern ? String(safePattern.id || '').trim() : '';
  var key = safePatternId && safeStep ? (safePatternId + '::' + String(safeIndex)) : '';
  var changed = key && key !== _timerActiveStepKey;

  if (changed && timerRunning) {
    recordActiveStepTiming();
  }

  if (!key) {
    _timerActiveStepKey = '';
    _timerStepEnteredAtSeconds = timerSeconds;
    _timerActivePatternId = '';
    _timerActiveStepIndex = -1;
    return;
  }

  if (!changed) return;

  _timerActiveStepKey = key;
  _timerStepEnteredAtSeconds = timerSeconds;
  _timerActivePatternId = safePatternId;
  _timerActiveStepIndex = safeIndex;

  if (_timerMode === 'timed') {
    timerGoalSeconds = getCurrentStepGoalSeconds(safePattern, _timerMode);
  }

  if (!(options && options.silentVoice) && !_timerPaused) {
    speakActiveStep(safeStep, safeIndex);
  }

  renderStepTimeStats(safeStep);
  renderTimedFullscreen();
}

// ── Per-step timing (live + historical average) ─────────────
function recordActiveStepTiming() {
  if (!_timerActivePatternId || _timerActiveStepIndex < 0) return;
  var elapsed = Math.max(0, timerSeconds - _timerStepEnteredAtSeconds);
  if (elapsed < 1) return; // ignore near-instant passes (e.g. quickly skimming through steps)

  var pattern = allPatterns.find(function(p) { return p.id === _timerActivePatternId; });
  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  var step = steps[_timerActiveStepIndex];
  if (!step || !step.stepId) return;

  if (typeof recordStepTiming === 'function' && _pUid) {
    recordStepTiming(_pUid, _timerActivePatternId, step.stepId, elapsed).catch(function(err) {
      console.error('Failed to record step timing:', err);
    });
  }
  addLocalStepTimingSample(step.stepId, elapsed);
}

function addLocalStepTimingSample(stepId, seconds) {
  if (!stepId) return;
  var entry = _stepTimingsCache[stepId] || { count: 0, totalSeconds: 0 };
  entry.count += 1;
  entry.totalSeconds += Math.round(seconds);
  _stepTimingsCache[stepId] = entry;
}

function loadStepTimingsForPattern(pattern) {
  if (!pattern || !_pUid) return;
  if (_stepTimingsPatternId === pattern.id) {
    renderStepTimeStatsForCurrentStep();
    return;
  }

  _stepTimingsPatternId = pattern.id;
  _stepTimingsCache = {};
  if (typeof fetchStepTimings !== 'function') return;

  fetchStepTimings(_pUid, pattern.id).then(function(result) {
    if (_stepTimingsPatternId !== pattern.id) return; // pattern changed again before this resolved
    _stepTimingsCache = result || {};
    renderStepTimeStatsForCurrentStep();
  }).catch(function(err) {
    console.error('Failed to load step timing history:', err);
  });
}

function renderStepTimeStats(step) {
  var el = document.getElementById('step-time-stats');
  if (!el) return;

  var entry = step && step.stepId ? _stepTimingsCache[step.stepId] : null;
  var avgText = entry && entry.count > 0 ? ('Avg ' + formatTimerClock(Math.round(entry.totalSeconds / entry.count))) : '';

  if (!timerRunning) {
    el.textContent = avgText;
    return;
  }

  var pausedSuffix = (_timerPaused || (_timerMode === 'timed' && _autoAdvancePaused)) ? ' · paused' : '';
  var elapsed = Math.max(0, timerSeconds - _timerStepEnteredAtSeconds);
  el.innerHTML = '<span class="step-time-current">' + formatTimerClock(elapsed) + '</span>' + (avgText ? ' · ' + avgText : '') + pausedSuffix;
}

function renderStepTimeStatsForCurrentStep() {
  var pattern = getSelectedPattern();
  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  renderStepTimeStats(steps[currentStepIndex] || null);
}

function toggleAutoAdvancePause() {
  _autoAdvancePaused = !_autoAdvancePaused;
  if (!_autoAdvancePaused) {
    _timerStepEnteredAtSeconds = timerSeconds; // fresh full window for the current step on resume
  }
  renderStepTimeStatsForCurrentStep();
  showToast(_autoAdvancePaused ? 'Auto-advance paused.' : 'Auto-advance resumed.');
}

// ── Init ─────────────────────────────────────────────────────
function initPatterns(userId) {
  _pUid = userId;

  initPatternSidebarToggle();
  initPatternFindingsPanelToggle();
  initFindingsExpandAllButton();
  loadStepSectionsOpenState();
  loadAccordionModeState();
  loadInlineEditorFontSizePreference();
  loadTimerPreferences();
  initPatternViewControls();
  bindInlineToolbarOffsetSync();
  initMobilePatternPicker();
  bindVoiceUnlockOnGesture();
  initTimedFullscreen();

  // Folders load alongside the patterns; each re-renders the list when it arrives.
  initPatternFolders(_pUid);

  // Subscribe to Firestore patterns
  _unsubscribePatterns = subscribePatterns(_pUid, patterns => {
    allPatterns = patterns;
    setAllPatternsRef(patterns);
    renderPatternFolderSelect(); // the folder counts follow the patterns
    applyFilters();
  });

  // Filter events
  document.getElementById('pattern-filter').addEventListener('input', applyFilters);

  // Modality buttons
  document.querySelectorAll('.mod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeModality = btn.dataset.mod;
      applyFilters();
    });
  });

  initPatternListContextMenu();

  // Timer controls
  document.getElementById('btn-start-timer').addEventListener('click', handleStartTimer);
  document.getElementById('btn-record-study').addEventListener('click', openRecordModal);
  document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);
  document.getElementById('timer-voice-speed').addEventListener('input', e => {
    _voiceSpeed = normaliseVoiceSpeed(e.target && e.target.value);
    localStorage.setItem(TIMER_VOICE_SPEED_STATE_KEY, String(_voiceSpeed));
    const speedValueEl = document.getElementById('timer-voice-speed-value');
    if (speedValueEl) speedValueEl.textContent = _voiceSpeed.toFixed(1) + 'x';
  });
  document.getElementById('timer-voice-volume').addEventListener('input', e => {
    resumeVoiceAudioContextFromUserGesture(); // this handler runs on a real user gesture — unlock early
    _voiceVolume = normaliseVoiceVolume(e.target && e.target.value);
    localStorage.setItem(TIMER_VOICE_VOLUME_STATE_KEY, String(_voiceVolume));
    const volumeValueEl = document.getElementById('timer-voice-volume-value');
    if (volumeValueEl) volumeValueEl.textContent = Math.round(_voiceVolume * 100) + '%';
    applyVoiceVolumeToPlayback();
  });
  document.getElementById('timer-mode-select').addEventListener('change', e => {
    const previousMode = _timerMode;
    _timerMode = normaliseTimerMode(e.target && e.target.value);
    localStorage.setItem(TIMER_GOAL_MODE_STATE_KEY, _timerMode);
    if (previousMode === 'timed' && _timerMode !== 'timed') {
      _autoAdvancePaused = false;
    }
    const pattern = getSelectedPattern();
    timerGoalSeconds = getCurrentStepGoalSeconds(pattern, _timerMode);
    syncTimerControlsFromState();
    renderStepTimeStatsForCurrentStep();
    renderTotalGoalDisplay(pattern);
    updateTimerDisplay();
  });

  document.getElementById('timer-voice-mode').addEventListener('change', e => {
    _voiceModeEnabled = Boolean(e.target && e.target.checked);
    localStorage.setItem(TIMER_VOICE_MODE_STATE_KEY, _voiceModeEnabled ? '1' : '0');
    if (!_voiceModeEnabled) {
      stopStepAnnouncementAudio();
      return;
    }
    unlockVoiceOutput(); // this handler runs on a real user gesture — unlock audio for later announcements
    const pattern = getSelectedPattern();
    const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
    const activeStep = steps[currentStepIndex] || null;
    speakActiveStep(activeStep, currentStepIndex);
  });
  const timerOptionsBtn = document.getElementById('btn-timer-options');
  if (timerOptionsBtn) {
    timerOptionsBtn.addEventListener('click', () => {
      const timerBar = document.getElementById('timer-bar');
      if (!timerBar) return;
      const open = timerBar.classList.toggle('timer-options-open');
      timerOptionsBtn.setAttribute('aria-expanded', String(open));
    });
  }
  syncTimerControlsFromState();
  updateTimerActionButtons();

  // Record modal
  document.getElementById('btn-record-confirm').addEventListener('click', confirmRecord);
  document.getElementById('btn-record-cancel').addEventListener('click', () => {
    document.getElementById('modal-record').style.display = 'none';
  });
  document.getElementById('modal-record').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-record')) {
      document.getElementById('modal-record').style.display = 'none';
    }
  });

  // Edit / Delete / New buttons
  document.getElementById('btn-new-pattern').addEventListener('click', () => openEditor(_pUid, null));
  document.getElementById('btn-edit-pattern').addEventListener('click', () => {
    if (selectedPatternId) {
      togglePatternViewerEditMode();
    }
  });
  document.getElementById('btn-add-pattern-step').addEventListener('click', handleAddPatternStep);

  // HDF5 import
  document.getElementById('btn-import-h5').addEventListener('click', () => {
    document.getElementById('import-h5-input').click();
  });
  document.getElementById('import-h5-input').addEventListener('change', handleH5Import);

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);
}

function extractStepSearchText(step, fallbackNumber) {
  if (!step) return '';
  var parts = [];
  var title = getCleanStepTitle(step.stepTitle);
  if (title) parts.push(title);
  if (fallbackNumber) parts.push('step ' + String(fallbackNumber));

  var sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);
  var searchPatternChunks = normaliseRichContent(sections.searchPattern || []);
  var searchPatternText = typeof richContentToPlainText === 'function'
    ? richContentToPlainText(searchPatternChunks)
    : searchPatternChunks.map(function(chunk) {
        return chunk && chunk.type === 'text' ? String(chunk.text || '') : '';
      }).join(' ');
  if (searchPatternText) parts.push(searchPatternText);

  var findingsChunks = normaliseRichContent(sections.dontMissPathology || []);
  var findingsText = typeof richContentToPlainText === 'function'
    ? richContentToPlainText(findingsChunks)
    : findingsChunks.map(function(chunk) {
        return chunk && chunk.type === 'text' ? String(chunk.text || '') : '';
      }).join(' ');
  if (findingsText) parts.push(findingsText);

  return parts.join(' ').toLowerCase();
}

function parseGoToTarget(text) {
  var cleaned = String(text || '').trim();
  if (!cleaned) return { type: 'none', value: '' };

  var numberMatch = cleaned.match(/(?:step\s*)?(\d+)/i);
  if (numberMatch) {
    var stepNumber = Number(numberMatch[1]);
    if (Number.isFinite(stepNumber) && stepNumber > 0) {
      return { type: 'index', value: Math.floor(stepNumber) - 1 };
    }
  }

  return { type: 'query', value: cleaned.toLowerCase() };
}

function focusCurrentStepToggle(stepIndex) {
  var toggle = document.querySelector('.step-item[data-step-index="' + stepIndex + '"] .step-item-toggle');
  if (toggle && typeof toggle.focus === 'function') {
    toggle.focus({ preventScroll: true });
  }
}

function getStepMarkKey(patternId, stepIndex) {
  var safePatternId = String(patternId || '').trim();
  if (!safePatternId || !Number.isInteger(stepIndex) || stepIndex < 0) return '';
  return safePatternId + '::' + String(stepIndex);
}

function isStepYellowMarked(patternId, stepIndex) {
  var key = getStepMarkKey(patternId, stepIndex);
  return key ? _yellowMarkedStepKeys.has(key) : false;
}

function markCurrentStepYellow() {
  var pattern = getSelectedPattern();
  if (!pattern) return false;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length || currentStepIndex < 0 || currentStepIndex >= steps.length) return false;

  return markStepYellowByIndex(currentStepIndex);
}

function markStepYellowByIndex(stepIndex) {
  var pattern = getSelectedPattern();
  if (!pattern) return false;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) return false;

  var key = getStepMarkKey(pattern.id, stepIndex);
  if (!key) return false;

  _yellowMarkedStepKeys.add(key);
  currentStepIndex = stepIndex;
  _openStepIndices = new Set([stepIndex]);
  renderCurrentStep(pattern);
  focusCurrentStepToggle(stepIndex);
  return true;
}

function normaliseMarkTargetQuery(rawQuery) {
  var query = String(rawQuery || '').toLowerCase().trim();
  if (!query) return '';
  query = query.replace(/^step\s+/i, '').trim();
  query = query.replace(/^the\s+/i, '').trim();
  if (query.indexOf('the') === 0 && query.length > 3 && query.charAt(3) !== ' ') {
    query = query.slice(3).trim();
  }
  return query;
}

function markStepYellowByTarget(rawTarget) {
  var pattern = getSelectedPattern();
  if (!pattern) return false;
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length) return false;

  var target = parseGoToTarget(normaliseMarkTargetQuery(rawTarget));
  if (target.type === 'index') {
    return markStepYellowByIndex(target.value);
  }

  if (target.type !== 'query' || !target.value) {
    return false;
  }

  var queryWords = target.value.split(/\s+/).filter(Boolean);
  if (!queryWords.length) return false;

  var bestIndex = -1;
  for (var i = 0; i < steps.length; i += 1) {
    var step = resolveLinkedStep(steps[i]);
    var haystack = extractStepSearchText(step, i + 1);
    var compactHaystack = haystack.replace(/\s+/g, '');
    var matched = queryWords.every(function(word) {
      var cleanWord = String(word || '').trim();
      if (!cleanWord) return true;
      if (haystack.indexOf(cleanWord) !== -1) return true;
      return compactHaystack.indexOf(cleanWord.replace(/\s+/g, '')) !== -1;
    });
    if (matched) {
      bestIndex = i;
      break;
    }
  }

  if (bestIndex < 0) return false;
  return markStepYellowByIndex(bestIndex);
}

function clearYellowStepMarks() {
  if (!_yellowMarkedStepKeys.size) return;
  _yellowMarkedStepKeys.clear();
}

function initPatternSidebarToggle() {
  const layout = document.querySelector('.patterns-layout');
  const btn = document.getElementById('btn-toggle-pattern-sidebar');
  if (!layout || !btn) return;

  const saved = localStorage.getItem('patternSidebarCollapsed');
  applyPatternSidebarState(saved === '1', false);

  btn.addEventListener('click', () => {
    applyPatternSidebarState(!_patternSidebarCollapsed, true);
  });
}

function applyPatternSidebarState(collapsed, persist) {
  const layout = document.querySelector('.patterns-layout');
  const btn = document.getElementById('btn-toggle-pattern-sidebar');
  if (!layout || !btn) return;

  _patternSidebarCollapsed = collapsed;
  layout.classList.toggle('sidebar-collapsed', collapsed);

  btn.textContent = collapsed ? '>' : '<';
  btn.title = collapsed ? 'Expand panel' : 'Minimize panel';
  btn.setAttribute('aria-label', collapsed ? 'Expand search pattern panel' : 'Minimize search pattern panel');
  btn.setAttribute('aria-expanded', String(!collapsed));

  if (persist) {
    localStorage.setItem('patternSidebarCollapsed', collapsed ? '1' : '0');
  }
}

function initPatternFindingsPanelToggle() {
  const panel = document.getElementById('pattern-findings-panel');
  const btn = document.getElementById('btn-toggle-pattern-findings-panel');
  if (!panel || !btn) return;

  // On a phone the panel is a bottom drawer that starts closed, and its open/closed state is not
  // persisted so it never overwrites the desktop preference.
  const saved = localStorage.getItem('patternFindingsPanelCollapsed');
  applyPatternFindingsPanelState(isMobileLayout() || saved === '1', false);

  btn.addEventListener('click', () => {
    applyPatternFindingsPanelState(!_findingsPanelCollapsed, !isMobileLayout());
  });

  const headerText = panel.querySelector('.pattern-findings-header-text');
  if (headerText) {
    headerText.addEventListener('click', () => {
      if (isMobileLayout()) btn.click();
    });
  }

  bindFindingsPanelResizeHandle();
  loadPatternFindingsPanelWidth();
}

function applyPatternFindingsPanelState(collapsed, persist) {
  const panel = document.getElementById('pattern-findings-panel');
  const btn = document.getElementById('btn-toggle-pattern-findings-panel');
  if (!panel || !btn) return;

  _findingsPanelCollapsed = collapsed;
  panel.classList.toggle('panel-collapsed', collapsed);

  btn.textContent = collapsed ? '>' : '<';
  btn.title = collapsed ? 'Expand findings window' : 'Minimize findings window';
  btn.setAttribute('aria-label', collapsed ? 'Expand search pattern findings window' : 'Minimize search pattern findings window');
  btn.setAttribute('aria-expanded', String(!collapsed));

  if (collapsed) {
    panel.style.removeProperty('width');
    panel.style.removeProperty('min-width');
  } else {
    applyPatternFindingsPanelWidth(_findingsPanelWidth, false);
  }

  if (persist) {
    localStorage.setItem('patternFindingsPanelCollapsed', collapsed ? '1' : '0');
  }
}

function clampFindingsPanelWidth(width) {
  const min = 280;
  const viewport = window.innerWidth || 1440;
  const max = Math.max(360, Math.floor(viewport * 0.62));
  const next = Number(width);
  if (!Number.isFinite(next)) return 360;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function applyPatternFindingsPanelWidth(width, persist) {
  const panel = document.getElementById('pattern-findings-panel');
  if (!panel) return;

  if (_findingsPanelCollapsed) {
    panel.style.removeProperty('width');
    panel.style.removeProperty('min-width');
    return;
  }

  if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
    panel.style.removeProperty('width');
    panel.style.removeProperty('min-width');
    return;
  }

  _findingsPanelWidth = clampFindingsPanelWidth(width);
  panel.style.width = _findingsPanelWidth + 'px';
  panel.style.minWidth = _findingsPanelWidth + 'px';

  if (persist) {
    localStorage.setItem('patternFindingsPanelWidth', String(_findingsPanelWidth));
  }
}

function loadPatternFindingsPanelWidth() {
  const saved = localStorage.getItem('patternFindingsPanelWidth');
  applyPatternFindingsPanelWidth(saved || _findingsPanelWidth, false);
}

function bindFindingsPanelResizeHandle() {
  if (_findingsPanelResizeBound) return;

  const handle = document.getElementById('pattern-findings-resize-handle');
  const panel = document.getElementById('pattern-findings-panel');
  if (!handle || !panel) return;

  function stopResize() {
    if (!_findingsPanelResizing) return;
    _findingsPanelResizing = false;
    document.body.classList.remove('is-resizing-findings-panel');
    localStorage.setItem('patternFindingsPanelWidth', String(_findingsPanelWidth));
  }

  function onPointerMove(event) {
    if (!_findingsPanelResizing || _findingsPanelCollapsed) return;
    const viewport = window.innerWidth || 1440;
    const desiredWidth = viewport - event.clientX;
    applyPatternFindingsPanelWidth(desiredWidth, false);
  }

  handle.addEventListener('pointerdown', function(event) {
    if (_findingsPanelCollapsed) return;
    if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) return;
    event.preventDefault();
    _findingsPanelResizing = true;
    document.body.classList.add('is-resizing-findings-panel');
    if (typeof handle.setPointerCapture === 'function') {
      handle.setPointerCapture(event.pointerId);
    }
  });

  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('resize', function() {
    if (_findingsPanelCollapsed) return;
    applyPatternFindingsPanelWidth(_findingsPanelWidth, false);
  });

  _findingsPanelResizeBound = true;
}

// ── Phone layout: pattern picker sheet ───────────────────────
// Keep this query identical to the mobile @media block in app.css.
var MOBILE_LAYOUT_QUERY = '(max-width: 700px), (max-height: 500px) and (pointer: coarse)';

function isMobileLayout() {
  return Boolean(window.matchMedia && window.matchMedia(MOBILE_LAYOUT_QUERY).matches);
}

function setPatternSheetOpen(open) {
  const layout = document.querySelector('.patterns-layout');
  const picker = document.getElementById('btn-pattern-picker');
  if (!layout) return;
  layout.classList.toggle('pattern-sheet-open', open);
  if (picker) picker.setAttribute('aria-expanded', String(open));
}

function initMobilePatternPicker() {
  const picker = document.getElementById('btn-pattern-picker');
  const closeBtn = document.getElementById('btn-close-pattern-sheet');
  const backdrop = document.getElementById('pattern-sheet-backdrop');
  const list = document.getElementById('pattern-tree');
  if (!picker || !list) return;

  picker.addEventListener('click', () => setPatternSheetOpen(true));
  if (closeBtn) closeBtn.addEventListener('click', () => setPatternSheetOpen(false));
  if (backdrop) backdrop.addEventListener('click', () => setPatternSheetOpen(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setPatternSheetOpen(false);
  });

  // Pattern rows are shared by the desktop sidebar and the phone sheet. Folder headers are handled in
  // pattern-folders.js.
  list.addEventListener('click', e => {
    const item = e.target.closest('.pattern-list-item');
    if (!item) return;
    const id = item.dataset.patternId;
    if (!id) return;

    if (e.target.closest('.pattern-list-item-more')) {
      e.stopPropagation(); // the document-level click handler would immediately hide the menu again
      const rect = e.target.closest('.pattern-list-item-more').getBoundingClientRect();
      showPatternListContextMenu(rect.right, rect.bottom, id);
      return;
    }

    if (_voiceModeEnabled) unlockVoiceOutput(); // picking a pattern starts its timer (and first announcement)
    loadPattern(id);
    setPatternSheetOpen(false); // no-op on desktop, where the sidebar is not a sheet
  });
  list.addEventListener('contextmenu', handlePatternListContextMenu);

  // Crossing the phone/desktop breakpoint (rotation, window resize) should not strand the sheet open
  // or leave the findings drawer in the wrong default state.
  const mq = window.matchMedia ? window.matchMedia(MOBILE_LAYOUT_QUERY) : null;
  if (mq) {
    const onChange = () => {
      setPatternSheetOpen(false);
      if (mq.matches) {
        applyPatternFindingsPanelState(true, false);
      } else {
        applyPatternFindingsPanelState(localStorage.getItem('patternFindingsPanelCollapsed') === '1', false);
        if (isTimedFullscreenOpen()) exitTimedFullscreen();
      }
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
  }
}

function updatePatternListSelection() {
  const list = document.getElementById('pattern-tree');
  if (list) {
    Array.prototype.forEach.call(list.querySelectorAll('.pattern-list-item'), item => {
      const selected = item.dataset.patternId === selectedPatternId;
      item.classList.toggle('is-selected', selected);
      if (selected) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
  }

  const nameEl = document.getElementById('pattern-picker-name');
  if (nameEl) {
    const pattern = selectedPatternId ? allPatterns.find(p => p.id === selectedPatternId) : null;
    nameEl.textContent = pattern && pattern.name ? pattern.name : 'Choose a pattern';
  }
}

// ── Filter & Render list ─────────────────────────────────────
// options.keepSelected: the open pattern stays in the list even when it no longer passes the filters. Used
// when a folder edit (not the reader's own filter change) is what took it out. This is also registered as a
// bare 'input' listener, so anything that isn't exactly { keepSelected: true } means "no options".
function applyFilters(options) {
  const q = document.getElementById('pattern-filter').value.trim().toLowerCase();
  const keepId = options && options.keepSelected === true ? selectedPatternId : null;

  filteredPatterns = allPatterns.filter(p => {
    if (p.id === keepId) return true;
    const matchMod = activeModality === 'All' || (p.modality || '').includes(activeModality);
    const matchQ   = !q || p.name.toLowerCase().includes(q);
    return matchMod && matchQ && patternMatchesFolderFilter(p.id);
  });

  renderPatternList();
}

function renderPatternList() {
  const prevId = selectedPatternId;
  const stepToRestore = _preferredStepIndex !== null ? _preferredStepIndex : currentStepIndex;
  _preferredStepIndex = null;

  renderPatternTree();

  // Restore selection if still present, otherwise auto-load the first pattern in the list.
  if (prevId && filteredPatterns.find(p => p.id === prevId)) {
    loadPattern(prevId, stepToRestore);
  } else if (filteredPatterns.length) {
    loadPattern(filteredPatterns[0].id);
  } else {
    selectedPatternId = null;
    clearStepView();
    updateSidebarButtons(false);
  }
  updatePatternListSelection();
}

// ── Load pattern ─────────────────────────────────────────────
function loadPattern(id, preferredStepIndex) {
  const pattern = allPatterns.find(p => p.id === id);
  if (!pattern) return;

  const wasSamePattern = selectedPatternId === id;
  selectedPatternId = id;
  updatePatternListSelection();
  const steps = pattern.steps || [];
  if (typeof preferredStepIndex === 'number' && steps.length) {
    currentStepIndex = Math.max(0, Math.min(preferredStepIndex, steps.length - 1));
    if (wasSamePattern) {
      const preservedOpenIndices = new Set();
      _openStepIndices.forEach(function(index) {
        if (Number.isInteger(index) && index >= 0 && index < steps.length) {
          preservedOpenIndices.add(index);
        }
      });
      _openStepIndices = preservedOpenIndices;
    } else {
      _openStepIndices = new Set([currentStepIndex]);
    }
  } else {
    currentStepIndex = 0;
    _openStepIndices = _patternViewerEditMode
      ? (steps.length ? new Set([currentStepIndex]) : new Set())
      : (steps.length ? new Set([0]) : new Set());
  }
  updateSidebarButtons(true);

  if (!wasSamePattern) {
    // Reset timer only when switching to a different pattern.
    stopTimer();
    timerSeconds = 0;
    _timerActiveStepKey = '';
    _timerActivePatternId = '';
    _timerActiveStepIndex = -1;
    _autoAdvancePaused = false;
    startTimer(pattern);
  } else {
    // Keep elapsed time when reloading the same pattern after background updates.
    timerGoalSeconds = getCurrentStepGoalSeconds(pattern, _timerMode);
    syncTimerControlsFromState();

    document.getElementById('timer-pattern-name').textContent = (pattern && pattern.name) ? pattern.name : '';
    if (timerRunning) {
      const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
      if (timerBar) timerBar.style.display = '';
    }
    updateTimerDisplay();
    updateTimerActionButtons();
  }

  renderCurrentStep(pattern);
  loadStepTimingsForPattern(pattern);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('pattern-selection-changed', {
      detail: { patternId: id }
    }));
  }
  const viewer = document.getElementById('step-viewer');
  const filterInput = document.getElementById('pattern-filter');
  if (viewer && document.activeElement !== filterInput) {
    viewer.focus({ preventScroll: true });
  }
}

function openPatternAtStepFromSearch(patternId, stepIndex) {
  if (!patternId) return;

  const filterInput = document.getElementById('pattern-filter');
  if (filterInput) filterInput.value = '';

  activeModality = 'All';
  document.querySelectorAll('.mod-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mod === 'All');
  });

  setActiveFolderFilter(FOLDER_FILTER_ALL); // the pattern may be outside the folder being viewed
  applyFilters();
  loadPattern(patternId, typeof stepIndex === 'number' ? stepIndex : 0);
  scrollSelectedPatternIntoView();
}

function getSelectedPattern() {
  return allPatterns.find(p => p.id === selectedPatternId) || null;
}

// ── Step rendering ───────────────────────────────────────────
function renderCurrentStep(pattern) {
  const steps = pattern.steps || [];

  const emptyEl   = document.getElementById('step-empty');
  const headerEl  = document.getElementById('step-header');
  const contentEl = document.getElementById('step-content');

  if (!steps.length) {
    updatePatternStepAddButton();
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    contentEl.style.display = 'none';
    emptyEl.innerHTML = '';
    const emptyMsg = document.createElement('p');
    emptyMsg.textContent = 'This pattern has no steps yet.';
    emptyEl.appendChild(emptyMsg);
    renderCurrentStepFindings(pattern, null, -1, 0);

    if (_patternViewerEditMode) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-accent btn-sm';
      addBtn.textContent = '+ Add Step';
      addBtn.addEventListener('click', handleAddPatternStep);
      emptyEl.appendChild(addBtn);
    }
    handleActiveStepChanged(pattern, -1, null, { silentVoice: true });
    return;
  }

  updatePatternStepAddButton();
  emptyEl.style.display = 'none';
  headerEl.style.display = '';
  contentEl.style.display = '';
  contentEl.classList.toggle('step-content-edit-mode', Boolean(_patternViewerEditMode));

  document.getElementById('step-counter').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  renderTotalGoalDisplay(pattern);
  const currentStep = steps[currentStepIndex] || steps[0] || null;
  handleActiveStepChanged(pattern, currentStepIndex, currentStep);
  document.getElementById('step-title').textContent = (currentStep && getCleanStepTitle(currentStep.stepTitle))
    ? getCleanStepTitle(currentStep.stepTitle)
    : 'Untitled Step';
  updateExpandAllButton(steps.length);

  contentEl.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'step-list';

  function clearDragOverState() {
    Array.from(list.querySelectorAll('.step-item')).forEach(function(item) {
      item.classList.remove('drag-over-before');
      item.classList.remove('drag-over-after');
      item.classList.remove('is-dragging');
    });
    list.classList.remove('list-drag-over-end');
  }

  function clearFindingDropTargetState() {
    Array.from(list.querySelectorAll('.step-item')).forEach(function(item) {
      item.classList.remove('finding-drop-target');
    });
  }

  steps.forEach((rawStep, idx) => {
    const step = resolveLinkedStep(rawStep);
    if (!step) return;

    const item = document.createElement('section');
    item.className = 'step-item';
    if (step.isRedStep) item.classList.add('step-item-red');
    if (isStepYellowMarked(pattern.id, idx)) item.classList.add('step-item-yellow');
    item.dataset.stepIndex = String(idx);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'step-item-toggle';

    const isOpen = _openStepIndices.has(idx);
    toggle.setAttribute('aria-expanded', String(isOpen));

    const label = document.createElement('span');
    label.className = 'step-item-label';

    const number = document.createElement('span');
    number.className = 'step-item-number';
    number.textContent = `Step ${idx + 1}`;

    const title = document.createElement('span');
    title.className = 'step-item-title';
    title.textContent = getCleanStepTitle(step.stepTitle) || `Untitled Step ${idx + 1}`;

    label.appendChild(number);
    label.appendChild(title);

    const chevron = document.createElement('span');
    chevron.className = 'step-item-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = isOpen ? '▾' : '▸';

    const header = document.createElement('div');
    header.className = 'step-item-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'step-drag-handle';
    dragHandle.setAttribute('aria-hidden', 'true');
    dragHandle.title = steps.length > 1 ? 'Drag to reorder' : 'Add more steps to reorder';
    dragHandle.textContent = '☰';
    dragHandle.draggable = _patternViewerEditMode && steps.length > 1;
    if (!_patternViewerEditMode) dragHandle.style.display = 'none';

    toggle.appendChild(label);
    toggle.appendChild(chevron);

    header.appendChild(dragHandle);
    header.appendChild(toggle);

    // Goal time is only editable in Edit Pattern mode now (inline-during-walkthrough editing was
    // clunky) — it stages into the pattern-edit draft exactly like step titles/findings do, and
    // only actually saves when the user clicks "Done Editing".
    if (_patternViewerEditMode) {
      const goalControl = document.createElement('div');
      goalControl.className = 'step-item-goal-control';
      goalControl.dataset.stepIndex = String(idx);

      const goalLabel = document.createElement('label');
      goalLabel.className = 'step-goal-label';
      goalLabel.setAttribute('for', 'step-item-goal-' + idx);
      goalLabel.textContent = 'Goal';

      const goalInput = document.createElement('input');
      goalInput.type = 'number';
      goalInput.min = '1';
      goalInput.step = '1';
      goalInput.id = 'step-item-goal-' + idx;
      goalInput.className = 'step-goal-input';
      goalInput.placeholder = 'sec';
      goalInput.value = String(getEffectiveStepGoalSeconds(step));

      const goalUnitSelect = document.createElement('select');
      goalUnitSelect.className = 'step-goal-unit-select';
      goalUnitSelect.setAttribute('aria-label', 'Goal time unit');
      goalUnitSelect.innerHTML = '<option value="sec">sec</option><option value="min">min</option>';
      goalUnitSelect.value = 'sec';
      goalUnitSelect.dataset.prevUnit = 'sec';

      goalControl.appendChild(goalLabel);
      goalControl.appendChild(goalInput);
      goalControl.appendChild(goalUnitSelect);

      goalUnitSelect.addEventListener('change', () => {
        const newUnit = goalUnitSelect.value === 'min' ? 'min' : 'sec';
        const prevUnit = goalUnitSelect.dataset.prevUnit || 'sec';
        const current = Number(goalInput.value);
        if (Number.isFinite(current) && current > 0 && newUnit !== prevUnit) {
          goalInput.value = newUnit === 'min'
            ? String(Math.round((current / 60) * 10) / 10)
            : String(Math.round(current * 60));
        }
        goalInput.step = newUnit === 'min' ? '0.1' : '1';
        goalInput.placeholder = newUnit;
        goalUnitSelect.dataset.prevUnit = newUnit;
      });

      goalInput.addEventListener('input', () => {
        if (!isValidGoalInputValue(goalInput.value)) return; // don't stage garbage mid-keystroke
        applyPatternViewerStepGoalDraft(idx, goalInput.value, goalUnitSelect.value);
      });
      goalInput.addEventListener('blur', () => {
        if (!isValidGoalInputValue(goalInput.value)) {
          showToast('Step goal must be a positive number.', true);
          const currentPattern = getSelectedPattern();
          const currentSteps = currentPattern && Array.isArray(currentPattern.steps) ? currentPattern.steps : [];
          const prevGoal = currentSteps[idx] ? getEffectiveStepGoalSeconds(currentSteps[idx]) : STEP_GOAL_DEFAULT_SECONDS;
          goalInput.value = formatGoalSecondsForUnit(prevGoal, goalUnitSelect.value);
          return;
        }
        applyPatternViewerStepGoalDraft(idx, goalInput.value, goalUnitSelect.value);
      });
      goalInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          goalInput.blur();
        }
      });

      header.appendChild(goalControl);
    } else if (_timerMode === 'timed') {
      // Read-only outside edit mode — editing only happens in Edit Pattern mode, but the goal
      // time should still be visible while actually walking through the pattern in Timed mode.
      const goalDisplay = document.createElement('span');
      goalDisplay.className = 'step-item-goal-display';
      goalDisplay.textContent = 'Goal ' + formatTimerClock(getEffectiveStepGoalSeconds(step));
      header.appendChild(goalDisplay);
    }

    const panel = document.createElement('div');
    panel.className = 'step-item-panel';
    if (!isOpen) panel.style.display = 'none';

    const panelInner = document.createElement('div');
    panelInner.className = 'step-item-panel-inner';
    renderStepSections(panelInner, step, idx);
    panel.appendChild(panelInner);

    toggle.addEventListener('click', () => {
      const nextOpen = !_openStepIndices.has(idx);
      if (nextOpen) {
        if (_accordionMode) {
          _openStepIndices = new Set([idx]);
        } else {
          _openStepIndices.add(idx);
        }
      } else {
        _openStepIndices.delete(idx);
      }
      currentStepIndex = idx;
      renderCurrentStep(pattern);
    });

    dragHandle.addEventListener('dragstart', e => {
      if (!_patternViewerEditMode) {
        e.preventDefault();
        return;
      }
      if (steps.length < 2) {
        e.preventDefault();
        return;
      }
      _draggingPatternStepIndex = idx;
      item.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      }
    });

    dragHandle.addEventListener('dragend', () => {
      _draggingPatternStepIndex = null;
      clearDragOverState();
    });

    item.addEventListener('dragover', e => {
      if (!_patternViewerEditMode) return;
      if (_draggingPatternFinding) {
        if (idx === _draggingPatternFinding.fromStepIndex) {
          item.classList.remove('finding-drop-target');
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        item.classList.add('finding-drop-target');
        return;
      }
      if (_draggingPatternStepIndex === null || _draggingPatternStepIndex === idx) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      list.classList.remove('list-drag-over-end');

      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) < (rect.height / 2);
      item.classList.toggle('drag-over-before', before);
      item.classList.toggle('drag-over-after', !before);
    });

    item.addEventListener('dragleave', e => {
      if (item.contains(e.relatedTarget)) return;
      item.classList.remove('finding-drop-target');
      item.classList.remove('drag-over-before');
      item.classList.remove('drag-over-after');
    });

    item.addEventListener('drop', e => {
      if (!_patternViewerEditMode) return;
      if (_draggingPatternFinding) {
        e.preventDefault();
        item.classList.remove('finding-drop-target');
        clearDragOverState();
        clearFindingDropTargetState();

        const dragging = _draggingPatternFinding;
        _draggingPatternFinding = null;

        if (idx === dragging.fromStepIndex) return;
        movePatternFindingBetweenSteps(dragging.fromStepIndex, idx, dragging.findingId, dragging.findingTitle || 'Finding');
        return;
      }
      if (_draggingPatternStepIndex === null) return;
      e.preventDefault();

      const rect = item.getBoundingClientRect();
      const before = (e.clientY - rect.top) < (rect.height / 2);
      let targetIdx = before ? idx : (idx + 1);
      if (_draggingPatternStepIndex < targetIdx) targetIdx -= 1;

      clearDragOverState();
      reorderPatternSteps(pattern, _draggingPatternStepIndex, targetIdx);
    });

    item.appendChild(header);
    item.appendChild(panel);
    list.appendChild(item);
  });

  list.addEventListener('dragover', e => {
    if (!_patternViewerEditMode) return;
    if (_draggingPatternFinding) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      return;
    }
    if (_draggingPatternStepIndex === null || e.target !== list) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    list.classList.add('list-drag-over-end');
  });

  list.addEventListener('dragleave', e => {
    if (list.contains(e.relatedTarget)) return;
    list.classList.remove('list-drag-over-end');
  });

  list.addEventListener('drop', e => {
    if (!_patternViewerEditMode) return;
    if (_draggingPatternFinding) {
      e.preventDefault();
      clearFindingDropTargetState();
      _draggingPatternFinding = null;
      return;
    }
    if (_draggingPatternStepIndex === null || e.target !== list) return;
    e.preventDefault();
    clearDragOverState();
    reorderPatternSteps(pattern, _draggingPatternStepIndex, steps.length - 1);
  });

  contentEl.appendChild(list);
  renderCurrentStepFindings(pattern, currentStep, currentStepIndex, steps.length);

  const activeItem = list.querySelector(`[data-step-index="${currentStepIndex}"]`);
  if (activeItem && _openStepIndices.has(currentStepIndex)) {
    requestAnimationFrame(() => {
      const viewer = document.getElementById('step-viewer');
      const header = document.getElementById('step-header');
      if (!viewer) {
        activeItem.scrollIntoView({ block: 'start' });
        return;
      }

      const viewerRect = viewer.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      const headerHeight = header && header.style.display !== 'none' ? header.offsetHeight : 0;
      const targetTop = viewer.scrollTop + (itemRect.top - viewerRect.top) - headerHeight - 8;
      viewer.scrollTo({ top: Math.max(0, targetTop) });
    });
  }

  syncInlineToolbarOffset();
}

function renderCurrentStepFindings(pattern, step, stepIndex, stepsLength) {
  const contentEl = document.getElementById('pattern-findings-content');
  if (!contentEl) return;

  const safePattern = pattern || null;
  const safeStep = step || null;
  const displayStepIndex = Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : -1;

  contentEl.innerHTML = '';
  contentEl.classList.toggle('step-content-edit-mode', Boolean(_patternViewerEditMode));

  if (!safeStep) {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = safePattern ? 'Select a step to view findings.' : 'Select a pattern to see findings.';
    contentEl.appendChild(empty);
    updateFindingsExpandAllButton([], -1);
    return;
  }

  const sections = normaliseStepSectionsSafe(safeStep.sections, safeStep.richContent || []);
  const findings = sections.dontMissPathology || [];
  updateFindingsExpandAllButton(findings, displayStepIndex);

  if (findings.length) {
    renderNestedSubsections(contentEl, findings, displayStepIndex, Number.isInteger(stepsLength) ? stepsLength : 0);
  } else {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = 'No findings yet.';
    contentEl.appendChild(empty);
  }

  if (_patternViewerEditMode) {
    const actions = document.createElement('div');
    actions.className = 'pattern-findings-actions';

    const addFindingBtn = document.createElement('button');
    addFindingBtn.type = 'button';
    addFindingBtn.className = 'btn btn-ghost btn-sm';
    addFindingBtn.textContent = 'Add Finding';
    addFindingBtn.addEventListener('click', function() {
      if (typeof openCreateFindingModal === 'function') {
        openCreateFindingModal({
          patternId: safePattern && safePattern.id ? safePattern.id : selectedPatternId,
          stepIndex: displayStepIndex >= 0 ? displayStepIndex : currentStepIndex
        });
      } else {
        showToast('Finding creation is unavailable right now.', true);
      }
    });

    actions.appendChild(addFindingBtn);
    contentEl.appendChild(actions);
  }
}

function moveStepIndexOrder(length, fromIndex, toIndex) {
  const order = Array.from({ length: length }, function(_, index) {
    return index;
  });
  if (fromIndex < 0 || fromIndex >= order.length || toIndex < 0 || toIndex >= order.length) {
    return order;
  }
  const moved = order.splice(fromIndex, 1)[0];
  order.splice(toIndex, 0, moved);
  return order;
}

function remapOpenStepIndices(order, openIndices) {
  const nextOpenIndices = new Set();
  order.forEach(function(previousIndex, nextIndex) {
    if (openIndices.has(previousIndex)) {
      nextOpenIndices.add(nextIndex);
    }
  });
  return nextOpenIndices;
}

async function reorderPatternSteps(pattern, fromIndex, toIndex) {
  const steps = Array.isArray(pattern && pattern.steps) ? pattern.steps : [];
  if (!_patternViewerEditMode || !pattern || !_pUid || steps.length < 2) return;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= steps.length || toIndex >= steps.length) {
    _draggingPatternStepIndex = null;
    return;
  }

  const previousSteps = steps.slice();
  const previousOpenIndices = new Set(_openStepIndices);
  const previousCurrentStepIndex = currentStepIndex;
  const order = moveStepIndexOrder(steps.length, fromIndex, toIndex);
  const nextSteps = order.map(function(previousIndex) {
    return previousSteps[previousIndex];
  });
  const movedStepNextIndex = order.indexOf(fromIndex);
  const nextCurrentStepIndex = order.indexOf(previousCurrentStepIndex);

  pattern.steps = nextSteps;
  _openStepIndices = new Set();
  currentStepIndex = nextCurrentStepIndex >= 0 ? nextCurrentStepIndex : 0;
  rememberStepForPattern(pattern.id, currentStepIndex);
  _draggingPatternStepIndex = null;
  renderCurrentStep(pattern);

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    showToast('Step order saved.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    _openStepIndices = previousOpenIndices;
    currentStepIndex = previousCurrentStepIndex;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to save step order.', true);
  }
}

async function movePatternFindingBetweenSteps(fromStepIndex, toStepIndex, findingId, findingTitle) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const sourceIndex = Number(fromStepIndex);
  const targetIndex = Number(toStepIndex);
  const safeFindingId = String(findingId || '').trim();
  if (!pattern || !_pUid || !_patternViewerEditMode || !safeFindingId) return;
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) return;
  if (sourceIndex < 0 || sourceIndex >= steps.length || targetIndex < 0 || targetIndex >= steps.length) return;
  if (sourceIndex === targetIndex) return;

  const previousSteps = JSON.parse(JSON.stringify(steps));
  const previousStepIndex = currentStepIndex;
  const previousOpen = new Set(_openStepIndices);

  const nextSteps = JSON.parse(JSON.stringify(steps));
  const sourceStep = nextSteps[sourceIndex] || {};
  const targetStep = nextSteps[targetIndex] || {};

  sourceStep.sections = normaliseStepSectionsSafe(sourceStep.sections, sourceStep.richContent || sourceStep.rich_content || []);
  targetStep.sections = normaliseStepSectionsSafe(targetStep.sections, targetStep.richContent || targetStep.rich_content || []);

  const sourceFindings = typeof ensureSubsectionMetadata === 'function'
    ? ensureSubsectionMetadata(sourceStep.sections.dontMissPathology || [])
    : normaliseRichContent(sourceStep.sections.dontMissPathology || []);
  const targetFindings = typeof ensureSubsectionMetadata === 'function'
    ? ensureSubsectionMetadata(targetStep.sections.dontMissPathology || [])
    : normaliseRichContent(targetStep.sections.dontMissPathology || []);

  const findingIndex = sourceFindings.findIndex(function(item) {
    return item
      && item.type === 'subsection'
      && String(item.subsectionId || '').trim() === safeFindingId;
  });

  if (findingIndex < 0) {
    showToast('Finding could not be found.', true);
    return;
  }

  const movedFinding = sourceFindings.splice(findingIndex, 1)[0];
  targetFindings.push(movedFinding);

  sourceStep.sections.dontMissPathology = sourceFindings;
  targetStep.sections.dontMissPathology = targetFindings;
  sourceStep.richContent = normaliseRichContent(sourceStep.sections.searchPattern || []);
  targetStep.richContent = normaliseRichContent(targetStep.sections.searchPattern || []);

  nextSteps[sourceIndex] = sourceStep;
  nextSteps[targetIndex] = targetStep;

  pattern.steps = nextSteps;
  currentStepIndex = targetIndex;
  _openStepIndices = new Set([targetIndex]);
  rememberStepForPattern(pattern.id, currentStepIndex);
  setFindingPanelOpen(safeFindingId, false, sourceIndex);
  setFindingPanelOpen(safeFindingId, true, targetIndex);
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Finding moved locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternReloadFromFirestore(pattern.id, targetIndex, nextSteps.length, 0);
    showToast('Finding moved.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    currentStepIndex = previousStepIndex;
    _openStepIndices = previousOpen;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to move finding.', true);
  }
}

function resolveLinkedStep(step) {
  if (!step) return step;
  return resolveSectionLinksForViewer(normaliseStepForViewer(step));
}

function normaliseSectionLinkForViewer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    mode: raw.mode === 'snapshot' ? 'snapshot' : 'internal',
    sourcePatternId: String(raw.sourcePatternId || '').trim(),
    sourcePatternName: String(raw.sourcePatternName || '').trim(),
    sourceStepId: String(raw.sourceStepId || '').trim(),
    sourceStepTitle: String(raw.sourceStepTitle || '').trim(),
    sourceSubsectionId: String(raw.sourceSubsectionId || '').trim(),
    sourceSubsectionTitle: String(raw.sourceSubsectionTitle || '').trim(),
    targetType: String(raw.targetType || '').trim(),
    tokenVersion: Number(raw.tokenVersion || 1)
  };
}

function normaliseSectionLinksForViewer(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.searchPattern) {
    const link = normaliseSectionLinkForViewer(raw.searchPattern);
    if (link && link.sourceStepId) out.searchPattern = link;
  }
  return out;
}

function findSubsectionByIdForViewer(step, subsectionId) {
  if (!step || !subsectionId) return null;
  const sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);
  const findings = normaliseRichContent(sections.dontMissPathology || []);
  for (const item of findings) {
    if (!item || item.type !== 'subsection') continue;
    if (String(item.subsectionId || '').trim() === String(subsectionId).trim()) return item;
  }
  return null;
}

function hasRenderableRichContent(content) {
  return normaliseRichContent(content || []).some(function(chunk) {
    if (!chunk) return false;
    if (chunk.type === 'image') return Boolean(chunk.data);
    if (chunk.type === 'link') {
      return Boolean(String(chunk.url || '').trim() || String(chunk.text || '').trim());
    }
    if (chunk.type === 'subsection') {
      return Boolean(String(chunk.title || '').trim()) || hasRenderableRichContent(chunk.content || []);
    }
    return Boolean(String(chunk.text || '').trim());
  });
}

function resolveSectionLinksForViewer(step) {
  const resolved = normaliseStepForViewer(step);
  resolved.sectionLinks = {};
  resolved.linkMeta = null;
  resolved.linkedStepId = '';
  resolved.sections.dontMissPathology = normaliseRichContent(resolved.sections.dontMissPathology || []).map(function(item) {
    if (!item || item.type !== 'subsection') return item;
    return Object.assign({}, item, { linkMeta: null });
  });

  return resolved;
}

function getStepLinkKeyForViewer(step) {
  if (!step) return '';
  const linked = String(step.linkedStepId || '').trim();
  if (linked) return linked;
  return String(step.stepId || '').trim();
}

function findLinkedStepData(linkedStepId) {
  const target = String(linkedStepId || '').trim();
  if (!target) return null;

  for (const pattern of allPatterns) {
    const steps = pattern.steps || [];
    for (const step of steps) {
      if (String((step && step.stepId) || '').trim() === target) {
        return {
          stepTitle: step.stepTitle || '',
          isRedStep: Boolean(step.isRedStep || step.is_red_step || step.stepColorRed),
          richContent: normaliseRichContent(step.richContent || step.rich_content || []),
          sections: normaliseStepSectionsSafe(step.sections, step.richContent || step.rich_content || [])
        };
      }
    }
  }

  // Legacy fallback for previously saved manual link keys.
  for (const pattern of allPatterns) {
    const steps = pattern.steps || [];
    for (const step of steps) {
      if (getStepLinkKeyForViewer(step) === target) {
        return {
          stepTitle: step.stepTitle || '',
          isRedStep: Boolean(step.isRedStep || step.is_red_step || step.stepColorRed),
          richContent: normaliseRichContent(step.richContent || step.rich_content || []),
          sections: normaliseStepSectionsSafe(step.sections, step.richContent || step.rich_content || [])
        };
      }
    }
  }
  return null;
}

function normaliseStepSectionsSafe(sections, fallbackRichContent) {
  if (typeof normaliseStepSections === 'function') {
    return normaliseStepSections(sections, normaliseRichContent(fallbackRichContent || []));
  }

  const fallback = normaliseRichContent(fallbackRichContent || []);
  const out = {
    dontMissPathology: [],
    searchPattern: []
  };

  STEP_SECTION_ORDER.forEach(key => {
    const raw = sections && Array.isArray(sections[key]) ? sections[key] : [];
    out[key] = normaliseRichContent(raw);
  });

  if (!out.searchPattern.length && fallback.length) {
    out.searchPattern = fallback;
  }

  // Migrate old section format to subsections within dontMissPathology
  if (sections) {
    const legacySections = [];
    const measurementContent = normaliseRichContent((sections.measurements) || []);
    const hyperlinkContent = normaliseRichContent((sections.hyperlinks) || []);
    const imageContent = normaliseRichContent((sections.images) || []);

    if (measurementContent && measurementContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Findings Section ' + (legacySections.length + 1),
        content: measurementContent
      });
    }
    if (hyperlinkContent && hyperlinkContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Findings Section ' + (legacySections.length + 1),
        content: hyperlinkContent
      });
    }
    if (imageContent && imageContent.length) {
      legacySections.push({
        type: 'subsection',
        title: 'Findings Section ' + (legacySections.length + 1),
        content: imageContent
      });
    }

    if (legacySections.length && out.dontMissPathology && out.dontMissPathology.length) {
      out.dontMissPathology = out.dontMissPathology.concat(legacySections);
    } else if (legacySections.length) {
      out.dontMissPathology = legacySections;
    }
  }

  return out;
}

function normaliseStepForViewer(step) {
  const fallback = normaliseRichContent((step && (step.richContent || step.rich_content)) || []);
  return {
    stepTitle: getCleanStepTitle(step && step.stepTitle),
    isRedStep: Boolean(step && (step.isRedStep || step.is_red_step || step.stepColorRed)),
    richContent: fallback,
    stepId: (step && step.stepId) || '',
    linkedStepId: (step && step.linkedStepId) || '',
    linkMeta: (step && step.linkMeta) || null,
    sectionLinks: normaliseSectionLinksForViewer(step && step.sectionLinks),
    sections: normaliseStepSectionsSafe(step && step.sections, fallback),
    goalSeconds: normaliseGoalSeconds(step && step.goalSeconds)
  };
}

function renderStepSections(container, step, stepIndex) {
  const sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);

  if (_patternViewerEditMode) {
    const titleEditWrap = document.createElement('div');
    titleEditWrap.className = 'step-title-edit-row';
    titleEditWrap.dataset.stepIndex = String(stepIndex);

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-input step-title-edit-input';
    titleInput.value = getCleanStepTitle(step.stepTitle);
    titleInput.placeholder = 'Step title';
    titleInput.dataset.stepIndex = String(stepIndex);
    titleInput.addEventListener('input', function() {
      applyPatternViewerStepTitleDraft(stepIndex, titleInput.value);
    });

    const deleteStepBtn = document.createElement('button');
    deleteStepBtn.type = 'button';
    deleteStepBtn.className = 'btn btn-danger btn-sm';
    deleteStepBtn.textContent = 'Delete Step';
    deleteStepBtn.addEventListener('click', function() {
      handleDeletePatternStep(stepIndex);
    });

    titleEditWrap.appendChild(titleInput);
    titleEditWrap.appendChild(deleteStepBtn);
    container.appendChild(titleEditWrap);
  }

  const searchPatternWrap = document.createElement('div');
  searchPatternWrap.className = 'step-search-pattern-content';
  renderSearchPatternContent(searchPatternWrap, sections.searchPattern || [], Boolean(step.isRedStep), stepIndex);
  container.appendChild(searchPatternWrap);
}

function areRichContentValuesEqual(left, right) {
  return JSON.stringify(normaliseRichContent(left || [])) === JSON.stringify(normaliseRichContent(right || []));
}

function stripFindingRedTextColor(content) {
  function walk(items) {
    return normaliseRichContent(items || []).map(function(chunk) {
      if (!chunk) return chunk;

      if (chunk.type === 'subsection') {
        return Object.assign({}, chunk, {
          content: walk(chunk.content || [])
        });
      }

      if (chunk.type === 'list') {
        return Object.assign({}, chunk, {
          items: (chunk.items || []).map(function(item) {
            var listContent = Array.isArray(item) ? item : (item && item.content) || [];
            return walk(listContent);
          })
        });
      }

      if (chunk.type === 'text' && String(chunk.color || '').toLowerCase() === 'red') {
        return Object.assign({}, chunk, { color: null });
      }

      return chunk;
    });
  }

  return walk(content || []);
}

function applyPatternViewerStepTitleDraft(stepIndex, nextTitleRaw) {
  if (!_patternViewerEditMode) return false;
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  if (!pattern || !steps[safeStepIndex]) return false;

  const nextTitle = getCleanStepTitle(nextTitleRaw);
  if (!nextTitle) return false;

  const currentTitle = String((steps[safeStepIndex] && steps[safeStepIndex].stepTitle) || '').trim();
  if (currentTitle === nextTitle) return false;

  steps[safeStepIndex].stepTitle = nextTitle;
  markPatternEditDraftDirty(pattern);
  return true;
}

function applyPatternViewerInlineDraft(options) {
  if (!_patternViewerEditMode) return false;
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(options && options.stepIndex) ? options.stepIndex : currentStepIndex;
  const sectionKey = String((options && options.sectionKey) || '').trim();
  if (!pattern || !steps[safeStepIndex] || !sectionKey) return false;

  const step = steps[safeStepIndex];
  step.sections = normaliseStepSectionsSafe(step.sections, step.richContent || step.rich_content || []);
  const forceApply = Boolean(options && options.force);

  let changed = false;
  const nextRichContent = normaliseRichContent((options && options.content) || []);
  const nextIsMarkedRed = Boolean(options && options.isMarkedRed);

  function detachWholeStepLink() {
    if (String(step.linkedStepId || '').trim()) {
      step.linkedStepId = '';
      changed = true;
    }
    if (step.linkMeta) {
      step.linkMeta = null;
      changed = true;
    }
  }

  if (sectionKey === 'searchPattern') {
    detachWholeStepLink();
    if (step.sectionLinks && step.sectionLinks.searchPattern) {
      delete step.sectionLinks.searchPattern;
      changed = true;
    }

    const currentSearchPattern = normaliseRichContent(step.sections.searchPattern || []);
    if (forceApply || !areRichContentValuesEqual(currentSearchPattern, nextRichContent)) {
      step.sections.searchPattern = nextRichContent;
      step.richContent = normaliseRichContent(nextRichContent);
      changed = true;
    }

    if (forceApply || Boolean(step.isRedStep) !== nextIsMarkedRed) {
      step.isRedStep = nextIsMarkedRed;
      changed = true;
    }
  } else if (sectionKey === 'dontMissPathology') {
    const safeFindingId = String((options && options.findingId) || '').trim();
    if (!safeFindingId) return false;

    detachWholeStepLink();
    const findings = typeof ensureSubsectionMetadata === 'function'
      ? ensureSubsectionMetadata(step.sections.dontMissPathology || [])
      : normaliseRichContent(step.sections.dontMissPathology || []);
    step.sections.dontMissPathology = findings;

    const finding = typeof findStepSubsectionById === 'function'
      ? findStepSubsectionById(step, safeFindingId)
      : null;
    if (!finding) return false;

    const nextTitle = String((options && options.title) || '').trim();
    if (nextTitle && (forceApply || String(finding.title || '').trim() !== nextTitle)) {
      finding.title = nextTitle;
      changed = true;
    }

    if (forceApply || Boolean(finding.isRedFinding) !== nextIsMarkedRed) {
      finding.isRedFinding = nextIsMarkedRed;
      changed = true;
    }

    var safeFindingContent = nextIsMarkedRed ? stripFindingRedTextColor(nextRichContent) : nextRichContent;
    if (forceApply || !areRichContentValuesEqual(finding.content || [], safeFindingContent)) {
      finding.content = safeFindingContent;
      changed = true;
    }

    if (finding.linkMeta) {
      finding.linkMeta = null;
      changed = true;
    }
  }

  if (changed) {
    markPatternEditDraftDirty(pattern);
  }
  return changed;
}

async function savePatternStepTitle(stepIndex, nextTitleRaw) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  if (!pattern || !_pUid || !steps[safeStepIndex]) return;

  const nextTitle = getCleanStepTitle(nextTitleRaw);
  if (!nextTitle) {
    showToast('Step title is required.', true);
    return;
  }

  const currentTitle = String((steps[safeStepIndex] && steps[safeStepIndex].stepTitle) || '').trim();
  if (currentTitle === nextTitle) {
    return;
  }
  if (_stepTitleSaveInFlight[String(safeStepIndex)]) {
    return;
  }

  _stepTitleSaveInFlight[String(safeStepIndex)] = true;

  const nextSteps = JSON.parse(JSON.stringify(steps));
  nextSteps[safeStepIndex].stepTitle = nextTitle;
  pattern.steps = nextSteps;
  if (safeStepIndex === currentStepIndex) {
    document.getElementById('step-title').textContent = nextTitle;
  }
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    _stepTitleSaveInFlight[String(safeStepIndex)] = false;
    showToast('Step title saved locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    if (_patternViewerEditMode) {
      _openStepIndices.add(safeStepIndex);
      currentStepIndex = safeStepIndex;
    }
    renderCurrentStep(pattern);
    queuePatternStepReloadFromFirestore(pattern.id, safeStepIndex, nextSteps[safeStepIndex], 0);
    showToast('Step title updated.');
  } catch (err) {
    console.error(err);
    const rollbackSteps = JSON.parse(JSON.stringify(nextSteps));
    rollbackSteps[safeStepIndex].stepTitle = currentTitle;
    pattern.steps = rollbackSteps;
    if (safeStepIndex === currentStepIndex) {
      document.getElementById('step-title').textContent = currentTitle;
    }
    renderCurrentStep(pattern);
    showToast('Failed to update step title.', true);
  } finally {
    _stepTitleSaveInFlight[String(safeStepIndex)] = false;
  }
}

function loadStepSectionsOpenState() {
  const raw = localStorage.getItem(STEP_SECTIONS_STATE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    STEP_SECTION_ORDER.forEach(key => {
      if (typeof parsed[key] === 'boolean') {
        _stepSectionsOpenState[key] = parsed[key];
      }
    });
  } catch (err) {
    console.warn('Failed to load step section state:', err);
  }
}

function persistStepSectionsOpenState() {
  localStorage.setItem(STEP_SECTIONS_STATE_KEY, JSON.stringify(_stepSectionsOpenState));
}

function setStepSectionOpenState(key, isOpen) {
  if (!Object.prototype.hasOwnProperty.call(_stepSectionsOpenState, key)) return;
  _stepSectionsOpenState[key] = Boolean(isOpen);
  persistStepSectionsOpenState();
}

function isStepSectionOpen(key) {
  return Boolean(_stepSectionsOpenState[key]);
}

function rememberStepForPattern(patternId, stepIndex) {
  if (!patternId || patternId !== selectedPatternId) return;
  _preferredStepIndex = typeof stepIndex === 'number' ? stepIndex : null;
}

function ensurePatternEditDraft(pattern) {
  var safePattern = pattern || getSelectedPattern();
  if (!safePattern) return null;
  var safePatternId = String(safePattern.id || '').trim();
  if (!safePatternId) return null;
  if (_patternEditDraft && _patternEditDraft.patternId === safePatternId) {
    return _patternEditDraft;
  }
  _patternEditDraft = {
    patternId: safePatternId,
    dirty: false
  };
  return _patternEditDraft;
}

function markPatternEditDraftDirty(pattern) {
  var draft = ensurePatternEditDraft(pattern);
  if (!draft) return;
  draft.dirty = true;
}

function clearPatternEditDraft() {
  _patternEditDraft = null;
}

function hasDirtyPatternEditDraft(patternId) {
  var safePatternId = String(patternId || '').trim();
  if (!_patternEditDraft || !_patternEditDraft.dirty) return false;
  if (!safePatternId) return true;
  return _patternEditDraft.patternId === safePatternId;
}

function isFirestorePermissionDeniedError(err) {
  if (!err) return false;
  if (String(err.code || '') === 'permission-denied') return true;
  var msg = String(err.message || err || '').toLowerCase();
  return msg.indexOf('insufficient privileges') >= 0 || msg.indexOf('permission denied') >= 0;
}

function withSyncTimeout(promise, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      reject(new Error('sync-timeout'));
    }, Math.max(1000, Number(timeoutMs) || PATTERN_SYNC_TIMEOUT_MS));

    Promise.resolve(promise).then(function(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function commitPatternEditDraftIfNeeded() {
  var pattern = getSelectedPattern();
  if (!pattern || !_pUid) return Promise.resolve();
  if (_patternEditCommitInFlight) return Promise.resolve();

  var patternId = String(pattern.id || '').trim();
  if (!patternId || !hasDirtyPatternEditDraft(patternId)) {
    return Promise.resolve();
  }

  _patternEditCommitInFlight = true;
  updateSidebarButtons(Boolean(selectedPatternId));

  var syncPromise = compressEmbeddedImagesForStorage(pattern.steps || [], _pUid).then(function(stepsForWrite) {
    return updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: stepsForWrite
    }).then(function() {
      pattern.steps = stepsForWrite;
    });
  });

  return withSyncTimeout(syncPromise, PATTERN_SYNC_TIMEOUT_MS).then(function() {
    if (_patternEditDraft && _patternEditDraft.patternId === patternId) {
      _patternEditDraft.dirty = false;
    }
    showToast('Saved edits to Firebase.');
  }).catch(function(err) {
    console.error(err);
    if (String(err && err.code || '') === 'resource-exhausted') {
      var waitMs = Number(err && err.retryAfterMs);
      var waitText = Number.isFinite(waitMs) && waitMs > 0 ? (' Retry in ' + Math.ceil(waitMs / 1000) + 's.') : '';
      showToast('Saved locally, but Firebase write queue is overloaded.' + waitText, true);
      return;
    }
    if (isFirestorePermissionDeniedError(err)) {
      showToast('Saved locally, but Firebase denied sync. Confirm Firestore permissions and signed-in account.', true);
      return;
    }
    if (String(err && err.message || '') === 'sync-timeout') {
      showToast('Saved locally. Firebase sync is taking too long (offline/network issue). Click Done Editing to retry.', true);
      return;
    }
    showToast('Saved locally, but failed to sync to Firebase. Click Done Editing again to retry.', true);
  }).finally(function() {
    _patternEditCommitInFlight = false;
    updateSidebarButtons(Boolean(selectedPatternId));
  });
}

function getStepSyncSignature(step) {
  try {
    return JSON.stringify(normaliseStepForViewer(step || {}));
  } catch (err) {
    console.warn('Failed to build step sync signature:', err);
    return '';
  }
}

function collectFindingIdsFromStepsForSync(steps) {
  var seen = {};
  var ids = [];

  (steps || []).forEach(function(step) {
    var sections = normaliseStepSectionsSafe(step && step.sections, step && (step.richContent || step.rich_content) || []);
    var findings = sections && Array.isArray(sections.dontMissPathology) ? sections.dontMissPathology : [];

    findings.forEach(function(item) {
      if (!item || item.type !== 'subsection') return;
      var findingId = String(item.findingId || '').trim();
      if (!findingId || seen[findingId]) return;
      seen[findingId] = 1;
      ids.push(findingId);
    });
  });

  return ids;
}

function loadFindingsMapForSync(uid, findingIds) {
  var safeUid = String(uid || '').trim();
  var uniqueIds = (findingIds || []).filter(function(id, index, list) {
    return id && list.indexOf(id) === index;
  });

  if (!safeUid || !uniqueIds.length) return Promise.resolve({});

  function parseFindingContentForSync(raw) {
    if (Array.isArray(raw)) return normaliseRichContent(raw);
    if (typeof raw === 'string') {
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? normaliseRichContent(parsed) : [];
      } catch (err) {
        return [];
      }
    }
    if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
      return normaliseRichContent(raw.content);
    }
    return [];
  }

  var refs = uniqueIds.map(function(id) {
    return _findingsRef(safeUid).doc(id);
  });

  function toMap(entries) {
    var out = {};
    (entries || []).forEach(function(entry) {
      if (!entry || !entry.exists || !entry.id || !entry.data) return;
      out[entry.id] = {
        id: entry.id,
        name: String((entry.data && entry.data.name) || '').trim(),
        isRedFinding: Boolean(entry.data && entry.data.isRedFinding),
        content: parseFindingContentForSync(entry.data && entry.data.content)
      };
    });
    return out;
  }

  if (typeof appDb.getAll === 'function') {
    return appDb.getAll.apply(appDb, refs).then(function() {
      var snapshots = Array.prototype.slice.call(arguments);
      return snapshots.map(function(doc, index) {
        return {
          id: uniqueIds[index],
          exists: Boolean(doc && doc.exists),
          data: doc && doc.exists ? (doc.data() || {}) : null
        };
      });
    }).then(toMap);
  }

  return Promise.all(refs.map(function(ref, index) {
    return ref.get({ source: 'server' }).then(function(doc) {
      return {
        id: uniqueIds[index],
        exists: Boolean(doc && doc.exists),
        data: doc && doc.exists ? (doc.data() || {}) : null
      };
    });
  })).then(toMap);
}

function hydrateServerStepsWithFindings(steps, findingsById) {
  return (steps || []).map(function(step) {
    var nextStep = Object.assign({}, step);
    var sections = normaliseStepSectionsSafe(step && step.sections, step && (step.richContent || step.rich_content) || []);
    var findings = Array.isArray(sections.dontMissPathology) ? sections.dontMissPathology : [];

    sections.dontMissPathology = findings.map(function(item) {
      if (!item || item.type !== 'subsection') return item;
      var findingId = String(item.findingId || '').trim();
      var finding = findingId ? findingsById[findingId] : null;
      if (!finding) return item;
      return Object.assign({}, item, {
        title: finding.name || item.title,
        isRedFinding: Boolean(finding.isRedFinding),
        content: normaliseRichContent(finding.content || [])
      });
    });

    nextStep.sections = sections;
    nextStep.richContent = normaliseRichContent((sections && sections.searchPattern) || nextStep.richContent || nextStep.rich_content || []);
    return nextStep;
  });
}

function loadHydratedPatternStepsFromServer(patternId) {
  var safePatternId = String(patternId || '').trim();
  if (!safePatternId || !_pUid || !appDb) return Promise.resolve(null);

  return _patternsRef(_pUid).doc(safePatternId).get({ source: 'server' }).then(function(snapshot) {
    if (!snapshot || !snapshot.exists) return null;

    var serverPattern = _normalisePatternDoc(snapshot.data() || {});
    var serverSteps = Array.isArray(serverPattern.steps) ? serverPattern.steps : [];
    var findingIds = collectFindingIdsFromStepsForSync(serverSteps);

    if (!findingIds.length) return serverSteps;

    return loadFindingsMapForSync(_pUid, findingIds).then(function(findingsById) {
      return hydrateServerStepsWithFindings(serverSteps, findingsById || {});
    });
  });
}

function queuePatternStepReloadFromFirestore(patternId, stepIndex, expectedStep, attempt) {
  var safePatternId = String(patternId || '').trim();
  var safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : -1;
  if (!safePatternId || safeStepIndex < 0 || !_pUid || !appDb) return;

  var maxAttempts = 8;
  var tryIndex = Number.isInteger(attempt) ? attempt : 0;
  var expectedSignature = getStepSyncSignature(expectedStep);

  loadHydratedPatternStepsFromServer(safePatternId).then(function(serverSteps) {
    serverSteps = Array.isArray(serverSteps) ? serverSteps : [];
    if (!serverSteps[safeStepIndex]) return;

    var serverSignature = getStepSyncSignature(serverSteps[safeStepIndex]);
    if (expectedSignature && serverSignature !== expectedSignature) {
      if (tryIndex >= maxAttempts - 1) return;
      setTimeout(function() {
        queuePatternStepReloadFromFirestore(safePatternId, safeStepIndex, expectedStep, tryIndex + 1);
      }, Math.min(250 * (tryIndex + 1), 1500));
      return;
    }

    var selected = getSelectedPattern();
    if (!selected || String(selected.id || '') !== safePatternId) return;

    selected.steps = serverSteps;
    if (_patternViewerEditMode) {
      _openStepIndices.add(safeStepIndex);
    }
    renderCurrentStep(selected);
  }).catch(function(err) {
    if (tryIndex >= maxAttempts - 1) {
      console.warn('Unable to reload step from Firestore server:', err);
      return;
    }
    setTimeout(function() {
      queuePatternStepReloadFromFirestore(safePatternId, safeStepIndex, expectedStep, tryIndex + 1);
    }, Math.min(250 * (tryIndex + 1), 1500));
  });
}

function queuePatternReloadFromFirestore(patternId, preferredStepIndex, expectedStepsLength, attempt) {
  var safePatternId = String(patternId || '').trim();
  if (!safePatternId || !_pUid || !appDb) return;

  var maxAttempts = 8;
  var tryIndex = Number.isInteger(attempt) ? attempt : 0;
  var expectedLength = Number.isInteger(expectedStepsLength) ? expectedStepsLength : null;

  loadHydratedPatternStepsFromServer(safePatternId).then(function(serverSteps) {
    serverSteps = Array.isArray(serverSteps) ? serverSteps : [];
    if (expectedLength !== null && serverSteps.length !== expectedLength) {
      if (tryIndex >= maxAttempts - 1) return;
      setTimeout(function() {
        queuePatternReloadFromFirestore(safePatternId, preferredStepIndex, expectedLength, tryIndex + 1);
      }, Math.min(250 * (tryIndex + 1), 1500));
      return;
    }

    var selected = getSelectedPattern();
    if (!selected || String(selected.id || '') !== safePatternId) return;

    selected.steps = serverSteps;

    if (serverSteps.length) {
      if (Number.isInteger(preferredStepIndex)) {
        currentStepIndex = Math.max(0, Math.min(preferredStepIndex, serverSteps.length - 1));
      } else {
        currentStepIndex = Math.max(0, Math.min(currentStepIndex, serverSteps.length - 1));
      }
      if (_patternViewerEditMode) {
        _openStepIndices.add(currentStepIndex);
      }
    } else {
      currentStepIndex = 0;
      _openStepIndices = new Set();
    }

    renderCurrentStep(selected);
  }).catch(function(err) {
    if (tryIndex >= maxAttempts - 1) {
      console.warn('Unable to reload pattern from Firestore server:', err);
      return;
    }
    setTimeout(function() {
      queuePatternReloadFromFirestore(safePatternId, preferredStepIndex, expectedLength, tryIndex + 1);
    }, Math.min(250 * (tryIndex + 1), 1500));
  });
}

function normaliseSubsectionEntries(content) {
  const chunks = normaliseRichContent(content);
  const entries = [];

  chunks.forEach((chunk, idx) => {
    if (chunk.type === 'subsection') {
      entries.push({
        title: (chunk.title || '').trim() || `Subsection ${entries.length + 1}`,
        isRedFinding: Boolean(chunk.isRedFinding),
        subsectionId: String(chunk.subsectionId || '').trim(),
        linkMeta: normaliseSectionLinkForViewer(chunk.linkMeta || null),
        content: normaliseRichContent(chunk.content || [])
      });
      return;
    }
    if (chunk.type === 'text' && (chunk.text || '').trim()) {
      entries.push({
        title: `Subsection ${entries.length + 1}`,
        isRedFinding: false,
        subsectionId: '',
        linkMeta: null,
        content: [{ type: 'text', text: chunk.text, bold: Boolean(chunk.bold), color: chunk.color || null }]
      });
      return;
    }
    if (chunk.type === 'image' || chunk.type === 'link') {
      entries.push({
        title: `Subsection ${entries.length + 1}`,
        isRedFinding: false,
        subsectionId: '',
        linkMeta: null,
        content: [chunk]
      });
      return;
    }
    if (idx === chunks.length - 1 && !entries.length) {
      entries.push({
        title: 'Subsection 1',
        isRedFinding: false,
        subsectionId: '',
        linkMeta: null,
        content: []
      });
    }
  });

  return sortSubsectionEntries(entries);
}

function sortSubsectionEntries(entries) {
  return entries.slice().sort((left, right) => {
    const leftTitle = String((left && left.title) || '').trim();
    const rightTitle = String((right && right.title) || '').trim();

    if (!leftTitle && !rightTitle) return 0;
    if (!leftTitle) return 1;
    if (!rightTitle) return -1;

    return leftTitle.localeCompare(rightTitle, undefined, {
      sensitivity: 'base',
      numeric: true
    });
  });
}

function getInlineEditKey(sectionKey, findingId) {
  return `${sectionKey || ''}::${String(findingId || '').trim()}`;
}

function isInlineEditActive(sectionKey, findingId) {
  if (!_activeInlineEdit) return false;
  if (_activeInlineEdit.stepIndex !== currentStepIndex) return false;
  return _activeInlineEdit.key === getInlineEditKey(sectionKey, findingId);
}

function getFindingPanelKey(findingId, stepIndexOverride) {
  var safeFindingId = String(findingId || '').trim();
  if (!safeFindingId) return '';
  var safePatternId = String(selectedPatternId || '').trim();
  var safeStepIndex = typeof stepIndexOverride === 'number' ? stepIndexOverride : currentStepIndex;
  if (!safePatternId || safeStepIndex < 0) return '';
  return [safePatternId, safeStepIndex, safeFindingId].join('::');
}

function setFindingPanelOpen(findingId, isOpen, stepIndexOverride) {
  var key = getFindingPanelKey(findingId, stepIndexOverride);
  if (!key) return;
  if (isOpen) {
    _openFindingPanels.add(key);
  } else {
    _openFindingPanels.delete(key);
  }
}

function isFindingPanelOpen(findingId, stepIndexOverride) {
  var key = getFindingPanelKey(findingId, stepIndexOverride);
  return key ? _openFindingPanels.has(key) : false;
}

function startInlineEdit(sectionKey, findingId, title, content, isMarkedRed) {
  if (sectionKey === 'dontMissPathology') {
    setFindingPanelOpen(findingId, true);
  }
  _activeInlineEdit = {
    key: getInlineEditKey(sectionKey, findingId),
    stepIndex: currentStepIndex,
    sectionKey: sectionKey,
    findingId: String(findingId || '').trim(),
    title: String(title || ''),
    content: normaliseRichContent(content || []),
    isMarkedRed: Boolean(isMarkedRed)
  };
  _inlineEditSaving = false;

  const pattern = getSelectedPattern();
  if (pattern) renderCurrentStep(pattern);
}

function cancelInlineEdit() {
  _activeInlineEdit = null;
  _inlineEditSaving = false;

  const pattern = getSelectedPattern();
  if (pattern) renderCurrentStep(pattern);
}

async function saveInlineEdit(sectionKey, findingId, nextTitle, nextContent, nextIsMarkedRed) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!pattern || !_pUid || !steps[currentStepIndex]) return;

  if (sectionKey === 'dontMissPathology' && !String(nextTitle || '').trim()) {
    showToast('Finding title is required.', true);
    return;
  }

  _inlineEditSaving = true;
  renderCurrentStep(pattern);

  const nextSteps = JSON.parse(JSON.stringify(steps));
  const nextStep = nextSteps[currentStepIndex] || {};
  nextStep.sections = normaliseStepSectionsSafe(nextStep.sections, nextStep.richContent || nextStep.rich_content || []);
  let detachedLiveLink = false;

  function detachWholeStepLink() {
    if (String(nextStep.linkedStepId || '').trim()) {
      nextStep.linkedStepId = '';
      detachedLiveLink = true;
    }
    if (nextStep.linkMeta) {
      nextStep.linkMeta = null;
      detachedLiveLink = true;
    }
  }

  const nextRichContent = Array.isArray(nextContent)
    ? normaliseRichContent(nextContent)
    : (typeof plainTextToRichContent === 'function'
        ? plainTextToRichContent(nextContent)
        : [{ type: 'text', text: String(nextContent || ''), bold: false, color: null }]);

  if (sectionKey === 'searchPattern') {
    detachWholeStepLink();
    if (nextStep.sectionLinks && nextStep.sectionLinks.searchPattern) {
      delete nextStep.sectionLinks.searchPattern;
      detachedLiveLink = true;
    }
    nextStep.sections.searchPattern = nextRichContent;
    nextStep.richContent = normaliseRichContent(nextStep.sections.searchPattern || []);
    nextStep.isRedStep = Boolean(nextIsMarkedRed);
  } else {
    detachWholeStepLink();
    const findings = typeof ensureSubsectionMetadata === 'function'
      ? ensureSubsectionMetadata(nextStep.sections.dontMissPathology || [])
      : normaliseRichContent(nextStep.sections.dontMissPathology || []);
    nextStep.sections.dontMissPathology = findings;

    const finding = typeof findStepSubsectionById === 'function'
      ? findStepSubsectionById(nextStep, findingId)
      : null;
    if (!finding) {
      _inlineEditSaving = false;
      renderCurrentStep(pattern);
      showToast('Finding could not be found.', true);
      return;
    }

    finding.title = String(nextTitle || '').trim();
    finding.isRedFinding = Boolean(nextIsMarkedRed);
    finding.content = nextIsMarkedRed ? stripFindingRedTextColor(nextRichContent) : nextRichContent;
    if (finding.linkMeta) {
      finding.linkMeta = null;
      detachedLiveLink = true;
    }
  }

  nextSteps[currentStepIndex] = nextStep;

  if (_patternViewerEditMode) {
    pattern.steps = nextSteps;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
    _openStepIndices.add(currentStepIndex);
    renderCurrentStep(pattern);
    markPatternEditDraftDirty(pattern);
    if (detachedLiveLink) {
      showToast((sectionKey === 'searchPattern' ? 'Search pattern' : 'Finding') + ' saved locally. Live link detached; sync runs on Done Editing.');
    } else {
      showToast((sectionKey === 'searchPattern' ? 'Search pattern' : 'Finding') + ' saved locally. Sync runs on Done Editing.');
    }
    return;
  }

  try {
    const stepsForWrite = await compressEmbeddedImagesForStorage(nextSteps, _pUid);
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: stepsForWrite
    });
    pattern.steps = stepsForWrite;
    if (sectionKey === 'dontMissPathology' && !_patternViewerEditMode) {
      setFindingPanelOpen(findingId, true);
    }
    if (_patternViewerEditMode) {
      _openStepIndices.add(currentStepIndex);
    }
    _activeInlineEdit = null;
    _inlineEditSaving = false;
    renderCurrentStep(pattern);
    queuePatternStepReloadFromFirestore(pattern.id, currentStepIndex, stepsForWrite[currentStepIndex], 0);
    if (detachedLiveLink) {
      showToast((sectionKey === 'searchPattern' ? 'Search pattern' : 'Finding') + ' updated. Live link detached so your edits persist.');
    } else {
      showToast(sectionKey === 'searchPattern' ? 'Search pattern updated.' : 'Finding updated.');
    }
  } catch (err) {
    console.error(err);
    _inlineEditSaving = false;
    renderCurrentStep(pattern);
    showToast('Failed to save changes.', true);
  }
}

function renderInlineEditForm(container, options) {
  const wrap = document.createElement('div');
  wrap.className = 'step-inline-edit';
  wrap.dataset.stepIndex = String(Number.isInteger(options && options.stepIndex) ? options.stepIndex : currentStepIndex);
  wrap.dataset.sectionKey = String((options && options.sectionKey) || '');
  wrap.dataset.findingId = String((options && options.findingId) || '');
  const supportsRichInlineEdit = typeof populateRichEditor === 'function'
    && typeof extractRichContent === 'function'
    && typeof bindRichEditorToolbar === 'function';

  let titleInput = null;
  if (options.includeTitle) {
    titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-input step-inline-edit-title';
    titleInput.value = options.title || '';
    titleInput.placeholder = 'Finding title';
    wrap.appendChild(titleInput);
  }

  let redCheckbox = null;
  if (options.redToggleLabel) {
    const redToggle = document.createElement('label');
    redToggle.className = options.includeTitle ? 'subsection-red-row' : 'step-red-checkbox-row';
    redCheckbox = document.createElement('input');
    redCheckbox.type = 'checkbox';
    redCheckbox.className = 'step-inline-red-toggle';
    redCheckbox.checked = Boolean(options.isMarkedRed);
    const redLabel = document.createElement('span');
    redLabel.textContent = options.redToggleLabel;
    redToggle.appendChild(redCheckbox);
    redToggle.appendChild(redLabel);
    wrap.appendChild(redToggle);
  }

  let textarea = null;
  let richEditor = null;

  if (supportsRichInlineEdit) {
    const toolbar = document.createElement('div');
    toolbar.className = 'rich-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', options.includeTitle ? 'Finding text formatting' : 'Search pattern text formatting');
    toolbar.innerHTML = [
      '<button type="button" class="rich-tool" data-rich-action="bold" title="Bold (Ctrl+B)"><b>B</b></button>',
      '<button type="button" class="rich-tool rich-tool-red" data-rich-color="red" title="Red text">A</button>',
      '<button type="button" class="rich-tool rich-tool-green" data-rich-color="green" title="Green text">A</button>',
      '<button type="button" class="rich-tool rich-tool-blue" data-rich-color="blue" title="Blue text">A</button>',
      '<button type="button" class="rich-tool rich-tool-white" data-rich-color="white" title="White text">A</button>',
      '<button type="button" class="rich-tool" data-rich-list="unordered" title="Bulleted list">• List</button>',
      '<button type="button" class="rich-tool" data-rich-list="ordered" title="Numbered list">1. List</button>',
      '<button type="button" class="rich-tool rich-tool-font-size" data-rich-font-size="sm" title="Small font">A-</button>',
      '<button type="button" class="rich-tool rich-tool-font-size" data-rich-font-size="md" title="Normal font">A</button>',
      '<button type="button" class="rich-tool rich-tool-font-size" data-rich-font-size="lg" title="Large font">A+</button>',
      '<button type="button" class="rich-tool" data-rich-action="link" title="Add hyperlink">&#128279; Link</button>',
      '<button type="button" class="rich-tool" data-rich-action="clear" title="Clear formatting">&#x2715; Format</button>',
      '<button type="button" class="rich-tool" data-rich-action="image" title="Paste image from clipboard">&#128247; Image</button>'
    ].join('');
    wrap.appendChild(toolbar);

    richEditor = document.createElement('div');
    richEditor.className = 'rich-editor step-inline-rich-editor';
    richEditor.contentEditable = 'true';
    richEditor.setAttribute('spellcheck', 'true');
    richEditor.setAttribute('aria-label', options.includeTitle ? 'Finding content editor' : 'Search pattern content editor');
    populateRichEditor(richEditor, options.content || []);
    bindRichEditorToolbar(toolbar, richEditor);
    bindInlineRichFontSizeControls(toolbar, richEditor);
    if (typeof attachRichEditorFocusHandlers === 'function') {
      attachRichEditorFocusHandlers(richEditor);
    }
    if (typeof handleRichEditorKeydown === 'function') {
      richEditor.addEventListener('keydown', handleRichEditorKeydown);
    }
    if (typeof handleEditorPaste === 'function') {
      richEditor.addEventListener('paste', handleEditorPaste);
    }
    wrap.appendChild(richEditor);
  } else {
    textarea = document.createElement('textarea');
    textarea.className = 'form-input step-inline-edit-content';
    textarea.rows = options.includeTitle ? 5 : 8;
    textarea.value = typeof richContentToPlainText === 'function'
      ? richContentToPlainText(options.content || [])
      : '';
    textarea.placeholder = options.includeTitle ? 'Finding content' : 'Search pattern content';
    wrap.appendChild(textarea);
  }

  let syncQueued = false;
  function queueLocalDraftSync() {
    if (!_patternViewerEditMode) return;
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(function() {
      syncQueued = false;
      const contentValue = richEditor && typeof extractRichContent === 'function'
        ? extractRichContent(richEditor)
        : (textarea ? textarea.value : '');
      applyPatternViewerInlineDraft({
        stepIndex: Number.isInteger(options && options.stepIndex) ? options.stepIndex : currentStepIndex,
        sectionKey: options.sectionKey,
        findingId: options.findingId,
        title: titleInput ? titleInput.value : '',
        content: contentValue,
        isMarkedRed: redCheckbox ? redCheckbox.checked : false
      });
    });
  }

  if (titleInput) {
    titleInput.addEventListener('input', queueLocalDraftSync);
  }
  if (redCheckbox) {
    redCheckbox.addEventListener('change', queueLocalDraftSync);
  }
  if (richEditor) {
    richEditor.addEventListener('input', queueLocalDraftSync);
  }
  if (textarea) {
    textarea.addEventListener('input', queueLocalDraftSync);
  }

  container.appendChild(wrap);

  if (richEditor) {
    if (typeof setActiveRichEditor === 'function') {
      setActiveRichEditor(richEditor);
    }
    richEditor.focus();
  } else if (textarea) {
    textarea.focus();
  }
}

function renderNestedSubsections(container, content, stepIndex, stepsLength) {
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  const canDragAcrossSteps = _patternViewerEditMode
    && Number.isInteger(stepsLength)
    && stepsLength > 1;
  const entries = normaliseSubsectionEntries(content).filter(entry => {
    return (entry.title || '').trim() || (entry.content || []).length;
  });
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'step-section-empty';
    empty.textContent = 'No subsections yet.';
    container.appendChild(empty);
    return;
  }

  entries.forEach((entry, idx) => {
    const wrap = document.createElement('section');
    wrap.className = 'step-subsection';
    if (entry.isRedFinding) wrap.classList.add('step-subsection-red');
    const isExpanded = isFindingPanelOpen(entry.subsectionId || '', safeStepIndex);
    const isEditing = _patternViewerEditMode && isExpanded;

    const header = document.createElement('div');
    header.className = 'step-subsection-header';

    if (_patternViewerEditMode && entry.subsectionId) {
      const dragHandle = document.createElement('span');
      dragHandle.className = 'finding-drag-handle';
      dragHandle.setAttribute('aria-hidden', 'true');
      dragHandle.textContent = '||';
      dragHandle.title = canDragAcrossSteps
        ? 'Drag to move into another step'
        : 'Add more steps to move findings';
      dragHandle.draggable = canDragAcrossSteps;
      if (!canDragAcrossSteps) {
        dragHandle.classList.add('is-disabled');
      }

      dragHandle.addEventListener('dragstart', function(e) {
        if (!canDragAcrossSteps) {
          e.preventDefault();
          return;
        }

        _draggingPatternFinding = {
          fromStepIndex: safeStepIndex,
          findingId: String(entry.subsectionId || '').trim(),
          findingTitle: String(entry.title || '').trim()
        };
        wrap.classList.add('is-dragging-finding');

        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', _draggingPatternFinding.findingId);
        }
      });

      dragHandle.addEventListener('dragend', function() {
        _draggingPatternFinding = null;
        wrap.classList.remove('is-dragging-finding');
        Array.from(document.querySelectorAll('.step-item.finding-drop-target')).forEach(function(item) {
          item.classList.remove('finding-drop-target');
        });
      });

      header.appendChild(dragHandle);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'step-subsection-toggle';
    btn.setAttribute('aria-expanded', String(isExpanded));
    btn.innerHTML = `
      <span>${entry.title || `Subsection ${idx + 1}`}</span>
      <span class="step-subsection-chevron" aria-hidden="true">${isExpanded ? '▾' : '▸'}</span>
    `;

    const panel = document.createElement('div');
    panel.className = 'step-subsection-panel';
    panel.style.display = isExpanded ? '' : 'none';

    const panelInner = document.createElement('div');
    panelInner.className = 'step-subsection-content';
    const displayContent = entry.isRedFinding
      ? stripFindingRedTextColor(entry.content || [])
      : (entry.content || []);
    if (isEditing) {
      renderInlineEditForm(panelInner, {
        stepIndex: safeStepIndex,
        sectionKey: 'dontMissPathology',
        findingId: entry.subsectionId || '',
        includeTitle: true,
        title: entry.title || '',
        content: displayContent,
        isMarkedRed: Boolean(entry.isRedFinding),
        redToggleLabel: 'Show this finding in red in main display'
      });
    } else if (displayContent.length) {
      renderRichContent(panelInner, displayContent);
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      panelInner.appendChild(empty);
    }

    if (_patternViewerEditMode && entry.subsectionId) {
      const actions = document.createElement('div');
      actions.className = 'step-subsection-danger-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger btn-sm';
      deleteBtn.textContent = 'Remove from This Step';
      deleteBtn.title = 'Remove this finding from the current search pattern step';
      deleteBtn.addEventListener('click', function() {
        handleDeletePatternFinding(safeStepIndex, entry.subsectionId, entry.title || 'Finding');
      });

      actions.appendChild(deleteBtn);
      panelInner.appendChild(actions);
    }

    panel.appendChild(panelInner);

    btn.addEventListener('click', () => {
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      const nextOpen = !isOpen;
      setFindingPanelOpen(entry.subsectionId || '', nextOpen, safeStepIndex);
      btn.setAttribute('aria-expanded', String(nextOpen));
      panel.style.display = nextOpen ? '' : 'none';
      const chevron = btn.querySelector('.step-subsection-chevron');
      if (chevron) chevron.textContent = nextOpen ? '▾' : '▸';
      updateFindingsExpandAllButton(content, safeStepIndex);

      if (_patternViewerEditMode && nextOpen) {
        // Re-render so the opened finding switches into direct edit mode.
        const pattern = getSelectedPattern();
        if (pattern) renderCurrentStep(pattern);
      }
    });

    header.appendChild(btn);
    wrap.appendChild(header);
    wrap.appendChild(panel);
    container.appendChild(wrap);
  });
}

async function handleDeletePatternFinding(stepIndex, findingId, findingTitle) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  const safeFindingId = String(findingId || '').trim();
  if (!pattern || !_pUid || !_patternViewerEditMode || !steps[safeStepIndex] || !safeFindingId) return;

  if (_activeInlineEdit) {
    const discardOk = await showConfirm(
      'Discard Unsaved Edits?',
      'Removing a finding now will discard the current inline edits. Continue?'
    );
    if (!discardOk) return;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }

  const title = String(findingTitle || '').trim() || 'this finding';
  const confirmed = await showConfirm(
    'Remove Finding from Step?',
    'Remove "' + title + '" from this search pattern step? This does not delete it from the Findings tab.'
  );
  if (!confirmed) return;

  const previousSteps = JSON.parse(JSON.stringify(steps));
  const previousInlineEdit = _activeInlineEdit;
  const previousInlineEditSaving = _inlineEditSaving;
  const previousPanelOpen = isFindingPanelOpen(safeFindingId, safeStepIndex);

  const nextSteps = JSON.parse(JSON.stringify(steps));
  const nextStep = nextSteps[safeStepIndex] || {};
  nextStep.sections = normaliseStepSectionsSafe(nextStep.sections, nextStep.richContent || nextStep.rich_content || []);

  const findings = typeof ensureSubsectionMetadata === 'function'
    ? ensureSubsectionMetadata(nextStep.sections.dontMissPathology || [])
    : normaliseRichContent(nextStep.sections.dontMissPathology || []);

  const findingIndex = findings.findIndex(function(item) {
    return item
      && item.type === 'subsection'
      && String(item.subsectionId || '').trim() === safeFindingId;
  });

  if (findingIndex < 0) {
    showToast('Finding could not be found.', true);
    return;
  }

  findings.splice(findingIndex, 1);
  nextStep.sections.dontMissPathology = findings;
  nextStep.richContent = normaliseRichContent(nextStep.sections.searchPattern || []);
  nextSteps[safeStepIndex] = nextStep;

  pattern.steps = nextSteps;
  setFindingPanelOpen(safeFindingId, false, safeStepIndex);
  _activeInlineEdit = null;
  _inlineEditSaving = false;
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Finding removed locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternStepReloadFromFirestore(pattern.id, safeStepIndex, nextSteps[safeStepIndex], 0);
    showToast('Finding removed from this step.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    _activeInlineEdit = previousInlineEdit;
    _inlineEditSaving = previousInlineEditSaving;
    setFindingPanelOpen(safeFindingId, previousPanelOpen, safeStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to delete finding.', true);
  }
}

function renderRichContent(container, richContent) {
  const chunks = normaliseRichContent(richContent);
  if (!chunks.length) return;

  if (typeof populateRichEditor === 'function') {
    container.innerHTML = '';
    const viewer = document.createElement('div');
    viewer.className = 'rich-editor rich-editor-readonly';
    viewer.contentEditable = 'false';
    viewer.setAttribute('aria-readonly', 'true');

    populateRichEditor(viewer, chunks);

    Array.from(viewer.querySelectorAll('a')).forEach(anchor => {
      anchor.classList.add('step-link');
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    });

    Array.from(viewer.querySelectorAll('img')).forEach(img => {
      img.alt = 'Step image';
      img.addEventListener('click', () => openLightbox(img.src));
    });

    container.appendChild(viewer);
    return;
  }

  container.textContent = richContentToPlainText(chunks);
}

function renderSearchPatternContent(container, richContent, isRedStep, stepIndex) {
  if (!_patternViewerEditMode) {
    const chunks = normaliseRichContent(richContent);
    if (chunks.length) {
      renderRichContent(container, chunks);
    } else {
      const empty = document.createElement('p');
      empty.className = 'step-section-empty';
      empty.textContent = 'No content yet.';
      container.appendChild(empty);
    }
    return;
  }

  const layout = document.createElement('div');
  layout.className = 'step-section-inline-layout';

  const body = document.createElement('div');
  body.className = 'step-section-inline-body';

  renderInlineEditForm(body, {
    stepIndex: Number.isInteger(stepIndex) ? stepIndex : currentStepIndex,
    sectionKey: 'searchPattern',
    findingId: '',
    includeTitle: false,
    title: '',
    content: richContent || [],
    isMarkedRed: Boolean(isRedStep),
    redToggleLabel: 'Change color of this step to red in main search pattern display'
  });

  layout.appendChild(body);
  container.appendChild(layout);
}

function clearStepView() {
  document.getElementById('step-empty').style.display = '';
  document.getElementById('step-empty').querySelector('p').textContent = 'Select a pattern to begin.';
  document.getElementById('step-header').style.display = 'none';
  document.getElementById('step-content').style.display = 'none';
  _openStepIndices = new Set();
  updateExpandAllButton(0);
  setPatternViewerEditMode(false, false);
  renderCurrentStepFindings(null, null, -1, 0);
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = 'none';
  stopTimer();
  timerGoalSeconds = null;
  _timerActiveStepKey = '';
  _timerActivePatternId = '';
  _timerActiveStepIndex = -1;
  syncTimerControlsFromState();
}

function updatePatternStepAddButton() {
  const btn = document.getElementById('btn-add-pattern-step');
  if (!btn) return;
  const hasPattern = Boolean(getSelectedPattern());
  const visible = _patternViewerEditMode && hasPattern;
  btn.style.display = visible ? '' : 'none';
  btn.disabled = !visible;
}

function makePatternViewerStepId() {
  if (typeof makeStepId === 'function') {
    return makeStepId();
  }
  if (window.crypto && window.crypto.randomUUID) {
    return 'step_' + window.crypto.randomUUID().replace(/-/g, '');
  }
  return 'step_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function buildNewViewerStep() {
  const emptyRich = [{ type: 'text', text: '', bold: false, color: null }];
  return {
    stepTitle: '',
    isRedStep: false,
    stepId: makePatternViewerStepId(),
    linkedStepId: '',
    linkMeta: null,
    sectionLinks: {},
    richContent: emptyRich,
    sections: normaliseStepSectionsSafe(null, emptyRich)
  };
}

async function handleAddPatternStep() {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!pattern || !_pUid || !_patternViewerEditMode) return;

  if (_activeInlineEdit) {
    const discardOk = await showConfirm(
      'Discard Unsaved Edits?',
      'Adding a step now will discard the current inline edits. Continue?'
    );
    if (!discardOk) return;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }

  const previousSteps = steps.slice();
  const previousOpen = new Set(_openStepIndices);
  const previousStepIndex = currentStepIndex;
  const nextSteps = steps.concat([buildNewViewerStep()]);
  const nextStepIndex = nextSteps.length - 1;

  pattern.steps = nextSteps;
  currentStepIndex = nextStepIndex;
  _openStepIndices = new Set([nextStepIndex]);
  rememberStepForPattern(pattern.id, currentStepIndex);
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Step added locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternStepReloadFromFirestore(pattern.id, nextStepIndex, nextSteps[nextStepIndex], 0);
    showToast('Step added.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    currentStepIndex = previousStepIndex;
    _openStepIndices = previousOpen;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to add step.', true);
  }
}

async function handleDeletePatternStep(stepIndex) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : currentStepIndex;
  if (!pattern || !_pUid || !_patternViewerEditMode || !steps[safeStepIndex]) return;

  if (_activeInlineEdit) {
    const discardOk = await showConfirm(
      'Discard Unsaved Edits?',
      'Deleting a step now will discard the current inline edits. Continue?'
    );
    if (!discardOk) return;
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }

  const stepTitle = getCleanStepTitle((steps[safeStepIndex] && steps[safeStepIndex].stepTitle) || '');
  const confirmTitle = steps.length === 1 ? 'Delete Only Step?' : 'Delete Step?';
  const confirmMessage = steps.length === 1
    ? 'Delete "' + (stepTitle || 'Untitled Step') + '"? This will leave the pattern with no steps.'
    : 'Delete "' + (stepTitle || 'Untitled Step') + '"? This cannot be undone.';

  const confirmed = await showConfirm(confirmTitle, confirmMessage);
  if (!confirmed) return;

  const previousSteps = steps.slice();
  const previousOpen = new Set(_openStepIndices);
  const previousStepIndex = currentStepIndex;
  const previousInlineEdit = _activeInlineEdit;
  const previousInlineEditSaving = _inlineEditSaving;

  const nextSteps = steps.filter(function(_, idx) {
    return idx !== safeStepIndex;
  });

  let nextStepIndex = currentStepIndex;
  if (!nextSteps.length) {
    nextStepIndex = 0;
  } else if (safeStepIndex < currentStepIndex) {
    nextStepIndex = Math.max(0, currentStepIndex - 1);
  } else if (safeStepIndex === currentStepIndex) {
    nextStepIndex = Math.min(safeStepIndex, nextSteps.length - 1);
  }

  const nextOpen = new Set();
  previousOpen.forEach(function(idx) {
    if (idx === safeStepIndex) return;
    nextOpen.add(idx > safeStepIndex ? idx - 1 : idx);
  });

  pattern.steps = nextSteps;
  currentStepIndex = nextStepIndex;
  _openStepIndices = nextOpen;
  rememberStepForPattern(pattern.id, currentStepIndex);
  renderCurrentStep(pattern);

  if (_patternViewerEditMode) {
    markPatternEditDraftDirty(pattern);
    showToast('Step deleted locally. Changes sync when you click Done Editing.');
    return;
  }

  try {
    await updatePattern(_pUid, pattern.id, {
      name: pattern.name,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: nextSteps
    });
    queuePatternReloadFromFirestore(pattern.id, nextStepIndex, nextSteps.length, 0);
    showToast('Step deleted.');
  } catch (err) {
    console.error(err);
    pattern.steps = previousSteps;
    currentStepIndex = previousStepIndex;
    _openStepIndices = previousOpen;
    _activeInlineEdit = previousInlineEdit;
    _inlineEditSaving = previousInlineEditSaving;
    rememberStepForPattern(pattern.id, currentStepIndex);
    renderCurrentStep(pattern);
    showToast('Failed to delete step.', true);
  }
}

function navigateStep(delta, options) {
  const pattern = getSelectedPattern();
  if (!pattern) return;
  const steps = pattern.steps || [];
  if (!steps.length) return;

  var next = currentStepIndex + delta;
  var wrap = Boolean(options && options.wrap);

  if (next < 0 || next >= steps.length) {
    if (!wrap) return;
    if (next < 0) {
      next = steps.length - 1;
    } else {
      next = 0;
    }
  }

  currentStepIndex = next;
  _openStepIndices = new Set([next]);
  renderCurrentStep(pattern);
  focusCurrentStepToggle(next);
}

function initPatternViewControls() {
  const expandAllBtn = document.getElementById('btn-steps-expand-all');
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      const pattern = getSelectedPattern();
      if (!pattern || _accordionMode) return;
      const steps = pattern.steps || [];
      if (!steps.length) return;

      const allOpen = steps.every((_, idx) => _openStepIndices.has(idx));
      if (allOpen) {
        _openStepIndices = new Set();
      } else {
        const next = new Set();
        steps.forEach((_, idx) => next.add(idx));
        _openStepIndices = next;
      }

      renderCurrentStep(pattern);
    });
  }

  const accordionCheckbox = document.getElementById('setting-step-accordion-mode');
  if (accordionCheckbox) {
    accordionCheckbox.checked = _accordionMode;
    accordionCheckbox.addEventListener('change', () => {
      applyAccordionModeState(accordionCheckbox.checked, true);
    });
  }
}

function loadAccordionModeState() {
  _accordionMode = localStorage.getItem(ACCORDION_MODE_STATE_KEY) === '1';
}

function applyAccordionModeState(enabled, persist) {
  _accordionMode = Boolean(enabled);
  if (persist) {
    localStorage.setItem(ACCORDION_MODE_STATE_KEY, _accordionMode ? '1' : '0');
  }

  const accordionCheckbox = document.getElementById('setting-step-accordion-mode');
  if (accordionCheckbox) {
    accordionCheckbox.checked = _accordionMode;
  }

  const pattern = getSelectedPattern();
  if (!_accordionMode || !pattern) {
    updateExpandAllButton(pattern && pattern.steps ? pattern.steps.length : 0);
    return;
  }

  if (_openStepIndices.size > 1) {
    const preferred = _openStepIndices.has(currentStepIndex)
      ? currentStepIndex
      : (_openStepIndices.values().next().value || 0);
    _openStepIndices = new Set([preferred]);
  }

  renderCurrentStep(pattern);
}

function updateExpandAllButton(stepCount) {
  const btn = document.getElementById('btn-steps-expand-all');
  if (!btn) return;

  if (!stepCount) {
    btn.textContent = 'Expand All';
    btn.disabled = true;
    btn.title = 'Select a pattern to expand steps.';
    return;
  }

  if (_accordionMode) {
    btn.textContent = 'Expand All';
    btn.disabled = true;
    btn.title = 'Disable accordion mode in Settings to expand all steps.';
    return;
  }

  const allOpen = Array.from({ length: stepCount }).every((_, idx) => _openStepIndices.has(idx));
  btn.textContent = allOpen ? 'Collapse All' : 'Expand All';
  btn.disabled = false;
  btn.title = allOpen ? 'Collapse every step in this pattern.' : 'Expand every step in this pattern.';
}

function getFindingEntriesForStepIndex(stepIndex) {
  const pattern = getSelectedPattern();
  const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  const step = Number.isInteger(stepIndex) && stepIndex >= 0 ? steps[stepIndex] : null;
  if (!step) return [];
  const sections = normaliseStepSectionsSafe(step.sections, step.richContent || []);
  return normaliseSubsectionEntries(sections.dontMissPathology || []).filter(entry => entry.subsectionId);
}

function initFindingsExpandAllButton() {
  const btn = document.getElementById('btn-findings-expand-all');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const pattern = getSelectedPattern();
    if (!pattern) return;
    const entries = getFindingEntriesForStepIndex(currentStepIndex);
    if (!entries.length) return;

    const allOpen = entries.every(entry => isFindingPanelOpen(entry.subsectionId, currentStepIndex));
    entries.forEach(entry => setFindingPanelOpen(entry.subsectionId, !allOpen, currentStepIndex));

    const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
    renderCurrentStepFindings(pattern, steps[currentStepIndex], currentStepIndex, steps.length);
  });
}

function updateFindingsExpandAllButton(findings, stepIndex) {
  const btn = document.getElementById('btn-findings-expand-all');
  if (!btn) return;

  const entries = normaliseSubsectionEntries(findings || []).filter(entry => entry.subsectionId);
  if (!entries.length) {
    btn.textContent = 'Expand All';
    btn.disabled = true;
    btn.title = 'No findings in this step yet.';
    syncTimedFullscreenFindingsHeader();
    return;
  }

  const allOpen = entries.every(entry => isFindingPanelOpen(entry.subsectionId, stepIndex));
  btn.textContent = allOpen ? 'Collapse All' : 'Expand All';
  btn.disabled = false;
  btn.title = allOpen ? 'Collapse every finding in this step.' : 'Expand every finding in this step.';
  syncTimedFullscreenFindingsHeader();
}

// ── Timer ────────────────────────────────────────────────────
function handleStartTimer() {
  const pattern = getSelectedPattern();
  if (!pattern) {
    showToast('Select a pattern before starting the timer.', true);
    return;
  }

  startTimer(pattern);
}

function startTimer(pattern) {
  stopTimer();
  clearYellowStepMarks();
  const patternName = pattern && pattern.name ? pattern.name : '';
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (timerBar) timerBar.style.display = '';
  document.getElementById('timer-pattern-name').textContent = patternName;
  timerGoalSeconds = getCurrentStepGoalSeconds(pattern, _timerMode);
  syncTimerControlsFromState();
  timerSeconds = 0;
  timerStartWallTime = Date.now();
  _timerActiveStepKey = '';
  _timerActivePatternId = '';
  _timerActiveStepIndex = -1;
  _timerStepEnteredAtSeconds = 0;
  timerRunning = true;
  _timerPaused = false;
  updateTimerDisplay();
  updateTimerActionButtons();
  timerInterval = setInterval(tickTimer, 1000);
}

function tickTimer() {
  timerSeconds = Math.floor((Date.now() - timerStartWallTime) / 1000);
  updateTimerDisplay();
  maybeAutoAdvanceStep();
  renderStepTimeStatsForCurrentStep();
}

function stopTimer() {
  if (timerRunning) recordActiveStepTiming();
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  _timerPaused = false;
  updateTimerActionButtons();
}

// A real pause: the clock (and therefore the per-step goal countdown and the recorded study time)
// stops, unlike toggleAutoAdvancePause() which only holds off the automatic step change. Resuming
// shifts the wall-clock origin forward by however long we were paused so no time is counted.
function pauseTimerClock() {
  if (!timerRunning || _timerPaused) return;
  _timerPaused = true;
  _timerPausedAtWall = Date.now();
  clearInterval(timerInterval);
  timerInterval = null;
  stopStepAnnouncementAudio();
  renderStepTimeStatsForCurrentStep();
  renderTimedFullscreen();
}

function resumeTimerClock() {
  if (!timerRunning || !_timerPaused) return;
  timerStartWallTime += Date.now() - _timerPausedAtWall;
  _timerPaused = false;
  timerInterval = setInterval(tickTimer, 1000);
  renderStepTimeStatsForCurrentStep();
  renderTimedFullscreen();
}

function toggleTimerClockPause() {
  if (_timerPaused) resumeTimerClock();
  else pauseTimerClock();
}

function updateTimerDisplay() {
  const timerDisplay = document.getElementById('timer-display');
  // Walkthrough mode has no pacing goal, so a ticking clock only adds time pressure it isn't meant
  // to have — keep tracking timerSeconds in the background (Record Study still needs it), just
  // don't show or color-code it.
  const showTimer = _timerMode !== 'walkthrough';
  timerDisplay.style.display = showTimer ? '' : 'none';
  if (showTimer) {
    timerDisplay.textContent = formatTimerClock(timerSeconds);
    const elapsedOnStep = Math.max(0, timerSeconds - _timerStepEnteredAtSeconds);
    const overGoal = timerGoalSeconds !== null && elapsedOnStep > timerGoalSeconds;
    timerDisplay.classList.toggle('timer-display-over-goal', overGoal);
  } else {
    timerDisplay.classList.remove('timer-display-over-goal');
  }
  applyTimerGoalTheme();
  renderTimedFullscreen();
}

function updateTimerActionButtons() {
  const startButton = document.getElementById('btn-start-timer');
  const stopButton = document.getElementById('btn-stop-timer');
  const recordButton = document.getElementById('btn-record-study');
  const hasPattern = Boolean(getSelectedPattern());

  if (startButton) startButton.disabled = !hasPattern || timerRunning;
  if (stopButton) stopButton.disabled = !timerRunning;
  if (recordButton) recordButton.disabled = !hasPattern;
}

// 'green' up to 2/3 of the step goal, 'yellow' up to the goal, 'red' past it, 'double' at 2x the goal;
// '' when there is no goal to pace against (Walkthrough mode).
function getStepGoalState() {
  if (_timerMode !== 'timed') return '';
  if (timerGoalSeconds === null) return '';

  const elapsedOnStep = Math.max(0, timerSeconds - _timerStepEnteredAtSeconds);
  const progress = elapsedOnStep / timerGoalSeconds;
  if (progress >= 2) return 'double';
  if (progress <= (2 / 3)) return 'green';
  if (progress <= 1) return 'yellow';
  return 'red';
}

function applyTimerGoalTheme() {
  const timerBar = document.getElementById('timer-bar') || document.querySelector('.timer-bar');
  if (!timerBar) return;

  timerBar.classList.remove('timer-goal-green', 'timer-goal-yellow', 'timer-goal-red', 'timer-goal-double');
  const state = getStepGoalState();
  if (state === 'double') {
    timerBar.classList.add('timer-goal-red', 'timer-goal-double');
  } else if (state) {
    timerBar.classList.add('timer-goal-' + state);
  }
}

function maybeAutoAdvanceStep() {
  if (!timerRunning) return;
  if (_timerMode !== 'timed') return;
  if (_autoAdvancePaused) return;

  var pattern = getSelectedPattern();
  if (!pattern) return;

  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (steps.length < 2) return;

  var step = steps[currentStepIndex];
  if (!step) return;
  var goal = getEffectiveStepGoalSeconds(step); // defaults to 1 minute when unset

  var elapsedOnCurrentStep = Math.max(0, timerSeconds - _timerStepEnteredAtSeconds);
  if (elapsedOnCurrentStep < goal) return;

  if (currentStepIndex >= steps.length - 1) return;

  navigateStep(1);
}

function normaliseGoalSeconds(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function formatTimerClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatGoalSecondsForUnit(seconds, unit) {
  if (seconds === null) return '';
  return unit === 'min' ? String(Math.round((seconds / 60) * 10) / 10) : String(seconds);
}

function isValidGoalInputValue(raw) {
  const trimmed = String(raw || '').trim();
  if (trimmed === '') return true; // empty means "clear the goal" — always a valid end state
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}

// Stages a step's goal time into the pattern-edit draft, same as step titles and findings do —
// only actually persisted to Firestore when the user clicks "Done Editing" (commitPatternEditDraftIfNeeded).
function applyPatternViewerStepGoalDraft(stepIndex, rawValue, unit) {
  if (!_patternViewerEditMode) return false;
  const pattern = getSelectedPattern();
  if (!pattern) return false;

  const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  const safeStepIndex = Number.isInteger(stepIndex) ? stepIndex : -1;
  const step = safeStepIndex >= 0 ? steps[safeStepIndex] : null;
  if (!step) return false;

  const safeUnit = unit === 'min' ? 'min' : 'sec';
  const rawGoal = String(rawValue || '').trim();
  const previousGoalSeconds = normaliseGoalSeconds(step.goalSeconds);

  let nextGoalSeconds = null;
  if (rawGoal !== '') {
    const rawNumber = Number(rawGoal);
    if (!Number.isFinite(rawNumber) || rawNumber <= 0) return false;
    nextGoalSeconds = Math.round(safeUnit === 'min' ? rawNumber * 60 : rawNumber);
  }

  if (nextGoalSeconds === previousGoalSeconds) return false;

  step.goalSeconds = nextGoalSeconds;
  markPatternEditDraftDirty(pattern);
  if (safeStepIndex === currentStepIndex) {
    timerGoalSeconds = getCurrentStepGoalSeconds(pattern, _timerMode);
  }
  renderTotalGoalDisplay(pattern);
  return true;
}



// ── Full-screen timed read (phone) ───────────────────────────
// A distraction-free view for working through a pattern in Timed mode: just the current step, its
// pacing clock and what's next. Tap anywhere to pause/resume, swipe to change step, and the final
// step offers Record / Exit. Built as an overlay (not the Fullscreen API) because iPhone Safari only
// allows native fullscreen for video — the native API is still requested where it exists (Android).
var _timedFsOpen = false;
var _timedFsWakeLock = null;
var _timedFsNativeFullscreen = false;
var _timedFsTouch = null;
var _timedFsSuppressTapUntil = 0;
var TIMED_FS_SWIPE_MIN_PX = 60;

function isTimedFullscreenOpen() {
  return _timedFsOpen;
}

function getTimedFullscreenStepTitle(steps, index) {
  var raw = steps[index];
  if (!raw) return '';
  var step = (typeof resolveLinkedStep === 'function' && resolveLinkedStep(raw)) || raw;
  return getCleanStepTitle(step.stepTitle) || ('Step ' + String(index + 1));
}

function renderTimedFullscreen() {
  if (!_timedFsOpen) return;
  var overlay = document.getElementById('timed-fs');
  if (!overlay) return;

  var pattern = getSelectedPattern();
  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  if ((!timerRunning && !_timedFsRestarting) || !steps.length) {
    exitTimedFullscreen(); // timer was stopped/changed elsewhere — nothing left to show
    return;
  }

  var index = Math.max(0, Math.min(currentStepIndex, steps.length - 1));
  var isFinal = index >= steps.length - 1;
  var elapsedOnStep = Math.max(0, timerSeconds - _timerStepEnteredAtSeconds);
  var goalState = getStepGoalState();
  var goalSeconds = timerGoalSeconds;

  overlay.dataset.state = _timerPaused ? 'paused' : 'running';
  overlay.dataset.goal = goalState === 'double' ? 'red' : (goalState || 'green');
  overlay.classList.toggle('is-double', goalState === 'double');
  overlay.classList.toggle('is-final', isFinal);

  document.getElementById('timed-fs-count').textContent = 'Step ' + (index + 1) + ' of ' + steps.length;
  document.getElementById('timed-fs-total').textContent = formatTimerClock(timerSeconds);
  document.getElementById('timed-fs-pattern').textContent = pattern.name || '';
  var stepTitle = getTimedFullscreenStepTitle(steps, index);
  document.getElementById('timed-fs-title').textContent = stepTitle;
  document.getElementById('timed-fs-paused-step').textContent = stepTitle;
  document.getElementById('timed-fs-findings-step').textContent = 'Step ' + (index + 1) + ' · ' + stepTitle;
  document.getElementById('timed-fs-clock').textContent = formatTimerClock(elapsedOnStep);
  document.getElementById('timed-fs-goal-text').textContent = goalSeconds ? ('Goal ' + formatTimerClock(goalSeconds)) : '';
  document.getElementById('timed-fs-goal-fill').style.width = (goalSeconds ? Math.min(100, (elapsedOnStep / goalSeconds) * 100) : 0) + '%';
  document.getElementById('timed-fs-progress-fill').style.width = (((index + 1) / steps.length) * 100) + '%';
  document.getElementById('timed-fs-next').textContent = isFinal
    ? 'Final step'
    : 'Next: ' + getTimedFullscreenStepTitle(steps, index + 1);
  document.getElementById('timed-fs-final').hidden = !isFinal;
  document.getElementById('timed-fs-hint').hidden = isFinal;
}

// Screen sleeping mid-read would freeze the voice and hide the steps, so hold the screen awake while
// the overlay is open (Screen Wake Lock: iOS 16.4+, Android Chrome). Unsupported browsers just skip it —
// the timer runs off the wall clock, so it still catches up if the screen does dim.
async function requestScreenWakeLock() {
  if (!navigator.wakeLock || _timedFsWakeLock) return;
  try {
    var sentinel = await navigator.wakeLock.request('screen');
    if (!_timedFsOpen) {
      sentinel.release().catch(function() { /* already released */ });
      return;
    }
    _timedFsWakeLock = sentinel;
    sentinel.addEventListener('release', function() {
      if (_timedFsWakeLock === sentinel) _timedFsWakeLock = null;
    });
  } catch (err) {
    // Denied or unsupported — not worth interrupting the read for.
  }
}

function releaseScreenWakeLock() {
  var sentinel = _timedFsWakeLock;
  _timedFsWakeLock = null;
  if (sentinel) sentinel.release().catch(function() { /* already released */ });
}

function openTimedFullscreen() {
  var overlay = document.getElementById('timed-fs');
  if (!overlay) return;

  _timedFsOpen = true;
  overlay.style.display = 'flex';
  document.documentElement.classList.add('timed-fs-open');
  renderTimedFullscreen();
  requestScreenWakeLock();

  try {
    var requestNative = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
    if (requestNative) {
      var result = requestNative.call(overlay);
      if (result && typeof result.then === 'function') {
        result.then(function() { _timedFsNativeFullscreen = true; }).catch(function() { /* overlay alone is fine */ });
      }
    }
  } catch (err) {
    // The overlay already covers the page; native fullscreen is a bonus.
  }
}

function exitTimedFullscreen() {
  if (!_timedFsOpen) return;
  closeTimedFullscreenFindings(); // hand the findings list back to its normal panel first
  _timedFsOpen = false;

  var overlay = document.getElementById('timed-fs');
  if (overlay) overlay.style.display = 'none';
  document.documentElement.classList.remove('timed-fs-open');
  releaseScreenWakeLock();

  if (_timedFsNativeFullscreen) {
    _timedFsNativeFullscreen = false;
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function() { /* already out */ });
      }
    } catch (err) {
      // Nothing to do.
    }
  }

  // Leaving while paused would strand a frozen clock in the normal view, so pick it back up.
  if (_timerPaused) resumeTimerClock();
}

// Starts a fresh timed read of the selected pattern from step 1 and shows it full screen. Runs from a
// tap, so this is also where voice audio gets unlocked for the announcements that follow.
function startTimedFullscreen() {
  var pattern = getSelectedPattern();
  if (!pattern) {
    showToast('Select a pattern first.', true);
    return;
  }
  var steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  if (!steps.length) {
    showToast('This pattern has no steps yet.', true);
    return;
  }
  if (_patternViewerEditMode) {
    showToast('Finish editing before starting a timed read.', true);
    return;
  }

  if (_voiceModeEnabled) unlockVoiceOutput();

  currentStepIndex = 0;
  _openStepIndices = new Set([0]);
  _autoAdvancePaused = false;
  startTimer(pattern);
  renderCurrentStep(pattern);
  openTimedFullscreen();
}

// Findings sheet: the same live #pattern-findings-content node is moved into the sheet while it is open
// (and back on close), so it keeps re-rendering per step and keeps its expand/collapse behaviour.
var _timedFsFindingsOpen = false;

function syncTimedFullscreenFindingsHeader() {
  var source = document.getElementById('btn-findings-expand-all');
  var target = document.getElementById('timed-fs-findings-expand');
  if (!source || !target) return;
  target.textContent = source.textContent;
  target.disabled = source.disabled;
}

function openTimedFullscreenFindings() {
  var overlay = document.getElementById('timed-fs');
  var content = document.getElementById('pattern-findings-content');
  var body = document.getElementById('timed-fs-findings-body');
  if (!_timedFsOpen || _timedFsFindingsOpen || !overlay || !content || !body) return;

  _timedFsFindingsOpen = true;
  body.appendChild(content);
  content.scrollTop = 0;
  overlay.classList.add('findings-open');
  document.getElementById('timed-fs-findings-handle').setAttribute('aria-expanded', 'true');
  syncTimedFullscreenFindingsHeader();
}

function closeTimedFullscreenFindings() {
  if (!_timedFsFindingsOpen) return;
  _timedFsFindingsOpen = false;

  var overlay = document.getElementById('timed-fs');
  var content = document.getElementById('pattern-findings-content');
  var home = document.querySelector('#pattern-findings-panel .pattern-findings-body');
  if (content && home) home.appendChild(content);
  if (overlay) overlay.classList.remove('findings-open');
  var handle = document.getElementById('timed-fs-findings-handle');
  if (handle) handle.setAttribute('aria-expanded', 'false');
}

// Finishing a study logs it (same as Space on desktop: RVU filled in from the pattern name when known)
// and immediately starts the next read from step 1, without leaving full screen.
var _timedFsRestarting = false;

async function finishAndRestartTimedFullscreen() {
  if (_timedFsRestarting) return;
  _timedFsRestarting = true;
  var button = document.getElementById('timed-fs-record');
  if (button) button.disabled = true;

  try {
    await autoRecordAndRestartPattern();
  } finally {
    _timedFsRestarting = false;
    if (button) button.disabled = false;
  }

  // The save failed, so the timer was left stopped: drop back to the normal view (its error toast is up).
  if (_timedFsOpen && !timerRunning) exitTimedFullscreen();
}

function initTimedFullscreen() {
  var overlay = document.getElementById('timed-fs');
  if (!overlay) return;

  document.getElementById('btn-timer-fullscreen').addEventListener('click', startTimedFullscreen);
  document.getElementById('timed-fs-close').addEventListener('click', exitTimedFullscreen);
  document.getElementById('timed-fs-exit').addEventListener('click', exitTimedFullscreen);
  document.getElementById('timed-fs-record').addEventListener('click', finishAndRestartTimedFullscreen);

  document.getElementById('timed-fs-findings-handle').addEventListener('click', function() {
    if (_timedFsFindingsOpen) closeTimedFullscreenFindings();
    else openTimedFullscreenFindings();
  });
  document.getElementById('timed-fs-findings-close').addEventListener('click', closeTimedFullscreenFindings);
  document.getElementById('timed-fs-findings-expand').addEventListener('click', function() {
    var source = document.getElementById('btn-findings-expand-all');
    if (source) source.click(); // re-renders the findings and refreshes this button's label via the sync hook
  });
  document.querySelector('.timed-fs-findings-head').addEventListener('click', function(e) {
    if (!e.target.closest('button')) closeTimedFullscreenFindings();
  });

  overlay.addEventListener('click', function(e) {
    if (e.target.closest('button')) return;
    if (e.target.closest('.timed-fs-findings-sheet')) return; // reading/expanding findings, not pausing
    if (Date.now() < _timedFsSuppressTapUntil) return; // the tail end of a swipe, not a tap
    if (_timedFsFindingsOpen) {
      closeTimedFullscreenFindings(); // tap outside the sheet dismisses it
      return;
    }
    toggleTimerClockPause();
  });

  overlay.addEventListener('touchstart', function(e) {
    var touch = e.changedTouches[0];
    _timedFsTouch = touch ? {
      x: touch.clientX,
      y: touch.clientY,
      inSheet: Boolean(e.target.closest('.timed-fs-findings-sheet')),
      onSheetHead: Boolean(e.target.closest('.timed-fs-findings-head'))
    } : null;
  }, { passive: true });

  overlay.addEventListener('touchend', function(e) {
    var start = _timedFsTouch;
    _timedFsTouch = null;
    var touch = e.changedTouches[0];
    if (!start || !touch) return;

    var dx = touch.clientX - start.x;
    var dy = touch.clientY - start.y;
    var isVerticalSwipe = Math.abs(dy) >= TIMED_FS_SWIPE_MIN_PX && Math.abs(dy) >= Math.abs(dx) * 1.5;

    if (_timedFsFindingsOpen) {
      // Inside the sheet only its header is a swipe target (down closes); the list itself just scrolls.
      if (start.onSheetHead && isVerticalSwipe && dy > 0) {
        _timedFsSuppressTapUntil = Date.now() + 400;
        closeTimedFullscreenFindings();
      }
      return;
    }

    if (isVerticalSwipe && dy < 0) {
      _timedFsSuppressTapUntil = Date.now() + 400;
      openTimedFullscreenFindings();
      return;
    }

    if (Math.abs(dx) < TIMED_FS_SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    _timedFsSuppressTapUntil = Date.now() + 400;
    navigateStep(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && _timedFsOpen) {
      requestScreenWakeLock(); // the browser drops the wake lock whenever the page is hidden
      renderTimedFullscreen();
    }
  });

  // Backing out of native fullscreen (Android back gesture / Esc) should also leave the overlay.
  document.addEventListener('fullscreenchange', function() {
    if (_timedFsNativeFullscreen && !document.fullscreenElement) {
      _timedFsNativeFullscreen = false;
      exitTimedFullscreen();
    }
  });
}

// ── Record modal ─────────────────────────────────────────────
function openRecordModal() {
  const pattern = getSelectedPattern();
  if (!pattern) return;

  pendingRecordPatternName = pattern.name;
  pendingRecordSeconds = timerSeconds;
  stopTimer();

  const dur = formatDuration(pendingRecordSeconds);
  document.getElementById('modal-record-body').textContent =
    `Record "${pendingRecordPatternName}" — ${dur}?`;
  document.getElementById('record-rvu-input').value = '';

  // Attach change handler by cloning node to clear any previous listeners
  const studySelect = document.getElementById('record-rvu-study-select');
  const freshSelect = studySelect.cloneNode(false);
  studySelect.parentNode.replaceChild(freshSelect, studySelect);

  RVUsData.populateSelect(freshSelect).then(() => {
    const idx = RVUsData.findIndex(pendingRecordPatternName);
    if (idx !== -1) {
      freshSelect.value = idx;
      const entry = RVUsData.getEntry(idx);
      if (entry) document.getElementById('record-rvu-input').value = entry.rvu;
    }
    freshSelect.addEventListener('change', () => {
      const entry = RVUsData.getEntry(Number(freshSelect.value));
      if (entry) document.getElementById('record-rvu-input').value = entry.rvu;
    });
  });

  document.getElementById('modal-record').style.display = '';
  setTimeout(() => document.getElementById('record-rvu-input').focus(), 50);
}

async function confirmRecord() {
  const rvu = document.getElementById('record-rvu-input').value;
  document.getElementById('modal-record').style.display = 'none';
  const recordedSeconds = pendingRecordSeconds;
  const pattern = getSelectedPattern();

  try {
    await addStudyLogEntry(_pUid, {
      study:    pendingRecordPatternName,
      seconds:  recordedSeconds,
      duration: formatDuration(recordedSeconds),
      rvu:      rvu !== '' ? rvu : null
    });
    timerSeconds = 0;
    clearYellowStepMarks();
    if (pattern) {
      currentStepIndex = 0;
      _openStepIndices = new Set([0]);
      _autoAdvancePaused = false;
      startTimer(pattern);
      renderCurrentStep(pattern);
    } else {
      updateTimerDisplay();
      updateTimerActionButtons();
    }
    pendingRecordSeconds = 0;
    showToast(`Recorded "${pendingRecordPatternName}" — ${formatDuration(recordedSeconds)} — restarted from step 1.`);
  } catch (err) {
    console.error(err);
    updateTimerActionButtons();
    showToast('Failed to save study record.', true);
  }
}

// Pressing Space on the final step records the study immediately (skipping the RVU modal — best-
// effort auto-filled the same way the modal does, if a matching RVU entry exists) and restarts the
// same pattern from step 1, for fast back-to-back reads without touching the mouse.
async function autoRecordAndRestartPattern() {
  const pattern = getSelectedPattern();
  if (!pattern) return;

  const patternName = pattern.name;
  const recordedSeconds = timerSeconds;
  stopTimer();

  let rvu = null;
  try {
    if (typeof RVUsData !== 'undefined' && RVUsData && typeof RVUsData.findIndex === 'function') {
      const idx = RVUsData.findIndex(patternName);
      if (idx !== -1) {
        const entry = RVUsData.getEntry(idx);
        if (entry) rvu = entry.rvu;
      }
    }
  } catch (err) {
    // Best-effort RVU auto-fill only — recording still proceeds without it.
  }

  try {
    await addStudyLogEntry(_pUid, {
      study: patternName,
      seconds: recordedSeconds,
      duration: formatDuration(recordedSeconds),
      rvu: rvu
    });

    currentStepIndex = 0;
    _openStepIndices = new Set([0]);
    _autoAdvancePaused = false;
    timerSeconds = 0;
    clearYellowStepMarks();
    startTimer(pattern);
    renderCurrentStep(pattern);

    showToast(`Recorded "${patternName}" — ${formatDuration(recordedSeconds)} — restarted from step 1.`);
  } catch (err) {
    console.error(err);
    updateTimerActionButtons();
    showToast('Failed to save study record.', true);
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ── Sidebar buttons ──────────────────────────────────────────
function updateSidebarButtons(hasSelection) {
  const editBtn = document.getElementById('btn-edit-pattern');
  const hasUnsyncedDraft = hasDirtyPatternEditDraft(selectedPatternId);
  editBtn.disabled = !hasSelection || _patternEditCommitInFlight;
  if (_patternEditCommitInFlight) {
    editBtn.textContent = 'Syncing...';
  } else if (_patternViewerEditMode) {
    editBtn.textContent = 'Done Editing';
  } else if (hasUnsyncedDraft) {
    editBtn.textContent = 'Edit Pattern (Unsynced)';
  } else {
    editBtn.textContent = 'Edit Pattern';
  }
  updatePatternStepAddButton();
}

// One floating menu serves both pattern rows and folder headers; whoever opens it supplies the items.
function initPatternListContextMenu() {
  if (_patternListContextMenu) return;

  const menu = document.createElement('div');
  menu.className = 'pattern-list-context-menu';
  menu.id = 'pattern-list-context-menu';
  menu.style.display = 'none';
  document.body.appendChild(menu);
  _patternListContextMenu = menu;

  document.addEventListener('click', function() {
    hidePatternListContextMenu();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hidePatternListContextMenu();
  });
  window.addEventListener('resize', hidePatternListContextMenu);
}

// items: { label, onSelect, danger?, choice?, checked?, keepOpen? } | { heading } | { divider: true }
// itemsOrBuilder may be that array directly, or a function returning a fresh one — a builder is what lets
// a `keepOpen` item (a folder checkbox) redraw the menu with up-to-date checked state after it runs,
// without losing its place on screen.
function openPatternListMenu(clientX, clientY, itemsOrBuilder) {
  if (!_patternListContextMenu) return;
  _patternListMenuState = {
    x: clientX,
    y: clientY,
    build: typeof itemsOrBuilder === 'function' ? itemsOrBuilder : function() { return itemsOrBuilder; }
  };
  renderPatternListMenu();
}

// Redraws the currently open menu in place from its builder; a no-op when no menu is open. Also called
// whenever the folders a pattern belongs to change underneath an open menu (e.g. the Firestore round trip
// after a checkbox click, or a folder edited from another device).
function renderPatternListMenu() {
  if (!_patternListMenuState || !_patternListContextMenu) return;
  const menu = _patternListContextMenu;
  const items = _patternListMenuState.build();
  menu.innerHTML = '';

  items.forEach(function(item) {
    if (item.divider) {
      const divider = document.createElement('div');
      divider.className = 'pattern-list-context-menu-divider';
      divider.setAttribute('role', 'separator');
      menu.appendChild(divider);
      return;
    }
    if (item.heading) {
      const heading = document.createElement('div');
      heading.className = 'pattern-list-context-menu-heading';
      heading.textContent = item.heading;
      menu.appendChild(heading);
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pattern-list-context-menu-item'
      + (item.danger ? ' is-danger' : '')
      + (item.choice ? ' is-choice' : '')
      + (item.checked ? ' is-checked' : '');
    btn.textContent = item.label;
    btn.addEventListener('click', function(e) {
      if (item.keepOpen) {
        e.stopPropagation(); // keep the document-level click-away handler from closing the menu on this click
        Promise.resolve(item.onSelect()).then(renderPatternListMenu);
      } else {
        hidePatternListContextMenu();
        item.onSelect();
      }
    });
    menu.appendChild(btn);
  });

  menu.style.display = 'block';
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = Math.min(Math.max(8, _patternListMenuState.x), maxLeft) + 'px';
  menu.style.top = Math.min(Math.max(8, _patternListMenuState.y), maxTop) + 'px';
  menu.style.visibility = 'visible';
}

function showPatternListContextMenu(clientX, clientY, patternId) {
  openPatternListMenu(clientX, clientY, function() {
    return [
      { label: 'Edit Pattern Name', onSelect: function() { return handleRenamePattern(patternId); } },
      { label: 'Duplicate Pattern', onSelect: function() { return handleDuplicatePattern(patternId); } }
    ].concat(buildPatternFolderMenuItems(patternId), [
      { label: 'Delete Pattern', danger: true, onSelect: function() { return handleDeletePattern(patternId); } }
    ]);
  });
}

function hidePatternListContextMenu() {
  _patternListMenuState = null;
  if (!_patternListContextMenu) return;
  _patternListContextMenu.style.display = 'none';
}

function handlePatternListContextMenu(e) {
  const item = e.target.closest('.pattern-list-item');
  const targetId = item && item.dataset.patternId;
  if (!targetId) return;

  e.preventDefault();

  // A mouse right-click also opens the pattern, as it always has. On a touch screen the same event is a
  // long-press, and opening a pattern starts its timer — so there it only opens the menu.
  if (!isTouchPrimaryDevice() && selectedPatternId !== targetId) loadPattern(targetId);

  showPatternListContextMenu(e.clientX, e.clientY, targetId);
}

async function handleRenamePattern(patternId) {
  const targetId = patternId || selectedPatternId;
  if (!targetId) return;

  const pattern = allPatterns.find(function(item) { return item.id === targetId; });
  if (!pattern) return;

  const renamed = window.prompt('Edit pattern name', String(pattern.name || ''));
  if (renamed === null) return;

  const nextName = String(renamed).trim();
  if (!nextName) {
    showToast('Pattern name cannot be blank.', true);
    return;
  }
  if (nextName === pattern.name) return;

  try {
    await updatePattern(_pUid, targetId, {
      name: nextName,
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: Array.isArray(pattern.steps) ? pattern.steps : []
    });
    showToast('Pattern renamed.');
  } catch (err) {
    console.error(err);
    showToast('Failed to rename pattern.', true);
  }
}

async function handleDuplicatePattern(patternId) {
  const targetId = patternId || selectedPatternId;
  if (!targetId) return;

  const pattern = allPatterns.find(function(item) { return item.id === targetId; });
  if (!pattern) return;

  try {
    const clonedSteps = JSON.parse(JSON.stringify(Array.isArray(pattern.steps) ? pattern.steps : []));
    const newPatternId = await createPattern(_pUid, {
      name: (pattern.name || 'Untitled Pattern') + ' (Copy)',
      modality: pattern.modality || 'Other',
      goalSeconds: pattern.goalSeconds,
      pathologyGoalSeconds: pattern.pathologyGoalSeconds,
      reportConfig: pattern.reportConfig && typeof pattern.reportConfig === 'object' ? pattern.reportConfig : null,
      steps: clonedSteps
    });
    selectedPatternId = newPatternId;
    const folderIds = getPatternFolderIds(pattern.id);
    if (folderIds.length) await setPatternFolders(newPatternId, folderIds); // the copy keeps the original's folders
    showToast('Pattern duplicated.');
  } catch (err) {
    console.error(err);
    showToast('Failed to duplicate pattern.', true);
  }
}

function flushPatternViewerDraftFromDom() {
  if (!_patternViewerEditMode) return;

  const titleInputs = Array.from(document.querySelectorAll('.step-title-edit-input[data-step-index]'));
  titleInputs.forEach(function(inputEl) {
    const stepIndex = Number(inputEl.dataset.stepIndex);
    if (!Number.isInteger(stepIndex)) return;
    applyPatternViewerStepTitleDraft(stepIndex, inputEl.value);
  });

  const goalControls = Array.from(document.querySelectorAll('.step-item-goal-control[data-step-index]'));
  goalControls.forEach(function(controlEl) {
    const stepIndex = Number(controlEl.dataset.stepIndex);
    if (!Number.isInteger(stepIndex)) return;
    const goalInput = controlEl.querySelector('.step-goal-input');
    const goalUnitSelect = controlEl.querySelector('.step-goal-unit-select');
    if (!goalInput || !isValidGoalInputValue(goalInput.value)) return;
    applyPatternViewerStepGoalDraft(stepIndex, goalInput.value, goalUnitSelect ? goalUnitSelect.value : 'sec');
  });

  const inlineForms = Array.from(document.querySelectorAll('.step-inline-edit[data-step-index][data-section-key]'));
  inlineForms.forEach(function(formEl) {
    const stepIndex = Number(formEl.dataset.stepIndex);
    if (!Number.isInteger(stepIndex)) return;

    const sectionKey = String(formEl.dataset.sectionKey || '');
    if (!sectionKey) return;

    const titleInput = formEl.querySelector('.step-inline-edit-title');
    const redToggle = formEl.querySelector('.step-inline-red-toggle');
    const richEditor = formEl.querySelector('.step-inline-rich-editor');
    const plainEditor = formEl.querySelector('.step-inline-edit-content');
    const contentValue = richEditor && typeof extractRichContent === 'function'
      ? extractRichContent(richEditor)
      : (plainEditor ? plainEditor.value : '');

    applyPatternViewerInlineDraft({
      stepIndex: stepIndex,
      sectionKey: sectionKey,
      findingId: String(formEl.dataset.findingId || ''),
      title: titleInput ? titleInput.value : '',
      content: contentValue,
      isMarkedRed: redToggle ? redToggle.checked : false,
      force: true
    });
  });
}

function setPatternViewerEditMode(enabled, shouldRender) {
  _patternViewerEditMode = Boolean(enabled);
  if (_patternViewerEditMode) {
    const pattern = getSelectedPattern();
    ensurePatternEditDraft(pattern);
    const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
    if (steps.length) {
      currentStepIndex = Math.max(0, Math.min(currentStepIndex, steps.length - 1));
      _openStepIndices = new Set([currentStepIndex]);
    } else {
      _openStepIndices = new Set();
    }
  } else {
    _activeInlineEdit = null;
    _inlineEditSaving = false;
  }
  updateSidebarButtons(Boolean(selectedPatternId));
  if (shouldRender && selectedPatternId) {
    const pattern = getSelectedPattern();
    if (pattern) renderCurrentStep(pattern);
  }
}

function togglePatternViewerEditMode() {
  if (_patternEditCommitInFlight) return;
  if (_patternViewerEditMode) {
    flushPatternViewerDraftFromDom();
    setPatternViewerEditMode(false, true);
    commitPatternEditDraftIfNeeded();
    return;
  }
  if (timerRunning) stopTimer();
  setPatternViewerEditMode(true, true);
  var pattern = getSelectedPattern();
  var steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
  var nextIndex = currentStepIndex + 1;
  var scrollIndex = nextIndex < steps.length ? nextIndex : currentStepIndex;
  requestAnimationFrame(function() {
    var nextItem = document.querySelector('[data-step-index="' + scrollIndex + '"]');
    if (!nextItem) return;
    var viewer = document.getElementById('step-viewer');
    var header = document.getElementById('step-header');
    if (!viewer) {
      nextItem.scrollIntoView({ block: 'start' });
      return;
    }
    var viewerRect = viewer.getBoundingClientRect();
    var itemRect = nextItem.getBoundingClientRect();
    var headerHeight = header && header.style.display !== 'none' ? header.offsetHeight : 0;
    viewer.scrollTo({ top: Math.max(0, viewer.scrollTop + (itemRect.top - viewerRect.top) - headerHeight - 8) });
  });
}

async function handleDeletePattern(patternId) {
  const targetId = patternId || selectedPatternId;
  if (!targetId) return;

  const pattern = allPatterns.find(function(item) { return item.id === targetId; });
  if (!pattern) return;

  const ok = await showConfirm('Delete Pattern', `Delete "${pattern.name}"? This cannot be undone.`);
  if (!ok) return;

  try {
    await deletePattern(_pUid, targetId);
    if (selectedPatternId === targetId) {
      selectedPatternId = null;
      clearStepView();
      updateSidebarButtons(false);
    }
    showToast('Pattern deleted.');
  } catch (err) {
    console.error(err);
    showToast('Failed to delete pattern.', true);
  }
}

// ── Keyboard navigation ──────────────────────────────────────
function isAnyModalOverlayOpen() {
  var overlays = document.querySelectorAll('.modal-overlay');
  for (var i = 0; i < overlays.length; i += 1) {
    var overlay = overlays[i];
    if (!overlay) continue;
    if (overlay.style && overlay.style.display === 'none') continue;
    var computed = window.getComputedStyle ? window.getComputedStyle(overlay) : null;
    if (computed && computed.display === 'none') continue;
    return true;
  }
  return false;
}

function handleKeydown(e) {
  // Keep modal keyboard behavior self-contained (Tab should move within modal fields).
  if (isAnyModalOverlayOpen()) return;

  // Only when not inside an input/textarea/contenteditable
  const tag = e.target.tagName;
  const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                    e.target.isContentEditable;
  if (isEditing) return;

  // The pattern list and its folder controls keep their own arrow/Tab/Space behavior (the list used to be a
  // <select>, exempt above).
  if (e.target.closest && e.target.closest('#patterns-sidebar')) return;

  // Only when patterns panel is active
  const panel = document.getElementById('panel-patterns');
  if (!panel.classList.contains('active')) return;

  if (_timedFsOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (_timedFsFindingsOpen) closeTimedFullscreenFindings();
      else exitTimedFullscreen();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      toggleTimerClockPause();
      return;
    }
  }

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateStep(1);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    navigateStep(-1);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    navigateStep(e.shiftKey ? -1 : 1);
  } else if (e.key === ' ') {
    e.preventDefault();
    const pattern = getSelectedPattern();
    const steps = pattern && Array.isArray(pattern.steps) ? pattern.steps : [];
    const onFinalStep = steps.length > 0 && currentStepIndex >= steps.length - 1;
    if (onFinalStep) {
      autoRecordAndRestartPattern();
    } else if (_timerMode === 'timed' && timerRunning) {
      toggleAutoAdvancePause();
    } else {
      openRecordModal();
    }
  }
}

// ── HDF5 Import ──────────────────────────────────────────────
/**
 * Import patterns from an HDF5 file using h5wasm loaded from CDN.
 * The .h5 format matches what the Python desktop app writes.
 */
async function handleH5Import(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset input

  showToast('Loading h5wasm…');

  try {
    // Dynamically load h5wasm from CDN
    const h5wasm = await loadH5Wasm();
    const buffer = await file.arrayBuffer();
    const uint8  = new Uint8Array(buffer);

    // Write to h5wasm virtual FS and open
    const filename = 'import.h5';
    h5wasm.FS.writeFile(filename, uint8);
    const f = new h5wasm.File(filename, 'r');

    const patterns = parseH5File(f);
    f.close();
    h5wasm.FS.unlink(filename);

    if (!patterns.length) {
      showToast('No patterns found in file.', true);
      return;
    }

    const ok = await showConfirm(
      'Import Patterns',
      `Import ${patterns.length} pattern(s) from "${file.name}"? Existing patterns will not be overwritten.`
    );
    if (!ok) return;

    showToast(`Compressing images…`);
    const compressed = await compressPatternImages(patterns);

    showToast(`Importing ${compressed.length} patterns…`);

    await batchImportPatterns(_pUid, compressed, (done, total) => {
      showToast(`Imported ${done} / ${total}…`);
    });

    showToast(`Imported ${compressed.length} patterns successfully.`);
  } catch (err) {
    console.error('HDF5 import error:', err);
    showToast('Import failed: ' + (err.message || err), true);
  }
}

// Deep-walks any step/section/finding structure and replaces embedded base64 image
// chunks (type: 'image', data: <base64>) with Storage-backed references (url/path),
// uploading + downscaling as needed. Every other field (linkMeta, subsectionId, etc.)
// is passed through untouched so this is safe to run over an entire steps tree before
// every write, keeping documents under Firestore's ~1MB size limit.
async function compressEmbeddedImagesForStorage(node, uid) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) out.push(await compressEmbeddedImagesForStorage(item, uid));
    return out;
  }
  if (node && typeof node === 'object') {
    if (node.type === 'image' && !node.url && node.data) {
      let data = node.data;
      let format = node.format || 'png';
      try {
        data = await compressBase64Image(data, format);
        format = 'jpeg';
      } catch (e) {
        // Keep original bytes if compression fails.
      }
      try {
        // Firebase Storage's SDK retries failed uploads internally for up to ~2 minutes,
        // which would otherwise blow through the whole save's sync timeout on a single
        // image (e.g. if Storage/CORS isn't configured). Bound it so a bad upload falls
        // back to the embedded copy quickly instead of stalling the entire save.
        const uploaded = await withSyncTimeout(uploadImageToStorage(uid, data, format), 8000);
        return { type: 'image', url: uploaded.url, path: uploaded.path, format: format };
      } catch (e) {
        console.warn('Image upload failed, keeping embedded copy:', e);
        return Object.assign({}, node, { format: format, data: data });
      }
    }
    const out = {};
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        out[key] = await compressEmbeddedImagesForStorage(node[key], uid);
      }
    }
    return out;
  }
  return node;
}

// Compress all base64 images in patterns to stay under Firestore's 1MB doc limit.
// Images are resized to max 1024px and re-encoded as JPEG at 0.75 quality.
async function compressPatternImages(patterns) {
  return Promise.all(patterns.map(async p => {
    const steps = await Promise.all((p.steps || []).map(async step => {
      const richContent = await Promise.all((step.richContent || []).map(async chunk => {
        if (chunk.type !== 'image' || !chunk.data) return chunk;
        try {
          const compressed = await compressBase64Image(chunk.data, chunk.format || 'png');
          const uploaded = await uploadImageToStorage(_pUid, compressed, 'jpeg');
          return { type: 'image', url: uploaded.url, path: uploaded.path, format: 'jpeg' };
        } catch (e) {
          console.warn('Image upload failed, keeping embedded copy:', e);
          return chunk;
        }
      }));
      return Object.assign({}, step, { richContent });
    }));
    return Object.assign({}, p, { steps });
  }));
}

function compressBase64Image(b64data, format) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = function() {
      const MAX = 1024;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      // Strip the "data:image/...;base64," prefix before returning
      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/' + format + ';base64,' + b64data;
  });
}

let _h5wasmPromise = null;
function loadH5Wasm() {
  if (_h5wasmPromise) return _h5wasmPromise;
  _h5wasmPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/h5wasm@0.7.5/dist/iife/h5wasm.js';
    s.onload = async () => {
      try {
        await h5wasm.ready;
        resolve(h5wasm);
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error('Failed to load h5wasm'));
    document.head.appendChild(s);
  });
  return _h5wasmPromise;
}

function parseH5File(f) {
  const patterns = [];
  const patternsGroup = f.get('patterns');
  if (!patternsGroup) return patterns;

  // Each key in the patterns group is one pattern
  for (const key of patternsGroup.keys()) {
    try {
      const group = patternsGroup.get(key);
      const patternName = group.attrs['pattern_name']?.value || decodePatternKey(key);
      const stepsDataset = group.get('steps_json');
      if (!stepsDataset) continue;

      const rawBytes = stepsDataset.value;
      const json = typeof rawBytes === 'string'
        ? rawBytes
        : new TextDecoder().decode(rawBytes);

      let steps = [];
      try { steps = JSON.parse(json); } catch { /* skip malformed */ }

      // Normalise step shape
      steps = steps.map(s => ({
        stepTitle:    s.step_title || s.stepTitle || '',
        isRedStep:    Boolean(s.is_red_step || s.isRedStep || s.stepColorRed),
        richContent:  normaliseRichContent(s.rich_content || s.richContent || []),
        linkedStepId: s.linked_step_id || s.linkedStepId || '',
        sections: normaliseStepSectionsSafe(s.sections, s.rich_content || s.richContent || [])
      }));

      // Infer modality from name
      const modality = inferModality(patternName);

      patterns.push({ name: patternName, modality, steps });
    } catch (groupErr) {
      console.warn('Error parsing pattern group:', groupErr);
    }
  }

  return patterns;
}

function decodePatternKey(key) {
  // Keys stored as "p_<base64url>" in the Python app
  if (key.startsWith('p_')) {
    try {
      const b64 = key.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      return atob(b64);
    } catch { /* fall through */ }
  }
  return key;
}

function inferModality(name) {
  const upper = name.toUpperCase();
  if (upper.includes('MRI') || upper.includes('MR ')) return 'MRI';
  if (upper.includes('CT'))  return 'CT';
  if (upper.includes(' US ') || upper.startsWith('US ') || upper.includes('ULTRASOUND')) return 'US';
  if (upper.includes('XR') || upper.includes('RADIOGRAPH') || upper.includes('X-RAY')) return 'Plain Radiograph';
  if (upper.includes('PET') || upper.includes('NUCLEAR') || upper.includes('NM ') || upper.includes('SPECT')) return 'Nuclear Medicine';
  return 'Other';
}

function normaliseMultilineText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function normaliseListItemContent(item) {
  if (Array.isArray(item)) return normaliseRichContent(item);
  if (item && typeof item === 'object' && Array.isArray(item.content)) {
    return normaliseRichContent(item.content);
  }
  return [];
}

function normaliseImageDataPayload(value) {
  if (typeof value === 'string') {
    var safe = String(value || '').trim();
    var match = safe.match(/^data:image\/[^;]+;base64,(.+)$/i);
    return match ? String(match[1] || '').trim() : safe;
  }
  if (value && typeof value === 'object') {
    if (typeof value.data === 'string') return normaliseImageDataPayload(value.data);
    if (typeof value.base64 === 'string') return normaliseImageDataPayload(value.base64);
    if (typeof value.image_data === 'string') return normaliseImageDataPayload(value.image_data);
    if (typeof value.dataUrl === 'string') return normaliseImageDataPayload(value.dataUrl);
  }
  return '';
}

function normaliseImageFormatValue(format, data) {
  var safeFormat = String(format || '').trim().toLowerCase();
  if (safeFormat) return safeFormat;
  var raw = String(data || '').trim();
  var match = raw.match(/^data:image\/([^;]+);base64,/i);
  if (match && match[1]) return String(match[1]).trim().toLowerCase();
  return 'png';
}

// Storage-backed images carry a url/path reference instead of embedded base64
// bytes. Legacy chunks (still embedded base64) fall back to the old handling.
function buildImageChunk(chunk) {
  var url = String((chunk && chunk.url) || '').trim();
  if (url) {
    return {
      type: 'image',
      url: url,
      path: String((chunk && chunk.path) || '').trim(),
      format: String((chunk && chunk.format) || '').trim().toLowerCase() || null
    };
  }

  var imageData = chunk?.data ?? chunk?.image_data;
  return {
    type: 'image',
    format: normaliseImageFormatValue(chunk?.format || chunk?.image_format, imageData),
    data: normaliseImageDataPayload(imageData)
  };
}

function collapseRedundantRichContentNewlines(chunks) {
  if (!Array.isArray(chunks)) return [];
  const out = [];
  chunks.forEach(function(chunk) {
    if (!chunk || chunk.type !== 'text') {
      out.push(chunk);
      return;
    }

    const text = String(chunk.text || '');
    const isNewlineOnly = /^[\n\r]+$/.test(text.replace(/\r/g, ''));
    if (!isNewlineOnly) {
      out.push(chunk);
      return;
    }

    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && /^[\n\r]+$/.test(String(prev.text || '').replace(/\r/g, ''))) {
      return;
    }

    out.push({ type: 'text', text: '\n', bold: false, color: null });
  });
  return out;
}

function normaliseRichContent(richContent) {
  if (!Array.isArray(richContent)) return [];

  const normalized = richContent.map(chunk => {
    const type = chunk?.type || (chunk?.image_data || chunk?.data ? 'image' : (chunk?.url ? 'link' : ((chunk?.title || chunk?.name) && Array.isArray(chunk?.content) ? 'subsection' : 'text')));

    if (type === 'image') {
      return buildImageChunk(chunk);
    }

    if (type === 'link') {
      return {
        type: 'link',
        text: normaliseMultilineText(chunk?.text || chunk?.content || chunk?.url || ''),
        url: chunk?.url || ''
      };
    }

    if (type === 'subsection') {
      return {
        type: 'subsection',
        subsectionId: String(chunk?.subsectionId || chunk?.subsection_id || '').trim(),
        findingId: String(chunk?.findingId || chunk?.finding_id || '').trim(),
        title: normaliseMultilineText(chunk?.title || chunk?.name || ''),
        isRedFinding: Boolean(chunk?.isRedFinding || chunk?.is_red_finding || chunk?.findingRed),
        linkMeta: normaliseSectionLinkForViewer(chunk?.linkMeta || chunk?.link_meta || null),
        content: normaliseRichContent(chunk?.content || [])
      };
    }

    if (type === 'list') {
      return {
        type: 'list',
        ordered: Boolean(chunk?.ordered),
        items: Array.isArray(chunk?.items)
          ? chunk.items.map(function(item) {
              return normaliseListItemContent(item);
            })
          : []
      };
    }

    return {
      type: 'text',
      text: normaliseMultilineText(chunk?.text || chunk?.content || ''),
      bold: Boolean(chunk?.bold),
      color: chunk?.color || null
    };
  });

  return collapseRedundantRichContentNewlines(normalized);
}

function sanitiseLinkUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw)) return raw;
  if (/^tel:/i.test(raw)) return raw;
  return 'https://' + raw;
}
