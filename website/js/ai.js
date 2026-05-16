// ai.js - frontend AI client via Firebase Functions proxy.

var _aiClientUid = null;
var ALLOWED_AI_PROVIDERS = {
  openai: true
};
var DEFAULT_AI_MODELS = {
  openai: 'gpt-5.5'
};
var AI_PROXY_FUNCTION_URL = null;

function initAiClient(uid) {
  _aiClientUid = uid;
}

function getAiClientUid() {
  return _aiClientUid;
}

function resolveAiProxyUrl() {
  if (AI_PROXY_FUNCTION_URL) return AI_PROXY_FUNCTION_URL;

  if (typeof window !== 'undefined' && window.SEARCHES_AI_PROXY_URL) {
    AI_PROXY_FUNCTION_URL = String(window.SEARCHES_AI_PROXY_URL || '').trim();
    return AI_PROXY_FUNCTION_URL;
  }

  if (typeof firebaseConfig !== 'undefined' && firebaseConfig && firebaseConfig.aiProxyUrl) {
    AI_PROXY_FUNCTION_URL = String(firebaseConfig.aiProxyUrl || '').trim();
    return AI_PROXY_FUNCTION_URL;
  }

  AI_PROXY_FUNCTION_URL = 'https://us-central1-searches-app.cloudfunctions.net/aiProxy';
  return AI_PROXY_FUNCTION_URL;
}

function assertProvider(provider) {
  var key = String(provider || '').trim();
  if (!ALLOWED_AI_PROVIDERS[key]) {
    throw new Error('Unsupported AI provider: ' + key);
  }
  return key;
}

function getModelForProvider(provider, requestedModel) {
  var requested = String(requestedModel || '').trim();
  if (requested) return requested;
  return DEFAULT_AI_MODELS[provider] || '';
}

async function getCurrentUserIdToken() {
  try {
    if (!appAuth || !appAuth.currentUser) return '';
    return await appAuth.currentUser.getIdToken();
  } catch (err) {
    return '';
  }
}

async function callAiProxy(action, payload) {
  var url = resolveAiProxyUrl();
  var token = await getCurrentUserIdToken();
  var headers = {
    'Content-Type': 'application/json'
  };

  if (token) headers.Authorization = 'Bearer ' + token;

  var res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        action: action,
        payload: payload || {}
      })
    });
  } catch (err) {
    var base = (err && err.message) ? err.message : 'Failed to reach AI proxy.';
    throw new Error(base + ' Verify network/CORS and proxy URL: ' + url);
  }

  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) {
    var errMsg = (data && data.error && data.error.message) || (data && data.message) || ('AI proxy request failed (' + res.status + ').');
    throw new Error(errMsg);
  }

  return data;
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
  var targetSection = String(input.targetSection || 'searchPattern').trim();

  return [
    'You are a radiology assistant refining one section of a search-pattern step.',
    'Return ONLY valid JSON with this exact schema:',
    '{"step":{"stepTitle":"string","content":"string"}}',
    'Requirements:',
    '- Preserve clinical correctness and clarity.',
    '- Tone preset: ' + tone + '.',
    '- Mode: ' + mode + ' (rewrite = replace, append = add useful content).',
    '- Target section: ' + targetSection + ' (only modify this section\'s content).',
    taskPrompt ? ('- User instruction: ' + taskPrompt) : '- No extra user instruction provided.',
    '',
    'Current step title:',
    stepTitle,
    '',
    'Current section content:',
    stepContent
  ].join('\n');
}

async function requestProviderText(provider, model, prompt) {
  var safeProvider = assertProvider(provider);
  var payload = await callAiProxy('completeText', {
    provider: safeProvider,
    model: String(model || '').trim(),
    prompt: String(prompt || '')
  });
  var text = String((payload && payload.data && payload.data.text) || '').trim();
  if (!text) {
    throw new Error('AI proxy response did not contain text output.');
  }
  return text;
}

async function requestReportText(action, provider, model, prompt) {
  var safeProvider = assertProvider(provider);
  var payload = await callAiProxy(action, {
    provider: safeProvider,
    model: String(model || '').trim(),
    prompt: String(prompt || '')
  });
  var text = String((payload && payload.data && payload.data.text) || '').trim();
  if (!text) {
    throw new Error('AI proxy response did not contain report text output.');
  }
  return text;
}

function getAiProviderStatus() {
  return callAiProxy('status', {})
    .then(function(payload) {
      var providers = (payload && payload.data && payload.data.providers) || {};
      return { providers: providers };
    })
    .catch(function() {
      return {
        providers: {
          openai: {
            configured: false,
            defaultModel: DEFAULT_AI_MODELS.openai || 'gpt-4o-mini'
          }
        }
      };
    });
}

async function testAiProvider(provider, model) {
  var safeProvider = assertProvider(provider);
  var resolvedModel = getModelForProvider(safeProvider, model);
  var payload = await callAiProxy('test', {
    provider: safeProvider,
    model: resolvedModel
  });
  var ok = !!(payload && payload.data && payload.data.ok);
  if (!ok) throw new Error('Provider test failed.');
  return {
    ok: true,
    provider: safeProvider,
    model: resolvedModel
  };
}

