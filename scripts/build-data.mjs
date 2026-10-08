/**
 * Pulls the Windsor connectors and writes the three payloads the dashboard
 * reads: data/light.json, data/sales.json, data/detail.json.
 *
 * Runs in GitHub Actions on a schedule. The API key comes from the
 * WINDSOR_API_KEY secret and never reaches the published page — the page only
 * ever fetches the JSON files this script produces.
 *
 * The CRM request is restricted to seven non-personal fields. No name, email,
 * phone, address, DOB, Aadhaar, PAN or parent contact is requested, and an
 * allow-list drops anything else the API might return, so nothing personal can
 * end up committed to a public repo.
 *
 * Usage: WINDSOR_API_KEY=... node scripts/build-data.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.WINDSOR_API_KEY;
if (!KEY) {
  console.error('WINDSOR_API_KEY is not set.');
  process.exit(1);
}

const CONN = 'https://connectors.windsor.ai';
const TODAY = new Date().toISOString().slice(0, 10);

const ZOHO_FIELDS = [
  'date', 'leads_id', 'leads_lead_source', 'leads_lead_status',
  'leads_course_interested', 'leads_course_fee', 'leads_converted_date',
];
const ZOHO_ALLOW = new Set(ZOHO_FIELDS);

const url = (ep, fields, from) =>
  `${CONN}/${ep}?date_from=${from}&date_to=${TODAY}&fields=${fields}&api_key=${KEY}`;

const SOURCES = {
  // actions_lead = Meta's own reported lead count per ad. This is the platform's
  // number, not the CRM's — it counts form submissions at the ad, so it runs
  // higher than Zoho's lead records and is only used for the ad-level drill
  // (leads / cost-per-lead per creative). Google's `conversions` is deliberately
  // not mapped: it returns every configured conversion action (~74k over two
  // months), which is not a lead count, so Google stays campaign-level only.
  meta: url('facebook', 'date,campaign,adset_name,ad_name,impressions,reach,clicks,spend,actions_lead', '2023-10-08'),
  google: url('google_ads', 'date,campaign,clicks,spend,impressions', '2021-10-08'),
  zoho: url('zoho', ZOHO_FIELDS.join(','), '2021-10-08'),
};

const num = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(x) ? x : 0; };
const fee = (v) => { const m = String(v ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : 0; };
const d10 = (v) => String(v ?? '').slice(0, 10);

// Some lead-source labels carry a phone number, e.g.
// "WhatsApp - Monolith Academy-+918124011190". The number adds nothing to the
// grouping, so strip it — leads still group under the readable label.
const cleanSource = (v) => String(v ?? '')
  .replace(/\+?\d[\d\s-]{7,}\d/g, '')
  .replace(/[\s\-–—_]+$/, '')
  .trim();

async function pull(name, u) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(u, { headers: { 'accept': 'application/json' } });
      if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
      const j = await r.json();
      const rows = j?.data ?? [];
      // An expired Windsor licence does not error — it replaces every value with
      // a sales message. Fail loudly instead of committing poisoned data.
      const probe = JSON.stringify(rows.slice(0, 5));
      if (/License expired/i.test(probe)) throw new Error(`${name}: Windsor licence expired — key needs renewing`);
      console.log(`  ${name}: ${rows.length} rows`);
      return rows;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  ${name}: attempt ${attempt} failed (${err.message}), retrying…`);
      await new Promise((res) => setTimeout(res, 5000 * attempt));
    }
  }
}

console.log('Fetching Windsor connectors…');
const [meta, google, zohoRaw] = await Promise.all([
  pull('meta', SOURCES.meta),
  pull('google', SOURCES.google),
  pull('zoho', SOURCES.zoho),
]);

// Hard allow-list: nothing outside the seven requested fields survives.
const zoho = zohoRaw.map((r) => {
  const clean = {};
  for (const k of ZOHO_ALLOW) if (Object.hasOwn(r ?? {}, k)) clean[k] = r[k];
  return clean;
});

/* ---- light.ads: one row per channel per campaign per day ---- */
const agg = new Map();
const addAd = (source, account, date, campaign, spend, clicks, impressions) => {
  if (!date) return;
  const k = `${source}|${date}|${campaign}`;
  let a = agg.get(k);
  if (!a) { a = { date, source, account, campaign, spend: 0, clicks: 0, impressions: 0, conversions: 0 }; agg.set(k, a); }
  a.spend += spend; a.clicks += clicks; a.impressions += impressions;
};
for (const r of meta) {
  addAd('Meta', 'MRTPL', d10(r.date), (r.campaign || '').trim() || '(unnamed)', num(r.spend), num(r.clicks), num(r.impressions));
}
for (const r of google) {
  addAd('Google', 'Monolith Academy', d10(r.date), (r.campaign || '').trim() || '(unnamed)', num(r.spend), num(r.clicks), num(r.impressions));
}
const ads = [...agg.values()].sort((a, b) => a.date.localeCompare(b.date));

