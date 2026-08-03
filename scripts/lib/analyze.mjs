// ComplaintGraph — shared analysis library.
//
// Single source of truth used by BOTH the real CFPB ingest and the sample-data
// generator, so live and sample datasets always have an identical shape.
//
// Input: a flat array of "records", each normalized to:
//   {
//     date_received:   "YYYY-MM-DD",
//     product:         string,
//     issue:           string,
//     state:           string ("" if unknown),
//     company_response:string,   // e.g. "Closed with explanation"
//     timely:          boolean,  // company responded in time
//     narrative:       string,   // "" when the consumer gave no consent
//   }
//
// Output: a per-company object (see buildCompany) that the static dashboard
// renders directly. Everything here is deterministic — no randomness, no
// network, no LLM. Any inferred number is labeled as a signal/estimate, never
// stated as a verdict about the company.

// ---------------------------------------------------------------------------
// Response buckets. CFPB's "company response to consumer" field is a small,
// stable enum. We treat monetary / non-monetary relief as "resolved with
// relief"; everything else closed is "closed without relief".
// ---------------------------------------------------------------------------
const RELIEF_RESPONSES = new Set([
  'Closed with monetary relief',
  'Closed with non-monetary relief',
]);
const NO_RELIEF_RESPONSES = new Set([
  'Closed with explanation',
  'Closed without relief',
  'Closed',
]);

