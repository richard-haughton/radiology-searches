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
    <p class="calc-description">Classifies liver injury pattern using the R-factor. Requires ALT and ALP with their upper limits of normal (ULN).</p>
    <div class="calc-form">
      <div class="calc-row">
        <label class="form-label">ALT (U/L)
          <input id="lft-alt" type="number" class="form-input" min="0" step="1" placeholder="e.g. 180">
        </label>
        <label class="form-label">ALT ULN (U/L)
          <input id="lft-alt-uln" type="number" class="form-input" min="1" step="1" placeholder="e.g. 40">
        </label>
      </div>
      <div class="calc-row">
        <label class="form-label">ALP (U/L)
          <input id="lft-alp" type="number" class="form-input" min="0" step="1" placeholder="e.g. 95">
        </label>
        <label class="form-label">ALP ULN (U/L)
          <input id="lft-alp-uln" type="number" class="form-input" min="1" step="1" placeholder="e.g. 120">
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
  ['lft-alt', 'lft-alt-uln', 'lft-alp', 'lft-alp-uln'].forEach(id => {
    document.getElementById(id).addEventListener('input', calcLft);
  });
  document.getElementById('lft-calc').addEventListener('click', calcLft);
  bindEnterToCalculate(['lft-alt', 'lft-alt-uln', 'lft-alp', 'lft-alp-uln'], calcLft);
}

function calcLft() {
  const alt    = parseFloat(document.getElementById('lft-alt').value);
  const altUln = parseFloat(document.getElementById('lft-alt-uln').value);
  const alp    = parseFloat(document.getElementById('lft-alp').value);
  const alpUln = parseFloat(document.getElementById('lft-alp-uln').value);
  const result = document.getElementById('lft-result');

  if ([alt, altUln, alp, alpUln].some(v => isNaN(v) || v <= 0)) { result.hidden = true; return; }

  const r = (alt / altUln) / (alp / alpUln);
  let pattern, cls, detail;

  if (r >= 5) {
    pattern = 'Hepatocellular';
    cls = 'calc-result is-danger';
    detail = `R = ${r.toFixed(2)} (≥5). Predominantly hepatocellular injury pattern. Consider hepatitis (viral, autoimmune, drug-induced), ischaemia, or metabolic liver disease.`;
  } else if (r <= 2) {
    pattern = 'Cholestatic';
    cls = 'calc-result is-warning';
    detail = `R = ${r.toFixed(2)} (≤2). Predominantly cholestatic pattern. Consider biliary obstruction, primary biliary cholangitis, drug-induced cholestasis.`;
  } else {
    pattern = 'Mixed';
    cls = 'calc-result';
    detail = `R = ${r.toFixed(2)} (2–5). Mixed hepatocellular/cholestatic pattern. Broad differential — consider cross-sectional imaging for biliary/hepatic assessment.`;
  }

  document.getElementById('lft-value').textContent = r.toFixed(2);
  document.getElementById('lft-label').textContent = pattern + ' pattern';
  document.getElementById('lft-detail').textContent = detail;
  result.className = cls;
  result.hidden = false;
}

// ── 4. DLP Multi-Scan Dose Estimator ───────────────────────
// AAPM k-factors (mSv per mGy·cm) — from AAPM Report 96
const DLP_K = {
  head:     { adult: 0.0023, pediatric_5y: 0.0067, pediatric_1y: 0.011 },
  chest:    { adult: 0.014,  pediatric_5y: 0.026,  pediatric_1y: 0.039 },
  abdomen:  { adult: 0.015,  pediatric_5y: 0.020,  pediatric_1y: 0.049 },
  pelvis:   { adult: 0.015,  pediatric_5y: 0.020,  pediatric_1y: 0.049 },
  spine:    { adult: 0.015,  pediatric_5y: 0.020,  pediatric_1y: 0.049 },
  caa:      { adult: 0.014,  pediatric_5y: 0.026,  pediatric_1y: 0.039 },  // chest+abdomen+pelvis
};

