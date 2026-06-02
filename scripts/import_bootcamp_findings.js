#!/usr/bin/env node
/**
 * import_bootcamp_findings.js
 *
 * Imports findings from scripts/data/bootcamp_radiology_findings_seed.json
 * into Firestore and links each finding to the matching search-pattern step
 * specified in the seed entry (patternName + stepTitle).
 *
 * Usage (preview, no writes):
 *   node scripts/import_bootcamp_findings.js --uid <uid>
 *
 * Usage (apply to Firestore):
 *   node scripts/import_bootcamp_findings.js --uid <uid> --apply
 *
 * Options:
 *   --uid <uid>          Target user (required)
 *   --project <id>       Firebase project id (default: searches-app)
 *   --database <id>      Firestore database id (default: (default))
 *   --apply              Write to Firestore (findings + pattern updates)
 *   --chunk-size <n>     Writes per commit batch (default: 50)
 *   --help, -h           Show this help
 *
 * What it does:
 *   1. Reads the seed JSON which already has patternName + stepTitle per finding.
 *   2. Lists the user's existing findings to detect creates vs. updates.
 *   3. Lists the user's existing patterns to look up patternId + stepId.
 *   4. Upserts each finding under users/{uid}/findings/{findingId}.
 *   5. For each finding that matches a pattern+step, adds a subsection entry
 *      to that step's dontMissPathology array in the pattern document and
 *      writes a link back on the finding document.
 *   6. Updates the pattern document if any step was modified.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_CHUNK_SIZE = 50;
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';
const SEED_FILE = path.join(__dirname, 'data', 'bootcamp_radiology_findings_seed.json');
const ALLOWED_MODALITIES = new Set(['CT', 'MRI', 'US', 'Plain Radiograph', 'Nuclear Medicine', 'Other']);

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    uid: '',
    apply: false,
    chunkSize: DEFAULT_CHUNK_SIZE,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help': case '-h': args.help = true; break;
      case '--apply': args.apply = true; break;
      case '--uid': args.uid = argv[++i] || ''; break;
      case '--project': args.projectId = argv[++i] || DEFAULT_PROJECT_ID; break;
      case '--database': args.databaseId = argv[++i] || DEFAULT_DATABASE_ID; break;
      case '--chunk-size': args.chunkSize = Number(argv[++i]) || DEFAULT_CHUNK_SIZE; break;
    }
  }
  return args;
}

function printHelp() {
  console.log([
    'Usage: node scripts/import_bootcamp_findings.js --uid <uid> [options]',
    '',
    'Options:',
    '  --uid <uid>          Target user library (required)',
    '  --project <id>       Firebase project id (default: searches-app)',
    '  --database <id>      Firestore database id (default: (default))',
    '  --apply              Write findings and pattern updates to Firestore',
    '  --chunk-size <n>     Writes per commit batch (default: 50)',
    '  --help, -h           Show this help text'
  ].join('\n'));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clone(v) { return JSON.parse(JSON.stringify(v)); }

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

function makeSubsectionId() {
  const ts = Date.now().toString(16);
  const rand = Math.random().toString(16).slice(2, 10);
  return `sub_${ts}${rand}`;
}

function normaliseModalities(items) {
  const seen = {};
  return (items || [])
    .map(i => String(i || '').trim() || 'Other')
    .filter(i => {
      const safe = ALLOWED_MODALITIES.has(i) ? i : 'Other';
      if (seen[safe]) return false;
      seen[safe] = 1;
      return true;
    })
    .map(i => ALLOWED_MODALITIES.has(i) ? i : 'Other')
    .sort();
}

function contentSignature(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type === 'image') return JSON.stringify({ type: 'image', format: chunk.format || 'png', data: chunk.data || '' });
  if (chunk.type === 'link') return JSON.stringify({ type: 'link', text: chunk.text || '', url: chunk.url || '' });
  if (chunk.type === 'subsection') return JSON.stringify({ type: 'subsection', title: chunk.title || '' });
  return JSON.stringify({ type: 'text', text: chunk.text || '', bold: Boolean(chunk.bold), color: chunk.color || null });
}

function mergeContent(base, incoming) {
  const out = clone(base || []);
  const seen = {};
  out.forEach(c => { seen[contentSignature(c)] = 1; });
  clone(incoming || []).forEach(c => {
    const key = contentSignature(c);
    if (!key || seen[key]) return;
    seen[key] = 1;
    out.push(c);
  });
  return out;
}

// Strip numeric prefixes like "1. " or "Step 1" from step titles for fuzzy matching
function stripStepPrefix(title) {
  return String(title || '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^step\s+\d+[:.]?\s*/i, '')
    .trim()
    .toLowerCase();
}

