// settings.js - AI settings UI for managed backend provider access.

var _settingsUid = null;
var _settingsInitialised = false;
var _aiProviderStatus = {};
var _aiModelAccess = {};
var _userAiSettings = {};

var PROVIDER_MODELS = {
  openai: [
    { value: 'gpt-5.5',       label: 'ChatGPT 5.5 (default)' },
    { value: 'gpt-5',         label: 'ChatGPT 5' },
    { value: 'gpt-5-mini',    label: 'ChatGPT 5 mini' },
    { value: 'gpt-4.5',       label: 'GPT-4.5' },
    { value: 'gpt-4o',        label: 'GPT-4o' },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
  ],
  anthropic: [
    { value: 'claude-sonnet-5',        label: 'Claude Sonnet 5 (default)' },
    { value: 'claude-opus-5',          label: 'Claude Opus 5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
  ],
  githubModels: []
};

var API_KEY_FIELDS = {
  openai: 'openaiApiKey',
  anthropic: 'anthropicApiKey'
};

function initSettings(uid) {
  _settingsUid = uid;
  initAiClient(uid);

  if (_settingsInitialised) {
    updateModelDropdown(document.getElementById('ai-provider-select').value);
    refreshAiProviderStatus();
    loadUserAiSettings();
    return;
  }

  _settingsInitialised = true;

  var providerSelect = document.getElementById('ai-provider-select');
  var modelInput = document.getElementById('ai-model-input');

  providerSelect.addEventListener('change', function() {
    updateModelDropdown(providerSelect.value);
    hydrateProviderInputs();
    refreshSelectedModelAccess().finally(renderAiProviderStatus);
    renderAiProviderStatus();
  });

  if (modelInput) {
    modelInput.addEventListener('change', function() {
      refreshSelectedModelAccess().finally(renderAiProviderStatus);
      renderAiProviderStatus();
    });
  }

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

  ['openai', 'anthropic'].forEach(function(provider) {
    var saveBtn = document.getElementById('btn-ai-key-save-' + provider);
    var clearBtn = document.getElementById('btn-ai-key-clear-' + provider);
    if (saveBtn) {
      saveBtn.addEventListener('click', function() { handleSaveApiKey(provider); });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function() { handleClearApiKey(provider); });
    }
  });

  updateModelDropdown(providerSelect.value);
  hydrateProviderInputs();
  refreshAiProviderStatus();
  loadUserAiSettings();

  // Also refresh when Settings tab is opened to pick up any recent status changes.
  var settingsTabBtn = document.querySelector('.tab-btn[data-tab="settings"]');
  if (settingsTabBtn) {
    settingsTabBtn.addEventListener('click', function() {
      refreshAiProviderStatus();
    });
  }
}

async function loadUserAiSettings() {
  if (!_settingsUid) return;
  try {
    _userAiSettings = await loadAiSettings(_settingsUid);
  } catch (err) {
    console.error('loadUserAiSettings failed:', err);
    _userAiSettings = {};
  }
  hydrateApiKeyStatus();
  renderAiProviderStatus();
}

function userHasApiKey(provider) {
  var field = API_KEY_FIELDS[provider];
  return !!(field && _userAiSettings && String(_userAiSettings[field] || '').trim());
}

function maskKeyForDisplay(rawKey) {
  var key = String(rawKey || '').trim();
  if (!key) return '';
  var tail = key.slice(-4);
  return '••••••••' + tail;
}

function hydrateApiKeyStatus() {
  ['openai', 'anthropic'].forEach(function(provider) {
    var statusEl = document.getElementById('ai-key-status-' + provider);
    var input = document.getElementById('ai-key-input-' + provider);
    var clearBtn = document.getElementById('btn-ai-key-clear-' + provider);
    var field = API_KEY_FIELDS[provider];
    var hasKey = userHasApiKey(provider);

    if (input) {
      input.value = '';
      input.placeholder = hasKey
        ? maskKeyForDisplay(_userAiSettings[field]) + ' (saved — enter a new key to replace)'
        : 'Enter your ' + (provider === 'anthropic' ? 'Anthropic' : 'OpenAI') + ' API key';
    }
    if (statusEl) {
      statusEl.textContent = hasKey ? 'Key saved.' : 'No key saved.';
    }
    if (clearBtn) {
      clearBtn.disabled = !hasKey;
    }
  });
}

