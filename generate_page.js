#!/usr/bin/env node
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("오류: GITHUB_TOKEN 환경변수를 설정해주세요."); process.exit(1); }

const GEMINI_KEY = process.env.GEMINI_API_KEY;

const SINCE = "weekly";

const CATEGORIES = {
  all:    { label: "전체",       type: "scrape", lang: "" },
  js:     { label: "JavaScript", type: "scrape", lang: "javascript" },
  ts:     { label: "TypeScript", type: "scrape", lang: "typescript" },
  python: { label: "Python",     type: "scrape", lang: "python" },
  rust:   { label: "Rust",       type: "scrape", lang: "rust" },
  go:     { label: "Go",         type: "scrape", lang: "go" },
  ai:     { label: "AI/ML",     type: "search", extra: "llm OR \"machine learning\" OR \"large language model\" OR transformer", minStars: 10 },
  web:    { label: "웹",         type: "search", extra: "react OR nextjs OR vue OR svelte OR tailwind OR frontend", minStars: 10 },
  tool:   { label: "도구",       type: "search", extra: "cli OR devtools OR automation OR \"developer tool\" OR productivity", minStars: 10 },
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(hostname, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = new URL(res.headers.location, `https://${hostname}`);
        return resolve(httpGet(loc.hostname, loc.pathname + loc.search, headers));
      }
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

// ── GitHub Trending scraper ───────────────────────────────────────────────────

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function stripTags(str) { return str.replace(/<[^>]+>/g, "").trim(); }
function parseNum(str) { return parseInt((str || "").replace(/,/g, "")) || 0; }

function parseTrendingHTML(html) {
  const repos = [];
  const blocks = html.split("<article ");

  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];

    // repo 링크는 반드시 <h2> 안에 있음 (apps/ 같은 다른 링크 제외)
    const h2Match = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2Match) continue;
    const nameMatch = h2Match[1].match(/href="\/([\w.-]+\/[\w.-]+)"/);
    if (!nameMatch) continue;
    const full_name = nameMatch[1];
    if (full_name.startsWith("apps/")) continue;

    let description = null;
    const descMatch = b.match(/col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (descMatch) description = decodeEntities(stripTags(descMatch[1])).replace(/\s+/g, " ").trim() || null;

    let language = null;
    const langMatch = b.match(/itemprop="programmingLanguage"[^>]*>(.*?)<\/span>/);
    if (langMatch) language = stripTags(langMatch[1]).trim() || null;

    let stargazers_count = 0;
    const starsMatch = b.match(/href="\/[\w.-]+\/[\w.-]+\/stargazers"[\s\S]*?([\d,]+)\s*<\/a>/);
    if (starsMatch) stargazers_count = parseNum(starsMatch[1]);

    let forks_count = 0;
    const forksMatch = b.match(/href="\/[\w.-]+\/[\w.-]+\/forks"[\s\S]*?([\d,]+)\s*<\/a>/);
    if (forksMatch) forks_count = parseNum(forksMatch[1]);

    let stars_gained = 0;
    const gainedMatch = b.match(/([\d,]+)\s+stars?\s+this\s+(?:week|day)/i);
    if (gainedMatch) stars_gained = parseNum(gainedMatch[1]);

    repos.push({ full_name, html_url: `https://github.com/${full_name}`, description, language, stargazers_count, forks_count, stars_gained, license: null });
  }
  return repos.slice(0, 25);
}

async function fetchTrending(lang = "") {
  const langPath = lang ? `/${encodeURIComponent(lang)}` : "";
  const { status, body } = await httpGet("github.com", `/trending${langPath}?since=${SINCE}`, {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
  });
  if (status !== 200) throw new Error(`Trending 페이지 오류 ${status} (lang=${lang})`);
  return parseTrendingHTML(body).slice(0, 10);
}

// ── GitHub API search ─────────────────────────────────────────────────────────

function githubSearch(query) {
  const params = new URLSearchParams({ q: query, sort: "stars", order: "desc", per_page: "20" });
  return new Promise((resolve, reject) => {
    https.get({
      hostname: "api.github.com",
      path: `/search/repositories?${params}`,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-trending-cli/1.0",
      },
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`API ${res.statusCode}: ${body}`)));
    }).on("error", reject);
  });
}

function isSpam(repo) {
  const desc = repo.description ?? "";
  if (!desc) return false;
  const words = desc.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return words.length > 0 && Math.max(...Object.values(freq)) >= 4;
}

// ── README fetch ─────────────────────────────────────────────────────────────