// Harm keywords used only to estimate how often consumers describe concrete
// harm in their own narratives. This is a coarse text signal, clearly labeled
// as such — not a claim that harm occurred.
const HARM_KEYWORDS = [
  'identity theft', 'fraud', 'fraudulent', 'scam', 'stolen', 'unauthorized',
  'never paid', 'not mine', 'wrongly', 'wrongfully', 'denied', 'harass',
  'threat', 'lawsuit', 'sued', 'garnish', 'evict', 'foreclos', 'repossess',
  'bankrupt', 'collection', 'damage', 'ruined', 'devastat',
];

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Count occurrences of a field and return the top N buckets, sorted desc.
function topBuckets(records, field, limit = 8) {
  const counts = new Map();
  for (const r of records) {
    const key = (r[field] || '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

// Dense month-by-month volume across the full window (zero-filled), so the
// trend chart never has gaps.
function monthlySeries(records, windowMin, windowMax) {
  const counts = new Map();
  for (const r of records) {
    const month = (r.date_received || '').slice(0, 7);
    if (!month) continue;
    counts.set(month, (counts.get(month) || 0) + 1);
  }
  const out = [];
  const start = new Date(`${windowMin.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${windowMax.slice(0, 7)}-01T00:00:00Z`);
  const cur = new Date(start);
  while (cur <= end) {
    const month = cur.toISOString().slice(0, 7);
    out.push({ month, count: counts.get(month) || 0 });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Risk signal. A transparent 0–100 score built from interpretable sub-signals,
// each in risk-direction (higher = more reason to look closer). The breakdown
// (value + weight + evidence) is shown in the UI so nothing is a black box.
// ---------------------------------------------------------------------------
function computeSignal(records, monthly, timelyRate, responseBreakdown, topIssueShare) {
  // 1. Timeliness gap — share of cases NOT answered on time.
  const timelinessGap = (1 - timelyRate) * 100;

  // 2. Relief gap — of closed cases, share closed without any relief.
  let relief = 0;
  let noRelief = 0;
  for (const b of responseBreakdown) {
    if (RELIEF_RESPONSES.has(b.name)) relief += b.count;
    else if (NO_RELIEF_RESPONSES.has(b.name)) noRelief += b.count;
  }
  const reliefGap = relief + noRelief > 0 ? (noRelief / (relief + noRelief)) * 100 : 0;

  // 3. Issue concentration — how dominated complaints are by a single issue.
  const issueConcentration = topIssueShare * 100;

  // 4. Trend — recent 3 months vs the prior 3, expressed around a 50 midpoint.
  const recent = monthly.slice(-3).reduce((s, m) => s + m.count, 0) / 3;
  const prior = monthly.slice(-6, -3).reduce((s, m) => s + m.count, 0) / 3;
  const trend = prior > 0 ? clamp(50 + ((recent - prior) / prior) * 50, 0, 100) : 50;

  // 5. Narrative harm — share of consent-given narratives mentioning concrete harm.
  const narratives = records.filter((r) => r.narrative);
  let harm = 0;
  for (const r of narratives) {
    const text = r.narrative.toLowerCase();
    if (HARM_KEYWORDS.some((k) => text.includes(k))) harm += 1;
  }
  const narrativeHarm = narratives.length > 0 ? (harm / narratives.length) * 100 : 0;

  const components = [
    { key: 'timeliness_gap', label: 'Untimely responses', weight: 0.15,
      value: round(timelinessGap, 1),
      evidence: `${round(timelinessGap, 1)}% of cases not answered on time` },
    { key: 'relief_gap', label: 'Closed without relief', weight: 0.30,
      value: round(reliefGap, 1),
      evidence: `${round(reliefGap, 1)}% of closed cases ended without monetary or non-monetary relief` },
    { key: 'issue_concentration', label: 'Issue concentration', weight: 0.20,
      value: round(issueConcentration, 1),
      evidence: `${round(issueConcentration, 1)}% of complaints share one top issue` },
    { key: 'trend', label: 'Recent trend', weight: 0.20,
      value: round(trend, 1),
      evidence: `last 3 months avg ${round(recent, 1)}/mo vs prior ${round(prior, 1)}/mo` },
    { key: 'narrative_harm', label: 'Harm language in narratives', weight: 0.15,
      value: round(narrativeHarm, 1),
      evidence: narratives.length
        ? `${round(narrativeHarm, 1)}% of ${narratives.length} narratives mention concrete harm`
        : 'no consumer narratives available' },
  ];

  const score = round(components.reduce((s, c) => s + c.value * c.weight, 0));
  let band = 'Low';
  if (score >= 75) band = 'High';
  else if (score >= 55) band = 'Elevated';
  else if (score >= 30) band = 'Moderate';

  return { score, band, components };
}

// Deterministic plain-English summary built only from the computed statistics.
function buildSummary(name, total, monthly, topProducts, topIssues, topStates, timelyRate, signal, window) {
  if (total === 0) {
    return `No CFPB complaints were published for ${name} between ${window.min} and ${window.max}.`;
  }
  const recent = monthly.slice(-3).reduce((s, m) => s + m.count, 0) / 3;
  const prior = monthly.slice(-6, -3).reduce((s, m) => s + m.count, 0) / 3;
  let trendWord = 'steady';
  if (prior > 0) {
    const change = (recent - prior) / prior;
    if (change > 0.15) trendWord = 'rising';
    else if (change < -0.15) trendWord = 'falling';
  }
  const topIssue = topIssues[0];
  const topIssueShare = topIssue ? round((topIssue.count / total) * 100) : 0;
  const topProduct = topProducts[0];
  const reliefLabel = signal.components.find((c) => c.key === 'relief_gap');

  const parts = [];
  parts.push(
    `Between ${window.min} and ${window.max}, the CFPB published ${total.toLocaleString('en-US')} ` +
    `complaints about ${name}.`,
  );
  parts.push(
    `Volume is ${trendWord} (last 3 months averaged ${round(recent)} per month versus ${round(prior)} before).`,
  );
  if (topIssue) {
    parts.push(
      `The most common issue is "${topIssue.name}" (${topIssueShare}% of complaints)` +
      (topProduct ? `, concentrated in ${topProduct.name.toLowerCase()}.` : '.'),
    );
  }
  parts.push(
    `The company responded on time to ${round(timelyRate * 100)}% of cases; ` +
    `${reliefLabel.value}% of closed cases ended without relief.`,
  );
  parts.push(
    `Overall risk signal: ${signal.band} (${signal.score}/100). This is an exploratory signal from public ` +
    `complaint data, not a regulatory, legal, or investment conclusion.`,
  );
  return parts.join(' ');
}

// Build the full per-company object from normalized records.
//
// `regulatory` is OPTIONAL: an additive public-record cross-reference block
// (FDIC / SEC / GLEIF) produced by scripts/lib/regulatory.mjs. When omitted the
// record simply has no `regulatory` key, so existing consumers are unaffected.
export function buildCompany({ slug, name, displayName, dataSource, snapshotDate, window, records, regulatory }) {
  const total = records.length;
  const monthly = monthlySeries(records, window.min, window.max);
  const topProducts = topBuckets(records, 'product');
  const topIssues = topBuckets(records, 'issue');
  const topStates = topBuckets(records, 'state', 10);
  const responseBreakdown = topBuckets(records, 'company_response', 10);

  const timelyCount = records.filter((r) => r.timely).length;
  const timelyRate = total > 0 ? timelyCount / total : 1;

  const narratives = records.filter((r) => r.narrative);
  const sampleNarratives = narratives
    .slice()
    .sort((a, b) => (a.date_received < b.date_received ? 1 : -1))
    .slice(0, 5)
    .map((r) => ({
      date: r.date_received,
      product: r.product,
      issue: r.issue,
      state: r.state,
      // Trim very long narratives so the page stays light.
      text: r.narrative.length > 600 ? `${r.narrative.slice(0, 600)}…` : r.narrative,
    }));

  const topIssueShare = total > 0 && topIssues[0] ? topIssues[0].count / total : 0;
  const signal = computeSignal(records, monthly, timelyRate, responseBreakdown, topIssueShare);
  const summary = buildSummary(
    displayName, total, monthly, topProducts, topIssues, topStates, timelyRate, signal, window,
  );

  const out = {
    slug,
    name,
    display_name: displayName,
    data_source: dataSource,
    snapshot_date: snapshotDate,
    window,
    total_complaints: total,
    monthly,
    top_products: topProducts,
    top_issues: topIssues,
    top_states: topStates,
    timely_response_rate: round(timelyRate, 4),
    company_responses: responseBreakdown,
    narrative_count: narratives.length,
    sample_narratives: sampleNarratives,
    signal,
    summary,
  };
  // Additive, optional public-record cross-reference. Only attached when given.
  if (regulatory) out.regulatory = regulatory;
  return out;
}

// The curated set of consumer-finance companies the MVP covers. `name` must be
// the exact CFPB "company" value (the search API filters on an exact match).
export const COMPANIES = [
  { slug: 'equifax', displayName: 'Equifax', name: 'EQUIFAX, INC.', kind: 'bureau' },
  { slug: 'experian', displayName: 'Experian', name: 'Experian Information Solutions Inc.', kind: 'bureau' },
  { slug: 'transunion', displayName: 'TransUnion', name: 'TRANSUNION INTERMEDIATE HOLDINGS, INC.', kind: 'bureau' },
  { slug: 'bank-of-america', displayName: 'Bank of America', name: 'BANK OF AMERICA, NATIONAL ASSOCIATION', kind: 'bank' },
  { slug: 'wells-fargo', displayName: 'Wells Fargo', name: 'WELLS FARGO & COMPANY', kind: 'bank' },
  { slug: 'jpmorgan-chase', displayName: 'JPMorgan Chase', name: 'JPMORGAN CHASE & CO.', kind: 'bank' },
  { slug: 'capital-one', displayName: 'Capital One', name: 'CAPITAL ONE FINANCIAL CORPORATION', kind: 'card' },
];

export { clamp, round };
