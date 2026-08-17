// ai.js - frontend AI client via Firebase Functions proxy.

var _aiClientUid = null;
var ALLOWED_AI_PROVIDERS = {
  openai: true,
  anthropic: true
};
var DEFAULT_AI_MODELS = {
  openai: 'gpt-5.5',
  anthropic: 'claude-sonnet-5'
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

function getAiProxyUrlCandidates() {
  var candidates = [];

  if (typeof window !== 'undefined' && window.SEARCHES_AI_PROXY_URL) {
    candidates.push(String(window.SEARCHES_AI_PROXY_URL || '').trim());
  }

  if (typeof firebaseConfig !== 'undefined' && firebaseConfig && firebaseConfig.aiProxyUrl) {
    candidates.push(String(firebaseConfig.aiProxyUrl || '').trim());
  }

  candidates.push('https://us-central1-searches-app.cloudfunctions.net/aiProxy');

  return candidates.filter(function(url, index, list) {
    return !!url && list.indexOf(url) === index;
  });
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
  var token = await getCurrentUserIdToken();
  var headers = {
    'Content-Type': 'application/json'
  };

  if (token) headers.Authorization = 'Bearer ' + token;

  var requestBody = JSON.stringify({
    action: action,
    payload: payload || {}
  });
  var urls = getAiProxyUrlCandidates();
  var lastError = null;

  for (var i = 0; i < urls.length; i += 1) {
    var url = urls[i];
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: requestBody
      });

      var data = await res.json().catch(function() { return {}; });
      if (!res.ok) {
        var errMsg = (data && data.error && data.error.message) || (data && data.message) || ('AI proxy request failed (' + res.status + ').');
        throw new Error(errMsg);
      }

      AI_PROXY_FUNCTION_URL = url;
      return data;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  var base = (lastError && lastError.message) ? lastError.message : 'Failed to reach AI proxy.';
  throw new Error(base + ' Tried: ' + urls.join(', '));
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
  var targetLabel = String(input.targetLabel || targetSection || 'searchPattern').trim();

  return [
    'You are a radiology assistant refining one section of a search-pattern step.',
    'Return ONLY valid JSON with this exact schema:',
    '{"step":{"stepTitle":"string","content":"string"}}',
    'Requirements:',
    '- Preserve clinical correctness and clarity.',
    '- Tone preset: ' + tone + '.',
    '- Mode: ' + mode + ' (rewrite = replace, append = add useful content).',
    '- Target section: ' + targetSection + ' (only modify this section\'s content).',
    '- Target detail: ' + targetLabel + '.',
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
          },
          anthropic: {
            configured: false,
            defaultModel: DEFAULT_AI_MODELS.anthropic || 'claude-sonnet-5'
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

function normaliseReportSections(inputSections) {
  var sections = Array.isArray(inputSections) ? inputSections : [];
  var cleaned = sections
    .map(function(item) { return String(item || '').trim(); })
    .filter(Boolean);
  return cleaned.length ? cleaned : ['Findings', 'Impression'];
}

function normaliseImpressionMode(mode) {
  var raw = String(mode || 'concise').trim();
  if (raw === 'expound') return 'expound';
  if (raw === 'omit') return 'omit';
  return 'concise';
}

function formatImpressionAsNumberedList(text, impressionMode) {
  var mode = normaliseImpressionMode(impressionMode);
  var source = String(text || '').trim();
  if (!source || mode === 'omit') return source;

  var items = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function(line) {
      return String(line || '')
        .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '')
        .trim();
    })
    .filter(Boolean);

  if (!items.length) return source;

  return items.map(function(item, index) {
    return String(index + 1) + '. ' + item;
  }).join('\n');
}

