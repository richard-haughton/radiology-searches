// ai.js - browser-direct AI client (no Firebase Functions required).

var _aiClientUid = null;
var AI_SETTINGS_STORAGE_KEY = 'searches.ai.settings.v1';
var ALLOWED_AI_PROVIDERS = {
  openai: true,
  anthropic: true,
  githubModels: true
};
var DEFAULT_AI_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  githubModels: 'gpt-4o-mini'
};

function initAiClient(uid) {
  _aiClientUid = uid;
}

function getAiClientUid() {
  return _aiClientUid;
}

function assertProvider(provider) {
  var key = String(provider || '').trim();
  if (!ALLOWED_AI_PROVIDERS[key]) {
    throw new Error('Unsupported AI provider: ' + key);
  }
  return key;
}

function readAiSettings() {
  try {
    var raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return { providers: {} };
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { providers: {} };
    if (!parsed.providers || typeof parsed.providers !== 'object') parsed.providers = {};
    return parsed;
  } catch (err) {
    console.error('Failed to read AI settings from localStorage:', err);
    return { providers: {} };
  }
}

function writeAiSettings(settings) {
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify(settings || { providers: {} }));
}

function maskKeyHint(apiKey) {
  var key = String(apiKey || '').trim();
  if (key.length < 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function getProviderConfig(provider) {
  var safeProvider = assertProvider(provider);
  var settings = readAiSettings();
  var cfg = settings.providers[safeProvider] || {};
  var apiKey = String(cfg.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('No API key saved for ' + safeProvider + '.');
  }
  return {
    provider: safeProvider,
    apiKey: apiKey,
    defaultModel: String(cfg.defaultModel || '').trim()
  };
}

function getModelForProvider(provider, requestedModel) {
  var requested = String(requestedModel || '').trim();
  if (requested) return requested;
  var cfg = getProviderConfig(provider);
  if (cfg.defaultModel) return cfg.defaultModel;
  return DEFAULT_AI_MODELS[provider] || '';
}

function safeJsonParse(text) {
  var src = String(text || '').trim();
  if (!src) return null;

  var fenceMatch = src.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    src = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(src);
  } catch (err) {
    return null;
  }
}

function coercePatternResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI returned invalid pattern JSON.');
  }

  var name = String(parsed.name || '').trim() || 'AI Generated Pattern';
  var modality = String(parsed.modality || '').trim() || 'Other';
  var rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  var steps = rawSteps
    .map(function(step) {
      return {
        stepTitle: String((step && step.stepTitle) || '').trim(),
        content: String((step && step.content) || '').trim()
      };
    })
    .filter(function(step) {
      return step.stepTitle || step.content;
    });

  if (!steps.length) {
    throw new Error('AI returned no usable steps.');
  }

  return {
    pattern: {
      name: name,
      modality: modality,
      steps: steps
    }
  };
}

function coerceStepResponse(parsed, fallbackTitle) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI returned invalid step JSON.');
  }

  var step = parsed.step && typeof parsed.step === 'object' ? parsed.step : parsed;
  var content = String(step.content || '').trim();
  if (!content) {
    throw new Error('AI returned empty step content.');
  }

  return {
    step: {
      stepTitle: String(step.stepTitle || fallbackTitle || '').trim(),
      content: content
    }
  };
}

function buildPatternPrompt(input) {
  var sourcePatterns = Array.isArray(input.sourcePatterns) ? input.sourcePatterns : [];
  var tone = String(input.tonePreset || 'concise').trim();
  var taskPrompt = String(input.taskPrompt || '').trim();
  var modality = String(input.modality || '').trim();

  return [
    'You are a radiology assistant generating a structured search pattern.',
    'Return ONLY valid JSON with this exact schema:',
    '{"name":"string","modality":"string","steps":[{"stepTitle":"string","content":"string"}]}',
    'Requirements:',
    '- Keep language clinically useful and concise.',
    '- Use ordered, practical step titles.',
    '- Keep each step content focused and actionable.',
    '- Tone preset: ' + tone + '.',
    modality ? ('- Modality preference: ' + modality + '.') : '- Infer modality from sources if possible.',
    taskPrompt ? ('- Additional instruction: ' + taskPrompt) : '- No extra user instruction provided.',
    '',
    'Source patterns JSON:',
    JSON.stringify(sourcePatterns)
  ].join('\n');
}

function buildStepPrompt(input) {
  var mode = String(input.mode || 'rewrite').trim();
  var tone = String(input.tonePreset || 'concise').trim();
  var taskPrompt = String(input.taskPrompt || '').trim();
  var stepTitle = String(input.stepTitle || '').trim();
  var stepContent = String(input.stepContent || '').trim();

  return [
    'You are a radiology assistant refining one search-pattern step.',
    'Return ONLY valid JSON with this exact schema:',
    '{"step":{"stepTitle":"string","content":"string"}}',
    'Requirements:',
    '- Preserve clinical correctness and clarity.',
    '- Tone preset: ' + tone + '.',
    '- Mode: ' + mode + ' (rewrite = replace, append = add useful content).',
    taskPrompt ? ('- User instruction: ' + taskPrompt) : '- No extra user instruction provided.',
    '',
    'Current step title:',
    stepTitle,
    '',
    'Current step content:',
    stepContent
  ].join('\n');
}

