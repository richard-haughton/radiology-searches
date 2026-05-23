#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_PROJECT_ID = 'searches-app';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_CHUNK_SIZE = 200;
const FIREBASE_TOKEN_FILE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_CLIENT_ID = process.env.FIREBASE_CLIENT_ID || '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = process.env.FIREBASE_CLIENT_SECRET || 'j9iVZfS8kkCEFUPaAeJV0sAi';
const TIMESTAMP_FIELD_NAMES = new Set(['updatedAt', 'createdAt', 'timestamp', 'sharedAt']);
const SEQUENCE_MARKER_PREFIXES = ['System-based review:', 'Sequence check:'];

const SEQUENCE_PATTERNS = [
  { regex: /\b(?:t1|tl)(?:-weighted| weighted)?\b/gi, label: 'T1' },
  { regex: /\b(?:t2)(?:-weighted| weighted)?\b/gi, label: 'T2' },
  { regex: /\bheavily\s+t2(?:-weighted| weighted)?\b/gi, label: 'heavily T2' },
  { regex: /\bfluid[- ]weighted\b|\bfluid[- ]sensitive\b/gi, label: 'fluid-sensitive sequences' },
  { regex: /\bflair\b/gi, label: 'FLAIR' },
  { regex: /\bhaste\b|\bt2\s+haste\b/gi, label: 'HASTE' },
  { regex: /\bdwi\b|\bdiffusion(?:-weighted)?\b/gi, label: 'DWI' },
  { regex: /\badc\b/gi, label: 'ADC' },
  { regex: /\bswi\b/gi, label: 'SWI' },
  { regex: /\bgre\b|\bgradient echo\b/gi, label: 'GRE' },
  { regex: /\bstir\b/gi, label: 'STIR' },
  { regex: /\bfat[- ]?sat\b|\bfat saturation\b/gi, label: 'fat-sat' },
  { regex: /\bin[- ]?phase\b/gi, label: 'in-phase' },
  { regex: /\bout[- ]?of[- ]?phase\b|\bopposed[- ]?phase\b/gi, label: 'out-of-phase' },
  { regex: /\bpre[- ]?contrast\b/gi, label: 'pre-contrast T1' },
  { regex: /\bpre\/?postcontrast\b|\bpre\/?post-contrast\b/gi, label: 'post-contrast T1' },
  { regex: /\bpost[- ]?contrast\b|\bpostcontrast\b/gi, label: 'post-contrast T1' },
  { regex: /\bcontrast[- ]enhanced\b|\bwith contrast\b|\bgadolinium\b/gi, label: 'post-contrast T1' },
  { regex: /\blocalizers?\b|\blocaliser\b|\bscout\b/gi, label: 'localizers' }
];

