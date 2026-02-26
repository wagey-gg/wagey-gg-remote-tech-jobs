#!/usr/bin/env node
/**
 * update.mjs — Fetches jobs from wagey.gg API and generates markdown for GitHub repos.
 *
 * Usage:
 *   node scripts/update.mjs                          # Production (wagey.gg)
 *   node scripts/update.mjs --dry-run                # Print stats, don't write files
 *   API_BASE_URL=https://localhost:4242 node scripts/update.mjs  # Local dev
 *
 * Environment:
 *   API_BASE_URL    — Base URL of the wagey.gg API (default: https://wagey.gg)
 *   SYSTEM_USER_ID  — User ID for API auth (default: system_github_publish)
 *
 * Writes to sibling repo directories:
 *   ../wagey-gg-remote-tech-jobs/      (this repo — WW + NA + LATAM)
 *   ../wagey-gg-remote-tech-emea-jobs/ (EMEA)
 *   ../wagey-gg-remote-tech-apac-jobs/ (APAC)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API_BASE = process.env.API_BASE_URL || 'https://wagey.gg';
const USER_ID = process.env.SYSTEM_USER_ID || 'system_github_publish';
const DRY_RUN = process.argv.includes('--dry-run');
const REF = 'github';

// ============================================================================
// REPO PATHS
// ============================================================================

const REPOS = {
  main: ROOT,
  emea: join(ROOT, '..', 'wagey-gg-remote-tech-emea-jobs'),
  apac: join(ROOT, '..', 'wagey-gg-remote-tech-apac-jobs'),
};

const GITHUB_REPOS = {
  main: 'https://github.com/7-of-9/wagey-gg-remote-tech-jobs',
  emea: 'https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs',
  apac: 'https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs',
};

// ============================================================================
// HELPERS
// ============================================================================

/** Slugify text for URLs */
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Build wagey.gg job URL */
function jobUrl(job) {
  const slug = slugify(`${job.title} at ${job.company}`);
  return `https://wagey.gg/jobs/${job.id}${slug ? '-' + slug : ''}?ref=${REF}`;
}

/** Format date as d-Mon-YYYY */
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** Format date+time as d-Mon-YYYY HH:MM UTC */
function fmtDateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

/** Format salary for display — always use annualized numeric values */
function fmtSalary(job) {
  if (job.salaryMin && job.salaryMax && job.salaryMin === job.salaryMax) {
    return `${fmtK(job.salaryMin)}/year`;
  }
  if (job.salaryMin && job.salaryMax) {
    return `${fmtK(job.salaryMin)}–${fmtK(job.salaryMax)}/year`;
  }
  if (job.salaryMin) return `${fmtK(job.salaryMin)}+/year`;
  if (job.salaryMax) return `${fmtK(job.salaryMax)}/year`;
  return '';
}

function fmtK(n) {
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

/** Parse "Python(0.95), AWS(0.80)" → ["Python", "AWS"] */
function parseSkills(str) {
  if (!str) return [];
  return str.split(',').map(s => {
    const m = s.trim().match(/^(.+?)(?:\([^)]+\))?$/);
    return m ? m[1].trim() : s.trim();
  }).filter(Boolean);
}

/** Top N skills as compact string */
function topSkills(job, n = 3) {
  const skills = parseSkills(job.skills);
  if (skills.length === 0) return '';
  const shown = skills.slice(0, n);
  return shown.join(', ') + (skills.length > n ? ` +${skills.length - n}` : '');
}

/** Region code to human label */
const REGION_LABELS = {
  WW: 'Remote Worldwide',
  EMEA: 'Europe & Middle East',
  APAC: 'Asia-Pacific',
  NA: 'North America',
  LATAM: 'Latin America',
};

/** Client-side garbage title filter — catches nonjobs that slipped through API */
const GARBAGE_TITLES = /^(careers?|job\s+openings?|open\s+positions?|positions?|current\s+(job\s+)?openings?|join\s+our\s+team|work\s+(with|at|for)\s+us)$/i;
function isGarbageJob(job) {
  return GARBAGE_TITLES.test((job.title || '').trim());
}

