// settings.js - AI settings UI for managed backend provider access.

var _settingsUid = null;
var _settingsInitialised = false;
var _aiProviderStatus = {};

var PROVIDER_MODELS = {
  openai: [
    { value: 'gpt-5.5',       label: 'ChatGPT 5.5' },
    { value: 'gpt-5.5-mini',  label: 'ChatGPT 5.5 mini' },
    { value: 'gpt-4.5',       label: 'GPT-4.5' },
    { value: 'gpt-4o',        label: 'GPT-4o' },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini (default)' },
    { value: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
  ],
  anthropic: [],
  githubModels: []
};

function initSettings(uid) {
  _settingsUid = uid;
  initAiClient(uid);

  if (_settingsInitialised) {
    updateModelDropdown(document.getElementById('ai-provider-select').value);
    refreshAiProviderStatus();
    return;
  }

  _settingsInitialised = true;

  var providerSelect = document.getElementById('ai-provider-select');
  var modelInput = document.getElementById('ai-model-input');

  providerSelect.addEventListener('change', function() {
    updateModelDropdown(providerSelect.value);
    hydrateProviderInputs();
    renderAiProviderStatus();
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

  updateModelDropdown(providerSelect.value);
  hydrateProviderInputs();
  refreshAiProviderStatus();

  // Also refresh when Settings tab is opened to pick up any recent status changes.
  var settingsTabBtn = document.querySelector('.tab-btn[data-tab="settings"]');
  if (settingsTabBtn) {
    settingsTabBtn.addEventListener('click', function() {
      refreshAiProviderStatus();
    });
  }
}

function setSettingsBusy(isBusy, statusText) {
  var ids = ['btn-ai-test'];
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
    // Select the configured model if it exists in the dropdown, otherwise add and select it.
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
    statusEl.textContent = 'Status: AI proxy not ready for ' + provider + '. Contact admin to configure backend key.';
    return;
  }

  var modelHint = status.defaultModel ? '\nModel: ' + status.defaultModel : '';
  statusEl.textContent = 'Status: managed backend access is active for ' + provider + '.' + modelHint;
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
