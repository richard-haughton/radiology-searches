// settings.js - AI provider settings UI.

var _settingsUid = null;
var _settingsInitialised = false;
var _aiProviderStatus = {};

var PROVIDER_MODELS = {
  openai: [
    { value: 'gpt-4o',        label: 'GPT-4o' },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini (default)' },
    { value: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
    { value: 'gpt-4',         label: 'GPT-4' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
  ],
  anthropic: [
    { value: 'claude-opus-4-5',          label: 'Claude Opus 4.5' },
    { value: 'claude-sonnet-4-5',        label: 'Claude Sonnet 4.5' },
    { value: 'claude-3-5-haiku-latest',  label: 'Claude Haiku 3.5 (default)' },
    { value: 'claude-3-5-sonnet-latest', label: 'Claude Sonnet 3.5' },
    { value: 'claude-3-opus-20240229',   label: 'Claude 3 Opus' }
  ],
  githubModels: [
    { value: 'gpt-4o',                      label: 'GPT-4o' },
    { value: 'gpt-4o-mini',                 label: 'GPT-4o mini (default)' },
    { value: 'Meta-Llama-3.1-70B-Instruct', label: 'Meta Llama 3.1 70B' },
    { value: 'Phi-4',                       label: 'Phi-4' },
    { value: 'Mistral-large',               label: 'Mistral Large' }
  ]
};

function initSettings(uid) {
  _settingsUid = uid;
  initAiClient(uid);

  if (_settingsInitialised) {
    updateModelDropdown(document.getElementById('ai-provider-select').value);
    return;
  }

  _settingsInitialised = true;

  var providerSelect = document.getElementById('ai-provider-select');
  var keyInput = document.getElementById('ai-key-input');
  var modelInput = document.getElementById('ai-model-input');
  var visibilityBtn = document.getElementById('btn-ai-key-visibility');

  providerSelect.addEventListener('change', function() {
    updateModelDropdown(providerSelect.value);
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
    var defaultModel = modelInput ? modelInput.value : '';

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
    var model = modelInput ? modelInput.value : '';

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

  updateModelDropdown(providerSelect.value);
  hydrateProviderInputs();

  // Refresh status lazily when the Settings tab is opened, not on every app init.
  var settingsTabBtn = document.querySelector('.tab-btn[data-tab="settings"]');
  if (settingsTabBtn) {
    settingsTabBtn.addEventListener('click', function() {
      refreshAiProviderStatus();
    });
  }
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

function updateModelDropdown(provider) {
  var modelSelect = document.getElementById('ai-model-input');
  if (!modelSelect) return;
  var models = PROVIDER_MODELS[provider] || [];
  modelSelect.innerHTML = models.map(function(m) {
    return '<option value="' + m.value + '">' + m.label + '</option>';
  }).join('');
}

function hydrateProviderInputs() {
  var providerSelect = document.getElementById('ai-provider-select');
  var modelSelect = document.getElementById('ai-model-input');
  if (!providerSelect || !modelSelect) return;

  var provider = providerSelect.value;
  var status = _aiProviderStatus[provider] || {};

  if (status.defaultModel) {
    // Select the saved model if it exists in the dropdown, otherwise add and select it.
    var opt = modelSelect.querySelector('option[value="' + status.defaultModel + '"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.value = status.defaultModel;
      opt.textContent = status.defaultModel;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = status.defaultModel;
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
  var modelSelect = document.getElementById('ai-model-input');
  return modelSelect ? modelSelect.value : '';
}

function isAiProviderConfigured(provider) {
  var status = _aiProviderStatus[provider || getSelectedAiProvider()] || {};
  return !!status.configured;
}
