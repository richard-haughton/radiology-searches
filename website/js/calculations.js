// calculations.js — plain script, no modules.

function initCalculations() {
  // Calc selector list
  document.querySelectorAll('.calc-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.calc-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      renderCalc(item.dataset.calc);
    });
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
    });
  });

  // Show default
  renderCalc('volume');
}

function renderCalc(key) {
  const main = document.getElementById('calc-main');
  switch (key) {
    case 'volume':   main.innerHTML = volumeHtml();   bindVolume();   break;
    case 'stenosis': main.innerHTML = stenosisHtml(); bindStenosis(); break;
    case 'lft':      main.innerHTML = lftHtml();      bindLft();      break;
    case 'dlp':      main.innerHTML = dlpHtml();      bindDlp();      break;
    case 'quick-links':
      main.innerHTML = quickLinksHtml();
      break;
  }
}

function bindEnterToCalculate(inputIds, calcFn) {
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        calcFn();
      }
    });
  });
}

// ── 1. Estimated Volume ──────────────────────────────────────
function volumeHtml() {
  return `
  <div class="calc-card">
    <h2>Estimated Volume</h2>
    <p class="calc-description">Ellipsoid approximation — commonly used for solid organ lesions and lymph nodes.</p>
    <div class="calc-form">
      <div class="calc-row">
        <label class="form-label">Height (cm)
          <input id="v-h" type="number" class="form-input" min="0" step="0.1" placeholder="0.0">
        </label>
        <label class="form-label">Width (cm)
          <input id="v-w" type="number" class="form-input" min="0" step="0.1" placeholder="0.0">
        </label>
        <label class="form-label">Length (cm)
          <input id="v-l" type="number" class="form-input" min="0" step="0.1" placeholder="0.0">
        </label>
      </div>
    </div>
    <div class="calc-actions">
      <button id="v-calc" type="button" class="btn btn-accent">Calculate</button>
    </div>
    <div id="v-result" class="calc-result" hidden>
      <div class="calc-result-value" id="v-value"></div>
      <div class="calc-result-label">cm³</div>
    </div>
    <div class="calc-formula">V = 0.523 × H × W × L</div>
  </div>`;
}

function bindVolume() {
  ['v-h', 'v-w', 'v-l'].forEach(id => {
    document.getElementById(id).addEventListener('input', calcVolume);
  });
  document.getElementById('v-calc').addEventListener('click', calcVolume);
  bindEnterToCalculate(['v-h', 'v-w', 'v-l'], calcVolume);
}

function calcVolume() {
  const h = parseFloat(document.getElementById('v-h').value);
  const w = parseFloat(document.getElementById('v-w').value);
  const l = parseFloat(document.getElementById('v-l').value);
  const result = document.getElementById('v-result');

  if (isNaN(h) || isNaN(w) || isNaN(l)) { result.hidden = true; return; }
  const vol = 0.523 * h * w * l;
  document.getElementById('v-value').textContent = vol.toFixed(2);
  result.hidden = false;
  result.className = 'calc-result';
}

// ── 2. Percent Narrowing ─────────────────────────────────────
function stenosisHtml() {
  return `
  <div class="calc-card">
    <h2>Percent Narrowing</h2>
    <p class="calc-description">Calculates the degree of luminal narrowing (stenosis), e.g. for arterial stenosis grading.</p>
    <div class="calc-form">
      <div class="calc-row">
        <label class="form-label">Normal Diameter (D) mm
          <input id="s-d" type="number" class="form-input" min="0" step="0.1" placeholder="e.g. 8.0">
        </label>
        <label class="form-label">Stenosed Diameter (P) mm
          <input id="s-p" type="number" class="form-input" min="0" step="0.1" placeholder="e.g. 3.5">
        </label>
      </div>
    </div>
    <div class="calc-actions">
      <button id="s-calc" type="button" class="btn btn-accent">Calculate</button>
    </div>
    <div id="s-result" class="calc-result" hidden>
      <div class="calc-result-value" id="s-value"></div>
      <div class="calc-result-label">% narrowing</div>
      <div class="calc-result-detail" id="s-detail"></div>
    </div>
    <div class="calc-formula">(D − P) ÷ D × 100</div>
  </div>`;
}

function bindStenosis() {
  ['s-d', 's-p'].forEach(id => {
    document.getElementById(id).addEventListener('input', calcStenosis);
  });
  document.getElementById('s-calc').addEventListener('click', calcStenosis);
  bindEnterToCalculate(['s-d', 's-p'], calcStenosis);
}