/** Escape pipe characters in markdown table cells */
function esc(str) {
  return (str || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ============================================================================
// FETCH JOBS (with exponential backoff retry)
// ============================================================================

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 3000; // 3s, 6s, 12s, 24s
const FETCH_TIMEOUT_MS = 360_000; // 6 minutes — endpoint streams ~24 MB NDJSON slowly on Azure B1

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJobs() {
  // Use a large hours value to get ALL applyable jobs, not just recent ones
  const url = `${API_BASE}/api/matching-data?hours=8760`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`Fetching from ${url} ... (attempt ${attempt}/${MAX_RETRIES})`);

    try {
      const resp = await fetch(url, {
        headers: {
          'x-user-id': USER_ID,
          'Accept': 'application/x-ndjson',
          'Accept-Encoding': 'gzip',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '(no body)');
        const isRetryable = resp.status >= 500 || resp.status === 429;
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`  API returned ${resp.status} — retrying in ${delay / 1000}s ...`);
          await sleep(delay);
          continue;
        }
        throw new Error(`API returned ${resp.status}: ${body.slice(0, 500)}`);
      }

      const text = await resp.text();
      const lines = text.split('\n').filter(l => l.trim());

      const jobs = [];
      let meta = null;

      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.type === 'meta') {
          meta = obj;
        } else if (obj.type === 'job') {
          jobs.push(obj.d);
        }
      }

      console.log(`Fetched ${jobs.length} jobs`);
      return { jobs, meta };

    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`  Fetch failed: ${err.message} — retrying in ${delay / 1000}s ...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ============================================================================
// GROUP & SORT
// ============================================================================

function groupByRegion(jobs) {
  const groups = { WW: [], EMEA: [], APAC: [], NA: [], LATAM: [] };
  for (const job of jobs) {
    if (isGarbageJob(job)) continue;  // Client-side garbage filter
    const region = job.region || 'WW';
    if (region === 'WW') {
      // WW section = true remote only (isRemote=true AND region=WW)
      if (job.isRemote) groups.WW.push(job);
      // Non-remote WW jobs are excluded (no section for them)
    } else if (groups[region]) {
      groups[region].push(job);
    }
  }
  return groups;
}

/** Sort value for salary — deprioritize hourly rates and cap outliers */
function salarySort(job) {
  const v = job.salaryMax || job.salaryMin || 0;
  // Hourly rates have misleadingly high annualized values — sort them after annual salaries
  if (job.salary && /\/hour/i.test(job.salary)) return 0;
  // Cap at $600k — anything higher is likely bad data
  return v > 600000 ? 0 : v;
}

/** Sort: freshness (most recently scraped first) */
function sortJobs(jobs) {
  return [...jobs].sort((a, b) => {
    return new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime();
  });
}

/** Human-readable age string from a date */
function fmtAge(dateStr) {
  if (!dateStr) return '';
  const ms = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d';
  return `${days}d`;
}

/** Format location — prefer x_loc (e.g. "Remote, United Kingdom"), fall back to region code */
function fmtLocation(job) {
  if (job.location) return job.location;
  if (job.region) return REGION_LABELS[job.region] || job.region;
  return '';
}

// ============================================================================
// MARKDOWN GENERATION
// ============================================================================

/** Normalize company name to match companyLogos keys */
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Placeholder logo URL — transparent 1px PNG from our API */
const PLACEHOLDER_LOGO = 'https://wagey.gg/api/company-logo?name=_placeholder';

/** Build company cell — logo for all (placeholder if missing), truncate long names */
function companyCell(job, logos) {
  const name = esc(job.company).slice(0, 25);
  const normalized = normalizeName(job.company);
  const logoId = logos[normalized];
  const logoUrl = logoId
    ? `https://wagey.gg/api/company-logo?id=${encodeURIComponent(logoId)}`
    : PLACEHOLDER_LOGO;
  return `<img src="${logoUrl}" alt="" height="16"> ${name}`;
}

