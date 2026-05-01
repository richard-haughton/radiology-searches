const crypto = require('crypto');

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const REGION = 'us-central1';
const AI_PROXY_SECRET = defineSecret('AI_PROXY_SECRET');
const ALLOWED_PROVIDERS = ['openai', 'anthropic', 'githubModels'];

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  githubModels: 'gpt-4o-mini'
};

function assertAuthed(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in is required.');
  }
  return request.auth.uid;
}

function assertProvider(provider) {
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new HttpsError('invalid-argument', 'Unsupported provider.');
  }
}

function getSecret() {
  const secret = AI_PROXY_SECRET.value() || process.env.APP_SECRET;
  if (!secret || secret.length < 16) {
    throw new HttpsError('failed-precondition', 'AI secret is not configured on server.');
  }
  return secret;
}

function getEncryptionKey() {
  return crypto.createHash('sha256').update(getSecret()).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
    v: 1
  };
}

function decrypt(payload) {
  if (!payload || !payload.iv || !payload.tag || !payload.data) {
    throw new HttpsError('failed-precondition', 'Provider key is not configured.');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function aiSettingsDoc(uid) {
  return db.collection('users').doc(uid).collection('private').doc('aiSettings');
}

async function getProviderRecord(uid, provider) {
  const snap = await aiSettingsDoc(uid).get();
  const providers = snap.exists ? (snap.data().providers || {}) : {};
  const record = providers[provider] || null;
  return { snap, providers, record };
}

function keyHintFromApiKey(apiKey) {
  const trimmed = String(apiKey || '').trim();
  if (trimmed.length < 6) return '***';
  const last4 = trimmed.slice(-4);
  return '***' + last4;
}

function normalizePlainText(input, maxLen) {
  return String(input || '').replace(/\r\n/g, '\n').trim().slice(0, maxLen);
}

function normalizeSourcePatterns(sourcePatterns) {
  if (!Array.isArray(sourcePatterns)) return [];

  return sourcePatterns.slice(0, 25).map((pattern) => {
    const steps = Array.isArray(pattern.steps) ? pattern.steps.slice(0, 80).map((step) => ({
      stepTitle: normalizePlainText(step.stepTitle, 200),
      content: normalizePlainText(step.content, 4000)
    })) : [];

    return {
      name: normalizePlainText(pattern.name, 200),
      modality: normalizePlainText(pattern.modality, 60),
      steps
    };
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      return JSON.parse(fenced[1]);
    }
    throw new HttpsError('internal', 'Model response was not valid JSON.');
  }
}

function normalizeGeneratedPattern(rawPattern) {
  const steps = Array.isArray(rawPattern.steps) ? rawPattern.steps.slice(0, 120).map((step, idx) => ({
    stepTitle: normalizePlainText(step.stepTitle || ('Step ' + (idx + 1)), 200) || ('Step ' + (idx + 1)),
    content: normalizePlainText(step.content, 5000)
  })).filter((step) => step.content.length > 0) : [];

  return {
    name: normalizePlainText(rawPattern.name || 'AI Generated Pattern', 180) || 'AI Generated Pattern',
    modality: normalizePlainText(rawPattern.modality || 'Other', 60) || 'Other',
    steps
  };
}

function buildTonePrompt(tonePreset) {
  switch (tonePreset) {
    case 'teaching':
      return 'Use a teaching style with rationale and brief pitfalls.';
    case 'resident-friendly':
      return 'Use resident-friendly language with direct, practical guidance.';
    default:
      return 'Use concise language.';
  }
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, messages }) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error('OpenAI-compatible provider error', { status: response.status, body: body.slice(0, 600) });
    throw new HttpsError('internal', 'Provider request failed.');
  }

  const data = await response.json();
  const text = (((data || {}).choices || [])[0] || {}).message?.content || '';
  return text;
}

async function callAnthropic({ apiKey, model, systemPrompt, userPrompt }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error('Anthropic provider error', { status: response.status, body: body.slice(0, 600) });
    throw new HttpsError('internal', 'Provider request failed.');
  }

  const data = await response.json();
  const text = (((data || {}).content || [])[0] || {}).text || '';
  return text;
}

