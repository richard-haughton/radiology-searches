#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_CHUNK_SIZE = 250;
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';
const SEED_FILE = path.join(__dirname, 'data', 'emergency_radiology_findings_seed.json');
const ALLOWED_MODALITIES = new Set(['CT', 'MRI', 'US', 'Plain Radiograph', 'Nuclear Medicine', 'Other']);

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    uid: '',
    apply: false,
    chunkSize: DEFAULT_CHUNK_SIZE,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--project' && argv[index + 1]) {
      args.projectId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--database' && argv[index + 1]) {
      args.databaseId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--uid' && argv[index + 1]) {
      args.uid = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--chunk-size' && argv[index + 1]) {
      args.chunkSize = Number(argv[index + 1]) || DEFAULT_CHUNK_SIZE;
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
    }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/import_emergency_radiology_findings.js --uid <uid> [options]',
    '',
    'Options:',
    '  --uid <uid>          Target user library (required)',
    '  --project <id>       Firebase project id (default: searches-app)',
    '  --database <id>      Firestore database id (default: (default))',
    '  --apply              Write the findings seed into Firestore',
    '  --chunk-size <n>     Writes per commit batch (default: 250)',
    '  --help, -h           Show this help text'
  ].join('\n'));
}

async function readAccessToken() {
  const raw = JSON.parse(fs.readFileSync(FIREBASE_TOKEN_FILE, 'utf8'));
  const refreshToken = raw && raw.tokens && raw.tokens.refresh_token;
  if (refreshToken) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: FIREBASE_CLIENT_ID,
      client_secret: FIREBASE_CLIENT_SECRET
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) {
      throw new Error(`Failed to refresh Firebase CLI access token (${response.status}): ${await response.text()}`);
    }
    const payload = await response.json();
    if (payload && payload.access_token) return payload.access_token;
  }
  throw new Error(`No usable Firebase access token found in ${FIREBASE_TOKEN_FILE}`);
}

function normaliseFindingName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeFindingId(name) {
  const key = normaliseFindingName(name);
  return key ? `finding_${key.replace(/\s+/g, '_').slice(0, 120)}` : '';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normaliseModalities(items) {
  const seen = {};
  return (items || []).map(item => String(item || '').trim() || 'Other').filter(item => {
    const safe = ALLOWED_MODALITIES.has(item) ? item : 'Other';
    if (seen[safe]) return false;
    seen[safe] = 1;
    return true;
  }).map(item => ALLOWED_MODALITIES.has(item) ? item : 'Other').sort();
}

function normaliseLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    patternId: String(raw.patternId || '').trim(),
    patternName: String(raw.patternName || '').trim(),
    modality: String(raw.modality || '').trim() || 'Other',
    stepId: String(raw.stepId || '').trim(),
    stepTitle: String(raw.stepTitle || '').trim(),
    subsectionId: String(raw.subsectionId || '').trim()
  };
}

function linkKey(link) {
  return [link.patternId, link.stepId, link.subsectionId].join('::');
}

function mergeLinks(baseLinks, incomingLinks) {
  const seen = {};
  const out = [];
  function append(link) {
    const safe = normaliseLink(link);
    if (!safe) return;
    const key = linkKey(safe);
    if (!safe.patternId || !safe.stepId || !safe.subsectionId || seen[key]) return;
    seen[key] = 1;
    out.push(safe);
  }
  (baseLinks || []).forEach(append);
  (incomingLinks || []).forEach(append);
  return out;
}

function contentSignature(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type === 'image') return JSON.stringify({ type: 'image', format: chunk.format || 'png', data: chunk.data || '' });
  if (chunk.type === 'link') return JSON.stringify({ type: 'link', text: chunk.text || '', url: chunk.url || '' });
  if (chunk.type === 'subsection') return JSON.stringify({ type: 'subsection', title: chunk.title || '', content: clone(chunk.content || []) });
  return JSON.stringify({ type: 'text', text: chunk.text || '', bold: Boolean(chunk.bold), color: chunk.color || null });
}

function mergeContent(baseContent, incomingContent) {
  const out = clone(baseContent || []);
  const seen = {};
  out.forEach(chunk => {
    seen[contentSignature(chunk)] = 1;
  });
  clone(incomingContent || []).forEach(chunk => {
    const key = contentSignature(chunk);
    if (!key || seen[key]) return;
    seen[key] = 1;
    out.push(chunk);
  });
  return out;
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return Boolean(value.booleanValue);
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    const values = Array.isArray(value.arrayValue && value.arrayValue.values) ? value.arrayValue.values : [];
    return values.map(decodeFirestoreValue);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    const fields = (value.mapValue && value.mapValue.fields) || {};
    const out = {};
    Object.keys(fields).forEach(key => {
      out[key] = decodeFirestoreValue(fields[key]);
    });
    return out;
  }
  return null;
}

