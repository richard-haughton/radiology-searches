#!/usr/bin/env node

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_PATTERN_NAME = 'CT Abdomen Pelvis';
const DEFAULT_BOOTCAMP_SEED = path.join(__dirname, 'data', 'bootcamp_radiology_findings_seed.json');
const DEFAULT_EMERGENCY_SEED = path.join(__dirname, 'data', 'emergency_radiology_findings_seed.json');
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    uid: '',
    patternName: DEFAULT_PATTERN_NAME,
    seedFiles: [DEFAULT_BOOTCAMP_SEED, DEFAULT_EMERGENCY_SEED],
    apply: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--uid' && argv[i + 1]) args.uid = argv[++i];
    else if (arg === '--project' && argv[i + 1]) args.projectId = argv[++i];
    else if (arg === '--database' && argv[i + 1]) args.databaseId = argv[++i];
    else if (arg === '--pattern-name' && argv[i + 1]) args.patternName = argv[++i];
    else if (arg === '--seed' && argv[i + 1]) args.seedFiles = [argv[++i]];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/restore_pattern_finding_content_from_entities.js [options]',
    '',
    'Options:',
    '  --uid <uid>            Target user uid (required)',
    '  --pattern-name <name>  Pattern name to restore (default: CT Abdomen Pelvis)',
    '  --seed <path>          Optional seed JSON fallback source (default uses both built-in seeds)',
    '  --project <id>         Firebase project id (default: searches-app)',
    '  --database <id>        Firestore database id (default: (default))',
    '  --apply                Write updates to Firestore (default is dry-run)',
    '  --help, -h             Show this help'
  ].join('\n'));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function normaliseName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasRenderableRichContent(content) {
  const chunks = Array.isArray(content) ? content : [];
  return chunks.some(chunk => {
    if (!chunk || typeof chunk !== 'object') return false;
    if (chunk.type === 'image') return Boolean(String(chunk.data || '').trim());
    if (chunk.type === 'link') {
      return Boolean(String(chunk.url || '').trim() || String(chunk.text || '').trim());
    }
    return Boolean(String(chunk.text || '').trim());
  });
}

function makeFindingIdFromName(name) {
  const key = normaliseName(name);
  return key ? `finding_${key.replace(/\s+/g, '_').slice(0, 120)}` : '';
}

function synthesiseSeedContent(row) {
  const out = [];
  const fields = [
    ['Clinical', row && row.clinical],
    ['Imaging', row && row.imaging],
    ['Report', row && row.report],
    ['Treatment', row && row.treatment]
  ];

  fields.forEach(pair => {
    const label = pair[0];
    const value = String(pair[1] || '').trim();
    if (!value) return;
    out.push({ type: 'text', text: `${label}: ${value}`, bold: false, color: null });
  });

  return out;
}

function compactRichContent(content) {
  const chunks = Array.isArray(content) ? content : [];
  const out = [];
  chunks.forEach(chunk => {
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.type === 'text') {
      const text = String(chunk.text || '').trim();
      if (!text) return;
      out.push({
        type: 'text',
        text: text.slice(0, 600),
        bold: Boolean(chunk.bold),
        color: chunk.color || null
      });
      return;
    }
    if (chunk.type === 'link') {
      const url = String(chunk.url || '').trim();
      const text = String(chunk.text || '').trim();
      if (!url && !text) return;
      out.push({
        type: 'link',
        text: text.slice(0, 180),
        url: url.slice(0, 500)
      });
    }
  });
  return out.slice(0, 12);
}

function buildSeedLookup(seedFiles, patternName) {
  const byId = {};
  const byTitle = {};

  (seedFiles || []).forEach(filePath => {
    if (!filePath || !fs.existsSync(filePath)) return;
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.warn(`Skipping unreadable seed file ${filePath}:`, err.message || err);
      return;
    }
    if (!Array.isArray(rows)) return;

    rows.forEach(row => {
      if (!row || typeof row !== 'object') return;
      const rowPattern = String(row.patternName || '').trim();
      if (rowPattern !== String(patternName || '').trim()) return;

      const rowId = String(row.findingId || makeFindingIdFromName(row.name || '') || '').trim();
      const titleKey = normaliseName(row.name || '');
      let content = synthesiseSeedContent(row);
      if (!hasRenderableRichContent(content)) {
        content = compactRichContent(Array.isArray(row.content) ? clone(row.content) : []);
      }
      if (!hasRenderableRichContent(content)) return;

      const payload = {
        name: String(row.name || '').trim(),
        content: content
      };

      if (rowId && !byId[rowId]) byId[rowId] = payload;
      if (titleKey && !byTitle[titleKey]) byTitle[titleKey] = payload;
    });
  });

  return { byId, byTitle };
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
    const vals = Array.isArray(v.arrayValue && v.arrayValue.values) ? v.arrayValue.values : [];
    return vals.map(decodeFirestoreValue);
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
  if (!payload || !payload.access_token) throw new Error('No access token returned');
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
  return rows.filter(row => row && row.document).map(row => decodeDocument(row.document));
}

