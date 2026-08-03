// ComplaintGraph — open regulatory cross-reference ingest.
//
// Runs AFTER the CFPB ingest (or after the sample generator). For each company
// it fetches PUBLIC, open registry data — FDIC BankFind, SEC EDGAR, GLEIF LEI —
// and merges an additive `regulatory` block into the already-baked company JSON
// in data/companies/. No API key required. A descriptive User-Agent is sent to
// SEC per its policy.
//
// Bounding / fallback discipline mirrors ingest-cfpb.mjs:
//   - per-request AbortController timeout (CG_REG_REQUEST_TIMEOUT_MS)
//   - hard wall-clock budget for the whole run (CG_REG_TOTAL_BUDGET_MS)
//   - on ANY failure for a company, keep whatever `regulatory` block already
//     exists on disk (so the committed SAMPLE block survives a failed live run).
//
// Usage:  node scripts/ingest-regulatory.mjs
// Env:    CG_REG_REQUEST_TIMEOUT_MS (default 15000)
//         CG_REG_TOTAL_BUDGET_MS    (default 180000)
//         CG_SEC_USER_AGENT         (override the SEC User-Agent string)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COMPANIES } from './lib/analyze.mjs';
import { fetchRegulatory } from './lib/regulatory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

const REQUEST_TIMEOUT_MS = Number(process.env.CG_REG_REQUEST_TIMEOUT_MS || 15000);
const TOTAL_BUDGET_MS = Number(process.env.CG_REG_TOTAL_BUDGET_MS || 180000);
const START = Date.now();

// Is the freshly-fetched live block worth keeping? Only if at least one of the
// public sources actually matched — otherwise we leave existing data untouched.
function hasAnyMatch(reg) {
  return Boolean(reg && (reg.fdic || reg.sec || reg.lei));
}

async function main() {
  let enriched = 0;
  let kept = 0;

  for (const company of COMPANIES) {
    const file = join(DATA_DIR, 'companies', `${company.slug}.json`);
    let record;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      console.warn(`  (skip ${company.displayName}: no baked file — ${err.message})`);
      continue;
    }

    if (Date.now() - START > TOTAL_BUDGET_MS) {
      console.warn('  (time budget reached — leaving remaining companies as-is)');
      break;
    }

    process.stdout.write(`Cross-referencing ${company.displayName}… `);
    let reg = null;
    try {
      reg = await fetchRegulatory(company, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
      // fetchRegulatory never throws, but be defensive.
      console.warn(`(failed: ${err.message})`);
      reg = null;
    }

    if (hasAnyMatch(reg)) {
      record.regulatory = reg;
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
      const parts = [reg.fdic && 'FDIC', reg.sec && 'SEC', reg.lei && 'LEI'].filter(Boolean);
      console.log(`matched ${parts.join(' + ')}`);
      enriched += 1;
    } else {
      // Keep whatever already exists (sample block stays if live found nothing).
      console.log('no live match — keeping existing data');
      kept += 1;
    }
  }

  console.log(`\nRegulatory cross-reference: ${enriched} enriched, ${kept} kept as-is.`);
}

main().catch((err) => {
  // Even a top-level failure must not blow away committed data.
  console.error(err.message);
  process.exit(1);
});