function calcStenosis() {
  const d = parseFloat(document.getElementById('s-d').value);
  const p = parseFloat(document.getElementById('s-p').value);
  const result = document.getElementById('s-result');

  if (isNaN(d) || isNaN(p) || d <= 0) { result.hidden = true; return; }

  const pct = ((d - p) / d) * 100;
  const clamped = Math.max(0, Math.min(100, pct));

  document.getElementById('s-value').textContent = clamped.toFixed(1);
  result.style.display = '';

  let cls = 'calc-result';
  let detail = '';
  if (clamped >= 70) { cls += ' is-danger'; detail = 'Severe stenosis (≥70%) — typically significant.'; }
  else if (clamped >= 50) { cls += ' is-warning'; detail = 'Moderate stenosis (50–69%).'; }
  else { detail = 'Mild stenosis (<50%).'; }

  result.className = cls;
  document.getElementById('s-detail').textContent = detail;
  result.hidden = false;
}

// ── 3. LFT Analysis ─────────────────────────────────────────
function lftHtml() {
  return `
  <div class="calc-card">
    <h2>LFT Pattern Analysis</h2>
    <p class="calc-description">Classifies liver injury pattern using the R-factor. Enter AST, ALT, ALP, and bilirubin values with their upper limits of normal (ULN).</p>
    <div class="calc-form">
      <div class="calc-row">
        <label class="form-label">AST (U/L)
          <input id="lft-ast" type="number" class="form-input" min="0" step="1" placeholder="e.g. 55">
        </label>
        <label class="form-label">AST ULN (U/L)
          <input id="lft-ast-uln" type="number" class="form-input" min="1" step="1" value="40">
        </label>
      </div>
      <div class="calc-row">
        <label class="form-label">ALT (U/L)
          <input id="lft-alt" type="number" class="form-input" min="0" step="1" placeholder="e.g. 180">
        </label>
        <label class="form-label">ALT ULN (U/L)
          <input id="lft-alt-uln" type="number" class="form-input" min="1" step="1" value="40">
        </label>
      </div>
      <div class="calc-row">
        <label class="form-label">ALP (U/L)
          <input id="lft-alp" type="number" class="form-input" min="0" step="1" placeholder="e.g. 95">
        </label>
        <label class="form-label">ALP ULN (U/L)
          <input id="lft-alp-uln" type="number" class="form-input" min="1" step="1" value="120">
        </label>
      </div>
      <div class="calc-row">
        <label class="form-label">Total bilirubin (mg/dL)
          <input id="lft-tbili" type="number" class="form-input" min="0" step="0.1" placeholder="e.g. 1.8">
        </label>
        <label class="form-label">Total bilirubin ULN (mg/dL)
          <input id="lft-tbili-uln" type="number" class="form-input" min="0.1" step="0.1" value="1.2">
        </label>
      </div>
      <div class="calc-row">
        <label class="form-label">Direct bilirubin (mg/dL, optional)
          <input id="lft-dbili" type="number" class="form-input" min="0" step="0.1" placeholder="optional">
        </label>
      </div>
    </div>
    <div class="calc-actions">
      <button id="lft-calc" type="button" class="btn btn-accent">Calculate</button>
    </div>
    <div id="lft-result" class="calc-result" hidden>
      <div class="calc-result-value" id="lft-value"></div>
      <div class="calc-result-label" id="lft-label"></div>
      <div class="calc-result-detail" id="lft-detail"></div>
    </div>
    <div class="calc-formula">R = (ALT / ALT<sub>ULN</sub>) ÷ (ALP / ALP<sub>ULN</sub>)</div>
  </div>`;
}

function bindLft() {
  ['lft-ast', 'lft-ast-uln', 'lft-alt', 'lft-alt-uln', 'lft-alp', 'lft-alp-uln', 'lft-tbili', 'lft-tbili-uln', 'lft-dbili'].forEach(id => {
    document.getElementById(id).addEventListener('input', calcLft);
  });
  document.getElementById('lft-calc').addEventListener('click', calcLft);
  bindEnterToCalculate(['lft-ast', 'lft-ast-uln', 'lft-alt', 'lft-alt-uln', 'lft-alp', 'lft-alp-uln', 'lft-tbili', 'lft-tbili-uln', 'lft-dbili'], calcLft);
}