function deterministicRiskBand(absorbedDoseMgy) {
  if (absorbedDoseMgy < 500) {
    return {
      cls: 'calc-result',
      text: 'Very low likelihood of deterministic tissue effects. Skin erythema, alopecia, and sterility are not expected at this level.'
    };
  }
  if (absorbedDoseMgy < 2000) {
    return {
      cls: 'calc-result',
      text: 'Low likelihood of deterministic tissue effects. Most patients remain below typical skin-injury and sterility thresholds.'
    };
  }
  if (absorbedDoseMgy < 3000) {
    return {
      cls: 'calc-result is-warning',
      text: 'Moderate likelihood zone. Transient skin erythema can occur in some patients; temporary epilation is less common but possible.'
    };
  }
  if (absorbedDoseMgy < 7000) {
    return {
      cls: 'calc-result is-danger',
      text: 'Higher deterministic-risk zone. Transient erythema and temporary alopecia become more likely. Temporary sterility can occur if gonadal dose is substantial.'
    };
  }
  return {
    cls: 'calc-result is-danger',
    text: 'Very high deterministic-risk zone. Significant skin injury (erythema/desquamation), prolonged alopecia, and gonadal injury risk require urgent dose review.'
  };
}

function dlpHtml() {
  return `
  <div class="calc-card">
    <h2>DLP Multi-Scan Dose Estimator</h2>
    <p class="calc-description">Estimates cumulative CT dose across multiple scans. Primary output is cumulative absorbed dose (mGy) using DLP/scan length, with deterministic-effect likelihood guidance.</p>
    <div class="calc-form">
      <label class="form-label">DLP per scan (mGy·cm)
        <input id="dlp-val" type="number" class="form-input" min="0" step="1" placeholder="e.g. 450">
      </label>
      <div class="calc-row">
        <label class="form-label">Number of scans
          <input id="dlp-scans" type="number" class="form-input" min="1" step="1" value="1">
        </label>
        <label class="form-label">Scan length per scan (cm)
          <input id="dlp-length" type="number" class="form-input" min="1" step="0.1" value="40">
        </label>
      </div>
      <div class="calc-row">
        <label class="form-label">Body Region
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
      <button id="dlp-calc" type="button" class="btn btn-accent">Calculate</button>
    </div>
    <div id="dlp-result" class="calc-result" hidden>
      <div class="calc-result-value" id="dlp-value"></div>
      <div class="calc-result-label">mGy cumulative absorbed dose (approx)</div>
      <div class="calc-result-detail" id="dlp-detail"></div>
      <div class="calc-result-detail" id="dlp-deterministic"></div>
    </div>
    <div class="calc-formula">Dose<sub>mGy</sub> ≈ (DLP per scan × scans) ÷ scan length</div>
  </div>`;
}

function bindDlp() {
  ['dlp-val', 'dlp-scans', 'dlp-length', 'dlp-region', 'dlp-age'].forEach(id => {
    document.getElementById(id).addEventListener('input', calcDlp);
  });
  document.getElementById('dlp-calc').addEventListener('click', calcDlp);
  bindEnterToCalculate(['dlp-val', 'dlp-scans', 'dlp-length', 'dlp-region', 'dlp-age'], calcDlp);
}

function calcDlp() {
  const dlpPerScan = parseFloat(document.getElementById('dlp-val').value);
  const scans = parseInt(document.getElementById('dlp-scans').value, 10);
  const scanLengthCm = parseFloat(document.getElementById('dlp-length').value);
  const region = document.getElementById('dlp-region').value;
  const age = document.getElementById('dlp-age').value;
  const result = document.getElementById('dlp-result');

  if (
    isNaN(dlpPerScan) || dlpPerScan < 0 ||
    isNaN(scans) || scans < 1 ||
    isNaN(scanLengthCm) || scanLengthCm <= 0
  ) {
    result.hidden = true;
    return;
  }

  const k = DLP_K[region]?.[age];
  if (!k) { result.hidden = true; return; }

  const totalDlp = dlpPerScan * scans;
  const totalMsv = k * totalDlp;
  const absorbedDoseMgy = totalDlp / scanLengthCm;

  document.getElementById('dlp-value').textContent = absorbedDoseMgy.toFixed(1);

  const riskBand = deterministicRiskBand(absorbedDoseMgy);
  const bgYears = totalMsv / 2.4;

  document.getElementById('dlp-detail').textContent =
    `Total DLP = ${totalDlp.toFixed(1)} mGy·cm (${dlpPerScan.toFixed(1)} × ${scans}). Effective dose context: ${totalMsv.toFixed(2)} mSv (k=${k}), about ${bgYears.toFixed(1)} years of natural background radiation.`;

  document.getElementById('dlp-deterministic').textContent =
    `${riskBand.text} Guidance only: deterministic thresholds vary by tissue, exposed field, and fractionation. Use formal dosimetry/physics review for clinical decisions.`;

  result.className = riskBand.cls;
  result.hidden = false;
}