async function handleSaveApiKey(provider) {
  var input = document.getElementById('ai-key-input-' + provider);
  var field = API_KEY_FIELDS[provider];
  if (!input || !field) return;

  var value = String(input.value || '').trim();
  if (!value) {
    showToast('Enter an API key before saving.', true);
    return;
  }

  var saveBtn = document.getElementById('btn-ai-key-save-' + provider);
  if (saveBtn) saveBtn.disabled = true;

  try {
    var update = {};
    update[field] = value;
    await saveAiSettings(_settingsUid, update);
    _userAiSettings[field] = value;
    hydrateApiKeyStatus();
    renderAiProviderStatus();
    showToast((provider === 'anthropic' ? 'Anthropic' : 'OpenAI') + ' API key saved.');
  } catch (err) {
    showToast(err.message || 'Failed to save API key.', true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function handleClearApiKey(provider) {
  var field = API_KEY_FIELDS[provider];
  if (!field) return;

  var clearBtn = document.getElementById('btn-ai-key-clear-' + provider);
  if (clearBtn) clearBtn.disabled = true;

  try {
    await clearAiApiKey(_settingsUid, provider);
    delete _userAiSettings[field];
    hydrateApiKeyStatus();
    renderAiProviderStatus();
    showToast((provider === 'anthropic' ? 'Anthropic' : 'OpenAI') + ' API key removed.');
  } catch (err) {
    showToast(err.message || 'Failed to remove API key.', true);
    if (clearBtn) clearBtn.disabled = !userHasApiKey(provider);
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
  await refreshSelectedModelAccess();
  renderAiProviderStatus();
}

async function refreshSelectedModelAccess() {
  var provider = getSelectedAiProvider();
  var model = getSelectedAiModel();

  if (!_aiProviderStatus[provider] || !_aiProviderStatus[provider].configured) {
    _aiModelAccess[provider] = null;
    return;
  }

  try {
    var result = await callAiProxy('modelAccess', {
      provider: provider,
      model: model
    });
    _aiModelAccess[provider] = (result && result.data) || null;
  } catch (err) {
    _aiModelAccess[provider] = {
      error: (err && err.message) ? err.message : 'Unable to verify model access.'
    };
  }
}

function updateModelDropdown(provider) {
  var modelSelect = document.getElementById('ai-model-input');
  if (!modelSelect) return;
  var previousValue = String(modelSelect.value || '').trim();
  var models = PROVIDER_MODELS[provider] || [];
  modelSelect.innerHTML = models.map(function(m) {
    return '<option value="' + m.value + '">' + m.label + '</option>';
  }).join('');

  if (previousValue && modelSelect.querySelector('option[value="' + previousValue + '"]')) {
    modelSelect.value = previousValue;
  }
}

function hydrateProviderInputs() {
  var providerSelect = document.getElementById('ai-provider-select');
  var modelSelect = document.getElementById('ai-model-input');
  if (!providerSelect || !modelSelect) return;

  var provider = providerSelect.value;
  var status = _aiProviderStatus[provider] || {};
  var currentModel = String(modelSelect.value || '').trim();

  // Keep the current manual selection when it exists in the dropdown.
  if (currentModel && modelSelect.querySelector('option[value="' + currentModel + '"]')) {
    return;
  }

  if (status.defaultModel) {
    // Fall back to configured default only when no valid user selection is present.
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
  var modelSelect = document.getElementById('ai-model-input');
  if (!statusEl || !providerSelect) return;

  var provider = providerSelect.value;
  var status = _aiProviderStatus[provider] || {};
  var hasPersonalKey = userHasApiKey(provider);

  if (!hasPersonalKey && !status.configured) {
    statusEl.textContent = provider === 'anthropic'
      ? 'Status: no Anthropic key configured. Add your own API key above to use Claude.'
      : 'Status: AI proxy not ready for ' + provider + '. Add your own API key above, or contact an admin.';
    return;
  }

  var selectedModel = modelSelect ? String(modelSelect.value || '').trim() : '';
  var text = hasPersonalKey
    ? 'Status: using your personal ' + provider + ' API key.'
    : 'Status: managed backend access is active for ' + provider + '.';
  if (selectedModel) {
    text += ' Using: ' + selectedModel;
  }

  var modelAccess = _aiModelAccess[provider];
  if (modelAccess && modelAccess.error) {
    text += ' Model access check: ' + modelAccess.error;
  } else if (modelAccess && selectedModel) {
    text += modelAccess.requestedModelVisible
      ? ' Model access: available.'
      : ' Model access: not visible to current API project/key.';
  }

  statusEl.textContent = text;
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
  var key = provider || getSelectedAiProvider();
  if (userHasApiKey(key)) return true;
  var status = _aiProviderStatus[key] || {};
  return !!status.configured;
}