function fetchReadme(full_name) {
  const [owner, repo] = full_name.split("/");
  return new Promise((resolve) => {
    https.get({
      hostname: "api.github.com",
      path: `/repos/${owner}/${repo}/readme`,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-trending-cli/1.0",
      },
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const content = Buffer.from(JSON.parse(body).content, "base64").toString("utf-8");
          const text = content.replace(/!\[.*?\]\(.*?\)/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/[#*`>|]/g, "").replace(/\n+/g, " ").trim().slice(0, 600);
          resolve(text);
        } catch { resolve(""); }
      });
    }).on("error", () => resolve(""));
  });
}

// ── Gemini summary ────────────────────────────────────────────────────────────

function callGemini(repo, readme) {
  if (!GEMINI_KEY) return Promise.resolve(null);

  const prompt = `다음 GitHub 레포지토리 정보를 바탕으로, 개발자 대상 뉴스레터 항목처럼 2~3문장으로 한국어로 설명해줘.
"왜 지금 주목받고 있는가"에 초점을 맞추고, 마크다운 없이 평문으로만 작성해.

레포: ${repo.full_name}
설명: ${repo.description || "없음"}
언어: ${repo.language || "없음"}
이번 주 별 증가: ${repo.stars_gained > 0 ? repo.stars_gained + "개" : "정보 없음"}
README: ${readme || "없음"}`;

  const bodyStr = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const text = JSON.parse(data)?.candidates?.[0]?.content?.parts?.[0]?.text;
          resolve(text?.trim() || null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(bodyStr);
    req.end();
  });
}

// ── Translation ───────────────────────────────────────────────────────────────

function translateOne(text) {
  if (!text) return Promise.resolve(null);
  const params = new URLSearchParams({ q: text, langpair: "en|ko" });
  return new Promise((resolve) => {
    https.get({
      hostname: "api.mymemory.translated.net",
      path: `/get?${params}`,
      headers: { "User-Agent": "github-trending-cli/1.0" },
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const t = JSON.parse(body)?.responseData?.translatedText;
          resolve(t && t !== text ? t : text);
        } catch { resolve(text); }
      });
    }).on("error", () => resolve(text));
  });
}

// ── Category fetcher ──────────────────────────────────────────────────────────