function calcLft() {
  const ast      = parseFloat(document.getElementById('lft-ast').value);
  const astUln   = parseFloat(document.getElementById('lft-ast-uln').value);
  const alt      = parseFloat(document.getElementById('lft-alt').value);
  const altUln   = parseFloat(document.getElementById('lft-alt-uln').value);
  const alp      = parseFloat(document.getElementById('lft-alp').value);
  const alpUln   = parseFloat(document.getElementById('lft-alp-uln').value);
  const tbili    = parseFloat(document.getElementById('lft-tbili').value);
  const tbiliUln = parseFloat(document.getElementById('lft-tbili-uln').value);
  const dbiliRaw = document.getElementById('lft-dbili').value.trim();
  const dbili    = dbiliRaw !== '' ? parseFloat(dbiliRaw) : null;
  const result   = document.getElementById('lft-result');

  if ([ast, astUln, alt, altUln, alp, alpUln, tbili, tbiliUln].some(v => isNaN(v) || v <= 0)) { result.hidden = true; return; }

  const astRatio   = ast / astUln;
  const altRatio   = alt / altUln;
  const alpRatio   = alp / alpUln;
  const tbiliRatio = tbili / tbiliUln;
  const r          = alpRatio > 0 ? altRatio / alpRatio : Infinity;

  let pattern, cls, lines = [];

  if (altRatio <= 1 && alpRatio <= 1 && tbiliRatio <= 1) {
    pattern = 'No significant LFT elevation pattern';
    cls = 'calc-result';
    lines.push('AST, ALT, ALP, and bilirubin are not above the entered upper limits of normal.');
    lines.push('Correlate with symptoms and trend over time if clinical concern remains high.');
  } else if (altRatio <= 1 && alpRatio <= 1 && tbiliRatio > 1) {
    pattern = 'Isolated hyperbilirubinemia';
    cls = 'calc-result is-warning';
    lines.push('Bilirubin is elevated without a clear hepatocellular or cholestatic enzyme pattern.');
    if (dbili !== null && tbili > 0) {
      const directFraction = dbili / tbili;
      if (directFraction < 0.2) {
        lines.push('Predominantly indirect bilirubin can suggest Gilbert syndrome or hemolysis.');
      } else if (directFraction > 0.5) {
        lines.push('Predominantly direct bilirubin can suggest cholestasis or impaired hepatic excretion.');
      }
    }
    lines.push('If bilirubin remains elevated, correlate with hemolysis labs and biliary imaging as appropriate.');
  } else {
    if (altRatio > 1 && alpRatio > 1) {
      if (r >= 5) {
        pattern = 'Hepatocellular pattern';
        cls = 'calc-result is-danger';
        lines.push('ALT elevation is dominant relative to ALP, which fits a hepatocellular injury pattern.');
        lines.push('Typical considerations include viral hepatitis, ischaemic injury, toxin or medication-related hepatitis, and autoimmune hepatitis.');
      } else if (r <= 2) {
        pattern = 'Cholestatic pattern';
        cls = 'calc-result is-warning';
        lines.push('ALP elevation is dominant relative to ALT, which fits a cholestatic pattern.');
        lines.push('This can suggest biliary obstruction, choledocholithiasis, PSC, PBC, infiltrative disease, or cholestatic drug injury.');
      } else {
        pattern = 'Mixed hepatocellular/cholestatic pattern';
        cls = 'calc-result';
        lines.push('Both ALT and ALP are elevated with an intermediate R factor, which fits a mixed injury pattern.');
        lines.push('This can be seen with drug-induced liver injury, biliary disease with superimposed hepatitis, or evolving obstruction.');
      }
    } else if (altRatio > 1) {
      pattern = 'Predominantly hepatocellular pattern';
      cls = 'calc-result is-danger';
      lines.push('Transaminase elevation is greater than ALP elevation, favouring hepatocellular injury.');
      lines.push('Consider viral, ischaemic, inflammatory, metabolic, or drug-related causes in the right clinical context.');
    } else {
      pattern = 'Predominantly cholestatic pattern';
      cls = 'calc-result is-warning';
      lines.push('ALP elevation exceeds the transaminase pattern, favouring cholestasis.');
      lines.push('Consider biliary obstruction or hepatic cholestatic processes; if ALP is isolated, confirm hepatic source with GGT or isoenzymes.');
    }

    if (tbiliRatio > 1) {
      lines.push('Concurrent bilirubin elevation suggests more significant cholestasis or reduced hepatic excretory function.');
    }
  }

  if (!isNaN(ast) && !isNaN(alt) && alt > 0 && (astRatio > 1 || altRatio > 1)) {
    const astAlt = ast / alt;
    if (astAlt >= 2) {
      lines.push('AST:ALT ratio ≥ 2 can be seen with alcohol-associated liver injury, especially when both are elevated.');
    } else if (astAlt > 1) {
      lines.push('AST:ALT ratio > 1 can be seen with advanced fibrosis or cirrhosis, but is nonspecific.');
    }
  }

  const ratioLine = [
    `AST ${astRatio.toFixed(1)}× ULN`,
    `ALT ${altRatio.toFixed(1)}× ULN`,
    `ALP ${alpRatio.toFixed(1)}× ULN`,
    `Total bilirubin ${tbiliRatio.toFixed(1)}× ULN`,
    isFinite(r) ? `R factor ${r.toFixed(2)}` : null,
    (!isNaN(ast) && alt > 0) ? `AST:ALT ${(ast/alt).toFixed(2)}` : null,
  ].filter(Boolean).join(' | ');

  document.getElementById('lft-value').textContent = isFinite(r) ? `R = ${r.toFixed(2)}` : '';
  document.getElementById('lft-label').textContent = pattern;
  document.getElementById('lft-detail').innerHTML = ratioLine + '<br><br>' + lines.join('<br>');
  result.className = cls;
  result.hidden = false;
}

