#!/usr/bin/env node

// Restores empty `findings/{id}.content` docs from JSON pattern backups, for
// a given set of pattern names. Unlike restore_pattern_findings_from_backup.js
// (which only adds findings entirely missing from a pattern's steps) and
// restore_pattern_finding_content_from_entities.js (which only pulls from the
// *live* findings collection or hardcoded seed data), this script treats the
// findings collection as the thing to repair, sourcing content from backup
// JSON exports of the `patterns` collection (the only place these older
// backups captured embedded finding content).
//
// Only ever fills in findings whose live content is currently empty — never
// overwrites a finding that already has content. Dry-run by default.

'use strict';

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
    uid: '',
    patternNames: [],
    // Newest first: preferred source wins when multiple backups have content.
    backupPaths: [],
    apply: false,
    backupFirst: false,
    outDir: path.join(process.cwd(), 'backups'),
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--apply') { args.apply = true; continue; }
    if (arg === '--backup-first') { args.backupFirst = true; continue; }
    if (arg === '--uid' && argv[i + 1]) { args.uid = argv[++i]; continue; }
    if (arg === '--project' && argv[i + 1]) { args.projectId = argv[++i]; continue; }
    if (arg === '--database' && argv[i + 1]) { args.databaseId = argv[++i]; continue; }
    if (arg === '--out-dir' && argv[i + 1]) { args.outDir = path.resolve(argv[++i]); continue; }
    if (arg === '--pattern-name' && argv[i + 1]) { args.patternNames.push(argv[++i]); continue; }
    if (arg === '--backup' && argv[i + 1]) { args.backupPaths.push(argv[++i]); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/restore_finding_entities_from_backups.js [options]',
    '',
    'Options:',
    '  --pattern-name <name>  Pattern name to restore findings for (repeatable)',
    '  --backup <path>        Backup JSON path, newest first (repeatable)',
    '  --uid <uid>            Restrict to one user uid',
    '  --project <id>         Firebase project id (default: searches-app)',
    '  --database <id>        Firestore database id (default: (default))',
    '  --backup-first         Create a live Firestore JSON backup before applying',
    '  --out-dir <dir>        Backup/preview output directory (default: backups)',
    '  --apply                Write changes to Firestore (default is dry-run)',
    '  --help, -h             Show this help'
  ].join('\n'));
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function hasRenderableContent(content) {
  const chunks = Array.isArray(content) ? content : [];
  return chunks.some(chunk => {
    if (!chunk || typeof chunk !== 'object') return false;
    if (chunk.type === 'image') return Boolean(String(chunk.data || chunk.url || '').trim());
    if (chunk.type === 'link') return Boolean(String(chunk.url || '').trim() || String(chunk.text || '').trim());
    if (chunk.type === 'subsection') return hasRenderableContent(chunk.content || []);
    return Boolean(String(chunk.text || '').trim());
  });
}

function collectFindingsFromPattern(pattern) {
  const out = [];
  (pattern.steps || []).forEach(step => {
    ((step.sections || {}).dontMissPathology || []).forEach(item => {
      if (!item || item.type !== 'subsection') return;
      out.push({
        findingId: String(item.findingId || '').trim(),
        title: String(item.title || '').trim(),
        content: item.content || []
      });
    });
  });
  return out;
}

// ── Firestore REST helpers ──────────────────────────────────────────────

function decodeFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in v) {
    const fields = (v.mapValue && v.mapValue.fields) || {};
    const out = {};
    Object.keys(fields).forEach(k => { out[k] = decodeFirestoreValue(fields[k]); });
    return out;
  }
  return null;
}
function decodeDocument(doc) {
  const out = { __name: doc.name };
  const fields = doc.fields || {};
  Object.keys(fields).forEach(k => { out[k] = decodeFirestoreValue(fields[k]); });
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
    Object.keys(v).forEach(k => { fields[k] = encodeValue(v[k]); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function toFirestoreDoc(name, data) {
  const payload = Object.assign({}, data);
  delete payload.__name;
  const fields = {};
  Object.keys(payload).forEach(k => { fields[k] = encodeValue(payload[k]); });
  return { name, fields };
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
  if (!response.ok) throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  const payload = await response.json();
  if (!payload || !payload.access_token) throw new Error('No access_token from token endpoint');
  return payload.access_token;
}

async function fetchJson(url, accessToken, opts) {
  const response = await fetch(url, {
    method: (opts && opts.method) || 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!response.ok) throw new Error(`Firestore request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function runCollectionGroupQuery(config, collectionId) {
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents:runQuery`;
  const rows = await fetchJson(url, config.accessToken, { method: 'POST', body: { structuredQuery: { from: [{ collectionId, allDescendants: true }] } } });
  return rows.filter(r => r && r.document).map(r => decodeDocument(r.document));
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
  const childProcess = require('child_process');
  const scriptPath = path.join(__dirname, 'export_firestore_database.js');
  const commandArgs = [scriptPath, '--project', args.projectId, '--database', args.databaseId, '--out-dir', args.outDir];
  childProcess.execFileSync(process.execPath, commandArgs, { stdio: 'inherit' });
}

// ── Backup loading ───────────────────────────────────────────────────────

function loadBackupPatternsByName(backupPath, patternNames, uidFilter) {
  const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const users = raw && raw.users && typeof raw.users === 'object' ? raw.users : {};
  const out = [];
  Object.keys(users).forEach(uid => {
    if (uidFilter && uid !== uidFilter) return;
    (users[uid].patterns || []).forEach(pattern => {
      const name = String(pattern.name || '').trim();
      if (patternNames.some(n => n.toLowerCase() === name.toLowerCase())) {
        out.push({ uid, pattern });
      }
    });
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.patternNames.length) throw new Error('At least one --pattern-name is required.');
  if (!args.backupPaths.length) throw new Error('At least one --backup <path> is required (newest first).');

  fs.mkdirSync(args.outDir, { recursive: true });

  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  console.log('Loading live findings...');
  let liveFindings = await runCollectionGroupQuery(config, 'findings');
  if (args.uid) liveFindings = liveFindings.filter(doc => extractUidFromDocName(doc.__name, 'findings') === args.uid);
  const liveFindingByUidAndId = {};
  liveFindings.forEach(doc => {
    const uid = extractUidFromDocName(doc.__name, 'findings');
    const id = String(doc.__name || '').split('/').pop();
    liveFindingByUidAndId[`${uid}::${id}`] = doc;
  });

  console.log('Loading live patterns to identify referenced findingIds...');
  let livePatterns = await runCollectionGroupQuery(config, 'patterns');
  livePatterns = livePatterns.filter(doc => {
    const name = String(doc.name || '').trim();
    if (!args.patternNames.some(n => n.toLowerCase() === name.toLowerCase())) return false;
    if (args.uid && extractUidFromDocName(doc.__name, 'patterns') !== args.uid) return false;
    return true;
  });

  console.log(`Loading ${args.backupPaths.length} backup file(s)...`);
  const backupsByPatternName = args.backupPaths.map(p => loadBackupPatternsByName(p, args.patternNames, args.uid));

  const writes = [];
  const report = [];
  let unrecoverable = 0;
  // Findings can be shared/linked across multiple patterns (same findingId
  // referenced from more than one pattern's steps). Track which finding
  // entities already got a write queued so we never emit two updates for the
  // same document in one commit — and so a pattern processed later correctly
  // sees the finding as "already restored" rather than re-flagging it empty.
  const queuedKeys = new Set();

  for (const livePattern of livePatterns) {
    const uid = extractUidFromDocName(livePattern.__name, 'patterns');
    const patternName = String(livePattern.name || '').trim();
    const liveFindingIds = collectFindingsFromPattern(livePattern);
    const patternReport = { pattern: patternName, restored: [], stillEmpty: [] };

    for (const item of liveFindingIds) {
      if (!item.findingId) continue;
      const key = `${uid}::${item.findingId}`;
      if (queuedKeys.has(key)) {
        patternReport.restored.push(`${item.title} (shared, restored above)`);
        continue;
      }
      const entity = liveFindingByUidAndId[key];
      const entityHasContent = entity ? hasRenderableContent(JSON.parse(entity.content || '[]')) : false;
      if (entityHasContent) continue; // already fine, never overwrite

      // Search backups newest-first for non-empty content for this finding.
      let sourceContent = null;
      for (const backupSet of backupsByPatternName) {
        const entry = backupSet.find(e => e.uid === uid && String(e.pattern.name || '').trim().toLowerCase() === patternName.toLowerCase());
        if (!entry) continue;
        const backupFindings = collectFindingsFromPattern(entry.pattern);
        const match = backupFindings.find(f => f.findingId === item.findingId || f.title.toLowerCase() === item.title.toLowerCase());
        if (match && hasRenderableContent(match.content)) {
          sourceContent = clone(match.content);
          break;
        }
      }

      if (!sourceContent) {
        unrecoverable += 1;
        patternReport.stillEmpty.push(item.title);
        continue;
      }

      patternReport.restored.push(item.title);

      if (entity) {
        const nextDoc = Object.assign({}, entity, {
          content: JSON.stringify(sourceContent),
          updatedAt: new Date().toISOString()
        });
        const doc = toFirestoreDoc(entity.__name, nextDoc);
        writes.push({ update: doc, updateMask: { fieldPaths: ['content', 'updatedAt'] } });
        queuedKeys.add(key);
      } else {
        console.log(`  Warning: no findings/${item.findingId} doc exists for uid ${uid}; skipping (would need a full create, out of scope for a content-only restore).`);
        unrecoverable += 1;
        patternReport.stillEmpty.push(item.title);
        patternReport.restored.pop();
      }
    }

    report.push(patternReport);
  }

  console.log('\n=== Restore preview ===');
  report.forEach(r => {
    console.log(`${r.pattern}: ${r.restored.length} restorable, ${r.stillEmpty.length} still empty (no backup source)`);
    if (r.restored.length) console.log('  restoring: ' + r.restored.join(', '));
    if (r.stillEmpty.length) console.log('  no source found for: ' + r.stillEmpty.join(', '));
  });
  console.log(`\nTotal findings to restore: ${writes.length}. Unrecoverable (no content in any given backup): ${unrecoverable}.`);

  if (!args.apply) {
    console.log('\nDry-run only. Re-run with --apply to write changes.');
    return;
  }

  if (!writes.length) {
    console.log('Nothing to apply.');
    return;
  }

  if (args.backupFirst) {
    console.log('Creating a fresh live Firestore backup before applying...');
    runBackupScript(args);
  }

  console.log(`Applying ${writes.length} finding content restore(s)...`);
  await commitWrites(config, writes);
  console.log('Done.');
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