const DEFAULT_FOCUS_RULES = [
  {
    regex: /internal auditory canals|\bmri iac\b|\biac\b|cerebellopontine angle|\bcpa\b/i,
    label: 'the internal auditory canals, labyrinth, CPA cisterns, adjacent cranial nerves, skull base, and extracranial soft tissues'
  },
  {
    regex: /orbits?/i,
    label: 'the globes, optic nerves, extraocular muscles, orbital apex, and adjacent soft tissues'
  },
  {
    regex: /sella|pituitar/i,
    label: 'the pituitary gland, infundibulum, optic apparatus, cavernous sinuses, and skull base'
  },
  {
    regex: /brain/i,
    label: 'the brain parenchyma, ventricles, extra-axial spaces, skull base, and soft tissues'
  },
  {
    regex: /cervical spine|thoracic spine|lumbar spine|total spine|\bspine\b/i,
    label: 'the vertebrae, discs, canal, foramina, neural elements, marrow, and paraspinal soft tissues'
  },
  {
    regex: /pelvis|prostate/i,
    label: 'the pelvic organs, bowel, peritoneum, bones, and soft tissues'
  },
  {
    regex: /enterography/i,
    label: 'the bowel, mesentery, peritoneum, solid organs, and surrounding soft tissues'
  },
  {
    regex: /urogram/i,
    label: 'the kidneys, collecting systems, ureters, bladder, and surrounding soft tissues'
  },
  {
    regex: /abdomen/i,
    label: 'the solid organs, biliary tree, bowel, vasculature, bones, and soft tissues'
  },
  {
    regex: /chest/i,
    label: 'the lungs, pleura, mediastinum, heart, chest wall, and surrounding soft tissues'
  },
  {
    regex: /neck/i,
    label: 'the aerodigestive tract, salivary glands, thyroid, nodal chains, vessels, and surrounding soft tissues'
  },
  {
    regex: /breast/i,
    label: 'the breast parenchyma, skin, chest wall, and axillary nodes'
  },
  {
    regex: /heart/i,
    label: 'the myocardium, chambers, valves, pericardium, great vessels, and extracardiac structures'
  },
  {
    regex: /shoulder/i,
    label: 'the rotator cuff, labrum, cartilage, marrow, and surrounding soft tissues'
  },
  {
    regex: /elbow/i,
    label: 'the tendons, ligaments, cartilage, marrow, nerves, and periarticular soft tissues of the elbow'
  },
  {
    regex: /wrist/i,
    label: 'the carpal bones, ligaments, TFCC, tendons, nerves, cartilage, and surrounding soft tissues'
  },
  {
    regex: /ankle/i,
    label: 'the osseous structures, ligaments, tendons, cartilage, and surrounding soft tissues'
  },
  {
    regex: /foot/i,
    label: 'the osseous structures, joints, tendons, plantar soft tissues, and surrounding soft tissues of the foot'
  },
  {
    regex: /knee/i,
    label: 'the menisci, ligaments, cartilage, extensor mechanism, marrow, and periarticular soft tissues'
  },
  {
    regex: /hip/i,
    label: 'the hip joint, labrum, marrow, tendons, bursae, and surrounding soft tissues'
  }
];

