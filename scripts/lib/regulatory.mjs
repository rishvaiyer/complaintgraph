// ComplaintGraph — open regulatory cross-reference layer.
//
// Adds an OPTIONAL, additive `regulatory` block to a company record by looking
// up PUBLIC, open government/registry data:
//   - FDIC BankFind Suite API   (bank identity / charter / assets / active)
//   - SEC EDGAR submissions JSON (public filer CIK + recent filings)
//   - GLEIF LEI records          (legal entity identifier + legal name)
//
// Everything here is public-record fact, clearly sourced and labeled — never a
// verdict and never editorialized. The block is OPTIONAL so existing consumers
// of buildCompany() that ignore it keep working unchanged.
//
// Two entry points:
//   sampleRegulatory(company)            — deterministic SAMPLE block, no network.
//   fetchRegulatory(company, opts)        — live, bounded lookups (see ingest).
//
// Schema (shape of the `regulatory` object attached to a company record):
//   {
//     data_source: "sample" | "live",
//     fdic: { cert, name, city, state, active, asset_thousands, established } | null,
//     sec:  { cik, entity_name, recent_filings: [{ form, date, primary_doc }] } | null,
//     lei:  { lei, legal_name, jurisdiction, status, registration_status } | null,
//     sources: [ { label, url } ],
//     note: string,
//   }

