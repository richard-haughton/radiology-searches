const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

const DEFAULT_MODEL = 'gpt-5.5';
const MAX_PROMPT_LENGTH = 24000;
const MAX_REQUEST_BYTES = 80 * 1024;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_TIMEOUT_MS = 12000;
const RESPONSES_CREATE_TIMEOUT_MS = 20000;
const RESPONSES_POLL_TIMEOUT_MS = 10000;
const RESPONSES_MAX_WAIT_MS = 50000;

let openAiModelCache = {
  expiresAt: 0,
  modelIds: []
};

// Per-IP pre-auth guard (wide window, loose limit — catches unauthenticated floods)
const IP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const IP_RATE_LIMIT_MAX = 40;
const ipBuckets = new Map();

// Per-user quota (tighter — applied after auth on real-work actions)
const USER_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const USER_RATE_LIMIT_MAX = 20;
const userBuckets = new Map();

function json(res, status, payload) {
  res.status(status).set('Content-Type', 'application/json').send(JSON.stringify(payload));
}

function isAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const parsed = new URL(origin);
    if (
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      parsed.protocol === 'http:'
    ) return true;
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.github.io');
  } catch (err) {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.get('origin') || '';
  if (isAllowedOrigin(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function checkRateLimit(buckets, key, windowMs, max) {
  const now = Date.now();
  const bucket = (buckets.get(key) || []).filter((ts) => now - ts < windowMs);
  if (bucket.length >= max) return false;
  bucket.push(now);
  buckets.set(key, bucket);
  return true;
}

function checkIpRateLimit(req) {
  const ipHeader = req.get('x-forwarded-for') || '';
  const ip = String(ipHeader.split(',')[0] || req.ip || 'unknown').trim() || 'unknown';
  return checkRateLimit(ipBuckets, ip, IP_RATE_LIMIT_WINDOW_MS, IP_RATE_LIMIT_MAX);
}

function checkUserRateLimit(uid) {
  return checkRateLimit(userBuckets, uid, USER_RATE_LIMIT_WINDOW_MS, USER_RATE_LIMIT_MAX);
}

async function verifyAuth(req) {
  const authHeader = String(req.get('Authorization') || '').trim();
  if (!authHeader.startsWith('Bearer ')) {
    throw Object.assign(new Error('Authentication required.'), { code: 'unauthenticated', status: 401 });
  }

  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) {
    throw Object.assign(new Error('Authentication required.'), { code: 'unauthenticated', status: 401 });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return { uid: decoded.uid };
  } catch (err) {
    throw Object.assign(new Error('Invalid or expired session. Please sign in again.'), {
      code: 'unauthenticated',
      status: 401
    });
  }
}

function sanitizePrompt(input) {
  return String(input || '').slice(0, MAX_PROMPT_LENGTH);
}

function getPayload(req) {
  if (!req.body || typeof req.body !== 'object') return {};
  return req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
}

function extractAssistantText(payload) {
  const choices = (payload && payload.choices) || [];
  const message = choices[0] && choices[0].message;
  const content = message && message.content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }

  return '';
}

function isAbortError(err) {
  if (!err) return false;
  return err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('aborted');
}

function getOpenAiErrorMessage(payload, fallback) {
  return (payload && payload.error && payload.error.message) || fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return '';
}

async function openAiJsonRequest(apiKey, method, path, body, timeoutMs) {
  const url = 'https://api.openai.com' + path;
  const headers = {
    Authorization: 'Bearer ' + apiKey
  };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw Object.assign(new Error('OpenAI request timed out.'), {
        code: 'upstream-timeout',
        status: 504
      });
    }
    throw Object.assign(new Error('Failed to connect to OpenAI.'), {
      code: 'upstream-network',
      status: 502
    });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const baseMsg = 'OpenAI request failed (' + response.status + ').';
    const message = getOpenAiErrorMessage(payload, baseMsg);
    let code = 'provider-error';
    if (response.status === 429) code = 'rate-limited';
    if (response.status === 401 || response.status === 403) code = 'provider-auth';
    if (response.status === 404) code = 'model-not-visible';
    if (response.status >= 500) code = 'upstream-error';

    throw Object.assign(new Error(message), {
      code,
      status: response.status
    });
  }

  return payload;
}

async function listOpenAiModels(apiKey, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && openAiModelCache.expiresAt > now && openAiModelCache.modelIds.length) {
    return openAiModelCache.modelIds.slice();
  }

  const payload = await openAiJsonRequest(apiKey, 'GET', '/v1/models', null, MODEL_LIST_TIMEOUT_MS);
  const modelIds = ((payload && payload.data) || [])
    .map((item) => String((item && item.id) || '').trim())
    .filter(Boolean)
    .sort();

  openAiModelCache = {
    expiresAt: now + MODEL_CACHE_TTL_MS,
    modelIds
  };
  return modelIds.slice();
}