/* ---- light.leads + salesIntel ---- */
const leads = [], records = [], monthly = {};
const courseTot = {}, courseRev = {};
for (const r of [...zoho].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
  const date = d10(r.date);
  if (!date) continue;
  const source = cleanSource(r.leads_lead_source) || '(none)';
  const status = (r.leads_lead_status || '').trim();
  const course = (r.leads_course_interested || '').trim();

  leads.push({ date, source, status, course });

  const ym = date.slice(0, 7);
  const b = monthly[ym] ??= { total: 0, converted: 0, pool: 0, phone: 0, email: 0, jfk: 0, status: {}, srcLeads: {} };
  b.total++;
  b.srcLeads[source] = (b.srcLeads[source] || 0) + 1;
  if (status) b.status[status] = (b.status[status] || 0) + 1;

  if (status === 'Converted') {
    b.converted++;
    const f = fee(r.leads_course_fee);
    const c = course || '(unspecified)';
    // d  = conversion date   -> sales basis (enrolments, seats, revenue booked)
    // ld = lead-created date -> marketing basis (ROAS, revenue-vs-spend, revenue trend)
    records.push({ d: d10(r.leads_converted_date) || date, ld: date, c, f, s: source });
    courseTot[c] = (courseTot[c] || 0) + 1;
    courseRev[c] = (courseRev[c] || 0) + f;
  }
}
const byCourse = Object.entries(courseTot)
  .map(([course, seats]) => ({ course, seats, revenue: courseRev[course] || 0 }))
  .sort((a, b) => b.revenue - a.revenue);
const totalRev = records.reduce((s, r) => s + (r.f || 0), 0);

/* ---- detail.adDetail: Meta creative level, monthly totals + daily series ---- */
const dmap = new Map();
for (const r of meta) {
  const date = d10(r.date);
  if (!date) continue;
  const y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1;
  const campaign = (r.campaign || '').trim() || '(unnamed)';
  const adSet = (r.adset_name || '').trim() || '(unnamed)';
  const adName = (r.ad_name || '').trim() || '(unnamed)';
  const k = `${campaign}|${adSet}|${adName}|${y}-${mo}`;
  let e = dmap.get(k);
  if (!e) {
    e = { campaign, adSet, adName, year: y - 2000, month: mo, spend: 0, clicks: 0, leads: 0, impressions: 0, days: [], firstDate: date, lastDate: date };
    dmap.set(k, e);
  }
  const lds = num(r.actions_lead);
  e.spend += num(r.spend); e.clicks += num(r.clicks); e.impressions += num(r.impressions); e.leads += lds;
  e.days.push({ d: date, s: num(r.spend), c: num(r.clicks), l: lds, i: num(r.impressions) });
  if (date < e.firstDate) e.firstDate = date;
  if (date > e.lastDate) e.lastDate = date;
}

/* ---- Meta reach by month, for the channel cards ---- */
const rmap = new Map();
for (const r of meta) {
  const ym = d10(r.date).slice(0, 7);
  if (ym.length !== 7) continue;
  const e = rmap.get(ym) ?? { ym, reach: 0, imp: 0 };
  e.reach += num(r.reach); e.imp += num(r.impressions);
  rmap.set(ym, e);
}