function decodeDocument(document) {
  const out = { __name: document.name };
  const fields = document.fields || {};
  Object.keys(fields).forEach(key => {
    out[key] = decodeFirestoreValue(fields[key]);
  });
  return out;
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    if (Number.isFinite(value)) return { doubleValue: value };
    return { nullValue: null };
  }
  if (typeof value === 'object') {
    const fields = {};
    Object.keys(value).forEach(key => {
      fields[key] = encodeFirestoreValue(value[key]);
    });
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function toFirestoreDocument(name, data) {
  const payload = Object.assign({}, data);
  delete payload.__name;
  const fields = {};
  Object.keys(payload).forEach(key => {
    fields[key] = encodeFirestoreValue(payload[key]);
  });
  return { name, fields };
}

async function fetchJson(url, accessToken, options) {
  const response = await fetch(url, {
    method: (options && options.method) || 'GET',
    headers: Object.assign({
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }, (options && options.headers) || {}),
    body: options && options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    throw new Error(`Firestore request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function listFindings(config, uid) {
  let pageToken = '';
  const docs = [];
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents/users/${uid}/findings`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchJson(url.toString(), config.accessToken);
    (response.documents || []).forEach(doc => docs.push(decodeDocument(doc)));
    pageToken = response.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function commitWrites(config, writes) {
  if (!writes.length) return;
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents:commit`;
  await fetchJson(url, config.accessToken, { method: 'POST', body: { writes } });
}

function buildSeedContent(entry) {
  return [{
    type: 'text',
    text: [
      `Clinical: ${entry.clinical}`,
      `Imaging: ${entry.imaging}`,
      `Report: ${entry.report}`,
      `Treatment: ${entry.treatment}`
    ].join('\n'),
    bold: false,
    color: null
  }];
}

function loadSeedData() {
  const parsed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Seed file is not an array: ${SEED_FILE}`);
  return parsed.map(entry => ({
    name: String(entry.name || '').trim(),
    modalities: normaliseModalities(entry.modalities || []),
    isRedFinding: Boolean(entry.isRedFinding),
    content: buildSeedContent(entry)
  })).filter(entry => entry.name);
}

function buildMergedFinding(existing, seed) {
  const mergedLinks = mergeLinks(existing && existing.links, []);
  const mergedModalities = normaliseModalities([].concat(existing && existing.modalities || [], seed.modalities || [], mergedLinks.map(link => link.modality)));
  return {
    name: seed.name,
    nameKey: normaliseFindingName(seed.name),
    content: mergeContent(existing && existing.content, seed.content),
    isRedFinding: Boolean((existing && existing.isRedFinding) || seed.isRedFinding),
    modalities: mergedModalities,
    links: mergedLinks,
    createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.uid) {
    throw new Error('Missing required --uid');
  }

  const seed = loadSeedData();
  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  const existingDocs = await listFindings(config, args.uid);
  const existingById = {};
  existingDocs.forEach(doc => {
    const id = String(doc.__name || '').split('/').pop();
    existingById[id] = doc;
  });

  const writes = [];
  let createCount = 0;
  let updateCount = 0;
  seed.forEach(entry => {
    const findingId = makeFindingId(entry.name);
    if (!findingId) return;
    const existing = existingById[findingId] || null;
    const merged = buildMergedFinding(existing, entry);
    const name = `projects/${config.projectId}/databases/${config.databaseId}/documents/users/${args.uid}/findings/${findingId}`;
    writes.push({ update: toFirestoreDocument(name, merged) });
    if (existing) updateCount += 1;
    else createCount += 1;
  });

  console.log('Emergency radiology findings seed summary:');
  console.log(JSON.stringify({
    uid: args.uid,
    seedCount: seed.length,
    existingFindings: existingDocs.length,
    creates: createCount,
    updates: updateCount
  }, null, 2));
  console.log('Sample findings:');
  seed.slice(0, 5).forEach(entry => console.log(`- ${entry.name}`));

  if (!args.apply) {
    console.log('Preview only; no Firestore writes were made.');
    return;
  }

  for (let index = 0; index < writes.length; index += args.chunkSize) {
    const slice = writes.slice(index, index + args.chunkSize);
    await commitWrites(config, slice);
    console.log(`Applied ${Math.min(index + args.chunkSize, writes.length)} / ${writes.length} writes`);
  }

  console.log('Emergency radiology findings import complete.');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});