/** Truncate role title */
function fmtRole(title) {
  const t = esc(title);
  return t.length > 40 ? t.slice(0, 37) + '...' : t;
}

/** Build the Apply cell based on visibility tier */
function applyCell(job) {
  if (job.visibility === 'teaser') {
    // Padlock outside link (no underline), non-breaking space keeps it on one line
    return `\u{1F512}\u00A0[Pro](https://wagey.gg/pricing?ref=${REF})`;
  }
  return `[Apply](${jobUrl(job)})`;
}

/** Deterministic varying-length mask for teaser company names */
function teaserMask(job) {
  // Simple hash from job title to get a number 4-12
  let h = 0;
  const s = job.title || job.id || '';
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const len = 4 + (Math.abs(h) % 9); // 4 to 12 blocks
  return '\u2591'.repeat(len);
}

function jobTable(jobs, logos, limit = 500) {
  const sorted = sortJobs(jobs).slice(0, limit);
  if (sorted.length === 0) return '*No jobs currently listed.*\n';

  const lines = [
    '| Company | Role | Salary USD | Age | |',
    '|---------|------|------------|-----|---|',
  ];

  for (const job of sorted) {
    const isTeaser = job.visibility === 'teaser';
    const company = isTeaser ? teaserMask(job) : companyCell(job, logos);
    const roleTitle = fmtRole(job.title);
    // Debug: show location, remote flag, region under role
    const remote = job.isRemote ? '\u{1F310}' : '\u{1F3E2}';  // 🌐 remote, 🏢 in-office
    const rawLoc = (job.location || '').trim();
    const loc = (!rawLoc || /^unknown/i.test(rawLoc)) ? '' : esc(rawLoc).slice(0, 35);
    const locPart = loc ? `${loc} \u2022 ` : '';
    const debug = ` <br><sub>${remote} ${locPart}${job.region || '?'}</sub>`;
    const role = roleTitle + debug;
    const salary = fmtSalary(job);
    const age = fmtAge(job.scrapedAt);
    const link = applyCell(job);
    lines.push(`| ${company} | ${role} | ${salary} | ${age} | ${link} |`);
  }

  return lines.join('\n') + '\n';
}

function regionStats(groups) {
  const rows = [];
  for (const [code, label] of Object.entries(REGION_LABELS)) {
    const jobs = groups[code] || [];
    const withSalary = jobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
    const verified = jobs.filter(j => j.verifiedAt).length;
    rows.push({ code, label, total: jobs.length, withSalary, verified });
  }
  return rows;
}

// ============================================================================
// UPDATE HISTORY (git log across all 3 repos)
// ============================================================================

const HISTORY_LIMIT = 42;

/** Read git log from a repo directory, return [{hash, date, message}] */
function readGitLog(repoPath, limit) {
  try {
    const raw = execSync(
      `git log --format="%H|%aI|%s" -${limit}`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const [hash, date, ...msgParts] = line.split('|');
      return { hash, date, message: msgParts.join('|') };
    });
  } catch {
    return [];
  }
}

/** Extract job count from commit message like "21,024 jobs | ..." */
function extractJobCount(message) {
  const m = message.match(/([\d,]+)\s+(EMEA |APAC )?jobs/);
  return m ? m[1] : null;
}

/** Extract timestamp from commit message like "... — 26-Feb-2026 04:35 UTC" */
function extractTimestamp(message) {
  const m = message.match(/(\d{1,2}-\w{3}-\d{4}\s+\d{2}:\d{2}\s+UTC)/);
  return m ? m[1] : null;
}