async function completeWithOpenAi(apiKey, model, prompt) {
  const selectedModel = model || DEFAULT_MODEL;
  const requestBody = {
    model: selectedModel,
    instructions: 'Return strict JSON only. Do not include markdown fences.',
    input: prompt,
    store: true
  };

  const modelName = String(selectedModel).toLowerCase();
  if (!modelName.startsWith('gpt-5')) {
    requestBody.temperature = 0.2;
  } else {
    requestBody.background = true;
  }

  const initial = await openAiJsonRequest(
    apiKey,
    'POST',
    '/v1/responses',
    requestBody,
    RESPONSES_CREATE_TIMEOUT_MS
  );

  let finalPayload = initial;
  const isPending = (status) => status === 'queued' || status === 'in_progress';

  if (isPending(String(initial.status || '')) && initial.id) {
    const deadline = Date.now() + RESPONSES_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await wait(1500);
      const polled = await openAiJsonRequest(
        apiKey,
        'GET',
        '/v1/responses/' + encodeURIComponent(initial.id),
        null,
        RESPONSES_POLL_TIMEOUT_MS
      );
      finalPayload = polled;
      if (!isPending(String(polled.status || ''))) break;
    }
  }

  const status = String(finalPayload.status || '').toLowerCase();
  if (status && status !== 'completed') {
    const failureMsg = getOpenAiErrorMessage(
      finalPayload,
      'OpenAI response ended with status "' + status + '".'
    );
    throw Object.assign(new Error(failureMsg), {
      code: status === 'incomplete' ? 'upstream-timeout' : 'provider-error',
      status: status === 'incomplete' ? 504 : 502
    });
  }

  const text = extractResponseText(finalPayload);
  if (!text) {
    throw new Error('OpenAI response did not contain text output.');
  }

  return text;
}

exports.aiProxy = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 60,
    memory: '256MiB',
    invoker: 'public',
    secrets: [OPENAI_API_KEY]
  },
  async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      json(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: 'Use POST.' }
      });
      return;
    }

    const contentLength = Number(req.get('content-length') || '0');
    if (contentLength > MAX_REQUEST_BYTES) {
      json(res, 413, {
        ok: false,
        error: { code: 'payload-too-large', message: 'Request is too large.' }
      });
      return;
    }

    // Pre-auth IP guard: broad flood protection before any token work.
    if (!checkIpRateLimit(req)) {
      json(res, 429, {
        ok: false,
        error: { code: 'rate-limited', message: 'Too many requests from this address. Please try again shortly.' }
      });
      return;
    }

    const action = String((req.body && req.body.action) || '').trim();
    const payload = getPayload(req);

    // Status is intentionally public so the frontend can show availability without auth.
    if (action === 'status') {
      const apiKey = String(OPENAI_API_KEY.value() || '').trim();
      json(res, 200, {
        ok: true,
        data: {
          providers: {
            openai: {
              configured: !!apiKey,
              defaultModel: DEFAULT_MODEL
            }
          }
        }
      });
      return;
    }

    // All other actions require a valid Firebase Auth session.
    let uid;
    try {
      ({ uid } = await verifyAuth(req));
    } catch (authErr) {
      json(res, authErr.status || 401, {
        ok: false,
        error: { code: authErr.code || 'unauthenticated', message: authErr.message }
      });
      return;
    }

    // Per-user quota after auth.
    if (!checkUserRateLimit(uid)) {
      json(res, 429, {
        ok: false,
        error: { code: 'rate-limited', message: 'Too many AI requests. Please wait a moment and try again.' }
      });
      return;
    }

    try {
      const apiKey = String(OPENAI_API_KEY.value() || '').trim();
      const model = String(payload.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const provider = String(payload.provider || 'openai').trim() || 'openai';

      if (provider !== 'openai') {
        json(res, 400, {
          ok: false,
          error: { code: 'unsupported-provider', message: 'Only OpenAI is supported right now.' }
        });
        return;
      }

      if (!apiKey) {
        json(res, 503, {
          ok: false,
          error: { code: 'missing-backend-key', message: 'AI backend key is not configured.' }
        });
        return;
      }

      if (action === 'modelAccess') {
        const requestedModel = String(payload.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
        const modelIds = await listOpenAiModels(apiKey, Boolean(payload.forceRefresh));
        const visible = modelIds.includes(requestedModel);
        const gpt55Visible = modelIds.includes('gpt-5.5');

        json(res, 200, {
          ok: true,
          data: {
            provider: 'openai',
            requestedModel,
            requestedModelVisible: visible,
            gpt55Visible,
            defaultModel: DEFAULT_MODEL,
            modelIds
          }
        });
        return;
      }

      if (action === 'test') {
        await completeWithOpenAi(
          apiKey,
          model,
          'Respond with only this JSON: {"ok":true,"message":"connection-ok"}'
        );

        json(res, 200, {
          ok: true,
          data: { ok: true, provider: 'openai', model: model }
        });
        return;
      }

      if (action === 'completeText') {
        const prompt = sanitizePrompt(payload.prompt);
        if (!prompt) {
          json(res, 400, {
            ok: false,
            error: { code: 'invalid-prompt', message: 'Prompt is required.' }
          });
          return;
        }

        const text = await completeWithOpenAi(apiKey, model, prompt);
        logger.info('aiProxy completeText', { uid, model, provider });
        json(res, 200, {
          ok: true,
          data: {
            provider: 'openai',
            model: model,
            text: text
          }
        });
        return;
      }

      json(res, 400, {
        ok: false,
        error: { code: 'invalid-action', message: 'Unsupported action.' }
      });
    } catch (err) {
      logger.error('aiProxy failed', {
        uid: uid || 'unknown',
        action: action,
        code: err && err.code ? err.code : 'proxy-failed',
        status: err && err.status ? err.status : 500,
        message: err && err.message ? err.message : String(err)
      });

      json(res, (err && err.status) || 500, {
        ok: false,
        error: {
          code: (err && err.code) || 'proxy-failed',
          message: err && err.message ? err.message : 'AI proxy failed.'
        }
      });
    }
  }
);