// ── 4. DLP Single-Scan Dose Builder ────────────────────────
// AAPM k-factors (mSv per mGy·cm) — from AAPM Report 96
const DLP_K = {
  head:     { adult: 0.0023, pediatric_5y: 0.0067, pediatric_1y: 0.011 },
  chest:    { adult: 0.014,  pediatric_5y: 0.026,  pediatric_1y: 0.039 },
  abdomen:  { adult: 0.015,  pediatric_5y: 0.020,  pediatric_1y: 0.049 },
  pelvis:   { adult: 0.015,  pediatric_5y: 0.020,  pediatric_1y: 0.049 },
  spine:    { adult: 0.015,  pediatric_5y: 0.020,  pediatric_1y: 0.049 },
  caa:      { adult: 0.014,  pediatric_5y: 0.026,  pediatric_1y: 0.039 },  // chest+abdomen+pelvis
};

let dlpScans = [];

function getDlpScanInputs() {
  const dlpPerScan = parseFloat(document.getElementById('dlp-val').value);
  const region = document.getElementById('dlp-region').value;
  const age = document.getElementById('dlp-age').value;

  if (
    isNaN(dlpPerScan) || dlpPerScan < 0
  ) {
    return null;
  }

  const k = DLP_K[region]?.[age];
  if (!k) {
    return null;
  }

  return {
    dlpPerScan,
    region,
    age,
    k,
    effectiveDoseMsv: dlpPerScan * k
  };
}

function beirRiskSummary(totalEffectiveDoseMsv, scanCount) {
  const scanLabel = scanCount === 1 ? 'scan' : 'scans';

  return {
    text: `BEIR VII Phase 2 describes ionizing-radiation risk primarily as a small, cumulative increase in lifetime cancer risk rather than immediate side effects. For ${scanCount} ${scanLabel}, the main concern is the added stochastic risk from the cumulative effective dose (${totalEffectiveDoseMsv.toFixed(2)} mSv). Acute effects such as skin injury are not expected from typical diagnostic CT exposures, but risk rises as more scans are added.`
  };
}

function renderDlpScans() {
  const result = document.getElementById('dlp-result');
  const scanList = document.getElementById('dlp-scan-list');

  if (!dlpScans.length) {
    scanList.innerHTML = '';
    result.hidden = true;
    return;
  }

  const totals = dlpScans.reduce((accumulator, scan) => {
    accumulator.totalDlp += scan.dlpPerScan;
    accumulator.totalEffectiveDoseMsv += scan.effectiveDoseMsv;
    return accumulator;
  }, {
    totalDlp: 0,
    totalEffectiveDoseMsv: 0
  });

  const latestScan = dlpScans[dlpScans.length - 1];
  const scanCount = dlpScans.length;
  const backgroundYears = totals.totalEffectiveDoseMsv / 2.4;
  const beirSummary = beirRiskSummary(totals.totalEffectiveDoseMsv, scanCount);

  document.getElementById('dlp-value').textContent = totals.totalEffectiveDoseMsv.toFixed(2);
  document.getElementById('dlp-detail').textContent =
    `Running total from ${scanCount} ${scanCount === 1 ? 'scan' : 'scans'}: ${totals.totalDlp.toFixed(1)} mGy·cm total DLP, ${totals.totalEffectiveDoseMsv.toFixed(2)} mSv effective dose, about ${backgroundYears.toFixed(1)} years of natural background radiation. Most recent scan: ${latestScan.dlpPerScan.toFixed(1)} mGy·cm in ${latestScan.region.replace(/_/g, ' ')} (${latestScan.age.replace(/_/g, ' ')}).`;
  document.getElementById('dlp-beir').textContent = beirSummary.text;

  scanList.innerHTML = dlpScans.map((scan, index) => {
    const scanNumber = index + 1;
    return `
      <li class="calc-scan-entry">
        <div class="calc-scan-copy">
          <strong>Scan ${scanNumber}</strong>
          <div class="calc-scan-meta">${scan.dlpPerScan.toFixed(1)} mGy·cm · ${scan.region.replace(/_/g, ' ')} · ${scan.age.replace(/_/g, ' ')}</div>
        </div>
        <div class="calc-scan-badge">${scan.effectiveDoseMsv.toFixed(2)} mSv</div>
      </li>`;
  }).join('');

  result.hidden = false;
}

