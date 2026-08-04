#!/usr/bin/env node

// Backfills legacy embedded base64 images (in `patterns` and `findings` docs)
// to Cloud Storage, replacing each {type:'image', data} chunk with a
// {type:'image', url, path} reference. Mirrors the REST/OAuth conventions of
// scripts/migrate_findings_to_entities.js — no new npm dependencies.
//
// Dry-run by default (counts only, no uploads, no writes). Pass --apply to
// actually upload images and commit the rewritten documents.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_BUCKET = 'searches-app.firebasestorage.app';
const DEFAULT_CHUNK_SIZE = 300;
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    bucket: DEFAULT_BUCKET,
    outDir: path.join(process.cwd(), 'backups'),
    apply: false,
    writePreview: true,
    backupFirst: false,
    uid: '',
    chunkSize: DEFAULT_CHUNK_SIZE,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--project' && argv[index + 1]) { args.projectId = argv[++index]; continue; }
    if (arg === '--database' && argv[index + 1]) { args.databaseId = argv[++index]; continue; }
    if (arg === '--bucket' && argv[index + 1]) { args.bucket = argv[++index]; continue; }
    if (arg === '--out-dir' && argv[index + 1]) { args.outDir = path.resolve(argv[++index]); continue; }
    if (arg === '--uid' && argv[index + 1]) { args.uid = argv[++index]; continue; }
    if (arg === '--chunk-size' && argv[index + 1]) { args.chunkSize = Number(argv[++index]) || DEFAULT_CHUNK_SIZE; continue; }
    if (arg === '--apply') { args.apply = true; continue; }
    if (arg === '--backup-first') { args.backupFirst = true; continue; }
    if (arg === '--write-preview') { args.writePreview = true; continue; }
    if (arg === '--no-preview') { args.writePreview = false; continue; }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/migrate_images_to_storage.js [options]',
    '',
    'Backfills legacy embedded base64 images in patterns/findings docs to',
    'Cloud Storage. Dry-run by default — only counts what would migrate.',
    '',
    'Options:',
    '  --project <id>       Firebase project id (default: searches-app)',
    '  --database <id>      Firestore database id (default: (default))',
    '  --bucket <name>      Storage bucket (default: searches-app.firebasestorage.app)',
    '  --out-dir <dir>      Preview/backup output directory (default: backups)',
    '  --uid <uid>          Restrict to one user library',
    '  --apply              Actually upload images and write updated docs',
    '  --backup-first       Create a JSON backup before applying changes',
    '  --chunk-size <n>     Number of writes per commit batch (default: 300)',
    '  --write-preview      Write a preview JSON summary (default)',
    '  --no-preview         Skip preview JSON output',
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

  const token = raw && raw.tokens && raw.tokens.access_token;
  if (!token) throw new Error(`No usable Firebase access token found in ${FIREBASE_TOKEN_FILE}`);
  return token;
}

function isoStampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Firestore REST encode/decode (mirrors migrate_findings_to_entities.js) ──

const TIMESTAMP_FIELD_NAMES = new Set(['updatedAt', 'createdAt', 'timestamp', 'sharedAt']);

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
    const out = {};
    const fields = (value.mapValue && value.mapValue.fields) || {};
    Object.keys(fields).forEach(key => { out[key] = decodeFirestoreValue(fields[key]); });
    return out;
  }
  return null;
}

function decodeDocument(document) {
  const out = { __name: document.name };
  const fields = document.fields || {};
  Object.keys(fields).forEach(key => { out[key] = decodeFirestoreValue(fields[key]); });
  return out;
}

