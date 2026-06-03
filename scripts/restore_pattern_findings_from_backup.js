#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_PATTERN_NAME = 'CT Abdomen Pelvis';
const DEFAULT_BACKUP_PATH = '/Users/dillonhaughton/Documents/Searches_Backups/backups/firebase_database_export_searches-app_2026-05-23T15-36-14-680Z.json';
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    patternName: DEFAULT_PATTERN_NAME,
    uid: '',
    backupPath: DEFAULT_BACKUP_PATH,
    apply: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--project' && argv[i + 1]) args.projectId = argv[++i];
    else if (arg === '--database' && argv[i + 1]) args.databaseId = argv[++i];
    else if (arg === '--pattern-name' && argv[i + 1]) args.patternName = argv[++i];
    else if (arg === '--uid' && argv[i + 1]) args.uid = argv[++i];
    else if (arg === '--backup' && argv[i + 1]) args.backupPath = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/restore_pattern_findings_from_backup.js [options]',
    '',
    'Options:',
    '  --pattern-name <name>  Pattern name to restore findings for (default: CT Abdomen Pelvis)',
    '  --uid <uid>            Restrict to one user uid (recommended when multiple users exist)',
    '  --backup <path>        Firestore export JSON path',
    '  --project <id>         Firebase project id (default: searches-app)',
    '  --database <id>        Firestore database id (default: (default))',
    '  --apply                Write changes to Firestore (default is dry-run)',
    '  --help, -h             Show this help'
  ].join('\n'));
}

function stripStepPrefix(title) {
  return String(title || '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^step\s+\d+[:.]?\s*/i, '')
    .trim()
    .toLowerCase();
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function decodeFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) {
    const values = Array.isArray(v.arrayValue && v.arrayValue.values) ? v.arrayValue.values : [];
    return values.map(decodeFirestoreValue);
  }
  if ('mapValue' in v) {
    const fields = (v.mapValue && v.mapValue.fields) || {};
    const out = {};
    Object.keys(fields).forEach(k => {
      out[k] = decodeFirestoreValue(fields[k]);
    });
    return out;
  }
  return null;
}

