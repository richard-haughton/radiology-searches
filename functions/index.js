const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_PROMPT_LENGTH = 24000;
const MAX_REQUEST_BYTES = 80 * 1024;

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
  if (origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000') return true;

  try {
    const parsed = new URL(origin);
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

async function completeWithOpenAi(apiKey, model, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
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

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerMsg =
      (payload && payload.error && payload.error.message) ||
      'OpenAI request failed (' + response.status + ').';
    throw new Error(providerMsg);
  }

  const text = extractAssistantText(payload).trim();
  if (!text) {
    throw new Error('OpenAI response did not contain text output.');
  }

  return text;
}

exports.aiProxy = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 30,
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
        message: err && err.message ? err.message : String(err)
      });

      json(res, 500, {
        ok: false,
        error: {
          code: 'proxy-failed',
          message: err && err.message ? err.message : 'AI proxy failed.'
        }
      });
    }
  }
);