/* ---- Pack the two big arrays ----------------------------------------
 * These files are committed on every refresh, so the repo grows by their
 * size each run. Written as objects the leads array alone is 4.3 MB, most
 * of it repeated field names and repeated label strings. Dictionary-encoded
 * it is roughly a tenth of that. The page's loader expands it back.
 */
const dict = () => {
  const idx = new Map(), list = [];
  return { list, id: (v) => { v = v ?? ''; if (!idx.has(v)) { idx.set(v, list.length); list.push(v); } return idx.get(v); } };
};
const lDate = dict(), lSrc = dict(), lStatus = dict(), lCourse = dict();
const leadsPacked = {
  d: lDate.list, s: lSrc.list, st: lStatus.list, c: lCourse.list,
  r: leads.map((l) => [lDate.id(l.date), lSrc.id(l.source), lStatus.id(l.status), lCourse.id(l.course)]),
};
const aDate = dict(), aSrc = dict(), aAcct = dict(), aCamp = dict();
const adsPacked = {
  d: aDate.list, s: aSrc.list, a: aAcct.list, c: aCamp.list,
  r: ads.map((a) => [aDate.id(a.date), aSrc.id(a.source), aAcct.id(a.account), aCamp.id(a.campaign),
                     Math.round(a.spend * 100) / 100, Math.round(a.clicks), Math.round(a.impressions)]),
};

const now = new Date().toISOString();
const payloads = {
  light: { fetched_at: now, adsPacked, leadsPacked },
  sales: {
    fetched_at: now,
    salesIntel: {
      from: '2021-10-08',
      monthly,
      enrollment: {
        updatedAt: now,
        totals: { enrolled: records.length, revenue: totalRev, fullyPaid: 0, partiallyPaid: 0 },
        byCourse, byYear: {}, records, cycle: null,
      },
    },
  },
  detail: {
    fetched_at: now,
    adDetail: [...dmap.values()],
    adDemo: null,
    adReach: { meta: [...rmap.values()], google: [], googleReported: false },
    campMeta: null,
  },
};

// Floating-point sums leave artefacts like 3033.590000000001, which bloat the
// files and trip the digit check below. Round every number to something a
// currency or a count can actually be.
const round = (node) => {
  if (Array.isArray(node)) return node.map(round);
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = round(node[k]);
    return node;
  }
  return typeof node === 'number' && Number.isFinite(node) ? Math.round(node * 100) / 100 : node;
};
round(payloads);

// Last line of defence: scan STRING values only — a leaked identifier would
// arrive as a string field, whereas numbers here are money and counts.
const strings = [];
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object') return Object.values(node).forEach(walk);
  if (typeof node === 'string') strings.push(node);
})(payloads);
const refuse = (why, sample) => { console.error(`Refusing to write: ${why}`, sample); process.exit(1); };
for (const s of strings) {
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) refuse('a value looks like an email address.', s.slice(0, 40));
  if (/\b\d{12}\b/.test(s)) refuse('a value contains a 12-digit number (possible Aadhaar).', s.slice(0, 40));
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(s)) refuse('a value looks like a PAN.', s.slice(0, 40));
  if (/\b(?:\+91[-\s]?)?[6-9]\d{9}\b/.test(s)) refuse('a value looks like an Indian mobile number.', s.slice(0, 40));
}

await mkdir('data', { recursive: true });
for (const [name, payload] of Object.entries(payloads)) {
  const file = `data/${name}.json`;
  await writeFile(file, JSON.stringify(payload));
  console.log(`  wrote ${file} (${(JSON.stringify(payload).length / 1e6).toFixed(2)} MB)`);
}
console.log(`Done. ${ads.length} ad-days, ${leads.length} leads, ${records.length} enrolments, revenue ${Math.round(totalRev).toLocaleString('en-IN')}.`);
