// ComplaintGraph — CFPB ingest.
//
// Fetches recent complaints for each curated company from the public CFPB
// Consumer Complaint Database and bakes them into static JSON the dashboard
// reads. No API key required. Runs in CI (open internet); the committed sample
// dataset is the fallback if this ever fails.
//
// Usage:  node scripts/ingest-cfpb.mjs
// Env:    CG_MONTHS (lookback window, default 18)
//         CG_MAX_PER_COMPANY (page cap, default 5000)
//
// Docs: https://cfpb.github.io/api/ccdb/api.html

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCompany, COMPANIES } from './lib/analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
const API = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';

const MONTHS = Number(process.env.CG_MONTHS || 18);
const MAX_PER_COMPANY = Number(process.env.CG_MAX_PER_COMPANY || 2000);
const PAGE = 100;
const REQUEST_TIMEOUT_MS = Number(process.env.CG_REQUEST_TIMEOUT_MS || 20000);
// Hard wall-clock budget for the whole ingest so a slow/hanging API can never
// stall the deploy. When it trips, whatever was fetched so far is used and the
// rest falls back to committed sample data.
const TOTAL_BUDGET_MS = Number(process.env.CG_TOTAL_BUDGET_MS || 240000);
const START = Date.now();

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function windowDates() {
  const max = new Date();
  const min = new Date(max);
  min.setUTCMonth(min.getUTCMonth() - MONTHS);
  return { min: isoDate(min), max: isoDate(max) };
}

// One page of raw hits for a company.
async function fetchPage(companyName, window, frm) {
  const url = new URL(API);
  url.searchParams.set('company', companyName);
  url.searchParams.set('date_received_min', window.min);
  url.searchParams.set('date_received_max', window.max);
  url.searchParams.set('size', String(PAGE));
  url.searchParams.set('frm', String(frm));
  url.searchParams.set('no_aggs', 'true');
  url.searchParams.set('sort', 'created_date_desc');
  url.searchParams.set('format', 'json');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${companyName} (frm=${frm})`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const hits = json?.hits?.hits ?? [];
  const totalRaw = json?.hits?.total;
  const total = typeof totalRaw === 'object' ? totalRaw?.value ?? 0 : totalRaw ?? 0;
  return { hits, total };
}

// Map a CFPB hit `_source` to our normalized record shape.
function normalize(src) {
  return {
    date_received: (src.date_received || '').slice(0, 10),
    product: src.product || '',
    issue: src.issue || '',
    state: src.state || '',
    company_response: src.company_response || '',
    timely: String(src.timely || '').toLowerCase() === 'yes',
    narrative: src.complaint_what_happened || '',
  };
}

async function fetchCompany(company, window) {
  const records = [];
  let frm = 0;
  let total = Infinity;
  while (frm < total && records.length < MAX_PER_COMPANY) {
    if (Date.now() - START > TOTAL_BUDGET_MS) {
      console.warn(`  (time budget reached — stopping ${company.displayName} at ${records.length})`);
      break;
    }
    const { hits, total: t } = await fetchPage(company.name, window, frm);
    total = t;
    if (!hits.length) break;
    for (const h of hits) records.push(normalize(h._source || {}));
    frm += PAGE;
  }
  return records;
}

async function main() {
  const window = windowDates();
  const snapshotDate = isoDate(new Date());
  await mkdir(join(DATA_DIR, 'companies'), { recursive: true });

  // Build everything in memory first. We only touch disk if ALL companies
  // succeed with data — so a slow/failed ingest leaves the committed sample
  // dataset fully intact and consistent (rather than a mix of live + empty).
  const built = [];
  for (const company of COMPANIES) {
    process.stdout.write(`Fetching ${company.displayName}… `);
    const records = await fetchCompany(company, window);
    if (records.length === 0) {
      throw new Error(`no records for ${company.displayName} (slow API or time budget) — keeping committed sample data`);
    }
    const company_built = buildCompany({
      slug: company.slug,
      name: company.name,
      displayName: company.displayName,
      dataSource: 'cfpb',
      snapshotDate,
      window,
      records,
    });
    built.push(company_built);
    console.log(`${company_built.total_complaints} complaints, signal ${company_built.signal.score}`);
  }

  // All good — commit every file.
  for (const b of built) {
    await writeFile(
      join(DATA_DIR, 'companies', `${b.slug}.json`),
      `${JSON.stringify(b, null, 2)}\n`,
    );
  }
  const index = {
    generated: snapshotDate,
    data_source: 'cfpb',
    window,
    note: 'Public CFPB Consumer Complaint Database snapshot. Signals are exploratory, not verdicts.',
    companies: built
      .map((b) => ({
        slug: b.slug,
        display_name: b.display_name,
        name: b.name,
        kind: COMPANIES.find((c) => c.slug === b.slug)?.kind,
        total_complaints: b.total_complaints,
        signal_score: b.signal.score,
        signal_band: b.signal.band,
      }))
      .sort((a, b) => b.signal_score - a.signal_score),
  };
  await writeFile(join(DATA_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\nWrote ${built.length}/${COMPANIES.length} companies to ${DATA_DIR}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