const STEP_FOCUS_RULES = [
  {
    regex: /internal auditory canal|\biac\b|cochlea|vestibular|labyrinth|porus acusticus|cpa|facial nerve|mastoid|middle ear|endolymphatic/gi,
    label: 'the internal auditory canals, labyrinth, CPA cisterns, adjacent cranial nerves, skull base, and extracranial soft tissues'
  },
  {
    regex: /orbit|globe|optic nerve|extraocular|lacrimal|orbital apex|cavernous sinus/gi,
    label: 'the globes, optic nerves, extraocular muscles, orbital apex, and adjacent soft tissues'
  },
  {
    regex: /pituitar|sella|infundibulum|optic chiasm|cavernous sinus/gi,
    label: 'the pituitary gland, infundibulum, optic apparatus, cavernous sinuses, and skull base'
  },
  {
    regex: /uterus|ovar(?:y|ies)|adnex|endometri|junctional zone|seminal vesicle|prostate|bladder|ureter|pelvi|bowel|peritone/gi,
    label: 'the pelvic organs, bowel, peritoneum, bones, and soft tissues'
  },
  {
    regex: /liver|hepatic|gallbladder|bile duct|biliary|pancrea|spleen|kidney|renal|adrenal|portal vein|ivc|aorta/gi,
    label: 'the solid organs, biliary tree, bowel, vasculature, bones, and soft tissues'
  },
  {
    regex: /enterography|ileum|jejun|colon|mesenter|fistula|stricture/gi,
    label: 'the bowel, mesentery, peritoneum, solid organs, and surrounding soft tissues'
  },
  {
    regex: /urogram|collecting system|renal pelvis|ureter|bladder/gi,
    label: 'the kidneys, collecting systems, ureters, bladder, and surrounding soft tissues'
  },
  {
    regex: /\bbrain\b|cerebr|cerebell|ventric|extra-axial|brainstem|white matter|diffusion restriction|hemorrhag/gi,
    label: 'the brain parenchyma, ventricles, extra-axial spaces, skull base, and soft tissues'
  },
  {
    regex: /\bcord\b|cauda equina|\bdisc(?:s|opathy)?\b|\bforamina\b|\bforaminal\b|\bcanal\b|vertebra(?:e|l)?|\bfacet(?:s)?\b|thecal sac|\bspine\b|paraspinal/gi,
    label: 'the vertebrae, discs, canal, foramina, neural elements, marrow, and paraspinal soft tissues'
  },
  {
    regex: /knee|menisc|acl|pcl|mcl|lcl|patell|tibiofemoral|femorotibial|trochlea|popliteal|baker|iliotibial|quadriceps|hamstring/gi,
    label: 'the menisci, ligaments, cartilage, extensor mechanism, marrow, and periarticular soft tissues'
  },
  {
    regex: /shoulder|labrum|rotator cuff|supraspinatus|infraspinatus|subscapularis|teres minor|glenoid|ac joint|biceps anchor/gi,
    label: 'the rotator cuff, labrum, cartilage, marrow, and surrounding soft tissues'
  },
  {
    regex: /elbow|ulnotrochlear|radiocapitellar|common flexor|common extensor|biceps|brachialis|triceps|ulnar collateral|radial collateral/gi,
    label: 'the tendons, ligaments, cartilage, marrow, nerves, and periarticular soft tissues of the elbow'
  },
  {
    regex: /wrist|tfcc|scaph|lunate|carpal|radiocarpal|radioulnar|carpal tunnel|extensor compartment|flexor tendon/gi,
    label: 'the carpal bones, ligaments, TFCC, tendons, nerves, cartilage, and surrounding soft tissues'
  },
  {
    regex: /ankle|talus|calcane|achilles|peroneal|deltoid ligament|sinus tarsi|tibiotalar|subtalar/gi,
    label: 'the osseous structures, ligaments, tendons, cartilage, and surrounding soft tissues'
  },
  {
    regex: /foot|metatars|phalang|sesamoid|plantar fascia|lisfranc|midfoot/gi,
    label: 'the osseous structures, joints, tendons, plantar soft tissues, and surrounding soft tissues of the foot'
  },
  {
    regex: /acetabul|femoral head|hip|iliopsoas|greater trochanter|trochanteric|labr(?:um|al)/gi,
    label: 'the hip joint, labrum, marrow, tendons, bursae, and surrounding soft tissues'
  },
  {
    regex: /breast|implant|axilla|nipple|chest wall|pectoralis/gi,
    label: 'the breast parenchyma, skin, chest wall, and axillary nodes'
  },
  {
    regex: /heart|myocard|ventric|atri|valve|pericard|aorta|cine|delayed enhancement|perfusion/gi,
    label: 'the myocardium, chambers, valves, pericardium, great vessels, and extracardiac structures'
  },
  {
    regex: /neck|pharynx|larynx|salivary|thyroid|lymph node|carotid|jugular|nasopharynx/gi,
    label: 'the aerodigestive tract, salivary glands, thyroid, nodal chains, vessels, and surrounding soft tissues'
  },
  {
    regex: /chest|lung|pleura|mediast|chest wall/gi,
    label: 'the lungs, pleura, mediastinum, heart, chest wall, and surrounding soft tissues'
  }
];

const ADMIN_STEP_PATTERNS = [
  /history|indication|priors?|laterality/i,
  /adequacy|technique|limitations?/i,
  /final synthesis|impression|proofread|last checks?|double check/i,
  /assess any hardware|check hardware|hardware/i
];

const FINAL_STEP_PATTERNS = [/final synthesis|impression|proofread|last checks?|double check/i];

const LOCALIZER_STEP_PATTERNS = [/localizer|localiser|scout/i];

const EXPLICIT_SYSTEM_STEP_PATTERNS = [
  /subcutaneous|musculature|tendons?|ligaments?|menisci|cartilage|bone cortex|marrow/i,
  /brain and central auditory pathways|cerebellopontine|facial nerve course|middle ear|skull base/i,
  /pelvic organs|solid organs|biliary tree|myocardium|breast parenchyma|aerodigestive tract/i
];