function extractUidAndDocId(name, collectionId) {
  const re = new RegExp(`/documents/users/([^/]+)/${collectionId}/([^/]+)$`);
  const match = String(name || '').match(re);
  if (!match) return { uid: '', id: '' };
  return { uid: match[1], id: match[2] };
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
  if (!args.uid) {
    throw new Error('--uid is required');
  }

  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  const patternDocs = await runCollectionGroupQuery(config, 'patterns');
  const livePattern = patternDocs.find(doc => {
    const info = extractUidAndDocId(doc.__name, 'patterns');
    return info.uid === args.uid && String(doc.name || '').trim() === String(args.patternName).trim();
  });

  if (!livePattern) {
    throw new Error(`Pattern not found for uid ${args.uid}: ${args.patternName}`);
  }

  const findingDocs = (await runCollectionGroupQuery(config, 'findings')).filter(doc => {
    const info = extractUidAndDocId(doc.__name, 'findings');
    return info.uid === args.uid;
  });

  const findingById = {};
  const findingByTitle = {};
  findingDocs.forEach(doc => {
    const info = extractUidAndDocId(doc.__name, 'findings');
    const id = String(doc.id || info.id || '').trim();
    const titleKey = normaliseName(doc.name || '');
    if (id) findingById[id] = doc;
    if (titleKey && !findingByTitle[titleKey]) findingByTitle[titleKey] = doc;
  });

  const seedLookup = buildSeedLookup(args.seedFiles, args.patternName);

  const steps = clone(Array.isArray(livePattern.steps) ? livePattern.steps : []);
  let restoredCount = 0;
  let untouchedEmptyCount = 0;
  const perStep = [];

  steps.forEach((step, stepIndex) => {
    const sections = step && step.sections && typeof step.sections === 'object' ? step.sections : (step.sections = {});
    const findings = Array.isArray(sections.dontMissPathology) ? sections.dontMissPathology : (sections.dontMissPathology = []);
    let stepRestored = 0;

    findings.forEach(subsection => {
      if (!subsection || subsection.type !== 'subsection') return;
      if (hasRenderableRichContent(subsection.content || [])) return;

      const findingId = String(subsection.findingId || '').trim();
      const titleKey = normaliseName(subsection.title || '');
      const source = (findingId && findingById[findingId]) || (titleKey && findingByTitle[titleKey]) || null;
      let sourceContent = source && Array.isArray(source.content) ? source.content : [];
      if (!hasRenderableRichContent(sourceContent)) {
        const seedSource = (findingId && seedLookup.byId[findingId]) || (titleKey && seedLookup.byTitle[titleKey]) || null;
        sourceContent = seedSource && Array.isArray(seedSource.content) ? seedSource.content : [];
      }
      if (!hasRenderableRichContent(sourceContent)) {
        untouchedEmptyCount += 1;
        return;
      }

      subsection.content = clone(sourceContent);
      stepRestored += 1;
      restoredCount += 1;
    });

    if (stepRestored > 0) {
      perStep.push({
        step: stepIndex + 1,
        stepTitle: String(step.stepTitle || ''),
        restored: stepRestored
      });
    }
  });

  if (!restoredCount) {
    console.log('No empty subsection content could be restored from finding entities.');
    if (untouchedEmptyCount) {
      console.log(`Subsections still empty with no source content available: ${untouchedEmptyCount}`);
    }
    return;
  }

  console.log(`Restorable finding subsections: ${restoredCount}`);
  perStep.forEach(item => {
    console.log(`  - Step ${item.step}: ${item.stepTitle || 'Untitled Step'} (+${item.restored})`);
  });
  if (untouchedEmptyCount) {
    console.log(`Subsections still empty (no entity content): ${untouchedEmptyCount}`);
  }

  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply to write changes.');
    return;
  }

  await commitPatternSteps(config, livePattern.__name, steps);
  console.log('Applied restore to Firestore.');
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
