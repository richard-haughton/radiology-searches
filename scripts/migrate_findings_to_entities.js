#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_CHUNK_SIZE = 300;
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';
const TIMESTAMP_FIELD_NAMES = new Set(['updatedAt', 'createdAt', 'timestamp', 'sharedAt']);

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
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
    if ((arg === '--help') || (arg === '-h')) {
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
    if (arg === '--out-dir' && argv[index + 1]) {
      args.outDir = path.resolve(argv[index + 1]);
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
      continue;
    }
    if (arg === '--backup-first') {
      args.backupFirst = true;
      continue;
    }
    if (arg === '--write-preview') {
      args.writePreview = true;
      continue;
    }
    if (arg === '--no-preview') {
      args.writePreview = false;
    }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/migrate_findings_to_entities.js [options]',
    '',
    'Options:',
    '  --project <id>       Firebase project id (default: searches-app)',
    '  --database <id>      Firestore database id (default: (default))',
    '  --out-dir <dir>      Preview/backup output directory (default: backups)',
    '  --uid <uid>          Restrict preview/apply to one user library',
    '  --apply              Write standalone findings + pattern updates to Firestore',
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
    Object.keys(value).forEach(key => {
      fields[key] = encodeFirestoreValue(value[key], fieldPath ? `${fieldPath}.${key}` : key);
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
    fields[key] = encodeFirestoreValue(payload[key], key);
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
  const query = { structuredQuery: { from: [{ collectionId, allDescendants: true }] } };
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

function runBackupScript(args) {
  const scriptPath = path.join(__dirname, 'export_firestore_database.js');
  const commandArgs = [scriptPath, '--project', args.projectId, '--database', args.databaseId, '--out-dir', args.outDir];
  childProcess.execFileSync(process.execPath, commandArgs, { stdio: 'inherit' });
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

function cloneRichContent(content) {
  return deepClone(Array.isArray(content) ? content : []);
}

function normaliseSubsectionChunk(chunk) {
  return {
    type: 'subsection',
    subsectionId: String((chunk && (chunk.subsectionId || chunk.subsection_id)) || '').trim(),
    findingId: String((chunk && (chunk.findingId || chunk.finding_id)) || '').trim(),
    title: String((chunk && (chunk.title || chunk.name)) || '').trim(),
    isRedFinding: Boolean(chunk && (chunk.isRedFinding || chunk.is_red_finding || chunk.findingRed)),
    linkMeta: chunk && (chunk.linkMeta || chunk.link_meta) ? deepClone(chunk.linkMeta || chunk.link_meta) : null,
    content: cloneRichContent((chunk && chunk.content) || [])
  };
}

function normaliseRichContent(content) {
  return cloneRichContent(content || []).map(chunk => {
    if (!chunk || typeof chunk !== 'object') {
      return { type: 'text', text: String(chunk || ''), bold: false, color: null };
    }
    if (chunk.type === 'image') {
      return { type: 'image', format: chunk.format || 'png', data: chunk.data || chunk.image_data || '' };
    }
    if (chunk.type === 'link') {
      return { type: 'link', text: chunk.text || chunk.url || '', url: chunk.url || '' };
    }
    if (chunk.type === 'subsection' || Array.isArray(chunk.content)) {
      return normaliseSubsectionChunk(chunk);
    }
    return {
      type: 'text',
      text: chunk.text || chunk.content || '',
      bold: Boolean(chunk.bold),
      color: chunk.color || null
    };
  });
}

function normaliseStepSections(step) {
  const fallback = normaliseRichContent((step && (step.richContent || step.rich_content)) || []);
  const rawSections = (step && step.sections) || {};
  const out = {
    searchPattern: normaliseRichContent(rawSections.searchPattern || []),
    dontMissPathology: normaliseRichContent(rawSections.dontMissPathology || [])
  };
  if (!out.searchPattern.length && fallback.length) out.searchPattern = fallback;
  return out;
}

function chunkSignature(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type === 'subsection') {
    return JSON.stringify({ type: 'subsection', title: chunk.title || '', content: cloneRichContent(chunk.content || []) });
  }
  return JSON.stringify(chunk);
}

function mergeRichContent(baseContent, incomingContent) {
  const merged = cloneRichContent(baseContent || []);
  const seen = new Set(merged.map(chunkSignature));
  cloneRichContent(incomingContent || []).forEach(chunk => {
    const key = chunkSignature(chunk);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(chunk);
  });
  return merged;
}

function mergeLinks(baseLinks, incomingLinks) {
  const merged = [];
  const seen = new Set();
  function append(link) {
    const safe = {
      patternId: String((link && link.patternId) || '').trim(),
      patternName: String((link && link.patternName) || '').trim(),
      modality: String((link && link.modality) || '').trim() || 'Other',
      stepId: String((link && link.stepId) || '').trim(),
      stepTitle: String((link && link.stepTitle) || '').trim(),
      subsectionId: String((link && link.subsectionId) || '').trim()
    };
    const key = `${safe.patternId}::${safe.stepId}::${safe.subsectionId}`;
    if (!safe.patternId || !safe.stepId || !safe.subsectionId || seen.has(key)) return;
    seen.add(key);
    merged.push(safe);
  }
  (baseLinks || []).forEach(append);
  (incomingLinks || []).forEach(append);
  return merged;
}

function modalitiesFromLinks(links) {
  return Array.from(new Set((links || []).map(link => String((link && link.modality) || 'Other').trim() || 'Other'))).sort();
}

function transformPatterns(patternDocs) {
  const findingsByUid = {};
  const changedPatterns = [];
  let duplicateMerges = 0;
  let linkedOccurrences = 0;

  patternDocs.forEach(doc => {
    const uid = extractUidFromDocName(doc.__name);
    const pattern = deepClone(doc);
    const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
    let changed = false;

    steps.forEach((step, stepIndex) => {
      const sections = normaliseStepSections(step);
      const findings = sections.dontMissPathology || [];
      findings.forEach((item, itemIndex) => {
        if (!item || item.type !== 'subsection') return;
        const title = String(item.title || '').trim();
        const findingId = String(item.findingId || '').trim() || makeFindingId(title);
        if (!findingId) return;
        if (!item.findingId) {
          item.findingId = findingId;
          changed = true;
        }
        if (!findingsByUid[uid]) findingsByUid[uid] = {};
        if (!findingsByUid[uid][findingId]) {
          findingsByUid[uid][findingId] = {
            id: findingId,
            name: title || `Findings Section ${itemIndex + 1}`,
            nameKey: normaliseFindingName(title),
            content: cloneRichContent(item.content || []),
            isRedFinding: Boolean(item.isRedFinding),
            links: []
          };
        } else {
          duplicateMerges += 1;
          findingsByUid[uid][findingId].content = mergeRichContent(findingsByUid[uid][findingId].content, item.content || []);
          findingsByUid[uid][findingId].isRedFinding = Boolean(findingsByUid[uid][findingId].isRedFinding || item.isRedFinding);
        }

        const stepId = String((step && (step.stepId || step.step_id)) || '').trim();
        findingsByUid[uid][findingId].links.push({
          patternId: String((pattern && pattern.__name) || '').split('/').pop(),
          patternName: pattern.name || 'Untitled Pattern',
          modality: pattern.modality || 'Other',
          stepId: stepId,
          stepTitle: String((step && step.stepTitle) || '').trim() || `Step ${stepIndex + 1}`,
          subsectionId: String(item.subsectionId || '').trim()
        });
        linkedOccurrences += 1;
      });
      step.sections = Object.assign({}, step.sections || {}, sections, { dontMissPathology: findings });
    });

    if (changed) {
      pattern.steps = steps;
      pattern.updatedAt = new Date().toISOString();
      changedPatterns.push({ uid, before: doc, after: pattern });
    }
  });

  const findingDocs = [];
  Object.keys(findingsByUid).forEach(uid => {
    Object.keys(findingsByUid[uid]).forEach(findingId => {
      const finding = findingsByUid[uid][findingId];
      const links = mergeLinks([], finding.links || []);
      findingDocs.push({
        uid,
        docId: findingId,
        doc: {
          name: finding.name,
          nameKey: finding.nameKey,
          content: finding.content,
          isRedFinding: Boolean(finding.isRedFinding),
          modalities: modalitiesFromLinks(links),
          links,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString()
        }
      });
    });
  });

  return {
    changedPatterns,
    findingDocs,
    summary: {
      scannedPatterns: patternDocs.length,
      changedPatterns: changedPatterns.length,
      uniqueFindings: findingDocs.length,
      linkedOccurrences,
      duplicateMerges
    }
  };
}

function buildPreviewPayload(args, patternDocs, result) {
  return {
    generatedAt: new Date().toISOString(),
    projectId: args.projectId,
    databaseId: args.databaseId,
    scopedUid: args.uid || null,
    summary: result.summary,
    changedPatterns: result.changedPatterns.map(entry => ({
      uid: entry.uid,
      name: entry.after.name || '',
      patternId: String(entry.after.__name || '').split('/').pop(),
      steps: (entry.after.steps || []).length
    })),
    findings: result.findingDocs.map(entry => ({
      uid: entry.uid,
      id: entry.docId,
      name: entry.doc.name,
      modalities: entry.doc.modalities,
      links: entry.doc.links.length
    })),
    scannedPatternNames: patternDocs.map(doc => ({ uid: extractUidFromDocName(doc.__name), name: doc.name || '', modality: doc.modality || '' }))
  };
}

async function applyChanges(config, result, chunkSize) {
  const writes = [];
  result.changedPatterns.forEach(entry => {
    writes.push({ update: toFirestoreDocument(entry.after.__name, entry.after) });
  });
  result.findingDocs.forEach(entry => {
    const name = `projects/${config.projectId}/databases/${config.databaseId}/documents/users/${entry.uid}/findings/${entry.docId}`;
    writes.push({ update: toFirestoreDocument(name, entry.doc) });
  });

  for (let index = 0; index < writes.length; index += chunkSize) {
    const slice = writes.slice(index, index + chunkSize);
    await commitWrites(config, slice);
    console.log(`  Applied ${Math.min(index + chunkSize, writes.length)} / ${writes.length} writes`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  fs.mkdirSync(args.outDir, { recursive: true });

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

  const result = transformPatterns(patternDocs);
  console.log('Preview summary:');
  console.log(JSON.stringify(result.summary, null, 2));

  if (args.writePreview) {
    const preview = buildPreviewPayload(args, patternDocs, result);
    const previewPath = path.join(args.outDir, `findings_entities_preview_${args.projectId}_${isoStampForFilename(new Date())}.json`);
    fs.writeFileSync(previewPath, JSON.stringify(preview, null, 2) + '\n');
    console.log(`Wrote preview to ${previewPath}`);
  }

  if (!args.apply) {
    console.log('Preview only; no Firestore writes were made.');
    return;
  }

  if (args.backupFirst) {
    console.log('Creating JSON backup before applying changes...');
    runBackupScript(args);
  }

  if (!result.changedPatterns.length && !result.findingDocs.length) {
    console.log('No findings migration changes were required.');
    return;
  }

  console.log(`Applying ${result.changedPatterns.length} pattern updates and ${result.findingDocs.length} findings docs...`);
  await applyChanges(config, result, args.chunkSize);
  console.log('Findings entity migration complete.');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