function parseArgs(argv) {
  const args = {
    projectId: DEFAULT_PROJECT_ID,
    databaseId: DEFAULT_DATABASE_ID,
    outDir: path.join(process.cwd(), 'backups'),
    apply: false,
    writePreview: true,
    backupFirst: false,
    uid: '',
    chunkSize: DEFAULT_CHUNK_SIZE
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
    if (arg === '--write-preview') {
      args.writePreview = true;
      continue;
    }
    if (arg === '--no-preview') {
      args.writePreview = false;
      continue;
    }
    if (arg === '--backup-first') {
      args.backupFirst = true;
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
    'Usage: node scripts/migrate_mri_patterns_system_based.js [options]',
    '',
    'Options:',
    '  --project <id>       Firebase project id (default: searches-app)',
    '  --database <id>      Firestore database id (default: (default))',
    '  --out-dir <path>     Directory for preview/backup JSON (default: ./backups)',
    '  --uid <uid>          Restrict preview/apply to one user library',
    '  --apply              Write transformed MRI patterns back to Firestore',
    '  --backup-first       Create a JSON backup before applying changes',
    '  --chunk-size <n>     Commit batch size for writes (default: 200)',
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

function flattenRichText(items) {
  const parts = [];
  (items || []).forEach(item => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'text') {
      parts.push(String(item.text || ''));
      return;
    }
    if (item.type === 'link') {
      parts.push(String(item.text || item.url || ''));
      return;
    }
    if (item.type === 'subsection') {
      parts.push(String(item.title || ''));
      parts.push(flattenRichText(item.content || []));
      return;
    }
  });
  return parts.join('\n');
}

function extractSearchPatternContent(step) {
  if (step && step.sections && Array.isArray(step.sections.searchPattern) && step.sections.searchPattern.length) {
    return deepClone(step.sections.searchPattern);
  }
  return deepClone(step && step.richContent ? step.richContent : []);
}

function stripGeneratedLead(items) {
  const next = deepClone(items || []);
  if (!next.length) return next;
  const first = next[0];
  if (first && first.type === 'text' && SEQUENCE_MARKER_PREFIXES.some(prefix => String(first.text || '').startsWith(prefix))) {
    next.shift();
  }
  return next;
}

function extractAllStepText(step) {
  const parts = [String((step && step.stepTitle) || '')];
  if (step && step.richContent) parts.push(flattenRichText(step.richContent));
  if (step && step.sections && step.sections.searchPattern) parts.push(flattenRichText(step.sections.searchPattern));
  return parts.join('\n');
}

function extractClassificationStepText(step) {
  const parts = [String((step && step.stepTitle) || '')];
  if (step && step.richContent) parts.push(flattenRichText(stripGeneratedLead(step.richContent)));
  if (step && step.sections && step.sections.searchPattern) parts.push(flattenRichText(stripGeneratedLead(step.sections.searchPattern)));
  return parts.join('\n');
}

function unique(values) {
  const seen = new Set();
  const out = [];
  values.forEach(value => {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  });
  return out;
}

function extractSequences(text) {
  const found = [];
  SEQUENCE_PATTERNS.forEach(entry => {
    if (entry.regex.test(text)) found.push(entry.label);
    entry.regex.lastIndex = 0;
  });
  return unique(found);
}

function formatList(items) {
  if (!items.length) return 'the available MRI sequences';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function splitNumberPrefix(title) {
  const match = String(title || '').match(/^\s*(\d+\.\s*)(.*)$/);
  if (!match) return { prefix: '', body: String(title || '').trim() };
  return { prefix: match[1], body: match[2].trim() };
}

function isSequenceBasedTitle(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  if (!extractSequences(text).length) return false;
  return /\b(look|review|examine|correlate|assess|check|reassess)\b/i.test(text);
}

function matchesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function isAdministrativeStep(step) {
  const text = extractClassificationStepText(step);
  return matchesAny(text, ADMIN_STEP_PATTERNS);
}

function isFinalStep(step) {
  const text = extractClassificationStepText(step);
  return matchesAny(text, FINAL_STEP_PATTERNS);
}

function isLocalizerStep(step) {
  const text = extractClassificationStepText(step);
  return matchesAny(text, LOCALIZER_STEP_PATTERNS);
}

function isExplicitSystemStep(step) {
  const title = String((step && step.stepTitle) || '');
  return matchesAny(title, EXPLICIT_SYSTEM_STEP_PATTERNS);
}

function deriveDefaultFocus(patternName) {
  const text = String(patternName || '');
  for (const rule of DEFAULT_FOCUS_RULES) {
    if (rule.regex.test(text)) return rule.label;
  }
  return 'the anatomy in the field of view';
}

function countMatches(regex, text) {
  const matches = String(text || '').match(regex);
  regex.lastIndex = 0;
  return matches ? matches.length : 0;
}

function deriveFocusLabel(pattern, stepText, fallbackFocus) {
  const defaultFocus = deriveDefaultFocus(pattern && pattern.name);
  let best = { label: defaultFocus, score: 0 };

  for (const rule of STEP_FOCUS_RULES) {
    const score = countMatches(rule.regex, stepText);
    if (score > best.score) {
      best = { label: rule.label, score };
    }
  }

  if (best.score > 0) return best.label;
  if (fallbackFocus && fallbackFocus !== 'the anatomy in the field of view') return fallbackFocus;
  return defaultFocus || 'the anatomy in the field of view';
}

function sequencePurposeText(sequences, titleText) {
  const lower = String(titleText || '').toLowerCase();
  if (lower.includes('fat-sat') || lower.includes('fat sat') || lower.includes('stir')) {
    return 'Use these sequences to reassess fluid, edema, and lesion conspicuity.';
  }
  if (lower.includes('in and out of phase') || lower.includes('out of phase') || lower.includes('in phase')) {
    return 'Use these sequences to check for fat, blood products, susceptibility, and marrow conspicuity.';
  }
  if (lower.includes('contrast')) {
    return 'Use these sequences to assess enhancement and confirm whether abnormalities persist across phases.';
  }
  if (sequences.indexOf('DWI') !== -1 || sequences.indexOf('ADC') !== -1) {
    return 'Use these sequences to assess diffusion restriction and correlate with the anatomic sequences.';
  }
  if (sequences.indexOf('localizers') !== -1) {
    return 'Use the localizers to avoid missing anatomy at the edge of the field of view before committing to the detailed review.';
  }
  return 'Correlate suspicious findings across these sequences before moving on.';
}

function makeSystemTitle(originalTitle, focusLabel, sequences) {
  const parts = splitNumberPrefix(originalTitle);
  const lower = String(originalTitle || '').toLowerCase();
  let body = `Review ${focusLabel}.`;

  if (lower.includes('contrast')) {
    body = `Reassess ${focusLabel} for enhancement.`;
  } else if (lower.includes('fat-sat') || lower.includes('fat sat') || lower.includes('stir')) {
    body = `Reassess ${focusLabel} for fluid and edema.`;
  } else if (lower.includes('in and out of phase') || lower.includes('out of phase') || lower.includes('in phase')) {
    body = `Reassess ${focusLabel} for fat, blood products, and susceptibility.`;
  } else if (sequences.indexOf('DWI') !== -1 || sequences.indexOf('ADC') !== -1) {
    body = `Reassess ${focusLabel} for diffusion abnormality.`;
  } else if (sequences.indexOf('localizers') !== -1) {
    body = `Use the localizers to extend the anatomy review.`;
  }

  return `${parts.prefix}${body}`.trim();
}

function buildLeadText(kind, focusLabel, sequences, titleText) {
  const prefix = kind === 'sequence-based' ? 'System-based review:' : 'Sequence check:';
  return `${prefix} scrutinize ${focusLabel} on ${formatList(sequences)}. ${sequencePurposeText(sequences, titleText)}`;
}

function withLeadText(content, leadText) {
  const next = Array.isArray(content) ? deepClone(content) : [];
  const first = next[0];
  if (first && first.type === 'text' && SEQUENCE_MARKER_PREFIXES.some(prefix => String(first.text || '').startsWith(prefix))) {
    first.text = leadText;
    return next;
  }
  next.unshift({ type: 'text', text: leadText, bold: false, color: null });
  return next;
}

function getGeneratedLeadKind(step) {
  const content = extractSearchPatternContent(step);
  const first = content[0];
  if (!first || first.type !== 'text') return '';
  const text = String(first.text || '');
  if (text.startsWith('System-based review:')) return 'sequence-based';
  if (text.startsWith('Sequence check:')) return 'system-based';
  return '';
}

function rewriteStep(pattern, step, context) {
  const text = extractClassificationStepText(step);
  const title = String(step.stepTitle || '');
  const stepSequences = extractSequences(text);
  const sequences = stepSequences.length ? stepSequences : context.patternSequences;
  const next = deepClone(step);
  const focusLabel = deriveFocusLabel(pattern, text, context.defaultFocus);
  const existingGeneratedKind = getGeneratedLeadKind(step);
  const hasSystemLanguage = isExplicitSystemStep(step) || (!isSequenceBasedTitle(title) && focusLabel !== 'the anatomy in the field of view' && !isAdministrativeStep(step) && !isFinalStep(step));
  const content = extractSearchPatternContent(step);

  if (isAdministrativeStep(step) || isFinalStep(step)) {
    return { step: next, changed: false, focusLabel: context.defaultFocus, mode: 'unchanged' };
  }

  if (!sequences.length) {
    return { step: next, changed: false, focusLabel, mode: 'unchanged' };
  }

  if (existingGeneratedKind) {
    const rewrittenContent = withLeadText(content, buildLeadText(existingGeneratedKind, focusLabel, sequences, title));
    next.richContent = rewrittenContent;
    if (next.sections && typeof next.sections === 'object') {
      next.sections.searchPattern = deepClone(rewrittenContent);
    }
    return {
      step: next,
      changed: JSON.stringify(next.richContent || []) !== JSON.stringify(step.richContent || []),
      focusLabel,
      mode: existingGeneratedKind
    };
  }

  if (isLocalizerStep(step) || isSequenceBasedTitle(title)) {
    next.stepTitle = makeSystemTitle(title, focusLabel, sequences);
    const rewrittenContent = withLeadText(content, buildLeadText('sequence-based', focusLabel, sequences, title));
    next.richContent = rewrittenContent;
    if (next.sections && typeof next.sections === 'object') {
      next.sections.searchPattern = deepClone(rewrittenContent);
    }
    context.lastFocus = focusLabel;
    return {
      step: next,
      changed: next.stepTitle !== step.stepTitle || JSON.stringify(next.richContent || []) !== JSON.stringify(step.richContent || []),
      focusLabel,
      mode: 'sequence-based'
    };
  }

  if (hasSystemLanguage) {
    const enrichedContent = withLeadText(content, buildLeadText('system-based', focusLabel, sequences, title));
    next.richContent = enrichedContent;
    if (next.sections && typeof next.sections === 'object') {
      next.sections.searchPattern = deepClone(enrichedContent);
    }
    return {
      step: next,
      changed: JSON.stringify(next.richContent || []) !== JSON.stringify(step.richContent || []),
      focusLabel,
      mode: 'system-based'
    };
  }

  return { step: next, changed: false, focusLabel, mode: 'unchanged' };
}

function transformPattern(patternDoc) {
  if (String(patternDoc.modality || '').toUpperCase() !== 'MRI') {
    return { changed: false, pattern: deepClone(patternDoc), summary: { sequenceSteps: 0, systemSteps: 0, unchangedSteps: (patternDoc.steps || []).length } };
  }

  const pattern = deepClone(patternDoc);
  const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  const patternSequences = unique(extractSequences(`${pattern.name || ''}\n${steps.map(extractAllStepText).join('\n')}`));
  const context = {
    patternSequences,
    defaultFocus: deriveDefaultFocus(pattern.name || '')
  };

  let changed = false;
  const summary = { sequenceSteps: 0, systemSteps: 0, unchangedSteps: 0 };

  pattern.steps = steps.map(step => {
    const result = rewriteStep(pattern, step, context);
    if (result.mode === 'sequence-based') summary.sequenceSteps += 1;
    else if (result.mode === 'system-based') summary.systemSteps += 1;
    else summary.unchangedSteps += 1;
    if (result.changed) changed = true;
    return result.step;
  });

  if (changed) {
    pattern.updatedAt = new Date().toISOString();
  }

  return { changed, pattern, summary, sequences: patternSequences };
}

function buildPreviewPayload(args, allPatterns, changedPatterns, totals) {
  return {
    generatedAt: new Date().toISOString(),
    projectId: args.projectId,
    databaseId: args.databaseId,
    scopedUid: args.uid || null,
    counts: totals,
    changedPatterns: changedPatterns.map(entry => ({
      uid: entry.uid,
      name: entry.after.name,
      beforeStepTitles: (entry.before.steps || []).map(step => step.stepTitle || ''),
      afterStepTitles: (entry.after.steps || []).map(step => step.stepTitle || ''),
      sequences: entry.sequences,
      summary: entry.summary,
      pattern: entry.after
    })),
    scannedPatternNames: allPatterns.map(doc => ({ uid: extractUidFromDocName(doc.__name), name: doc.name || '', modality: doc.modality || '' }))
  };
}

function runBackupScript(args) {
  const scriptPath = path.join(__dirname, 'export_firestore_database.js');
  const commandArgs = [scriptPath, '--project', args.projectId, '--database', args.databaseId, '--out-dir', args.outDir];
  childProcess.execFileSync(process.execPath, commandArgs, { stdio: 'inherit' });
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

  fs.mkdirSync(args.outDir, { recursive: true });

  const config = {
    projectId: args.projectId,
    databaseId: args.databaseId,
    accessToken: await readAccessToken()
  };

  console.log('Loading all Firestore pattern documents...');
  let patternDocs = await runCollectionGroupQuery(config, 'patterns');
  if (args.uid) {
    patternDocs = patternDocs.filter(doc => extractUidFromDocName(doc.__name) === args.uid);
  }
  console.log(`  Loaded ${patternDocs.length} pattern documents${args.uid ? ` for UID ${args.uid}` : ''}.`);

  const mriDocs = patternDocs.filter(doc => String(doc.modality || '').toUpperCase() === 'MRI');
  console.log(`  MRI patterns in scope: ${mriDocs.length}`);

  const changedPatterns = [];
  let alreadySystemBased = 0;
  let unchanged = 0;

  patternDocs.forEach(doc => {
    const result = transformPattern(doc);
    if (String(doc.modality || '').toUpperCase() !== 'MRI') return;
    if (result.summary.systemSteps > 0) alreadySystemBased += 1;
    if (result.changed) {
      changedPatterns.push({
        uid: extractUidFromDocName(doc.__name),
        before: deepClone(doc),
        after: result.pattern,
        summary: result.summary,
        sequences: result.sequences
      });
    } else {
      unchanged += 1;
    }
  });

  const totals = {
    scannedPatterns: patternDocs.length,
    scannedMriPatterns: mriDocs.length,
    changedMriPatterns: changedPatterns.length,
    unchangedMriPatterns: unchanged,
    patternsContainingSystemSteps: alreadySystemBased
  };

  console.log('Preview summary:');
  console.log(JSON.stringify(totals, null, 2));

  if (args.writePreview) {
    const preview = buildPreviewPayload(args, patternDocs, changedPatterns, totals);
    const previewPath = path.join(args.outDir, `mri_system_based_preview_${args.projectId}_${isoStampForFilename(new Date())}.json`);
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

  if (!changedPatterns.length) {
    console.log('No MRI patterns required updates.');
    return;
  }

  console.log(`Applying ${changedPatterns.length} MRI pattern updates...`);
  await applyChanges(config, changedPatterns, args.chunkSize);
  console.log('Migration complete.');
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});