function coerceReportResponse(parsed, fallbackSections, impressionMode) {
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
    var sectionText = String(sections[key] || '').trim();
    outputSections[sectionTitle] = sectionTitle === 'Impression'
      ? formatImpressionAsNumberedList(sectionText, impressionMode)
      : sectionText;
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
  var sections = Array.isArray(input.sectionOrder) ? input.sectionOrder.slice() : ['Findings', 'Impression'];
  var findingsLanguageMode = String(input.findingsLanguageMode || 'improve').trim() === 'keep'
    ? 'keep'
    : (String(input.findingsLanguageMode || 'improve').trim() === 'omit' ? 'omit' : 'improve');
  var impressionMode = normaliseImpressionMode(input.impressionMode);
  var templateText = String(input.templateText || '').trim();
  var templateRulesText = String(input.templateRulesText || '').trim();
  var globalRulesText = String(input.globalRulesText || '').trim();

  var lines = [
    'You are an expert radiologist generating a complete, structured radiology report.',
    'Return ONLY valid JSON with this exact schema:',
    '{"finalized":boolean,"questions":["string"],"sections":{"SectionName":"string"}}',
    '',
    'INSTRUCTIONS:',
    '- Write each section in full — never truncate or summarize prematurely.',
    '- Use precise, professional radiology language.',
    '- If the findings are sparse, negative, or empty, generate standard normal radiology language for the relevant section rather than leaving it blank.',
    '- Do not add new abnormalities that are not supported by the findings.',
    '- Standard normal language is allowed when the findings indicate no abnormality or provide no actionable detail.',
    '- Do not include markdown code fences in your JSON response.',
    '- Set finalized=true and questions=[] in every response.',
    'Only include these section keys in the JSON response: ' + sections.join(', ') + '.',
    'Do not return omitted sections even if they appear in the report template.',
    findingsLanguageMode === 'keep'
      ? '- Language handling mode: KEEP EXACT LANGUAGE. Preserve the wording of the findings input as closely as possible. Do not paraphrase or polish the findings content. If the input contains only normal or minimal wording, you may use standard normal report language for the section while keeping the meaning unchanged.'
      : (findingsLanguageMode === 'omit'
          ? '- Findings section mode: OMIT. Do not return a Findings section.'
          : '- Findings section mode: IMPROVE LANGUAGE. Rewrite the findings into clear, polished radiology language while preserving the exact clinical meaning. If the findings are empty or normal, generate standard normal section language.'),
    impressionMode !== 'omit'
      ? '- For the Impression section, return a numbered list ordered from most important to least important. Use one item per line with the format 1., 2., 3.'
      : '- Impression section numbering rule: not applicable because Impression is omitted.',
    impressionMode === 'concise'
      ? '- Impression section mode: CONCISE. Summarize the most important aspects of the findings as a concise numbered list. Include differential diagnosis and recommendations only when supported and clinically appropriate.'
      : (impressionMode === 'expound'
          ? '- Impression section mode: EXPOUND. Provide a fuller analytical impression as a numbered list with diagnostic reasoning and recommendations when supported by the findings.'
          : '- Impression section mode: OMIT. Do not return an Impression section.'),
    '',
    'FINDINGS (provided by the radiologist):',
    findings || '(no findings provided; generate standard normal language as appropriate)'
  ];

  if (templateText) {
    lines.push(
      '',
      'REPORT TEMPLATE — PRIMARY OUTPUT STRUCTURE:',
      'The template below defines all required section names and any existing boilerplate.',
      'Use the template section headings as the keys in your "sections" JSON object.',
      'Treat the template as the source of truth for wording outside the supplied findings.',
      'For each template section, first ask: does the findings input explicitly provide abnormal or specific content for this section?',
      'If YES: update only the specific text supported by the findings.',
      'If NO: use standard normal radiology language for that section rather than leaving it blank.',
      'If a template contains a section that is not in the requested output sections, omit it from the response.',
      'Do not paraphrase unchanged template sections when the section already contains a normal boilerplate line that remains correct.',
      'Do not invent abnormalities, but do produce a normal statement when the section has nothing abnormal to report.',
      'If the template section already contains normal boilerplate that fits the findings, preserve it.',
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

  if (templateRulesText) {
    lines.push(
      '',
      'TEMPLATE-SPECIFIC RULES (apply these in addition to the template body and global rules):',
      templateRulesText
    );
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

function coerceVoiceNavigatorResponse(parsed, stepCount) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI returned invalid voice navigator JSON.');
  }

  var safeStepCount = Number.isInteger(stepCount) && stepCount > 0 ? stepCount : 1;
  var reply = String(parsed.reply || '').trim() || 'Okay.';

  var action = String(parsed.action || 'stay').trim().toLowerCase();
  if (['stay', 'next', 'previous', 'goto', 'repeat'].indexOf(action) === -1) {
    action = 'stay';
  }

  var targetStepIndex = null;
  if (action === 'goto') {
    var rawTarget = Number(parsed.targetStepIndex);
    targetStepIndex = Number.isFinite(rawTarget)
      ? Math.max(0, Math.min(Math.round(rawTarget), safeStepCount - 1))
      : null;
    if (targetStepIndex === null) action = 'stay';
  }

  var showFindings = parsed.showFindings === true;
  var findingsStepIndex = null;
  if (showFindings) {
    var rawFindingsTarget = Number(parsed.findingsStepIndex);
    findingsStepIndex = Number.isFinite(rawFindingsTarget)
      ? Math.max(0, Math.min(Math.round(rawFindingsTarget), safeStepCount - 1))
      : null;
  }

  return {
    reply: reply,
    action: action,
    targetStepIndex: targetStepIndex,
    showFindings: showFindings,
    findingsStepIndex: findingsStepIndex
  };
}

function buildVoiceNavigatorPrompt(input) {
  var patternName = String(input.patternName || 'this search pattern').trim();
  var steps = Array.isArray(input.steps) ? input.steps : [];
  var currentStepIndex = Number.isInteger(input.currentStepIndex) ? input.currentStepIndex : 0;
  var history = Array.isArray(input.history) ? input.history : [];
  var userMessage = String(input.userMessage || '').trim();

  var stepsBlock = steps.map(function(step, idx) {
    var lines = ['Step ' + (idx + 1) + (idx === currentStepIndex ? ' (CURRENT STEP)' : '') + ': ' + (step.title || '(untitled)')];
    if (step.searchPatternText) lines.push('  Search pattern: ' + step.searchPatternText);
    if (step.findingsText) lines.push('  Don\'t-miss findings: ' + step.findingsText);
    return lines.join('\n');
  }).join('\n\n');

  var historyBlock = history.map(function(turn) {
    var speaker = turn.role === 'user' ? 'Radiologist' : 'Navigator';
    return speaker + ': ' + turn.text;
  }).join('\n');

  return [
    'You are a hands-free voice navigator helping a radiologist read a study by walking them through a structured search pattern.',
    'You are speaking OUT LOUD via text-to-speech, so keep replies short and conversational — normally 1 to 3 sentences, unless the radiologist explicitly asks for more detail.',
    'The radiologist talks to you via speech-to-text, so their message may contain minor transcription errors; interpret intent charitably.',
    '',
    'Behavior rules:',
    '- Discuss the CURRENT STEP with the radiologist: orient them briefly, answer questions, and surface relevant "don\'t-miss" findings when useful.',
    '- Do not read step content verbatim unless asked; paraphrase concisely.',
    '- Only move to a different step when the radiologist clearly asks to (e.g. "next", "next step", "go back", "previous", "repeat", "go to step 4", "let\'s do the liver step").',
    '- Use action="next" / "previous" for relative moves, action="goto" with a zero-based targetStepIndex for a named/numbered step, action="repeat" to re-orient on the same step, action="stay" otherwise.',
    '- When moving to a new step, briefly summarize what mattered on the step just left (in your reply) before orienting on the new one.',
    '- If the radiologist asks to see, pull up, or review findings (for the current step or another step), set showFindings=true and findingsStepIndex to the relevant zero-based step index (default to the current step if unspecified), and mention them in your reply.',
    '- If the radiologist asks a clinical question about a finding, answer using only the information in the pattern below; do not invent findings not present in the data.',
    '',
    'Return ONLY valid JSON with this exact schema, no markdown fences:',
    '{"reply":"string","action":"stay|next|previous|goto|repeat","targetStepIndex":number|null,"showFindings":boolean,"findingsStepIndex":number|null}',
    '',
    'SEARCH PATTERN: ' + patternName,
    stepsBlock,
    '',
    historyBlock ? ('CONVERSATION SO FAR:\n' + historyBlock) : 'CONVERSATION SO FAR: (none yet — this is the start of the conversation)',
    '',
    'Radiologist just said: ' + (userMessage || '(no speech — they just switched into voice navigation mode; greet them and orient on the current step)')
  ].join('\n');
}

async function sendVoiceNavigatorTurn(options) {
  var input = options || {};
  var safeProvider = assertProvider(input.provider || 'openai');
  var model = getModelForProvider(safeProvider, input.model);
  var prompt = buildVoiceNavigatorPrompt(input);

  var raw = await requestProviderText(safeProvider, model, prompt);
  var parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('AI did not return valid JSON for voice navigation.');
  }

  var stepCount = Array.isArray(input.steps) ? input.steps.length : 1;
  return coerceVoiceNavigatorResponse(parsed, stepCount);
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
  return coerceReportResponse(parsed, input.sectionOrder, input.impressionMode);
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
  return coerceReportResponse(parsed, input.sectionOrder, input.impressionMode);
}
