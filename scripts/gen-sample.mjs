// ComplaintGraph — sample dataset generator.
//
// Produces a deterministic, clearly-labeled SAMPLE dataset so the dashboard
// renders locally and on GitHub Pages even before/without a live CFPB ingest.
// Numbers are synthetic but shaped to resemble real complaint distributions
// (credit bureaus skew to credit-reporting issues; banks are more varied).
//
// Real data, when ingested in CI, overwrites these files. Nothing here uses a
// real person's data or name.
//
// Usage: node scripts/gen-sample.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCompany, COMPANIES } from './lib/analyze.mjs';
import { sampleRegulatory } from './lib/regulatory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

// Deterministic RNG (mulberry32) seeded per company — reproducible builds.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Weighted pick: items is [[value, weight], ...].
function weighted(rand, items) {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [value, w] of items) {
    if ((x -= w) <= 0) return value;
  }
  return items[items.length - 1][0];
}

const STATES = [
  ['CA', 12], ['TX', 10], ['FL', 9], ['NY', 7], ['GA', 6], ['PA', 4], ['IL', 4],
  ['NC', 4], ['OH', 3], ['NJ', 3], ['VA', 3], ['MI', 2], ['AZ', 2], ['WA', 2],
];

// Per-kind distributions over product / issue / response, plus a volume range
// and a trend bias (>1 rising, <1 falling).
const PROFILES = {
  bureau: {
    volume: [1600, 2600], trendBias: 1.35, timely: 0.985,
    products: [
      ['Credit reporting, credit repair services, or other personal consumer reports', 92],
      ['Debt collection', 5],
      ['Credit card or prepaid card', 3],
    ],
    issues: [
      ['Incorrect information on your report', 46],
      ["Problem with a company's investigation into an existing problem", 30],
      ['Improper use of your report', 14],
      ['Unable to get your credit report or credit score', 6],
      ['Problem with fraud alerts or security freezes', 4],
    ],
    responses: [
      ['Closed with explanation', 86],
      ['Closed with non-monetary relief', 11],
      ['Closed with monetary relief', 1],
      ['In progress', 2],
    ],
  },
  bank: {
    volume: [700, 1400], trendBias: 1.05, timely: 0.965,
    products: [
      ['Checking or savings account', 34],
      ['Mortgage', 24],
      ['Credit card or prepaid card', 20],
      ['Money transfer, virtual currency, or money service', 12],
      ['Vehicle loan or lease', 6],
      ['Debt collection', 4],
    ],
    issues: [
      ['Managing an account', 26],
      ['Trouble during payment process', 16],
      ['Problem with a purchase shown on your statement', 14],
      ['Closing an account', 10],
      ['Fraud or scam', 12],
      ['Applying for a mortgage or refinancing an existing mortgage', 12],
      ['Struggling to pay your loan', 10],
    ],
    responses: [
      ['Closed with explanation', 62],
      ['Closed with monetary relief', 22],
      ['Closed with non-monetary relief', 11],
      ['In progress', 5],
    ],
  },
  card: {
    volume: [900, 1500], trendBias: 1.15, timely: 0.97,
    products: [
      ['Credit card or prepaid card', 64],
      ['Checking or savings account', 22],
      ['Debt collection', 9],
      ['Money transfer, virtual currency, or money service', 5],
    ],
    issues: [
      ['Problem with a purchase shown on your statement', 24],
      ['Fraud or scam', 18],
      ['Getting a credit card', 14],
      ['Other features, terms, or problems', 14],
      ['Problem when making payments', 16],
      ['Closing your account', 14],
    ],
    responses: [
      ['Closed with explanation', 58],
      ['Closed with monetary relief', 26],
      ['Closed with non-monetary relief', 11],
      ['In progress', 5],
    ],
  },
};

