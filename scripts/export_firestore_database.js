#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    outDir: path.join(process.cwd(), 'backups'),
    pretty: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
    if (arg === '--out-dir' && argv[index + 1]) {
      args.outDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--compact') {
      args.pretty = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/export_firestore_database.js [options]',
    '',
    'Options:',
    '  --project <id>      Firebase project id (default: searches-app)',
    '  --database <id>     Firestore database id (default: (default))',
    '  --out-dir <path>    Output directory for the backup JSON (default: ./backups)',
    '  --compact           Write compact JSON instead of pretty-printed JSON',
    '  --help, -h          Show this help text'
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
  if (!token) {
    throw new Error(`No usable Firebase access token found in ${FIREBASE_TOKEN_FILE}`);
  }
  return token;
}

function isoStampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return Boolean(value.booleanValue);
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'bytesValue')) return value.bytesValue;
  if (Object.prototype.hasOwnProperty.call(value, 'referenceValue')) return value.referenceValue;
  if (Object.prototype.hasOwnProperty.call(value, 'geoPointValue')) return value.geoPointValue;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    const values = Array.isArray(value.arrayValue && value.arrayValue.values) ? value.arrayValue.values : [];
    return values.map(decodeFirestoreValue);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    const out = {};
    const fields = (value.mapValue && value.mapValue.fields) || {};
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
  const query = {
    structuredQuery: {
      from: [{ collectionId, allDescendants: true }]
    }
  };
  const rows = await fetchJson(url, config.accessToken, { method: 'POST', body: query });
  return rows
    .filter(row => row && row.document)
    .map(row => decodeDocument(row.document));
}

async function listCollection(config, collectionPath) {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents/${collectionPath}`;
  let pageToken = '';
  const results = [];

  do {
    const url = new URL(baseUrl);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const payload = await fetchJson(url.toString(), config.accessToken);
    (payload.documents || []).forEach(document => {
      results.push(decodeDocument(document));
    });
    pageToken = payload.nextPageToken || '';
  } while (pageToken);

  return results;
}

function ensureUserBucket(users, uid) {
  if (!users[uid]) {
    users[uid] = {
      patternCount: 0,
      studyLogCount: 0,
      reportTemplateCount: 0,
      patterns: [],
      studyLog: [],
      reportTemplates: []
    };
  }
  return users[uid];
}

function groupDocsByUid(patternDocs, studyLogDocs, reportTemplateDocs) {
  const users = {};

  patternDocs.forEach(doc => {
    const match = String(doc.__name || '').match(/\/documents\/users\/([^/]+)\/patterns\/([^/]+)$/);
    if (!match) return;
    const uid = match[1];
    const patternId = match[2];
    const copy = Object.assign({ id: patternId }, doc);
    const bucket = ensureUserBucket(users, uid);
    bucket.patterns.push(copy);
    bucket.patternCount += 1;
  });

  studyLogDocs.forEach(doc => {
    const match = String(doc.__name || '').match(/\/documents\/users\/([^/]+)\/studyLog\/([^/]+)$/);
    if (!match) return;
    const uid = match[1];
    const logId = match[2];
    const copy = Object.assign({ id: logId }, doc);
    const bucket = ensureUserBucket(users, uid);
    bucket.studyLog.push(copy);
    bucket.studyLogCount += 1;
  });

  reportTemplateDocs.forEach(doc => {
    const match = String(doc.__name || '').match(/\/documents\/users\/([^/]+)\/reportTemplates\/([^/]+)$/);
    if (!match) return;
    const uid = match[1];
    const templateId = match[2];
    const copy = Object.assign({ id: templateId }, doc);
    const bucket = ensureUserBucket(users, uid);
    bucket.reportTemplates.push(copy);
    bucket.reportTemplateCount += 1;
  });

  Object.keys(users).forEach(uid => {
    users[uid].patterns.sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
    users[uid].studyLog.sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
    users[uid].reportTemplates.sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  });

  return users;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const exportedAt = new Date();
  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  console.log('Exporting users/{uid}/patterns via collection-group query...');
  const patternDocs = await runCollectionGroupQuery(config, 'patterns');
  console.log(`  Found ${patternDocs.length} pattern documents.`);

  console.log('Exporting users/{uid}/studyLog via collection-group query...');
  const studyLogDocs = await runCollectionGroupQuery(config, 'studyLog');
  console.log(`  Found ${studyLogDocs.length} study log documents.`);

  console.log('Exporting users/{uid}/reportTemplates via collection-group query...');
  const reportTemplateDocs = await runCollectionGroupQuery(config, 'reportTemplates');
  console.log(`  Found ${reportTemplateDocs.length} report template documents.`);

  console.log('Exporting sharedPatterns collection...');
  const sharedPatterns = await listCollection(config, 'sharedPatterns');
  console.log(`  Found ${sharedPatterns.length} shared pattern metadata documents.`);

  const users = groupDocsByUid(patternDocs, studyLogDocs, reportTemplateDocs);
  const userIds = Object.keys(users).sort();
  const mriPatternCount = patternDocs.filter(doc => String(doc.modality || '').toUpperCase() === 'MRI').length;

  const payload = {
    exportedAt: exportedAt.toISOString(),
    projectId: args.projectId,
    databaseId: args.databaseId,
    counts: {
      users: userIds.length,
      patterns: patternDocs.length,
      mriPatterns: mriPatternCount,
      studyLog: studyLogDocs.length,
      reportTemplates: reportTemplateDocs.length,
      sharedPatterns: sharedPatterns.length
    },
    users,
    sharedPatterns: sharedPatterns.sort((left, right) => String(left.patternName || '').localeCompare(String(right.patternName || '')))
  };

  const filename = `firebase_database_export_${args.projectId}_${isoStampForFilename(exportedAt)}.json`;
  const targetPath = path.join(args.outDir, filename);
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, args.pretty ? 2 : 0) + (args.pretty ? '\n' : ''));

  console.log(`Wrote backup to ${targetPath}`);
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});