/** Build the cross-repo update history markdown table */
function buildHistoryTable() {
  const mainLog = readGitLog(REPOS.main, HISTORY_LIMIT);
  const emeaLog = readGitLog(REPOS.emea, HISTORY_LIMIT);
  const apacLog = readGitLog(REPOS.apac, HISTORY_LIMIT);

  // Index EMEA/APAC by timestamp for matching
  const emeaByTs = new Map();
  for (const e of emeaLog) {
    const ts = extractTimestamp(e.message);
    if (ts) emeaByTs.set(ts, e);
  }
  const apacByTs = new Map();
  for (const e of apacLog) {
    const ts = extractTimestamp(e.message);
    if (ts) apacByTs.set(ts, e);
  }

  // Build rows from main log, matching EMEA/APAC by timestamp
  const rows = [];
  for (const entry of mainLog) {
    const ts = extractTimestamp(entry.message);
    const mainJobs = extractJobCount(entry.message);
    if (!ts || !mainJobs) continue; // Skip non-data commits (e.g. code changes)

    const emea = emeaByTs.get(ts);
    const apac = apacByTs.get(ts);

    const mainCell = `[\`${entry.hash.slice(0, 7)}\`](${GITHUB_REPOS.main}/commit/${entry.hash}) ${mainJobs}`;
    const emeaCell = emea
      ? `[\`${emea.hash.slice(0, 7)}\`](${GITHUB_REPOS.emea}/commit/${emea.hash}) ${extractJobCount(emea.message) || '?'}`
      : '—';
    const apacCell = apac
      ? `[\`${apac.hash.slice(0, 7)}\`](${GITHUB_REPOS.apac}/commit/${apac.hash}) ${extractJobCount(apac.message) || '?'}`
      : '—';

    rows.push(`| ${ts} | ${mainCell} | ${emeaCell} | ${apacCell} |`);
  }

  if (rows.length === 0) return '';

  return `## Update History

Last ${rows.length} updates. Full history in each repo's [commit log](${GITHUB_REPOS.main}/commits/main/).

| Time (UTC) | Main | EMEA | APAC |
|---|---|---|---|
${rows.join('\n')}
`;
}

// ============================================================================
// README TEMPLATES
// ============================================================================

function mainReadme(groups, allJobs, logos, historyTable) {
  const totalJobs = allJobs.length;
  const totalSalary = allJobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
  const totalVerified = allJobs.filter(j => j.verifiedAt).length;
  const now = fmtDateTime(new Date().toISOString());

  // Region stats — on-page first (WW, NA, LATAM), off-page last (EMEA, APAC)
  const onPage = ['WW', 'NA', 'LATAM'];
  const offPage = ['EMEA', 'APAC'];
  const regionOrder = [...onPage, ...offPage];

  function regionRow(code) {
    const label = REGION_LABELS[code];
    const jobs = groups[code] || [];
    const sal = jobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
    const ver = jobs.filter(j => j.verifiedAt).length;
    let linkedLabel;
    if (code === 'EMEA') linkedLabel = `[${label}](https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs)`;
    else if (code === 'APAC') linkedLabel = `[${label}](https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs)`;
    else linkedLabel = `[${label}](#${code.toLowerCase()})`;
    return `| ${linkedLabel} | ${jobs.length.toLocaleString()} | ${sal.toLocaleString()} | ${ver.toLocaleString()} |`;
  }

  /* Top Jobs section — commented out for now, may revisit
  const topJobs = allJobs
    .filter(j => j.visibility !== 'teaser')
    .sort((a, b) => (b.hotScore || 0) - (a.hotScore || 0))
    .slice(0, 20);
  */

  return `# Remote Tech Jobs — Updated Hourly

> Every job is checked against the employer's live careers page. Every job can be applied to in one click at [wagey.gg](https://wagey.gg?ref=${REF}).

## Jobs by Region

| Region | Jobs | With Salary | Verified |
|--------|------|-------------|----------|
${regionOrder.map(c => regionRow(c)).join('\n')}
| **Total as of ${now}** | **${totalJobs.toLocaleString()}** | **${totalSalary.toLocaleString()}** | **${totalVerified.toLocaleString()}** |

> Upload your CV at [wagey.gg](https://wagey.gg?ref=${REF}) for smart matching and one-click apply.

## How It Works

1. **Scrape** thousands of job boards, company career pages, and ATS platforms daily
2. **Verify** every job is still live on the employer's site — dead links are removed automatically
3. **Tag** each job with skills, seniority, salary, and region using AI extraction
4. **Apply** in one click via [wagey.gg](https://wagey.gg?ref=${REF}) — upload your CV once, then auto-apply to any job

## Other Regions

- [**Europe & Middle East**](https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs) — ${(groups.EMEA?.length || 0).toLocaleString()} jobs
- [**Asia-Pacific**](https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs) — ${(groups.APAC?.length || 0).toLocaleString()} jobs

---

## <a id="ww"></a>Remote Worldwide (${(groups.WW?.length || 0).toLocaleString()})

True remote — no location restriction.

${jobTable(groups.WW, logos)}

---

## <a id="na"></a>North America (${(groups.NA?.length || 0).toLocaleString()})

${jobTable(groups.NA, logos)}

---

## <a id="latam"></a>Latin America (${(groups.LATAM?.length || 0).toLocaleString()})

${jobTable(groups.LATAM, logos)}

---

${historyTable}

*Updated automatically every hour. Powered by [wagey.gg](https://wagey.gg?ref=${REF}).*
`;
}

