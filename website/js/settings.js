// settings.js - AI provider settings UI.

var _settingsUid = null;
var _settingsInitialised = false;
var _aiProviderStatus = {};

function initSettings(uid) {
  _settingsUid = uid;
  initAiClient(uid);

  if (_settingsInitialised) {
    refreshAiProviderStatus();
    return;
  }

  _settingsInitialised = true;

  var providerSelect = document.getElementById('ai-provider-select');
  var keyInput = document.getElementById('ai-key-input');
  var modelInput = document.getElementById('ai-model-input');
  var visibilityBtn = document.getElementById('btn-ai-key-visibility');

  providerSelect.addEventListener('change', function() {
    hydrateProviderInputs();
    renderAiProviderStatus();
  });

  visibilityBtn.addEventListener('click', function() {
    if (keyInput.type === 'password') {
      keyInput.type = 'text';
      visibilityBtn.textContent = 'Hide';
    } else {
      keyInput.type = 'password';
      visibilityBtn.textContent = 'Show';
    }
  });

  document.getElementById('btn-ai-save').addEventListener('click', async function() {
    var provider = providerSelect.value;
    var apiKey = keyInput.value.trim();
    var defaultModel = modelInput.value.trim();

    if (!apiKey) {
      showToast('Enter an API key before saving.', true);
      keyInput.focus();
      return;
    }

    setSettingsBusy(true, 'Saving key...');
    try {
      await saveAiProviderKey(provider, apiKey, defaultModel);
      keyInput.value = '';
      keyInput.type = 'password';
      visibilityBtn.textContent = 'Show';
      showToast('Provider key saved.');
      await refreshAiProviderStatus();
    } catch (err) {
      showToast(err.message || 'Failed to save key.', true);
    } finally {
      setSettingsBusy(false);
    }
  });

  document.getElementById('btn-ai-test').addEventListener('click', async function() {
    var provider = providerSelect.value;
    var model = modelInput.value.trim();

    setSettingsBusy(true, 'Testing provider...');
    try {
      await testAiProvider(provider, model);
      showToast('Provider test succeeded.');
      await refreshAiProviderStatus();
    } catch (err) {
      showToast(err.message || 'Provider test failed.', true);
    } finally {
      setSettingsBusy(false);
    }
  });

  document.getElementById('btn-ai-remove').addEventListener('click', async function() {
    var provider = providerSelect.value;
    var ok = await showConfirm('Remove Provider Key', 'Remove saved key for ' + provider + '?');
    if (!ok) return;

    setSettingsBusy(true, 'Removing key...');
    try {
      await removeAiProviderKey(provider);
      showToast('Provider key removed.');
      await refreshAiProviderStatus();
    } catch (err) {
      showToast(err.message || 'Failed to remove key.', true);
    } finally {
      setSettingsBusy(false);
    }
  });

  hydrateProviderInputs();
  refreshAiProviderStatus();
}

function setSettingsBusy(isBusy, statusText) {
  var ids = ['btn-ai-save', 'btn-ai-test', 'btn-ai-remove'];
  ids.forEach(function(id) {
    var btn = document.getElementById(id);
    if (btn) btn.disabled = !!isBusy;
  });
  if (isBusy && statusText) {
    var statusEl = document.getElementById('ai-provider-status');
    if (statusEl) statusEl.textContent = statusText;
  }
}

async function refreshAiProviderStatus() {
  try {
    var response = await getAiProviderStatus();
    _aiProviderStatus = (response && response.providers) || {};
  } catch (err) {
    console.error('refreshAiProviderStatus failed:', err);
    _aiProviderStatus = {};
  }

  hydrateProviderInputs();
  renderAiProviderStatus();
}

function hydrateProviderInputs() {
  var providerSelect = document.getElementById('ai-provider-select');
  var modelInput = document.getElementById('ai-model-input');
  if (!providerSelect || !modelInput) return;

  var provider = providerSelect.value;
  var status = _aiProviderStatus[provider] || {};

  if (status.defaultModel) {
    modelInput.value = status.defaultModel;
  }
}

function renderAiProviderStatus() {
  var statusEl = document.getElementById('ai-provider-status');
  var providerSelect = document.getElementById('ai-provider-select');
  if (!statusEl || !providerSelect) return;

  var provider = providerSelect.value;
  var status = _aiProviderStatus[provider] || {};
  if (!status.configured) {
    statusEl.textContent = 'Status: not configured for ' + provider + '.';
    return;
  }

  var keyHint = status.keyHint ? ' (' + status.keyHint + ')' : '';
  var modelHint = status.defaultModel ? '\nModel: ' + status.defaultModel : '';
  statusEl.textContent = 'Status: configured for ' + provider + keyHint + '.' + modelHint;
}

function getSelectedAiProvider() {
  var providerSelect = document.getElementById('ai-provider-select');
  return providerSelect ? providerSelect.value : 'openai';
}

function getSelectedAiModel() {
  var modelInput = document.getElementById('ai-model-input');
  return modelInput ? modelInput.value.trim() : '';
}

function isAiProviderConfigured(provider) {
  var status = _aiProviderStatus[provider || getSelectedAiProvider()] || {};
  return !!status.configured;
}