async function postOpenAiCompatible(url, apiKey, model, prompt) {
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Return strict JSON only. Do not include markdown fences.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  var payload = await res.json().catch(function() { return {}; });
  if (!res.ok) {
    var errMsg = (payload && payload.error && payload.error.message) || ('API request failed (' + res.status + ').');
    throw new Error(errMsg);
  }

  var choices = (payload && payload.choices) || [];
  var message = choices[0] && choices[0].message;
  var content = message && message.content;

  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(function(part) {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  throw new Error('API response did not contain text output.');
}

async function postAnthropic(apiKey, model, prompt) {
  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1400,
      temperature: 0.2,
      system: 'Return strict JSON only. Do not include markdown fences.',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  var payload = await res.json().catch(function() { return {}; });
  if (!res.ok) {
    var errMsg = (payload && payload.error && payload.error.message) || ('API request failed (' + res.status + ').');
    throw new Error(errMsg);
  }

  var contentParts = (payload && payload.content) || [];
  var text = contentParts.map(function(part) {
    return (part && typeof part.text === 'string') ? part.text : '';
  }).join('');

  if (!text.trim()) {
    throw new Error('Anthropic response did not contain text output.');
  }

  return text;
}

async function requestProviderText(provider, model, prompt) {
  var cfg = getProviderConfig(provider);

  if (provider === 'openai') {
    return postOpenAiCompatible('https://api.openai.com/v1/chat/completions', cfg.apiKey, model, prompt);
  }
  if (provider === 'githubModels') {
    return postOpenAiCompatible('https://models.inference.ai.azure.com/chat/completions', cfg.apiKey, model, prompt);
  }
  if (provider === 'anthropic') {
    return postAnthropic(cfg.apiKey, model, prompt);
  }

  throw new Error('Unsupported AI provider: ' + provider);
}

function saveAiProviderKey(provider, apiKey, defaultModel) {
  var safeProvider = assertProvider(provider);
  var key = String(apiKey || '').trim();
  if (!key) throw new Error('API key is required.');

  var settings = readAiSettings();
  settings.providers[safeProvider] = {
    apiKey: key,
    defaultModel: String(defaultModel || '').trim(),
    updatedAt: Date.now()
  };
  writeAiSettings(settings);

  return Promise.resolve({ ok: true });
}

function removeAiProviderKey(provider) {
  var safeProvider = assertProvider(provider);
  var settings = readAiSettings();
  delete settings.providers[safeProvider];
  writeAiSettings(settings);
  return Promise.resolve({ ok: true });
}

function getAiProviderStatus() {
  var settings = readAiSettings();
  var providers = {};

  Object.keys(ALLOWED_AI_PROVIDERS).forEach(function(provider) {
    var cfg = settings.providers[provider] || {};
    var apiKey = String(cfg.apiKey || '').trim();
    providers[provider] = {
      configured: !!apiKey,
      keyHint: apiKey ? maskKeyHint(apiKey) : '',
      defaultModel: String(cfg.defaultModel || '').trim()
    };
  });

  return Promise.resolve({ providers: providers });
}

async function testAiProvider(provider, model) {
  var safeProvider = assertProvider(provider);
  var resolvedModel = getModelForProvider(safeProvider, model);
  var prompt = [
    'Respond with only this JSON:',
    '{"ok":true,"message":"connection-ok"}'
  ].join('\n');

  var raw = await requestProviderText(safeProvider, resolvedModel, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed || parsed.ok !== true) {
    throw new Error('Provider test failed: invalid response.');
  }

  return { ok: true, provider: safeProvider, model: resolvedModel };
}

async function generatePatternFromAi(options) {
  var input = options || {};
  var safeProvider = assertProvider(input.provider || 'openai');
  var model = getModelForProvider(safeProvider, input.model);
  var prompt = buildPatternPrompt(input);

  var raw = await requestProviderText(safeProvider, model, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('AI did not return valid JSON for pattern generation.');
  }

  return coercePatternResponse(parsed);
}

async function modifyStepWithAi(options) {
  var input = options || {};
  var safeProvider = assertProvider(input.provider || 'openai');
  var model = getModelForProvider(safeProvider, input.model);
  var prompt = buildStepPrompt(input);

  var raw = await requestProviderText(safeProvider, model, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('AI did not return valid JSON for step update.');
  }

  return coerceStepResponse(parsed, input.stepTitle);
}