async function fetchCategory(key, cat) {
  let repos;

  if (cat.type === "scrape") {
    repos = await fetchTrending(cat.lang);
  } else {
    const weekAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const data = await githubSearch(`created:>=${weekAgo} stars:>=${cat.minStars} ${cat.extra}`);
    repos = (data.items ?? []).filter(r => !isSpam(r)).slice(0, 10).map(r => ({
      full_name: r.full_name,
      html_url: r.html_url,
      description: r.description,
      language: r.language,
      stargazers_count: r.stargazers_count,
      forks_count: r.forks_count,
      stars_gained: null,
      license: r.license?.spdx_id ?? null,
    }));
  }

  const translations = await Promise.all(repos.map(r => translateOne(r.description)));
  return repos.map((r, i) => ({ ...r, descKo: translations[i] }));
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function computeStats(allData) {
  const topLanguages = {};
  for (const repo of (allData.all ?? [])) {
    if (repo.language) topLanguages[repo.language] = (topLanguages[repo.language] || 0) + 1;
  }
  const categoryCount = {};
  for (const [key, repos] of Object.entries(allData)) {
    if (key !== "all") categoryCount[key] = repos.length;
  }
  return { topLanguages, categoryCount };
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return (str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function repoCard(repo, rank) {
  const name    = escapeHtml(repo.full_name);
  const url     = escapeHtml(repo.html_url);
  const stars   = repo.stargazers_count.toLocaleString();
  const desc    = escapeHtml(repo.descKo ?? repo.description ?? "설명 없음");
  const lang    = escapeHtml(repo.language ?? "");
  const license = repo.license ? `<span class="license">${escapeHtml(repo.license)}</span>` : "";
  const gained  = repo.stars_gained > 0
    ? `<span class="gained">▲ ${repo.stars_gained.toLocaleString()} this ${SINCE}</span>`
    : "";
  const rankClass = rank <= 3 ? "top3" : "";

  return `
    <div class="card ${rankClass}">
      <div class="card-rank">${rank}</div>
      <div class="card-body">
        <a class="card-name" href="${url}" target="_blank" rel="noopener">${name}</a>
        <div class="card-meta">
          <span class="stars">★ ${stars}</span>
          ${gained}
          ${lang ? `<span class="lang">${lang}</span>` : ""}
          ${license}
        </div>
        <p class="card-desc">${desc}</p>
        ${repo.aiSummary ? `<p class="card-ai">${escapeHtml(repo.aiSummary)}</p>` : ""}
      </div>
    </div>`;
}

function buildHtml(allData, generatedAt) {
  const tabButtons = Object.entries(CATEGORIES)
    .map(([k, v], i) => `<button class="tab-btn${i === 0 ? " active" : ""}" data-tab="${k}">${v.label}</button>`)
    .join("\n    ");

  const tabPanels = Object.entries(allData)
    .map(([k, repos], i) => {
      const cards = repos.map((r, j) => repoCard(r, j + 1)).join("");
      return `<div class="tab-panel${i === 0 ? " active" : ""}" id="tab-${k}">${cards}\n  </div>`;
    })
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub 핫한 오픈소스 Top 10</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 1.5rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.4rem; }
    .badge { background: #238636; color: #fff; font-size: .7rem; padding: .2rem .5rem; border-radius: 999px; }
    .updated { margin-left: auto; font-size: .8rem; color: #8b949e; }
    .tabs { display: flex; gap: .4rem; padding: 1rem 2rem; flex-wrap: wrap; background: #161b22; border-bottom: 1px solid #30363d; }
    .tab-btn { background: transparent; border: 1px solid #30363d; color: #8b949e; padding: .4rem .9rem; border-radius: 6px; cursor: pointer; font-size: .85rem; transition: all .15s; }
    .tab-btn:hover { border-color: #58a6ff; color: #58a6ff; }
    .tab-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
    .tab-panel { display: none; padding: 1.5rem 2rem; max-width: 860px; margin: 0 auto; }
    .tab-panel.active { display: block; }
    .card { display: flex; gap: 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1rem 1.2rem; margin-bottom: .8rem; transition: border-color .15s; }
    .card:hover { border-color: #58a6ff; }
    .card.top3 { border-color: #d29922; }
    .card-rank { font-size: 1.6rem; font-weight: 800; color: #30363d; min-width: 2rem; text-align: center; line-height: 1.2; padding-top: .1rem; }
    .card.top3 .card-rank { color: #d29922; }
    .card-body { flex: 1; }
    .card-name { font-weight: 700; color: #58a6ff; text-decoration: none; font-size: 1rem; }
    .card-name:hover { text-decoration: underline; }
    .card-meta { display: flex; align-items: center; gap: .8rem; margin: .3rem 0; flex-wrap: wrap; }
    .stars { color: #e3b341; font-size: .85rem; font-weight: 600; }
    .gained { color: #3fb950; font-size: .82rem; font-weight: 600; }
    .lang { background: #21262d; border: 1px solid #30363d; color: #8b949e; font-size: .75rem; padding: .15rem .5rem; border-radius: 4px; }
    .license { background: #1c2d3f; border: 1px solid #1f6feb44; color: #58a6ff; font-size: .72rem; padding: .15rem .5rem; border-radius: 4px; }
    .card-desc { color: #8b949e; font-size: .88rem; line-height: 1.5; }
    .card-ai { color: #e6edf3; font-size: .85rem; line-height: 1.6; margin-top: .5rem; padding-top: .5rem; border-top: 1px solid #21262d; }
    .trend-section { max-width: 860px; margin: 2rem auto; padding: 0 2rem 2rem; }
    .trend-section h2 { font-size: 1.1rem; color: #e6edf3; margin-bottom: 1.2rem; padding-bottom: .6rem; border-bottom: 1px solid #30363d; }
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 640px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 1.2rem; }
    .chart-box h3 { font-size: .85rem; color: #8b949e; margin-bottom: 1rem; }
    .chart-loading { color: #484f58; font-size: .85rem; text-align: center; padding: 2rem 0; }
    footer { text-align: center; padding: 2rem; color: #484f58; font-size: .8rem; }
  </style>
</head>
<body>
  <header>
    <h1>🔥 GitHub 핫한 오픈소스 Top 10</h1>
    <span class="badge">WEEKLY</span>
    <span class="updated">업데이트: ${generatedAt}</span>
  </header>
  <nav class="tabs">
    ${tabButtons}
  </nav>
  ${tabPanels}

  <section class="trend-section">
    <h2>📈 주차별 트렌드</h2>
    <div class="charts-grid">
      <div class="chart-box">
        <h3>언어별 등장 추이 (최근 12주)</h3>
        <canvas id="langChart"></canvas>
        <p class="chart-loading" id="lang-loading">데이터 로딩 중...</p>
      </div>
      <div class="chart-box">
        <h3>이번 주 카테고리별 레포 수</h3>
        <canvas id="catChart"></canvas>
        <p class="chart-loading" id="cat-loading">데이터 로딩 중...</p>
      </div>
    </div>
  </section>

  <footer>매주 자동 갱신 · GitHub Actions + GitHub Pages · 설명은 한국어 자동 번역</footer>
  <script>
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn, .tab-panel").forEach(el => el.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      });
    });

    const COLORS = ["#58a6ff","#3fb950","#d29922","#f78166","#a371f7","#39d353","#e3b341","#ff7b72","#79c0ff","#56d364"];
    const CAT_LABELS = { ai:"AI/ML", web:"웹", tool:"도구", js:"JavaScript", ts:"TypeScript", python:"Python", rust:"Rust", go:"Go" };

    async function loadTrends() {
      try {
        const mRes = await fetch("./data/manifest.json");
        if (!mRes.ok) return;
        const manifest = await mRes.json();
        const weeks = manifest.weeks.slice(-12);
        const weekData = await Promise.all(weeks.map(w => fetch("./data/" + w + ".json").then(r => r.json()).catch(() => null)));
        const valid = weekData.filter(Boolean);
        if (valid.length === 0) return;

        const allLangs = [...new Set(valid.flatMap(d => Object.keys(d.stats.topLanguages)))];
        const topLangs = allLangs
          .map(l => ({ lang: l, total: valid.reduce((s, d) => s + (d.stats.topLanguages[l] || 0), 0) }))
          .sort((a, b) => b.total - a.total).slice(0, 5).map(x => x.lang);

        document.getElementById("lang-loading").style.display = "none";
        new Chart(document.getElementById("langChart"), {
          type: "line",
          data: {
            labels: valid.map(d => d.week),
            datasets: topLangs.map((lang, i) => ({
              label: lang, data: valid.map(d => d.stats.topLanguages[lang] || 0),
              borderColor: COLORS[i], backgroundColor: COLORS[i] + "22", tension: 0.3, fill: false,
            })),
          },
          options: {
            responsive: true,
            plugins: { legend: { labels: { color: "#8b949e", font: { size: 11 } } } },
            scales: {
              x: { ticks: { color: "#8b949e", font: { size: 10 } }, grid: { color: "#21262d" } },
              y: { ticks: { color: "#8b949e", stepSize: 1 }, grid: { color: "#21262d" }, beginAtZero: true },
            },
          },
        });

        const latest = valid[valid.length - 1];
        const catKeys = Object.keys(latest.stats.categoryCount);
        document.getElementById("cat-loading").style.display = "none";
        new Chart(document.getElementById("catChart"), {
          type: "bar",
          data: {
            labels: catKeys.map(k => CAT_LABELS[k] || k),
            datasets: [{ label: latest.week, data: catKeys.map(k => latest.stats.categoryCount[k]), backgroundColor: COLORS.slice(0, catKeys.length), borderRadius: 4 }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: "#8b949e", font: { size: 11 } }, grid: { color: "#21262d" } },
              y: { ticks: { color: "#8b949e", stepSize: 1 }, grid: { color: "#21262d" }, beginAtZero: true },
            },
          },
        });
      } catch (e) { console.error("트렌드 로드 실패:", e); }
    }

    loadTrends();
  <\/script>
</body>
</html>`;
}

// ── Week ID ───────────────────────────────────────────────────────────────────

function getWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const docsDir = path.join(__dirname, "docs");
  const dataDir = path.join(docsDir, "data");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const allData = {};
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    process.stdout.write(`[${key}] 조회 중...\n`);
    try {
      allData[key] = await fetchCategory(key, cat);
    } catch (err) {
      console.error(`[${key}] 오류: ${err.message}`);
      allData[key] = [];
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // 고유 레포 모아서 Gemini 요약 생성
  if (GEMINI_KEY) {
    const uniqueRepos = new Map();
    for (const repos of Object.values(allData)) {
      for (const repo of repos) {
        if (!uniqueRepos.has(repo.full_name)) uniqueRepos.set(repo.full_name, repo);
      }
    }
    console.log(`\nGemini 요약 생성 중... (${uniqueRepos.size}개 레포)`);
    const summaries = {};
    for (const [full_name, repo] of uniqueRepos) {
      process.stdout.write(`  ${full_name} ...\n`);
      const readme = await fetchReadme(full_name);
      summaries[full_name] = await callGemini(repo, readme);
      await new Promise(r => setTimeout(r, 1200));
    }
    for (const repos of Object.values(allData)) {
      for (const repo of repos) repo.aiSummary = summaries[repo.full_name] || null;
    }
  }

  const weekId = getWeekId();
  const stats = computeStats(allData);
  const weekJson = { week: weekId, generatedAt: new Date().toISOString(), stats, repos: allData };

  fs.writeFileSync(path.join(dataDir, `${weekId}.json`), JSON.stringify(weekJson, null, 2), "utf8");

  const manifestPath = path.join(dataDir, "manifest.json");
  let manifest = { weeks: [] };
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.weeks.includes(weekId)) { manifest.weeks.push(weekId); manifest.weeks.sort(); }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const generatedAt = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  fs.writeFileSync(path.join(docsDir, "index.html"), buildHtml(allData, generatedAt), "utf8");
  console.log(`\n✅ 완료: docs/index.html + docs/data/${weekId}.json (${generatedAt})`);
}

main().catch(err => { console.error("오류:", err.message); process.exit(1); });