function regionReadme(regionCode, regionLabel, jobs, allGroups, logos, historyTable) {
  const totalJobs = jobs.length;
  const withSalary = jobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
  const verified = jobs.filter(j => j.verifiedAt).length;
  const now = fmtDateTime(new Date().toISOString());

  return `# Remote Tech Jobs — ${regionLabel} — Updated Hourly

> Every job is checked against the employer's live careers page. Every job can be applied to in one click at [wagey.gg](https://wagey.gg?ref=${REF}).

| | Jobs | With Salary | Verified |
|--|------|-------------|----------|
| **${regionLabel} as of ${now}** | **${totalJobs.toLocaleString()}** | **${withSalary.toLocaleString()}** | **${verified.toLocaleString()}** |

> Upload your CV at [wagey.gg](https://wagey.gg?ref=${REF}) for smart matching and one-click apply.

## Other Regions

- [**All regions (main list)**](https://github.com/7-of-9/wagey-gg-remote-tech-jobs)
${regionCode !== 'EMEA' ? `- [**Europe & Middle East**](https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs) — ${(allGroups.EMEA?.length || 0).toLocaleString()} jobs\n` : ''}${regionCode !== 'APAC' ? `- [**Asia-Pacific**](https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs) — ${(allGroups.APAC?.length || 0).toLocaleString()} jobs\n` : ''}
---

## Jobs

${jobTable(jobs, logos)}

---

${historyTable}

*Updated automatically every hour. Powered by [wagey.gg](https://wagey.gg?ref=${REF}).*
`;
}

// ============================================================================
// DATA JSON
// ============================================================================

function buildDataJson(jobs) {
  return jobs.map(j => {
    const isTeaser = j.visibility === 'teaser';
    return {
      id: j.id,
      title: j.title,
      company: isTeaser ? null : j.company,
      region: j.region,
      salary: fmtSalary(j),
      salaryMin: j.salaryMin || null,
      salaryMax: j.salaryMax || null,
      skills: parseSkills(j.skills),
      seniority: j.seniority || null,
      ats: j.ats || null,
      verifiedAt: j.verifiedAt || null,
      scrapedAt: j.scrapedAt || null,
      url: isTeaser ? null : jobUrl(j),
      visibility: j.visibility || 'full',
    };
  });
}

// ============================================================================
// WRITE FILES
// ============================================================================

