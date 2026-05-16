// settings.js - AI settings UI for managed backend provider access.

var _settingsUid = null;
var _settingsInitialised = false;
var _aiProviderStatus = {};
var _aiModelAccess = {};
var _reportGeneratorSettings = {
  defaultSections: ['Findings', 'Impression'],
  globalRulesText: ''
};

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

  var saveReportSettingsBtn = document.getElementById('btn-save-report-settings');
  if (saveReportSettingsBtn) {
    saveReportSettingsBtn.addEventListener('click', handleSaveReportSettings);
  }

  updateModelDropdown(providerSelect.value);
  hydrateProviderInputs();
  refreshAiProviderStatus();
  loadReportGeneratorSettings();

  // Also refresh when Settings tab is opened to pick up any recent status changes.
  var settingsTabBtn = document.querySelector('.tab-btn[data-tab="settings"]');
  if (settingsTabBtn) {
    settingsTabBtn.addEventListener('click', function() {
      refreshAiProviderStatus();
      loadReportGeneratorSettings();
    });
  }
}

function parseSectionsCsv(input) {
  var raw = String(input || '');
  var list = raw.split(',').map(function(item) { return item.trim(); }).filter(Boolean);
  return list.length ? list : ['Findings', 'Impression'];
}

function renderReportGeneratorSettings(settings) {
  var sectionsEl = document.getElementById('report-default-sections');
  var rulesEl = document.getElementById('report-global-rules');
  if (!sectionsEl || !rulesEl) return;

  var safe = settings || _reportGeneratorSettings;
  sectionsEl.value = (safe.defaultSections || ['Findings', 'Impression']).join(', ');
  rulesEl.value = safe.globalRulesText || '';
}

function setReportSettingsStatus(text, isError) {
  var el = document.getElementById('report-settings-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--danger)' : '';
}

async function loadReportGeneratorSettings() {
  if (!_settingsUid || typeof getUserReportSettings !== 'function') return;
  try {
    var settings = await getUserReportSettings(_settingsUid);
    _reportGeneratorSettings = {
      defaultSections: Array.isArray(settings.defaultSections) && settings.defaultSections.length
        ? settings.defaultSections
        : ['Findings', 'Impression'],
      globalRulesText: String(settings.globalRulesText || '')
    };
    renderReportGeneratorSettings(_reportGeneratorSettings);
    setReportSettingsStatus('');
  } catch (err) {
    setReportSettingsStatus((err && err.message) || 'Failed to load report settings.', true);
  }
}

async function handleSaveReportSettings() {
  if (!_settingsUid || typeof saveUserReportSettings !== 'function') return;
  var sectionsEl = document.getElementById('report-default-sections');
  var rulesEl = document.getElementById('report-global-rules');
  if (!sectionsEl || !rulesEl) return;

  var payload = {
    defaultSections: parseSectionsCsv(sectionsEl.value),
    globalRulesText: String(rulesEl.value || '')
  };

  try {
    await saveUserReportSettings(_settingsUid, payload);
    _reportGeneratorSettings = payload;
    setReportSettingsStatus('Saved.');
    showToast('Report settings saved.');
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('report-settings-changed', { detail: { settings: getReportGeneratorSettings() } }));
    }
  } catch (err) {
    setReportSettingsStatus((err && err.message) || 'Failed to save report settings.', true);
    showToast((err && err.message) || 'Failed to save report settings.', true);
  }
}

function getReportGeneratorSettings() {
  return {
    defaultSections: Array.isArray(_reportGeneratorSettings.defaultSections)
      ? _reportGeneratorSettings.defaultSections.slice()
      : ['Findings', 'Impression'],
    globalRulesText: String(_reportGeneratorSettings.globalRulesText || '')
  };
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
  if (!status.configured) {
    statusEl.textContent = 'Status: AI proxy not ready for ' + provider + '. Contact admin to configure backend key.';
    return;
  }

  var selectedModel = modelSelect ? String(modelSelect.value || '').trim() : '';
  var text = 'Status: managed backend access is active for ' + provider + '.';
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
  var status = _aiProviderStatus[provider || getSelectedAiProvider()] || {};
  return !!status.configured;
}