function decodeDocument(doc) {
  const out = { __name: doc.name };
  const fields = doc.fields || {};
  Object.keys(fields).forEach(k => {
    out[k] = decodeFirestoreValue(fields[k]);
  });
  return out;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    if (Number.isFinite(v)) return { doubleValue: v };
    return { nullValue: null };
  }
  if (typeof v === 'object') {
    const fields = {};
    Object.keys(v).forEach(k => {
      fields[k] = encodeValue(v[k]);
    });
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function readBackupPatterns(backupPath) {
  const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const users = raw && raw.users && typeof raw.users === 'object' ? raw.users : {};
  const docs = [];
  Object.keys(users).forEach(uid => {
    const patterns = Array.isArray(users[uid].patterns) ? users[uid].patterns : [];
    patterns.forEach(pattern => {
      docs.push({ uid, pattern });
    });
  });
  return docs;
}

function normaliseStepSections(step) {
  const safe = step && typeof step === 'object' ? step : {};
  const sections = safe.sections && typeof safe.sections === 'object' ? clone(safe.sections) : {};
  if (!Array.isArray(sections.dontMissPathology)) sections.dontMissPathology = [];
  if (!Array.isArray(sections.searchPattern)) sections.searchPattern = [];
  return sections;
}

function subsectionKey(item) {
  if (!item || typeof item !== 'object') return '';
  const findingId = String(item.findingId || '').trim();
  const subsectionId = String(item.subsectionId || '').trim();
  const title = String(item.title || '').trim().toLowerCase();
  return [findingId, subsectionId, title].join('|');
}

function mergeMissingFindings(currentSteps, backupSteps) {
  const nextSteps = clone(currentSteps || []);
  const backupByStepId = {};
  const backupByTitle = {};

  (backupSteps || []).forEach(step => {
    const stepId = String((step && step.stepId) || '').trim();
    const titleKey = stripStepPrefix(step && step.stepTitle);
    if (stepId) backupByStepId[stepId] = step;
    if (titleKey && !backupByTitle[titleKey]) backupByTitle[titleKey] = step;
  });

  let addedTotal = 0;
  const perStep = [];

  nextSteps.forEach((step, index) => {
    const stepId = String((step && step.stepId) || '').trim();
    const titleKey = stripStepPrefix(step && step.stepTitle);
    const backupStep = (stepId && backupByStepId[stepId]) || backupByTitle[titleKey] || null;
    if (!backupStep) return;

    const currentSections = normaliseStepSections(step);
    const backupSections = normaliseStepSections(backupStep);
    const currentFindings = Array.isArray(currentSections.dontMissPathology) ? currentSections.dontMissPathology : [];
    const backupFindings = Array.isArray(backupSections.dontMissPathology) ? backupSections.dontMissPathology : [];
    if (!backupFindings.length) return;

    const seen = {};
    currentFindings.forEach(item => {
      const key = subsectionKey(item);
      if (key) seen[key] = 1;
      const fid = String((item && item.findingId) || '').trim();
      const title = String((item && item.title) || '').trim().toLowerCase();
      if (fid) seen[`fid:${fid}`] = 1;
      if (title) seen[`title:${title}`] = 1;
    });

    let added = 0;
    backupFindings.forEach(item => {
      if (!item || item.type !== 'subsection') return;
      const key = subsectionKey(item);
      const fid = String(item.findingId || '').trim();
      const title = String(item.title || '').trim().toLowerCase();
      if ((key && seen[key]) || (fid && seen[`fid:${fid}`]) || (title && seen[`title:${title}`])) {
        return;
      }
      currentFindings.push(clone(item));
      if (key) seen[key] = 1;
      if (fid) seen[`fid:${fid}`] = 1;
      if (title) seen[`title:${title}`] = 1;
      added += 1;
    });

    if (added > 0) {
      step.sections = currentSections;
      step.sections.dontMissPathology = currentFindings;
      addedTotal += added;
      perStep.push({
        index,
        stepTitle: String(step.stepTitle || ''),
        added
      });
    }
  });

  return { nextSteps, addedTotal, perStep };
}

async function readAccessToken() {
  const raw = JSON.parse(fs.readFileSync(FIREBASE_TOKEN_FILE, 'utf8'));
  const refreshToken = raw && raw.tokens && raw.tokens.refresh_token;
  if (!refreshToken) throw new Error(`No usable Firebase access token in ${FIREBASE_TOKEN_FILE}`);

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
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  const payload = await response.json();
  if (!payload || !payload.access_token) throw new Error('No access_token from token endpoint');
  return payload.access_token;
}

async function fetchJson(url, accessToken, opts) {
  const response = await fetch(url, {
    method: (opts && opts.method) || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
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
  return rows.filter(r => r && r.document).map(r => decodeDocument(r.document));
}

function extractUidFromPatternName(docName) {
  const match = String(docName || '').match(/\/documents\/users\/([^/]+)\/patterns\/[^/]+$/);
  return match ? match[1] : '';
}

async function commitPatternSteps(config, patternDocName, steps) {
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents:commit`;
  const writes = [{
    update: {
      name: patternDocName,
      fields: {
        steps: encodeValue(steps),
        updatedAt: encodeValue(new Date().toISOString())
      }
    },
    updateMask: {
      fieldPaths: ['steps', 'updatedAt']
    }
  }];
  await fetchJson(url, config.accessToken, { method: 'POST', body: { writes } });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(args.backupPath)) {
    throw new Error(`Backup file not found: ${args.backupPath}`);
  }

  const backupDocs = readBackupPatterns(args.backupPath).filter(entry => {
    const name = String(entry && entry.pattern && entry.pattern.name || '').trim();
    if (name !== String(args.patternName).trim()) return false;
    if (args.uid && String(entry.uid) !== String(args.uid)) return false;
    return true;
  });

  if (!backupDocs.length) {
    throw new Error(`No backup pattern found for name "${args.patternName}"` + (args.uid ? ` and uid "${args.uid}".` : '.'));
  }

  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  const livePatternDocs = (await runCollectionGroupQuery(config, 'patterns')).filter(doc => {
    const name = String(doc.name || '').trim();
    if (name !== String(args.patternName).trim()) return false;
    const uid = extractUidFromPatternName(doc.__name);
    if (args.uid && uid !== String(args.uid)) return false;
    return true;
  });

  if (!livePatternDocs.length) {
    throw new Error(`No live pattern found for name "${args.patternName}"` + (args.uid ? ` and uid "${args.uid}".` : '.'));
  }

  let totalPatternsChanged = 0;
  let totalAddedFindings = 0;

  for (const live of livePatternDocs) {
    const uid = extractUidFromPatternName(live.__name);
    const backup = backupDocs.find(entry => {
      if (entry.uid !== uid) return false;
      const backupId = String(entry.pattern && entry.pattern.id || '').trim();
      const liveId = String(live.id || '').trim();
      if (backupId && liveId && backupId === liveId) return true;
      return String(entry.pattern && entry.pattern.name || '').trim() === String(live.name || '').trim();
    });

    if (!backup) {
      console.log(`Skipping live pattern for uid ${uid}: no matching backup entry found.`);
      continue;
    }

    const currentSteps = Array.isArray(live.steps) ? live.steps : [];
    const backupSteps = Array.isArray(backup.pattern.steps) ? backup.pattern.steps : [];
    const merged = mergeMissingFindings(currentSteps, backupSteps);

    if (!merged.addedTotal) {
      console.log(`No missing findings to restore for uid ${uid}, pattern ${live.id}.`);
      continue;
    }

    console.log(`uid ${uid}, pattern ${live.id}: restore ${merged.addedTotal} findings across ${merged.perStep.length} steps`);
    merged.perStep.forEach(item => {
      console.log(`  - step ${item.index + 1} (${item.stepTitle || 'Untitled Step'}): +${item.added}`);
    });

    if (args.apply) {
      await commitPatternSteps(config, live.__name, merged.nextSteps);
      console.log('  applied');
    } else {
      console.log('  dry-run only (use --apply to write)');
    }

    totalPatternsChanged += 1;
    totalAddedFindings += merged.addedTotal;
  }

  if (!totalPatternsChanged) {
    console.log('No patterns required changes.');
    return;
  }

  console.log(`Done. Patterns changed: ${totalPatternsChanged}. Findings restored: ${totalAddedFindings}.`);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