// Generic, obviously-synthetic narrative fragments keyed loosely by theme.
// Some contain harm language so the narrative-harm signal is exercised.
const NARRATIVES = {
  reporting: [
    'There is an account on my credit report that is not mine. I believe this is the result of identity theft and I have disputed it twice with no correction.',
    'I sent a dispute about incorrect information but the investigation came back "verified" without any real review. The wrong balance is still showing.',
    'A fraudulent account was opened in my name. Despite a police report and a fraud alert, the item has not been removed from my report.',
    'My report shows a late payment that I never had. This error is hurting my score and I was denied a loan because of it.',
  ],
  bank: [
    'Unauthorized charges appeared on my account and the bank denied my claim without explanation. I am out the money and getting no help.',
    'I was charged repeated overdraft fees in a way I do not understand. When I called, I was transferred multiple times and never got a resolution.',
    'During the payment process my mortgage payment was misapplied, and now I am being reported as delinquent for a payment I actually made.',
    'I tried to close my account and was still charged fees afterward. The representative could not explain the charges.',
  ],
  card: [
    'A purchase I did not make showed up on my statement. I reported it as fraud and the dispute was closed against me with no evidence shared.',
    'I have been trying to get a refund for a transaction that was clearly a scam, and the company keeps closing my case with an explanation that does not address it.',
    'My payment was processed late through no fault of mine, triggering a fee and an interest charge I should not owe.',
  ],
};

function narrativePool(kind) {
  if (kind === 'bureau') return NARRATIVES.reporting;
  if (kind === 'card') return NARRATIVES.card;
  return NARRATIVES.bank;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function generateRecords(company, window, rand) {
  const profile = PROFILES[company.kind];
  const [vmin, vmax] = profile.volume;
  const total = Math.floor(vmin + rand() * (vmax - vmin));

  const start = new Date(`${window.min}T00:00:00Z`);
  const end = new Date(`${window.max}T00:00:00Z`);
  const spanMs = end - start;
  const pool = narrativePool(company.kind);

  const records = [];
  for (let i = 0; i < total; i++) {
    // Bias dates toward the recent end according to trendBias so trends move.
    const u = rand();
    const skew = profile.trendBias >= 1
      ? u ** (1 / profile.trendBias) // pull toward 1 (recent)
      : u ** (1 / profile.trendBias);
    const when = new Date(start.getTime() + skew * spanMs);

    const response = weighted(rand, profile.responses);
    const timely = rand() < profile.timely;
    // ~38% of complaints carry a consented narrative (loosely realistic).
    const hasNarrative = rand() < 0.38;

    records.push({
      date_received: isoDate(when),
      product: weighted(rand, profile.products),
      issue: weighted(rand, profile.issues),
      state: weighted(rand, STATES),
      company_response: response,
      timely,
      narrative: hasNarrative ? pool[Math.floor(rand() * pool.length)] : '',
    });
  }
  return records;
}

function windowDates() {
  // Fixed window so sample output is fully deterministic across machines.
  return { min: '2025-01-01', max: '2026-06-29' };
}

async function main() {
  const window = windowDates();
  const snapshotDate = window.max;
  await mkdir(join(DATA_DIR, 'companies'), { recursive: true });

  const indexEntries = [];
  for (const company of COMPANIES) {
    const rand = rng(seedFrom(company.slug));
    const records = generateRecords(company, window, rand);
    const built = buildCompany({
      slug: company.slug,
      name: company.name,
      displayName: company.displayName,
      dataSource: 'sample',
      snapshotDate,
      window,
      records,
      regulatory: sampleRegulatory(company),
    });
    await writeFile(
      join(DATA_DIR, 'companies', `${company.slug}.json`),
      `${JSON.stringify(built, null, 2)}\n`,
    );
    indexEntries.push({
      slug: company.slug,
      display_name: company.displayName,
      name: company.name,
      kind: company.kind,
      total_complaints: built.total_complaints,
      signal_score: built.signal.score,
      signal_band: built.signal.band,
    });
    console.log(`${company.displayName}: ${built.total_complaints} complaints, signal ${built.signal.score} (${built.signal.band})`);
  }

  const index = {
    generated: snapshotDate,
    data_source: 'sample',
    window,
    note: 'SAMPLE data — synthetic, for demo only. Replaced by live CFPB data when ingested in CI.',
    companies: indexEntries.sort((a, b) => b.signal_score - a.signal_score),
  };
  await writeFile(join(DATA_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\nWrote ${COMPANIES.length} sample companies to ${DATA_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