async function generatePatternFromAi(options) {
  var input = options || {};
  var safeProvider = assertProvider(input.provider || 'openai');
  var model = getModelForProvider(safeProvider, input.model);
  var prompt = buildPatternPrompt(input);

  var raw = await requestReportText('generateReport', safeProvider, model, prompt);
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

  var raw = await requestReportText('refineReport', safeProvider, model, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('AI did not return valid JSON for step update.');
  }

  return coerceStepResponse(parsed, input.stepTitle);
}

function normaliseReportSections(inputSections) {
  var sections = Array.isArray(inputSections) ? inputSections : [];
  var cleaned = sections
    .map(function(item) { return String(item || '').trim(); })
    .filter(Boolean);
  return cleaned.length ? cleaned : ['Findings', 'Impression'];
}

function coerceReportResponse(parsed, fallbackSections) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI returned invalid report JSON.');
  }

  var finalized = parsed.finalized !== false;
  var questions = Array.isArray(parsed.questions)
    ? parsed.questions.map(function(q) { return String(q || '').trim(); }).filter(Boolean)
    : [];
  var sections = parsed.sections && typeof parsed.sections === 'object' ? parsed.sections : {};
  var ordered = normaliseReportSections(fallbackSections);
  var outputSections = {};

  Object.keys(sections).forEach(function(key) {
    var sectionTitle = String(key || '').trim();
    if (!sectionTitle) return;
    outputSections[sectionTitle] = String(sections[key] || '').trim();
  });

  ordered.forEach(function(sectionTitle) {
    if (!Object.prototype.hasOwnProperty.call(outputSections, sectionTitle)) {
      outputSections[sectionTitle] = '';
    }
  });

  if (!Object.keys(outputSections).length) {
    throw new Error('AI did not return report sections.');
  }

  return {
    finalized: finalized,
    questions: questions,
    sections: outputSections
  };
}

function buildReportGenerationPrompt(input) {
  var findings = String(input.findings || '').trim();
  var sections = normaliseReportSections(input.sectionOrder);
  var templateText = String(input.templateText || '').trim();
  var globalRulesText = String(input.globalRulesText || '').trim();

  var lines = [
    'You are an expert radiologist generating a complete, structured radiology report.',
    'Return ONLY valid JSON with this exact schema:',
    '{"finalized":boolean,"questions":["string"],"sections":{"SectionName":"string"}}',
    '',
    'INSTRUCTIONS:',
    '- Write each section in full — never truncate or summarize prematurely.',
    '- Use precise, professional radiology language.',
    '- Do not include markdown code fences in your JSON response.',
    '- Set finalized=true and questions=[] in every response.',
    '',
    'FINDINGS (provided by the radiologist):',
    findings || '(none provided)'
  ];

  if (templateText) {
    lines.push(
      '',
      'REPORT TEMPLATE — PRIMARY OUTPUT STRUCTURE:',
      'The template below defines all required section names and any existing boilerplate.',
      'Use the template section headings as the keys in your "sections" JSON object.',
      'Preserve all boilerplate text already in the template; expand blanks and',
      'placeholder lines with content derived from the findings above.',
      templateText
    );
  } else {
    lines.push(
      '',
      'OUTPUT SECTIONS (populate each in order): ' + sections.join(', ')
    );
  }

  if (globalRulesText) {
    lines.push('', 'GLOBAL RULES (always apply):', globalRulesText);
  }

  return lines.join('\n');
}

function buildReportRefinementPrompt(input) {
  var draftSections = input.draftSections && typeof input.draftSections === 'object' ? input.draftSections : {};
  var refineRequest = String(input.refineRequest || '').trim();
  var sections = normaliseReportSections(input.sectionOrder);

  return [
    'You are refining a radiology report draft.',
    'Return ONLY valid JSON with this schema:',
    '{"finalized":boolean,"questions":["string"],"sections":{"SectionName":"string"}}',
    'Rules:',
    '- Preserve clinical correctness.',
    '- Apply the user refinement request.',
    '- Keep section names aligned to requested sections.',
    '- Do not include markdown code fences.',
    '',
    'Requested output sections: ' + sections.join(', ') + '.',
    '',
    'Current draft sections JSON:',
    JSON.stringify(draftSections),
    '',
    'User refinement request:',
    refineRequest || '(none provided)'
  ].join('\n');
}

async function generateRadiologyReportWithAi(options) {
  var input = options || {};
  var safeProvider = assertProvider(input.provider || 'openai');
  var model = getModelForProvider(safeProvider, input.model);
  var prompt = buildReportGenerationPrompt(input);

  var raw = await requestProviderText(safeProvider, model, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('AI did not return valid JSON for report generation.');
  }
  return coerceReportResponse(parsed, input.sectionOrder);
}

async function refineRadiologyReportWithAi(options) {
  var input = options || {};
  var safeProvider = assertProvider(input.provider || 'openai');
  var model = getModelForProvider(safeProvider, input.model);
  var prompt = buildReportRefinementPrompt(input);

  var raw = await requestProviderText(safeProvider, model, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('AI did not return valid JSON for report refinement.');
  }
  return coerceReportResponse(parsed, input.sectionOrder);
}