function writeFile(path, content) {
  if (DRY_RUN) {
    console.log(`  [dry-run] Would write ${path} (${content.length} bytes)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  console.log(`  Wrote ${path} (${content.length} bytes)`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`\n=== wagey.gg GitHub Job Publisher ===`);
  console.log(`API: ${API_BASE}`);
  console.log(`User: ${USER_ID}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const { jobs, meta } = await fetchJobs();

  if (jobs.length === 0) {
    console.error('No jobs fetched — aborting');
    process.exit(1);
  }

  const logos = (meta && meta.companyLogos) || {};
  console.log(`Company logos: ${Object.keys(logos).length} companies with logos`);

  const groups = groupByRegion(jobs);

  console.log('\nRegion breakdown:');
  for (const [code, label] of Object.entries(REGION_LABELS)) {
    const g = groups[code] || [];
    const sal = g.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
    const ver = g.filter(j => j.verifiedAt).length;
    console.log(`  ${label}: ${g.length} jobs (${sal} with salary, ${ver} verified)`);
  }
  console.log(`  TOTAL: ${jobs.length} jobs`);

  // Headline stats for commit messages
  const totalSalary = jobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
  const totalVerified = jobs.filter(j => j.verifiedAt).length;
  const teaserCount = jobs.filter(j => j.visibility === 'teaser').length;
  const now = fmtDateTime(new Date().toISOString());
  const emeaCount = (groups.EMEA || []).length;
  const apacCount = (groups.APAC || []).length;

  const mainMsg = `${jobs.length.toLocaleString()} jobs | ${totalSalary.toLocaleString()} with salary | ${totalVerified.toLocaleString()} verified | ${teaserCount.toLocaleString()} for Pro members — ${now}`;
  const emeaMsg = `${emeaCount.toLocaleString()} EMEA jobs | ${(groups.EMEA || []).filter(j => j.salaryMin || j.salaryMax || j.salary).length.toLocaleString()} with salary | ${(groups.EMEA || []).filter(j => j.verifiedAt).length.toLocaleString()} verified — ${now}`;
  const apacMsg = `${apacCount.toLocaleString()} APAC jobs | ${(groups.APAC || []).filter(j => j.salaryMin || j.salaryMax || j.salary).length.toLocaleString()} with salary | ${(groups.APAC || []).filter(j => j.verifiedAt).length.toLocaleString()} verified — ${now}`;

  // Build cross-repo update history table
  console.log('\n--- Building update history ---');
  const historyTable = buildHistoryTable();
  console.log(`  History: ${historyTable ? historyTable.split('\n').length - 4 : 0} entries`);

  console.log('\n--- Main repo ---');
  writeFile(join(REPOS.main, 'README.md'), mainReadme(groups, jobs, logos, historyTable));
  writeFile(join(REPOS.main, 'data', 'jobs.json'), JSON.stringify(buildDataJson(jobs), null, 2));
  writeFile(join(REPOS.main, 'data', 'commit-msg.txt'), mainMsg);

  console.log('\n--- EMEA repo ---');
  writeFile(join(REPOS.emea, 'README.md'), regionReadme('EMEA', 'Europe & Middle East', groups.EMEA || [], groups, logos, historyTable));
  writeFile(join(REPOS.emea, 'data', 'jobs.json'), JSON.stringify(buildDataJson(groups.EMEA || []), null, 2));
  writeFile(join(REPOS.emea, 'data', 'commit-msg.txt'), emeaMsg);

  console.log('\n--- APAC repo ---');
  writeFile(join(REPOS.apac, 'README.md'), regionReadme('APAC', 'Asia-Pacific', groups.APAC || [], groups, logos, historyTable));
  writeFile(join(REPOS.apac, 'data', 'jobs.json'), JSON.stringify(buildDataJson(groups.APAC || []), null, 2));
  writeFile(join(REPOS.apac, 'data', 'commit-msg.txt'), apacMsg);

  console.log(`\nCommit messages:`);
  console.log(`  Main: ${mainMsg}`);
  console.log(`  EMEA: ${emeaMsg}`);
  console.log(`  APAC: ${apacMsg}`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