// Find a step in a pattern that best matches the given stepTitle from the seed
function findMatchingStep(pattern, targetStepTitle) {
  const steps = pattern.steps || [];
  const target = stripStepPrefix(targetStepTitle);

  // First try exact match
  for (const step of steps) {
    if (step.stepTitle === targetStepTitle) return step;
  }
  // Then try prefix-stripped match
  for (const step of steps) {
    if (stripStepPrefix(step.stepTitle) === target) return step;
  }
  // Then try substring match
  for (const step of steps) {
    const stripped = stripStepPrefix(step.stepTitle);
    if (stripped.includes(target) || target.includes(stripped)) return step;
  }
  return null;
}

// ─── Firestore encoding/decoding ─────────────────────────────────────────────

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

// ─── Firestore REST ───────────────────────────────────────────────────────────

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
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  const payload = await res.json();
  if (payload && payload.access_token) return payload.access_token;
  throw new Error('No access_token in token response');
}

async function fetchJson(url, accessToken, opts) {
  const res = await fetch(url, {
    method: (opts && opts.method) || 'GET',
    headers: Object.assign(
      { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      (opts && opts.headers) || {}
    ),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) throw new Error(`Firestore request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function listCollection(config, collectionPath) {
  let pageToken = '';
  const docs = [];
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}/documents/${collectionPath}`);
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

// ─── Seed loading ─────────────────────────────────────────────────────────────

function buildFindingContent(entry) {
  // The seed already carries a rich 'content' array with text nodes and images.
  // Build supplemental text from clinical/report/treatment if not already in content.
  const richContent = Array.isArray(entry.content) && entry.content.length > 0
    ? clone(entry.content)
    : [];

  const supplemental = [
    entry.clinical && `Clinical: ${entry.clinical}`,
    entry.report   && `Report: ${entry.report}`,
    entry.treatment && `Treatment: ${entry.treatment}`
  ].filter(Boolean).join('\n');

  if (supplemental) {
    // Only add if not already present
    const existing = richContent.filter(c => c.type === 'text').map(c => c.text).join(' ');
    if (!existing.includes(supplemental.slice(0, 40))) {
      richContent.push({ type: 'text', text: supplemental, bold: false, color: null });
    }
  }
  return richContent;
}

function loadSeedData() {
  const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`Seed is not an array: ${SEED_FILE}`);
  return raw.map(entry => ({
    name: String(entry.name || '').trim(),
    modalities: normaliseModalities(entry.modalities || []),
    isRedFinding: Boolean(entry.isRedFinding),
    patternName: String(entry.patternName || '').trim(),
    stepTitle: String(entry.stepTitle || '').trim(),
    content: buildFindingContent(entry)
  })).filter(e => e.name);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.uid) throw new Error('Missing required --uid');

  const seed = loadSeedData();
  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };
  const uid = args.uid;
  const basePath = `projects/${config.projectId}/databases/${config.databaseId}/documents/users/${uid}`;

  console.log(`\nLoaded ${seed.length} findings from seed.`);

  // 1. Load existing findings
  const existingFindingDocs = await listCollection(config, `users/${uid}/findings`);
  const existingById = {};
  existingFindingDocs.forEach(doc => {
    const id = String(doc.__name || '').split('/').pop();
    existingById[id] = doc;
  });
  console.log(`Existing findings in Firestore: ${existingFindingDocs.length}`);

  // 2. Load existing patterns
  const patternDocs = await listCollection(config, `users/${uid}/patterns`);
  // Index patterns by name (normalised)
  const patternByName = {};
  patternDocs.forEach(doc => {
    const patName = String(doc.name || '').trim();
    if (patName) patternByName[patName] = doc;
  });
  console.log(`Existing patterns in Firestore: ${patternDocs.length}`);

  // 3. Build finding writes + pattern mutations
  const findingWrites = [];
  const patternMutations = {}; // patternDocName → modified doc

  let createCount = 0;
  let updateCount = 0;
  let linkedCount = 0;
  let noPatternMatch = 0;

  const now = new Date().toISOString();

  for (const entry of seed) {
    const findingId = makeFindingId(entry.name);
    if (!findingId) continue;

    const existing = existingById[findingId] || null;
    const mergedModalities = normaliseModalities([
      ...(existing && existing.modalities || []),
      ...entry.modalities
    ]);

    const mergedContent = mergeContent(existing && existing.content, entry.content);

    // Try to find and link the pattern step
    let linkEntry = null;
    const patternDoc = patternByName[entry.patternName];
    if (patternDoc) {
      const matchedStep = findMatchingStep(patternDoc, entry.stepTitle);
      if (matchedStep) {
        // Ensure the step has a subsectionId slot for this finding
        const subsectionId = makeSubsectionId();
        const stepId = matchedStep.stepId || '';

        const patternDocName = patternDoc.__name;
        // Clone pattern for mutation if not already queued
        if (!patternMutations[patternDocName]) {
          patternMutations[patternDocName] = clone(patternDoc);
        }
        const mutatedPattern = patternMutations[patternDocName];
        const mutatedStep = (mutatedPattern.steps || []).find(s => s.stepId === stepId);

        if (mutatedStep) {
          const dmp = mutatedStep.sections && mutatedStep.sections.dontMissPathology;
          if (Array.isArray(dmp)) {
            // Only add if not already present (by findingId)
            const alreadyLinked = dmp.some(item => item.findingId === findingId);
            if (!alreadyLinked) {
              const subsection = {
                type: 'subsection',
                subsectionId,
                findingId,
                title: entry.name,
                isRedFinding: entry.isRedFinding,
                content: [], // lean reference; full content lives in finding doc
                linkMeta: null
              };
              dmp.push(subsection);
              linkedCount++;
            }
          }
        }

        const patternId = patternDocName.split('/').pop();
        linkEntry = {
          patternId,
          patternName: entry.patternName,
          modality: entry.modalities[0] || 'Other',
          stepId,
          stepTitle: matchedStep.stepTitle || entry.stepTitle,
          subsectionId
        };
      } else {
        console.warn(`  [no step match] pattern "${entry.patternName}" → step "${entry.stepTitle}"`);
        noPatternMatch++;
      }
    } else {
      console.warn(`  [no pattern]   "${entry.patternName}" not found in user's patterns`);
      noPatternMatch++;
    }

    // Build existing links, add new one
    const existingLinks = (existing && existing.links) || [];
    const allLinks = linkEntry
      ? mergeLinks(existingLinks, [linkEntry])
      : existingLinks;

    const mergedFinding = {
      name: entry.name,
      nameKey: normaliseFindingName(entry.name),
      content: mergedContent,
      isRedFinding: entry.isRedFinding,
      modalities: mergedModalities,
      links: allLinks,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now
    };

    const docName = `${basePath}/findings/${findingId}`;
    findingWrites.push({ update: toFirestoreDoc(docName, mergedFinding) });

    if (existing) updateCount++;
    else createCount++;
  }

  // 4. Build pattern writes
  const patternWrites = [];
  for (const [, patDoc] of Object.entries(patternMutations)) {
    patDoc.updatedAt = now;
    patternWrites.push({ update: toFirestoreDoc(patDoc.__name, patDoc) });
  }

  // ── Summary ──
  console.log('\nBootcamp findings import summary:');
  console.log(JSON.stringify({
    uid,
    seedFindings: seed.length,
    existingFindings: existingFindingDocs.length,
    creates: createCount,
    updates: updateCount,
    findingsLinkedToSteps: linkedCount,
    patternsToUpdate: patternWrites.length,
    unmatchedPatternOrStep: noPatternMatch
  }, null, 2));

  if (!args.apply) {
    console.log('\nPreview only — no Firestore writes made.');
    console.log('Re-run with --apply to commit changes.');
    return;
  }

  // 5. Write findings
  const allWrites = [...findingWrites, ...patternWrites];
  console.log(`\nApplying ${findingWrites.length} finding write(s) and ${patternWrites.length} pattern write(s)...`);
  for (let i = 0; i < allWrites.length; i += args.chunkSize) {
    const slice = allWrites.slice(i, i + args.chunkSize);
    await commitWrites(config, slice);
    console.log(`  Applied ${Math.min(i + args.chunkSize, allWrites.length)} / ${allWrites.length}`);
  }

  console.log('\nBootcamp findings import complete.');
}

// ─── Link helpers (same as emergency findings script) ─────────────────────────

function normLink(raw) {
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

function linkKey(l) { return [l.patternId, l.stepId, l.subsectionId].join('::'); }

function mergeLinks(base, incoming) {
  const seen = {};
  const out = [];
  function add(raw) {
    const l = normLink(raw);
    if (!l) return;
    const key = linkKey(l);
    if (!l.patternId || !l.stepId || !l.subsectionId || seen[key]) return;
    seen[key] = 1;
    out.push(l);
  }
  (base || []).forEach(add);
  (incoming || []).forEach(add);
  return out;
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