// ---------------------------------------------------------------------------
// Public source links (shown in the UI, also used as provenance).
// ---------------------------------------------------------------------------
export const SOURCE_LINKS = {
  fdic: { label: 'FDIC BankFind Suite', url: 'https://banks.data.fdic.gov/bankfind-suite/bankfind' },
  sec: { label: 'SEC EDGAR', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany' },
  lei: { label: 'GLEIF LEI Search', url: 'https://search.gleif.org/' },
};

// Descriptive User-Agent required by SEC EDGAR policy. Includes a contact.
export const SEC_USER_AGENT =
  process.env.CG_SEC_USER_AGENT ||
  'ComplaintGraph/0.1 (unEvilGenius Labs; open public-data dashboard; contact: complaintgraph@example.com)';

// ---------------------------------------------------------------------------
// SAMPLE regulatory data.
//
// Deterministic, synthetic-but-realistically-shaped public-record blocks so the
// dashboard renders fully offline. Clearly labeled SAMPLE. Values are plausible
// stand-ins (e.g. banks have an FDIC cert; credit bureaus do not but may have an
// LEI / SEC filer status). NOT authoritative — replaced by live lookups in CI.
// ---------------------------------------------------------------------------
const SAMPLE_REGULATORY = {
  'capital-one': {
    fdic: {
      cert: 4297, name: 'Capital One, National Association', city: 'McLean',
      state: 'VA', active: true, asset_thousands: 478_000_000, established: '1933-07-07',
    },
    sec: {
      cik: '0000927628', entity_name: 'CAPITAL ONE FINANCIAL CORP',
      recent_filings: [
        { form: '10-K', date: '2026-02-20', primary_doc: 'cof-20251231.htm' },
        { form: '10-Q', date: '2026-05-01', primary_doc: 'cof-20260331.htm' },
        { form: '8-K', date: '2026-04-22', primary_doc: 'cof-8k.htm' },
      ],
    },
    lei: {
      lei: '6J1FOLBNV4Q1KYT3X664', legal_name: 'Capital One Financial Corporation',
      jurisdiction: 'US-DE', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
  'bank-of-america': {
    fdic: {
      cert: 3510, name: 'Bank of America, National Association', city: 'Charlotte',
      state: 'NC', active: true, asset_thousands: 2_550_000_000, established: '1879-01-01',
    },
    sec: {
      cik: '0000070858', entity_name: 'BANK OF AMERICA CORP',
      recent_filings: [
        { form: '10-K', date: '2026-02-24', primary_doc: 'bac-20251231.htm' },
        { form: '10-Q', date: '2026-05-02', primary_doc: 'bac-20260331.htm' },
      ],
    },
    lei: {
      lei: 'B4TYDEB6GKMZO031MB27', legal_name: 'Bank of America Corporation',
      jurisdiction: 'US-DE', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
  'wells-fargo': {
    fdic: {
      cert: 3511, name: 'Wells Fargo Bank, National Association', city: 'Sioux Falls',
      state: 'SD', active: true, asset_thousands: 1_720_000_000, established: '1870-01-01',
    },
    sec: {
      cik: '0000072971', entity_name: 'WELLS FARGO & COMPANY',
      recent_filings: [
        { form: '10-K', date: '2026-02-18', primary_doc: 'wfc-20251231.htm' },
        { form: '8-K', date: '2026-04-11', primary_doc: 'wfc-8k.htm' },
      ],
    },
    lei: {
      lei: 'PBLD0EJDB5FWOLXP3B76', legal_name: 'Wells Fargo & Company',
      jurisdiction: 'US-DE', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
  'jpmorgan-chase': {
    fdic: {
      cert: 628, name: 'JPMorgan Chase Bank, National Association', city: 'Columbus',
      state: 'OH', active: true, asset_thousands: 3_500_000_000, established: '1824-01-01',
    },
    sec: {
      cik: '0000019617', entity_name: 'JPMORGAN CHASE & CO',
      recent_filings: [
        { form: '10-K', date: '2026-02-13', primary_doc: 'jpm-20251231.htm' },
        { form: '10-Q', date: '2026-05-05', primary_doc: 'jpm-20260331.htm' },
      ],
    },
    lei: {
      lei: '8I5DZWZKVSZI1NUHU748', legal_name: 'JPMorgan Chase & Co.',
      jurisdiction: 'US-DE', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
  // Credit bureaus: no FDIC charter (not banks). Experian is privately held in
  // the US (no US SEC filer) but has an LEI; Equifax and TransUnion are public
  // filers with an LEI but no FDIC cert.
  experian: {
    fdic: null,
    sec: null,
    lei: {
      lei: '213800FNJTRSU3SZWN05', legal_name: 'Experian Information Solutions, Inc.',
      jurisdiction: 'US-OH', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
  equifax: {
    fdic: null,
    sec: {
      cik: '0000033185', entity_name: 'EQUIFAX INC',
      recent_filings: [
        { form: '10-K', date: '2026-02-25', primary_doc: 'efx-20251231.htm' },
        { form: '8-K', date: '2026-04-16', primary_doc: 'efx-8k.htm' },
      ],
    },
    lei: {
      lei: 'L13RU0RZ8NU6RWFW1Y26', legal_name: 'Equifax Inc.',
      jurisdiction: 'US-GA', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
  transunion: {
    fdic: null,
    sec: {
      cik: '0001552033', entity_name: 'TransUnion',
      recent_filings: [
        { form: '10-K', date: '2026-02-12', primary_doc: 'tru-20251231.htm' },
        { form: '10-Q', date: '2026-05-09', primary_doc: 'tru-20260331.htm' },
      ],
    },
    lei: {
      lei: '529900XSTAS5T2ELEW68', legal_name: 'TransUnion',
      jurisdiction: 'US-DE', status: 'ACTIVE', registration_status: 'ISSUED',
    },
  },
};

const SAMPLE_NOTE =
  'SAMPLE public-record cross-reference — synthetic, illustrative values for offline demo. ' +
  'Replaced by live FDIC / SEC EDGAR / GLEIF lookups when ingested in CI.';

// Build the `sources` list from whichever facts are present.
function sourcesFor({ fdic, sec, lei }) {
  const out = [];
  if (fdic) out.push(SOURCE_LINKS.fdic);
  if (sec) out.push(SOURCE_LINKS.sec);
  if (lei) out.push(SOURCE_LINKS.lei);
  return out;
}

// Deterministic SAMPLE regulatory block for a company (by slug). Returns a block
// even when there is no match, so the UI can render "no public match" cleanly.
export function sampleRegulatory(company) {
  const base = SAMPLE_REGULATORY[company.slug] || { fdic: null, sec: null, lei: null };
  const fdic = base.fdic || null;
  const sec = base.sec || null;
  const lei = base.lei || null;
  return {
    data_source: 'sample',
    fdic,
    sec,
    lei,
    sources: sourcesFor({ fdic, sec, lei }),
    note: SAMPLE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// LIVE lookups. Each is independently bounded (per-request AbortController) and
// swallows its own errors, returning null on any failure so the caller can keep
// whatever data already exists. Mirrors the CFPB ingest's discipline.
// ---------------------------------------------------------------------------

async function fetchJSON(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// FDIC BankFind Suite — only banks match. Returns null on no-match or error.
async function fetchFDIC(company, opts) {
  // Only attempt for bank-like entities; bureaus/cards holding cos won't match.
  if (company.kind === 'bureau') return null;
  try {
    const q = (company.displayName || company.name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim();
    if (!q) return null;
    const url =
      'https://banks.data.fdic.gov/api/institutions' +
      '?filters=ACTIVE:1' +
      `&search=NAME:${encodeURIComponent(q)}` +
      '&fields=NAME,CERT,CITY,STALP,ACTIVE,ASSET,ESTYMD' +
      '&sort_by=ASSET&sort_order=DESC&limit=1&format=json';
    const json = await fetchJSON(url, { timeoutMs: opts.timeoutMs });
    const row = json?.data?.[0]?.data;
    if (!row || row.CERT == null) return null;
    return {
      cert: Number(row.CERT),
      name: row.NAME || '',
      city: row.CITY || '',
      state: row.STALP || '',
      active: String(row.ACTIVE) === '1' || row.ACTIVE === 1,
      asset_thousands: row.ASSET != null ? Number(row.ASSET) : null,
      established: normalizeFdicDate(row.ESTYMD),
    };
  } catch (err) {
    console.warn(`  (FDIC lookup failed for ${company.displayName}: ${err.message})`);
    return null;
  }
}

function normalizeFdicDate(v) {
  if (!v) return '';
  // FDIC ESTYMD is often an ISO-ish string or epoch ms; keep just YYYY-MM-DD.
  const s = String(v);
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return '';
}

// SEC EDGAR — resolve CIK via the full-text company tickers map, then pull the
// submissions JSON for recent filings. Requires a descriptive User-Agent.
async function fetchSEC(company, opts) {
  try {
    const cik = await resolveCIK(company, opts);
    if (!cik) return null;
    const padded = String(cik).padStart(10, '0');
    const json = await fetchJSON(`https://data.sec.gov/submissions/CIK${padded}.json`, {
      headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
      timeoutMs: opts.timeoutMs,
    });
    const recent = json?.filings?.recent;
    const filings = [];
    if (recent?.form) {
      const n = Math.min(recent.form.length, 6);
      for (let i = 0; i < n && filings.length < 5; i++) {
        filings.push({
          form: recent.form[i] || '',
          date: recent.filingDate?.[i] || '',
          primary_doc: recent.primaryDocument?.[i] || '',
        });
      }
    }
    return {
      cik: padded,
      entity_name: json?.name || company.displayName,
      recent_filings: filings,
    };
  } catch (err) {
    console.warn(`  (SEC lookup failed for ${company.displayName}: ${err.message})`);
    return null;
  }
}

// Resolve a CIK from SEC's public company_tickers.json (name → CIK), bounded.
let _tickerCache = null;
async function resolveCIK(company, opts) {
  if (!_tickerCache) {
    const json = await fetchJSON('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
      timeoutMs: opts.timeoutMs,
    });
    _tickerCache = Object.values(json || {});
  }
  const target = (company.displayName || company.name || '').toUpperCase();
  // Match on a leading token of the display name (e.g. "CAPITAL ONE").
  const key = target.split(/\s+/).slice(0, 2).join(' ');
  let best = null;
  for (const e of _tickerCache) {
    const t = String(e.title || '').toUpperCase();
    if (t.startsWith(key)) { best = e; break; }
  }
  return best ? best.cik_str : null;
}

// GLEIF LEI — confirm the legal entity. Returns null on no-match or error.
async function fetchLEI(company, opts) {
  try {
    const name = company.displayName || company.name || '';
    if (!name) return null;
    const url =
      'https://api.gleif.org/api/v1/lei-records' +
      `?filter[entity.legalName]=${encodeURIComponent(name)}&page[size]=1`;
    const json = await fetchJSON(url, {
      headers: { Accept: 'application/vnd.api+json' },
      timeoutMs: opts.timeoutMs,
    });
    const rec = json?.data?.[0];
    if (!rec) return null;
    const attr = rec.attributes || {};
    const entity = attr.entity || {};
    return {
      lei: rec.id || attr.lei || '',
      legal_name: entity.legalName?.name || name,
      jurisdiction: entity.jurisdiction || (entity.legalAddress?.country
        ? `${entity.legalAddress.country}` : ''),
      status: entity.status || '',
      registration_status: attr.registration?.status || '',
    };
  } catch (err) {
    console.warn(`  (GLEIF lookup failed for ${company.displayName}: ${err.message})`);
    return null;
  }
}

// Live enrichment for one company. Each source is independent; any failure just
// yields null for that source. Never throws.
export async function fetchRegulatory(company, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const [fdic, sec, lei] = await Promise.all([
    fetchFDIC(company, { timeoutMs }),
    fetchSEC(company, { timeoutMs }),
    fetchLEI(company, { timeoutMs }),
  ]);
  return {
    data_source: 'live',
    fdic,
    sec,
    lei,
    sources: sourcesFor({ fdic, sec, lei }),
    note: 'Live public-record cross-reference from FDIC BankFind, SEC EDGAR, and GLEIF. Public records only — not a verdict.',
  };
}