function encodeFirestoreValue(value, fieldPath) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item, index) => encodeFirestoreValue(item, `${fieldPath}[${index}]`)) } };
  }
  const type = typeof value;
  if (type === 'string') {
    const key = String(fieldPath || '').split('.').pop().replace(/\[\d+\]$/, '');
    if (TIMESTAMP_FIELD_NAMES.has(key) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return { timestampValue: value };
    }
    return { stringValue: value };
  }
  if (type === 'boolean') return { booleanValue: value };
  if (type === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    if (Number.isFinite(value)) return { doubleValue: value };
    return { nullValue: null };
  }
  if (type === 'object') {
    const fields = {};
    Object.keys(value).forEach(key => { fields[key] = encodeFirestoreValue(value[key], fieldPath ? `${fieldPath}.${key}` : key); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function toFirestoreDocument(name, data) {
  const payload = Object.assign({}, data);
  delete payload.__name;
  const fields = {};
  Object.keys(payload).forEach(key => { fields[key] = encodeFirestoreValue(payload[key], key); });
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

async function runCollectionGroupQuery(config, collectionId) {
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents:runQuery`;
  const query = { structuredQuery: { from: [{ collectionId, allDescendants: true }] } };
  const rows = await fetchJson(url, config.accessToken, { method: 'POST', body: query });
  return rows.filter(row => row && row.document).map(row => decodeDocument(row.document));
}

async function commitWrites(config, writes) {
  if (!writes.length) return;
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents:commit`;
  await fetchJson(url, config.accessToken, { method: 'POST', body: { writes } });
}

function extractUidFromDocName(name, collectionId) {
  const match = String(name || '').match(new RegExp(`/documents/users/([^/]+)/${collectionId}/[^/]+$`));
  return match ? match[1] : '';
}

function runBackupScript(args) {
  const scriptPath = path.join(__dirname, 'export_firestore_database.js');
  const commandArgs = [scriptPath, '--project', args.projectId, '--database', args.databaseId, '--out-dir', args.outDir];
  childProcess.execFileSync(process.execPath, commandArgs, { stdio: 'inherit' });
}

// ── Cloud Storage upload (raw REST, same bearer token as Firestore) ─────────

function makeImageId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function uploadImageToStorage(config, uid, base64Data, format) {
  const safeFormat = String(format || 'jpeg').trim().toLowerCase() || 'jpeg';
  const ext = safeFormat === 'jpeg' ? 'jpg' : safeFormat;
  const objectPath = `users/${uid}/images/${makeImageId()}.${ext}`;
  const encodedPath = encodeURIComponent(objectPath);
  const bytes = Buffer.from(base64Data, 'base64');
  const token = crypto.randomUUID();

  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${config.bucket}/o?uploadType=media&name=${encodedPath}`;
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': `image/${safeFormat}`
    },
    body: bytes
  });
  if (!uploadResp.ok) {
    throw new Error(`Storage upload failed (${uploadResp.status}): ${await uploadResp.text()}`);
  }

  // Set a Firebase-style download token so the object is fetchable via a
  // plain <img src="..."> URL, matching what the client SDK's
  // getDownloadURL() produces (the token is a bypass for Storage rules,
  // by design, same as any Firebase Storage download link).
  const metaUrl = `https://storage.googleapis.com/storage/v1/b/${config.bucket}/o/${encodedPath}`;
  const metaResp = await fetch(metaUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ metadata: { firebaseStorageDownloadTokens: token } })
  });
  if (!metaResp.ok) {
    throw new Error(`Storage metadata update failed (${metaResp.status}): ${await metaResp.text()}`);
  }

  const url = `https://firebasestorage.googleapis.com/v0/b/${config.bucket}/o/${encodedPath}?alt=media&token=${token}`;
  return { url, path: objectPath };
}

// ── Rich content tree walking ────────────────────────────────────────────

function isLegacyImageChunk(chunk) {
  return Boolean(chunk) && chunk.type === 'image' && !chunk.url && chunk.data;
}

function countLegacyImages(content) {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  content.forEach(chunk => {
    if (!chunk || typeof chunk !== 'object') return;
    if (isLegacyImageChunk(chunk)) { count += 1; return; }
    if (chunk.type === 'subsection') { count += countLegacyImages(chunk.content || []); return; }
    if (chunk.type === 'list') {
      (chunk.items || []).forEach(item => {
        const raw = Array.isArray(item) ? item : (item && Array.isArray(item.content) ? item.content : []);
        count += countLegacyImages(raw);
      });
    }
  });
  return count;
}

async function migrateImagesInContent(content, uploadFn) {
  if (!Array.isArray(content)) return { content, count: 0 };
  let count = 0;

  const out = await Promise.all(content.map(async chunk => {
    if (!chunk || typeof chunk !== 'object') return chunk;

    if (chunk.type === 'image') {
      if (!isLegacyImageChunk(chunk)) return chunk;
      const uploaded = await uploadFn(chunk.data, chunk.format || 'jpeg');
      count += 1;
      return { type: 'image', url: uploaded.url, path: uploaded.path, format: chunk.format || 'jpeg' };
    }

    if (chunk.type === 'subsection') {
      const result = await migrateImagesInContent(chunk.content || [], uploadFn);
      count += result.count;
      return Object.assign({}, chunk, { content: result.content });
    }

    if (chunk.type === 'list') {
      const items = await Promise.all((chunk.items || []).map(async item => {
        const raw = Array.isArray(item) ? item : (item && Array.isArray(item.content) ? item.content : []);
        const result = await migrateImagesInContent(raw, uploadFn);
        count += result.count;
        return { content: result.content };
      }));
      return Object.assign({}, chunk, { items });
    }

    return chunk;
  }));

  return { content: out, count };
}

// ── Patterns ──────────────────────────────────────────────────────────────

function countLegacyImagesInPattern(pattern) {
  let count = 0;
  (pattern.steps || []).forEach(step => {
    if (Array.isArray(step.richContent)) count += countLegacyImages(step.richContent);
    if (step.sections && typeof step.sections === 'object') {
      Object.keys(step.sections).forEach(key => { count += countLegacyImages(step.sections[key] || []); });
    }
  });
  return count;
}

async function migratePatternImages(pattern, uid, config) {
  const uploadFn = (data, format) => uploadImageToStorage(config, uid, data, format);
  let count = 0;
  const nextSteps = await Promise.all((pattern.steps || []).map(async step => {
    const nextStep = Object.assign({}, step);
    if (Array.isArray(step.richContent)) {
      const result = await migrateImagesInContent(step.richContent, uploadFn);
      nextStep.richContent = result.content;
      count += result.count;
    }
    if (step.sections && typeof step.sections === 'object') {
      const nextSections = {};
      for (const key of Object.keys(step.sections)) {
        const result = await migrateImagesInContent(step.sections[key] || [], uploadFn);
        nextSections[key] = result.content;
        count += result.count;
      }
      nextStep.sections = nextSections;
    }
    return nextStep;
  }));
  return { pattern: Object.assign({}, pattern, { steps: nextSteps, updatedAt: new Date().toISOString() }), count };
}

// ── Findings (content field is a JSON-stringified array) ───────────────────

function countLegacyImagesInFinding(doc) {
  let contentArr = [];
  try { contentArr = JSON.parse(doc.content || '[]'); } catch (e) { contentArr = []; }
  return countLegacyImages(Array.isArray(contentArr) ? contentArr : []);
}

async function migrateFindingImages(doc, uid, config) {
  const uploadFn = (data, format) => uploadImageToStorage(config, uid, data, format);
  let contentArr = [];
  try { contentArr = JSON.parse(doc.content || '[]'); } catch (e) { contentArr = []; }
  const result = await migrateImagesInContent(Array.isArray(contentArr) ? contentArr : [], uploadFn);
  return {
    doc: Object.assign({}, doc, { content: JSON.stringify(result.content), updatedAt: new Date().toISOString() }),
    count: result.count
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  fs.mkdirSync(args.outDir, { recursive: true });

  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    bucket: args.bucket,
    accessToken: await readAccessToken()
  };

  console.log('Loading Firestore pattern and finding documents...');
  let patternDocs = await runCollectionGroupQuery(config, 'patterns');
  let findingDocs = await runCollectionGroupQuery(config, 'findings');
  if (args.uid) {
    patternDocs = patternDocs.filter(doc => extractUidFromDocName(doc.__name, 'patterns') === args.uid);
    findingDocs = findingDocs.filter(doc => extractUidFromDocName(doc.__name, 'findings') === args.uid);
  }
  console.log(`  Loaded ${patternDocs.length} pattern docs and ${findingDocs.length} finding docs${args.uid ? ` for UID ${args.uid}` : ''}.`);

  const patternsWithImages = patternDocs
    .map(doc => ({ doc, count: countLegacyImagesInPattern(doc) }))
    .filter(entry => entry.count > 0);
  const findingsWithImages = findingDocs
    .map(doc => ({ doc, count: countLegacyImagesInFinding(doc) }))
    .filter(entry => entry.count > 0);

  const totalImages = patternsWithImages.reduce((sum, e) => sum + e.count, 0)
    + findingsWithImages.reduce((sum, e) => sum + e.count, 0);

  const summary = {
    scannedPatterns: patternDocs.length,
    scannedFindings: findingDocs.length,
    patternsWithLegacyImages: patternsWithImages.length,
    findingsWithLegacyImages: findingsWithImages.length,
    totalLegacyImages: totalImages
  };
  console.log('Preview summary:');
  console.log(JSON.stringify(summary, null, 2));

  if (args.writePreview) {
    const preview = {
      generatedAt: new Date().toISOString(),
      projectId: args.projectId,
      databaseId: args.databaseId,
      scopedUid: args.uid || null,
      summary,
      patterns: patternsWithImages.map(e => ({
        uid: extractUidFromDocName(e.doc.__name, 'patterns'),
        patternId: String(e.doc.__name || '').split('/').pop(),
        name: e.doc.name || '',
        legacyImages: e.count
      })),
      findings: findingsWithImages.map(e => ({
        uid: extractUidFromDocName(e.doc.__name, 'findings'),
        findingId: String(e.doc.__name || '').split('/').pop(),
        name: e.doc.name || '',
        legacyImages: e.count
      }))
    };
    const previewPath = path.join(args.outDir, `image_migration_preview_${args.projectId}_${isoStampForFilename(new Date())}.json`);
    fs.writeFileSync(previewPath, JSON.stringify(preview, null, 2) + '\n');
    console.log(`Wrote preview to ${previewPath}`);
  }

  if (!args.apply) {
    console.log('Preview only; no images were uploaded and no Firestore writes were made.');
    return;
  }

  if (!totalImages) {
    console.log('No legacy embedded images found; nothing to migrate.');
    return;
  }

  if (args.backupFirst) {
    console.log('Creating JSON backup before applying changes...');
    runBackupScript(args);
  }

  console.log(`Uploading and rewriting ${patternsWithImages.length} pattern doc(s) and ${findingsWithImages.length} finding doc(s)...`);

  const writes = [];
  let uploaded = 0;

  for (const entry of patternsWithImages) {
    const uid = extractUidFromDocName(entry.doc.__name, 'patterns');
    if (!uid) continue;
    const result = await migratePatternImages(entry.doc, uid, config);
    uploaded += result.count;
    writes.push({ update: toFirestoreDocument(entry.doc.__name, result.pattern) });
    console.log(`  Pattern "${entry.doc.name || entry.doc.__name}": uploaded ${result.count} image(s)`);
  }

  for (const entry of findingsWithImages) {
    const uid = extractUidFromDocName(entry.doc.__name, 'findings');
    if (!uid) continue;
    const result = await migrateFindingImages(entry.doc, uid, config);
    uploaded += result.count;
    writes.push({ update: toFirestoreDocument(entry.doc.__name, result.doc) });
    console.log(`  Finding "${entry.doc.name || entry.doc.__name}": uploaded ${result.count} image(s)`);
  }

  console.log(`Uploaded ${uploaded} image(s). Committing ${writes.length} document write(s)...`);
  for (let index = 0; index < writes.length; index += args.chunkSize) {
    const slice = writes.slice(index, index + args.chunkSize);
    await commitWrites(config, slice);
    console.log(`  Committed ${Math.min(index + args.chunkSize, writes.length)} / ${writes.length} writes`);
  }

  console.log('Image migration complete.');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