function addDlpScan() {
  const scan = getDlpScanInputs();
  if (!scan) {
    return;
  }

  dlpScans.push(scan);
  renderDlpScans();
}

function resetDlpScans() {
  dlpScans = [];
  renderDlpScans();
}

function dlpHtml() {
  return `
  <div class="calc-card">
    <h2>DLP Single-Scan Dose Builder</h2>
    <p class="calc-description">Calculates one scan at a time using DLP plus scan type and age group, then adds each scan to a running total so you can build up cumulative dose step by step.</p>
    <div class="calc-form">
      <label class="form-label">DLP per scan (mGy·cm)
        <input id="dlp-val" type="number" class="form-input" min="0" step="1" placeholder="e.g. 450">
      </label>
      <div class="calc-row">
        <label class="form-label">Scan type
          <select id="dlp-region" class="form-input">
            <option value="head">Head / Brain</option>
            <option value="chest" selected>Chest</option>
            <option value="abdomen">Abdomen</option>
            <option value="pelvis">Pelvis</option>
            <option value="caa">Chest + Abd + Pelvis</option>
            <option value="spine">Spine</option>
          </select>
        </label>
        <label class="form-label">Patient Age
          <select id="dlp-age" class="form-input">
            <option value="adult" selected>Adult</option>
            <option value="pediatric_5y">Paediatric (~5 yr)</option>
            <option value="pediatric_1y">Paediatric (~1 yr)</option>
          </select>
        </label>
      </div>
    </div>
    <div class="calc-actions">
      <button id="dlp-add-scan" type="button" class="btn btn-accent">Add scan</button>
      <button id="dlp-reset" type="button" class="btn btn-ghost">Reset total</button>
    </div>
    <div id="dlp-result" class="calc-result" hidden>
      <div class="calc-result-value" id="dlp-value"></div>
      <div class="calc-result-label">mSv running effective dose total (approx)</div>
      <div class="calc-result-detail" id="dlp-detail"></div>
      <div class="calc-result-detail" id="dlp-beir"></div>
      <ul id="dlp-scan-list" class="calc-scan-list"></ul>
    </div>
    <div class="calc-formula">Dose<sub>mSv</sub> ≈ DLP × k-factor. Click Add scan to keep a running total.</div>
  </div>`;
}

function bindDlp() {
  ['dlp-val', 'dlp-region', 'dlp-age'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderDlpScans);
  });
  document.getElementById('dlp-add-scan').addEventListener('click', addDlpScan);
  document.getElementById('dlp-reset').addEventListener('click', resetDlpScans);
  bindEnterToCalculate(['dlp-val', 'dlp-region', 'dlp-age'], addDlpScan);
  renderDlpScans();
}

function quickLinksHtml() {
  return `
  <div class="calc-card">
    <h2>Quick Links</h2>
    <p class="calc-description">Fast access to common external radiology resources.</p>
    <ul class="quick-links-list">
      <li class="quick-links-item">
        <a class="quick-link" href="https://www.mrisafety.com/TMDL_list.php?orderby=alist_description" target="_blank" rel="noopener noreferrer">MRI Safety</a>
      </li>
      <li class="quick-links-item">
        <a class="quick-link" href="https://gravitas.acr.org/acportal?_gl=1*1h69pe5*_gcl_au*MTE4NzYxMzAwLjE3Nzg0NDc1NTY.*_ga*MjE0MzgxMjI2NS4xNzUzNTQ1MDIx*_ga_K9XZBF7MXP*czE3Nzg2ODM2NDMkbzI4JGcwJHQxNzc4NjgzNjQzJGo2MCRsMCRoMA.." target="_blank" rel="noopener noreferrer">ACR Appropriateness Criteria</a>
      </li>
    </ul>
  </div>`;
}
