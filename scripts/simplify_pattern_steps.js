#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_CHUNK_SIZE = 250;
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    uid: '',
    apply: false,
    writePreview: false,
    backupFirst: false,
    chunkSize: DEFAULT_CHUNK_SIZE,
    outDir: path.join(process.cwd(), 'backups'),
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
    if (arg === '--out-dir' && argv[index + 1]) {
      args.outDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--write-preview') {
      args.writePreview = true;
      continue;
    }
    if (arg === '--backup-first') {
      args.backupFirst = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/simplify_pattern_steps.js [options]',
    '',
    'Options:',
    '  --uid <uid>          Scope the run to one user library',
    '  --project <id>       Firebase project id (default: searches-app)',
    '  --database <id>      Firestore database id (default: (default))',
    '  --write-preview      Write a preview JSON into ./backups',
    '  --apply              Write the simplified patterns back to Firestore',
    '  --backup-first       Run the full database export script before apply',
    '  --chunk-size <n>     Writes per commit batch (default: 250)',
    '  --out-dir <path>     Output directory for preview JSON (default: ./backups)',
    '  --help, -h           Show this help text'
  ].join('\n'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isoStampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
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
    return { doubleValue: value };
  }
  if (typeof value === 'object') {
    const fields = {};
    Object.keys(value).forEach(key => {
      if (key === '__name') return;
      fields[key] = encodeFirestoreValue(value[key]);
    });
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function toFirestoreDocument(name, data) {
  const fields = {};
  Object.keys(data || {}).forEach(key => {
    if (key === '__name') return;
    fields[key] = encodeFirestoreValue(data[key]);
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

async function commitWrites(config, writes) {
  if (!writes.length) return;
  const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents:commit`;
  await fetchJson(url, config.accessToken, { method: 'POST', body: { writes } });
}

function extractUidFromDocName(name) {
  const match = String(name || '').match(/\/documents\/users\/([^/]+)\/patterns\/[^/]+$/);
  return match ? match[1] : '';
}

function normaliseStepSections(step) {
  const out = {
    searchPattern: [],
    dontMissPathology: []
  };

  if (step && step.sections && typeof step.sections === 'object') {
    if (Array.isArray(step.sections.searchPattern)) out.searchPattern = clone(step.sections.searchPattern);
    if (Array.isArray(step.sections.dontMissPathology)) out.dontMissPathology = clone(step.sections.dontMissPathology);
  }

  if (!out.searchPattern.length && step && Array.isArray(step.richContent) && step.richContent.length) {
    out.searchPattern = clone(step.richContent);
  }

  return out;
}

function capitalizeFirstLetter(text) {
  return String(text || '').replace(/^([^A-Za-z]*)([a-z])/, (match, prefix, first) => `${prefix}${first.toUpperCase()}`);
}

function stripTrailingPunctuation(text) {
  return String(text || '').replace(/[\s.?!:;,]+$/g, '').trim();
}

function stripLeadingFiller(text) {
  let next = String(text || '').trim();

  next = next.replace(/^now\s+/i, '');
  next = next.replace(/^quickly\s+/i, '');
  next = next.replace(/^remember to\s+/i, '');
  next = next.replace(/^be sure to\s+/i, '');
  next = next.replace(/^make sure\s+/i, '');
  next = next.replace(/^take a moment to\s+/i, '');
  next = next.replace(/^look to see if there (?:is|are)\s+/i, '');
  next = next.replace(/^look(?:\s+closely)?\s+(?:at|for)\s+/i, '');
  next = next.replace(/^look\s+/i, '');
  next = next.replace(/^check(?:\s+for)?\s+/i, '');
  next = next.replace(/^assess(?:\s+for)?\s+/i, '');
  next = next.replace(/^examine\s+/i, '');
  next = next.replace(/^review\s+/i, '');
  next = next.replace(/^inspect\s+/i, '');
  next = next.replace(/^evaluate\s+/i, '');
  next = next.replace(/^reassess\s+/i, '');
  next = next.replace(/^do you see\s+/i, '');
  next = next.replace(/^can you see\s+/i, '');
  next = next.replace(/^is there\s+/i, '');
  next = next.replace(/^are there\s+/i, '');
  next = next.replace(/^is the\s+/i, '');
  next = next.replace(/^are the\s+/i, '');
  next = next.replace(/^was the\s+/i, '');
  next = next.replace(/^were there\s+/i, '');
  next = next.replace(/^note\s+/i, '');
  next = next.replace(/^consider whether\s+/i, '');
  next = next.replace(/^as necessary,\s*/i, '');
  next = next.replace(/^especially for\s+/i, 'For ');
  next = next.replace(/^the\s+/i, '');
  next = next.replace(/^any\s+/i, '');

  return next.trim();
}

function simplifySentence(text, options) {
  const isTitle = Boolean(options && options.isTitle);
  let next = String(text || '').replace(/\s+/g, ' ').trim();
  if (!next) return '';

  next = next.replace(/^if (.+?),\s*consider (?:getting|obtaining)\s+(.+)$/i, 'If $1, obtain $2');
  next = next.replace(/^if (.+?),\s*consider\s+(.+)$/i, (match, condition, target) => {
    const lower = String(target || '').toLowerCase();
    if (/(view|lateral|radiograph|image|images|series|projection|scan)/.test(lower)) {
      return `If ${condition}, obtain ${target}`;
    }
    return `If ${condition}, consider ${target}`;
  });
  next = stripLeadingFiller(next);
  next = next.replace(/^perform any (?:other )?last checks? and proofread(?: (?:the|your) report)?\.?$/i, 'final review');
  next = next.replace(/^perform last checks?\.?$/i, 'final review');
  next = next.replace(/^last checks? and proofread(?: (?:the|your) report)?\.?$/i, 'final review');
  next = next.replace(/^double check(?: the)?\s+/i, '');
  next = next.replace(/^do a quick first look at\s+/i, '');
  next = next.replace(/^do a quick look at\s+/i, '');
  next = next.replace(/^take a quick look at\s+/i, '');
  next = next.replace(/^take a look at\s+/i, '');
  next = next.replace(/\bprior exams?\b/ig, 'priors');
  next = next.replace(/\bhistory, indications?,? and priors\b/ig, 'history, indication, priors');
  next = next.replace(/\bhistory and indications?,? and priors\b/ig, 'history, indication, priors');
  next = next.replace(/\bhistory, indications?\b/ig, 'history and indication');
  next = next.replace(/\bindications?, history\b/ig, 'indication and history');
  next = next.replace(/\blines\s*\/\s*tubes\b/ig, 'lines and tubes');
  next = next.replace(/\bsoft tissue neck adequacy\b/ig, 'neck soft tissue adequacy');
  next = next.replace(/\s+\/\s+/g, ' / ');
  next = next.replace(/\s+,/g, ',');
  next = next.replace(/\s+\./g, '.');
  next = next.replace(/\s+/g, ' ').trim();

  if (isTitle) {
    next = next.replace(/^perform\s+/i, '');
    next = next.replace(/^do\s+/i, '');
  }

  if (isTitle) {
    next = stripTrailingPunctuation(next);
  } else {
    next = next.replace(/[?]+$/g, '');
    if (next && !/[.:;)]$/.test(next)) next += '.';
  }

  next = capitalizeFirstLetter(next);
  return next;
}

function splitLinePrefix(line) {
  const match = String(line || '').match(/^(\s*(?:[-*]\s+|[a-z]\.\s+|\d+\.\s+)?)(.*)$/i);
  if (!match) return { prefix: '', body: String(line || '') };
  return { prefix: match[1], body: match[2] };
}

function simplifyTextBlock(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];

  lines.forEach(line => {
    if (!String(line || '').trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      return;
    }

    const parts = splitLinePrefix(line);
    const body = simplifySentence(parts.body, { isTitle: false });
    if (!body) return;
    out.push(`${parts.prefix}${body}`.replace(/\s+$/g, ''));
  });

  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function simplifyRichContent(items) {
  return (items || []).map(item => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'text') {
      const nextText = simplifyTextBlock(item.text || '');
      return Object.assign({}, item, { text: nextText });
    }
    if (item.type === 'subsection') {
      return Object.assign({}, item, {
        title: item.title ? simplifySentence(item.title, { isTitle: true }) : item.title,
        content: simplifyRichContent(item.content || [])
      });
    }
    return clone(item);
  }).filter(item => {
    if (!item || typeof item !== 'object') return false;
    if (item.type === 'text') return Boolean(String(item.text || '').trim());
    return true;
  });
}

function splitNumberPrefix(title) {
  const match = String(title || '').match(/^\s*(\d+\.\s*)(.*)$/);
  if (!match) return { prefix: '', body: String(title || '').trim() };
  return { prefix: match[1], body: match[2].trim() };
}

function simplifyTitle(title) {
  const parts = splitNumberPrefix(title);
  const body = simplifySentence(parts.body, { isTitle: true });
  if (!body) return stripTrailingPunctuation(String(title || '').trim());
  return `${parts.prefix}${body}`.trim();
}

function transformPattern(patternDoc) {
  const pattern = clone(patternDoc);
  const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  let changed = false;

  pattern.steps = steps.map(step => {
    const next = clone(step);
    const nextTitle = simplifyTitle(step.stepTitle || '');
    const sections = normaliseStepSections(step);
    const simplifiedSearchPattern = simplifyRichContent(sections.searchPattern || []);

    if (nextTitle && nextTitle !== String(step.stepTitle || '')) {
      next.stepTitle = nextTitle;
      changed = true;
    }

    next.sections = Object.assign({}, sections, { searchPattern: simplifiedSearchPattern });
    next.richContent = clone(simplifiedSearchPattern);

    if (stableSerialize(next.sections.searchPattern || []) !== stableSerialize(sections.searchPattern || [])) {
      changed = true;
    }
    if (stableSerialize(next.richContent || []) !== stableSerialize(step.richContent || [])) {
      changed = true;
    }

    return next;
  });

  if (changed) {
    pattern.updatedAt = new Date().toISOString();
  }

  return { changed, pattern };
}

function buildPreviewPayload(args, patternDocs, changedPatterns) {
  return {
    generatedAt: new Date().toISOString(),
    projectId: args.projectId,
    databaseId: args.databaseId,
    scopedUid: args.uid || null,
    counts: {
      scannedPatterns: patternDocs.length,
      changedPatterns: changedPatterns.length
    },
    changedPatterns: changedPatterns.map(entry => ({
      uid: entry.uid,
      patternId: String(entry.after.__name || '').split('/').pop(),
      name: entry.after.name || '',
      beforeStepTitles: (entry.before.steps || []).map(step => step.stepTitle || ''),
      afterStepTitles: (entry.after.steps || []).map(step => step.stepTitle || ''),
      pattern: entry.after
    }))
  };
}

function writePreviewFile(args, patternDocs, changedPatterns) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const preview = buildPreviewPayload(args, patternDocs, changedPatterns);
  const filename = `pattern_step_simplify_preview_${args.projectId}_${isoStampForFilename(new Date())}.json`;
  const targetPath = path.join(args.outDir, filename);
  fs.writeFileSync(targetPath, JSON.stringify(preview, null, 2) + '\n');
  return targetPath;
}

function runBackupScript(args) {
  const scriptPath = path.join(__dirname, 'export_firestore_database.js');
  childProcess.execFileSync(process.execPath, [scriptPath, '--project', args.projectId, '--database', args.databaseId, '--out-dir', args.outDir], { stdio: 'inherit' });
}

async function applyChanges(config, changedPatterns, chunkSize) {
  for (let index = 0; index < changedPatterns.length; index += chunkSize) {
    const slice = changedPatterns.slice(index, index + chunkSize);
    const writes = slice.map(entry => ({
      update: toFirestoreDocument(entry.after.__name, entry.after)
    }));
    await commitWrites(config, writes);
    console.log(`  Applied ${Math.min(index + chunkSize, changedPatterns.length)} / ${changedPatterns.length}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  console.log('Loading Firestore pattern documents...');
  let patternDocs = await runCollectionGroupQuery(config, 'patterns');
  if (args.uid) {
    patternDocs = patternDocs.filter(doc => extractUidFromDocName(doc.__name) === args.uid);
  }
  console.log(`  Loaded ${patternDocs.length} pattern documents${args.uid ? ` for UID ${args.uid}` : ''}.`);

  const changedPatterns = [];
  patternDocs.forEach(doc => {
    const result = transformPattern(doc);
    if (!result.changed) return;
    changedPatterns.push({
      uid: extractUidFromDocName(doc.__name),
      before: clone(doc),
      after: result.pattern
    });
  });

  console.log(`  Patterns changed: ${changedPatterns.length}`);

  if (args.writePreview || !args.apply) {
    const previewPath = writePreviewFile(args, patternDocs, changedPatterns);
    console.log(`Wrote preview to ${previewPath}`);
  }

  if (!args.apply) return;

  if (args.backupFirst) {
    console.log('Running backup before apply...');
    runBackupScript(args);
  }

  if (!changedPatterns.length) {
    console.log('No changes to apply.');
    return;
  }

  console.log(`Applying ${changedPatterns.length} pattern updates...`);
  await applyChanges(config, changedPatterns, args.chunkSize);
  console.log('Done.');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});