async function callProviderJson(provider, apiKey, model, systemPrompt, userPrompt) {
  if (provider === 'openai') {
    const text = await callOpenAiCompatible({
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey,
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    return safeJsonParse(text);
  }

  if (provider === 'githubModels') {
    const text = await callOpenAiCompatible({
      baseUrl: 'https://models.inference.ai.azure.com/chat/completions',
      apiKey,
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    return safeJsonParse(text);
  }

  if (provider === 'anthropic') {
    const text = await callAnthropic({
      apiKey,
      model,
      systemPrompt,
      userPrompt
    });
    return safeJsonParse(text);
  }

  throw new HttpsError('invalid-argument', 'Unsupported provider.');
}

exports.saveAiProviderKey = onCall({ region: REGION, secrets: [AI_PROXY_SECRET] }, async (request) => {
  const uid = assertAuthed(request);
  const provider = normalizePlainText(request.data.provider, 40);
  const apiKey = String((request.data.apiKey || '')).trim();
  const defaultModel = normalizePlainText(request.data.defaultModel, 120);

  assertProvider(provider);

  if (apiKey.length < 12) {
    throw new HttpsError('invalid-argument', 'API key is too short.');
  }

  const encrypted = encrypt(apiKey);
  const ref = aiSettingsDoc(uid);

  await ref.set({
    providers: {
      [provider]: {
        encrypted,
        keyHint: keyHintFromApiKey(apiKey),
        defaultModel: defaultModel || DEFAULT_MODELS[provider],
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }
  }, { merge: true });

  return {
    ok: true,
    provider,
    keyHint: keyHintFromApiKey(apiKey)
  };
});

exports.removeAiProviderKey = onCall({ region: REGION, secrets: [AI_PROXY_SECRET] }, async (request) => {
  const uid = assertAuthed(request);
  const provider = normalizePlainText(request.data.provider, 40);
  assertProvider(provider);

  const ref = aiSettingsDoc(uid);
  await ref.set({
    providers: {
      [provider]: admin.firestore.FieldValue.delete()
    }
  }, { merge: true });

  return { ok: true, provider };
});

exports.getAiProviderStatus = onCall({ region: REGION, secrets: [AI_PROXY_SECRET] }, async (request) => {
  const uid = assertAuthed(request);
  const snap = await aiSettingsDoc(uid).get();
  const providers = snap.exists ? (snap.data().providers || {}) : {};

  const result = {};
  for (const provider of ALLOWED_PROVIDERS) {
    const record = providers[provider] || {};
    result[provider] = {
      configured: Boolean(record.encrypted && record.encrypted.data),
      keyHint: record.keyHint || '',
      defaultModel: record.defaultModel || DEFAULT_MODELS[provider]
    };
  }

  return { providers: result };
});

exports.testAiProvider = onCall({ region: REGION, timeoutSeconds: 60, secrets: [AI_PROXY_SECRET] }, async (request) => {
  const uid = assertAuthed(request);
  const provider = normalizePlainText(request.data.provider, 40);
  const model = normalizePlainText(request.data.model, 120);
  assertProvider(provider);

  const { record } = await getProviderRecord(uid, provider);
  const apiKey = decrypt(record.encrypted);
  const chosenModel = model || record.defaultModel || DEFAULT_MODELS[provider];

  const systemPrompt = 'Return valid JSON: {"ok":true}. No markdown.';
  const userPrompt = 'Respond with JSON only.';

  const json = await callProviderJson(provider, apiKey, chosenModel, systemPrompt, userPrompt);
  if (!json || json.ok !== true) {
    throw new HttpsError('internal', 'Provider test failed.');
  }

  return { ok: true, provider, model: chosenModel };
});

exports.generatePatternFromAi = onCall({ region: REGION, timeoutSeconds: 120, secrets: [AI_PROXY_SECRET] }, async (request) => {
  const uid = assertAuthed(request);
  const provider = normalizePlainText(request.data.provider, 40);
  const model = normalizePlainText(request.data.model, 120);
  const tonePreset = normalizePlainText(request.data.tonePreset, 40) || 'concise';
  const taskPrompt = normalizePlainText(request.data.taskPrompt, 2000);
  const sourcePatterns = normalizeSourcePatterns(request.data.sourcePatterns);

  assertProvider(provider);
  if (!sourcePatterns.length) {
    throw new HttpsError('invalid-argument', 'At least one source pattern is required.');
  }

  const { record } = await getProviderRecord(uid, provider);
  const apiKey = decrypt(record.encrypted);
  const chosenModel = model || record.defaultModel || DEFAULT_MODELS[provider];

  const systemPrompt = [
    'You generate radiology search patterns.',
    buildTonePrompt(tonePreset),
    'Return JSON only with shape:',
    '{"name":"...","modality":"...","steps":[{"stepTitle":"...","content":"..."}]}'
  ].join(' ');

  const userPrompt = JSON.stringify({
    task: taskPrompt || 'Generate a high-yield search pattern using the source patterns.',
    sourcePatterns
  });

  const raw = await callProviderJson(provider, apiKey, chosenModel, systemPrompt, userPrompt);
  const pattern = normalizeGeneratedPattern(raw || {});

  if (!pattern.steps.length) {
    throw new HttpsError('internal', 'Generated pattern had no usable steps.');
  }

  return { pattern };
});

exports.modifyStepWithAi = onCall({ region: REGION, timeoutSeconds: 90, secrets: [AI_PROXY_SECRET] }, async (request) => {
  const uid = assertAuthed(request);
  const provider = normalizePlainText(request.data.provider, 40);
  const model = normalizePlainText(request.data.model, 120);
  const mode = normalizePlainText(request.data.mode, 20);
  const tonePreset = normalizePlainText(request.data.tonePreset, 40) || 'concise';
  const taskPrompt = normalizePlainText(request.data.taskPrompt, 1600);
  const stepTitle = normalizePlainText(request.data.stepTitle, 200);
  const stepContent = normalizePlainText(request.data.stepContent, 6000);

  assertProvider(provider);
  if (mode !== 'rewrite' && mode !== 'append') {
    throw new HttpsError('invalid-argument', 'Mode must be rewrite or append.');
  }
  if (!stepContent) {
    throw new HttpsError('invalid-argument', 'Step content is required.');
  }

  const { record } = await getProviderRecord(uid, provider);
  const apiKey = decrypt(record.encrypted);
  const chosenModel = model || record.defaultModel || DEFAULT_MODELS[provider];

  const systemPrompt = [
    'You edit radiology search pattern steps.',
    buildTonePrompt(tonePreset),
    'Return JSON only with shape:',
    '{"stepTitle":"...","content":"..."}'
  ].join(' ');

  const userPrompt = JSON.stringify({
    mode,
    instruction: taskPrompt || (mode === 'append' ? 'Append useful details.' : 'Rewrite for clarity and quality.'),
    step: {
      stepTitle,
      content: stepContent
    }
  });

  const raw = await callProviderJson(provider, apiKey, chosenModel, systemPrompt, userPrompt);
  const step = {
    stepTitle: normalizePlainText(raw.stepTitle || stepTitle || 'Step', 200) || 'Step',
    content: normalizePlainText(raw.content || '', 7000)
  };

  if (!step.content) {
    throw new HttpsError('internal', 'Model returned empty step content.');
  }

  return { step };
});
