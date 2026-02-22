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

/** Format salary for display — prefer human-readable string, fall back to numeric range */
function fmtSalary(job) {
  // Prefer the human-readable salary string (handles hourly, GBP, EUR, etc.)
  if (job.salary) {
    const s = job.salary.trim();
    return s.length > 35 ? s.slice(0, 32) + '...' : s;
  }
  // Fall back to numeric range (annual USD)
  if (job.salaryMin && job.salaryMax && job.salaryMin === job.salaryMax) {
    return fmtK(job.salaryMin);
  }
  if (job.salaryMin && job.salaryMax) {
    return `${fmtK(job.salaryMin)}–${fmtK(job.salaryMax)}`;
  }
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
  WW: 'Worldwide',
  EMEA: 'Europe & Middle East',
  APAC: 'Asia-Pacific',
  NA: 'North America',
  LATAM: 'Latin America',
};

/** Escape pipe characters in markdown table cells */
function esc(str) {
  return (str || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ============================================================================
// FETCH JOBS
// ============================================================================

async function fetchJobs() {
  const url = `${API_BASE}/api/matching-data?hours=168`; // 7 days
  console.log(`Fetching from ${url} ...`);

  const resp = await fetch(url, {
    headers: {
      'x-user-id': USER_ID,
      'Accept': 'application/x-ndjson',
      'Accept-Encoding': 'gzip',
    },
    // Allow self-signed certs for local dev
    ...(API_BASE.includes('localhost') ? { dispatcher: undefined } : {}),
  });

  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}: ${await resp.text()}`);
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
    // 'done' line ignored
  }

  console.log(`Fetched ${jobs.length} jobs`);
  return { jobs, meta };
}

// ============================================================================
// GROUP & SORT
// ============================================================================

function groupByRegion(jobs) {
  const groups = { WW: [], EMEA: [], APAC: [], NA: [], LATAM: [] };
  for (const job of jobs) {
    const region = job.region || 'WW';
    if (groups[region]) {
      groups[region].push(job);
    } else {
      groups.WW.push(job); // Unknown regions → WW
    }
  }
  return groups;
}

/** Clamp salary to reasonable annual range (ignore annualized hourly rates) */
function salarySort(job) {
  const v = job.salaryMax || job.salaryMin || 0;
  // Cap at $600k — anything higher is likely an annualized hourly rate
  return v > 600000 ? 0 : v;
}

/** Sort: salary DESC (jobs with salary first), then by scrapedAt DESC */
function sortJobs(jobs) {
  return [...jobs].sort((a, b) => {
    const aSal = salarySort(a);
    const bSal = salarySort(b);
    // Jobs with salary first
    if (aSal && !bSal) return -1;
    if (!aSal && bSal) return 1;
    if (aSal !== bSal) return bSal - aSal;
    // Then by recency
    return new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime();
  });
}

// ============================================================================
// MARKDOWN GENERATION
// ============================================================================

function jobTable(jobs, limit = 500) {
  const sorted = sortJobs(jobs).slice(0, limit);
  if (sorted.length === 0) return '*No jobs currently listed.*\n';

  const lines = [
    '| Company | Role | Salary | Skills | Verified | Apply |',
    '|---------|------|--------|--------|----------|-------|',
  ];

  for (const job of sorted) {
    const company = esc(job.company);
    const title = esc(job.title);
    const salary = fmtSalary(job);
    const skills = esc(topSkills(job));
    const verified = job.verifiedAt ? `✓ ${fmtDate(job.verifiedAt)}` : '';
    const link = `[Apply →](${jobUrl(job)})`;
    lines.push(`| ${company} | ${title} | ${salary} | ${skills} | ${verified} | ${link} |`);
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
// README TEMPLATES
// ============================================================================

function mainReadme(groups, allJobs) {
  const stats = regionStats(groups);
  const totalJobs = allJobs.length;
  const totalSalary = allJobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
  const totalVerified = allJobs.filter(j => j.verifiedAt).length;
  const salaryPct = totalJobs > 0 ? Math.round(totalSalary / totalJobs * 100) : 0;
  const today = fmtDate(new Date().toISOString());

  // Top 20 jobs across all regions for the hero table
  const topJobs = sortJobs(allJobs).slice(0, 20);

  return `# Remote Tech Jobs — Verified Daily, Apply in One Click

> Every job on this list has been verified against the employer's live careers page.
> Every job can be applied to in one click at [wagey.gg](https://wagey.gg?ref=${REF}).
>
> No dead links. No guessing. Just real jobs you can apply to right now.

**${totalJobs.toLocaleString()}** live jobs | **${salaryPct}%** with salary data | **${totalVerified.toLocaleString()}** verified | Updated ${today}

## Why This List Is Different

| | This list | Other GitHub job lists |
|---|---|---|
| Jobs verified live | ✓ Daily | ✗ |
| One-click apply | ✓ via [wagey.gg](https://wagey.gg?ref=${REF}) | ✗ |
| Salary data | ${salaryPct}% of jobs | ~0% |
| Regions | Global (5 regions) | US-only |
| Skills tagged | ✓ (1,000+ skills) | ✗ |
| Seniority levels | Junior → C-level | Intern/new-grad only |

## Jobs by Region

| Region | Jobs | With Salary | Verified | Browse |
|--------|------|-------------|----------|--------|
${stats.map(s => {
  let link;
  if (s.code === 'EMEA') link = '[View jobs →](https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs)';
  else if (s.code === 'APAC') link = '[View jobs →](https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs)';
  else link = `[View below ↓](#${s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`;
  return `| ${s.label} | ${s.total.toLocaleString()} | ${s.withSalary.toLocaleString()} | ${s.verified.toLocaleString()} | ${link} |`;
}).join('\n')}

## Today's Top Jobs

${jobTable(topJobs, 20)}

> Want smart matching to YOUR skills? Upload your CV at [wagey.gg](https://wagey.gg?ref=${REF}) →

---

## Worldwide

Remote jobs with no location restriction.

${jobTable(groups.WW)}

---

## North America

${jobTable(groups.NA)}

---

## Latin America

${jobTable(groups.LATAM)}

---

## How It Works

1. **We scrape** thousands of job boards, company career pages, and ATS platforms daily
2. **We verify** every job is still live on the employer's site — dead links are removed automatically
3. **We tag** each job with skills, seniority, salary, and region using AI extraction
4. **You apply** in one click via [wagey.gg](https://wagey.gg?ref=${REF}) — upload your CV once, then auto-apply to any job

## Other Regions

- [**Europe & Middle East →**](https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs) — ${(groups.EMEA?.length || 0).toLocaleString()} jobs
- [**Asia-Pacific →**](https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs) — ${(groups.APAC?.length || 0).toLocaleString()} jobs

---

*Updated automatically every day at 06:00 UTC. Powered by [wagey.gg](https://wagey.gg?ref=${REF}).*
`;
}

function regionReadme(regionCode, regionLabel, jobs, allGroups) {
  const totalJobs = jobs.length;
  const withSalary = jobs.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
  const verified = jobs.filter(j => j.verifiedAt).length;
  const salaryPct = totalJobs > 0 ? Math.round(withSalary / totalJobs * 100) : 0;
  const today = fmtDate(new Date().toISOString());

  return `# Remote Tech Jobs — ${regionLabel}

> Every job on this list has been verified against the employer's live careers page.
> Every job can be applied to in one click at [wagey.gg](https://wagey.gg?ref=${REF}).

**${totalJobs.toLocaleString()}** live jobs | **${salaryPct}%** with salary data | **${verified.toLocaleString()}** verified | Updated ${today}

## Jobs

${jobTable(jobs)}

> Upload your CV at [wagey.gg](https://wagey.gg?ref=${REF}) for smart job matching and one-click apply →

## Other Regions

- [**All regions (main list) →**](https://github.com/7-of-9/wagey-gg-remote-tech-jobs)
${regionCode !== 'EMEA' ? `- [**Europe & Middle East →**](https://github.com/7-of-9/wagey-gg-remote-tech-emea-jobs) — ${(allGroups.EMEA?.length || 0).toLocaleString()} jobs\n` : ''}${regionCode !== 'APAC' ? `- [**Asia-Pacific →**](https://github.com/7-of-9/wagey-gg-remote-tech-apac-jobs) — ${(allGroups.APAC?.length || 0).toLocaleString()} jobs\n` : ''}
---

*Updated automatically every day at 06:00 UTC. Powered by [wagey.gg](https://wagey.gg?ref=${REF}).*
`;
}

// ============================================================================
// DATA JSON
// ============================================================================

function buildDataJson(jobs) {
  return jobs.map(j => ({
    id: j.id,
    title: j.title,
    company: j.company,
    region: j.region,
    salary: fmtSalary(j),
    salaryMin: j.salaryMin || null,
    salaryMax: j.salaryMax || null,
    skills: parseSkills(j.skills),
    seniority: j.seniority || null,
    ats: j.ats || null,
    verifiedAt: j.verifiedAt || null,
    scrapedAt: j.scrapedAt || null,
    url: jobUrl(j),
  }));
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

  const { jobs } = await fetchJobs();

  if (jobs.length === 0) {
    console.error('No jobs fetched — aborting');
    process.exit(1);
  }

  const groups = groupByRegion(jobs);

  // Stats
  console.log('\nRegion breakdown:');
  for (const [code, label] of Object.entries(REGION_LABELS)) {
    const g = groups[code] || [];
    const sal = g.filter(j => j.salaryMin || j.salaryMax || j.salary).length;
    const ver = g.filter(j => j.verifiedAt).length;
    console.log(`  ${label}: ${g.length} jobs (${sal} with salary, ${ver} verified)`);
  }

  // Main repo: README + data
  console.log('\n--- Main repo ---');
  writeFile(join(REPOS.main, 'README.md'), mainReadme(groups, jobs));
  writeFile(join(REPOS.main, 'data', 'jobs.json'), JSON.stringify(buildDataJson(jobs), null, 2));

  // EMEA repo
  console.log('\n--- EMEA repo ---');
  writeFile(join(REPOS.emea, 'README.md'), regionReadme('EMEA', 'Europe & Middle East', groups.EMEA || [], groups));
  writeFile(join(REPOS.emea, 'data', 'jobs.json'), JSON.stringify(buildDataJson(groups.EMEA || []), null, 2));

  // APAC repo
  console.log('\n--- APAC repo ---');
  writeFile(join(REPOS.apac, 'README.md'), regionReadme('APAC', 'Asia-Pacific', groups.APAC || [], groups));
  writeFile(join(REPOS.apac, 'data', 'jobs.json'), JSON.stringify(buildDataJson(groups.APAC || []), null, 2));

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
