#!/usr/bin/env node
"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("오류: GITHUB_TOKEN 환경변수를 설정해주세요.");
  process.exit(1);
}

const CATEGORIES = {
  all:    { label: "전체",        extra: "",                                                                                          minStars: 10 },
  ai:     { label: "AI/ML",      extra: "llm OR \"machine learning\" OR transformer OR \"neural network\" OR \"large language\"",    minStars: 5  },
  web:    { label: "웹",          extra: "react OR nextjs OR vue OR svelte OR frontend OR tailwind",                                  minStars: 5  },
  tool:   { label: "도구",        extra: "cli OR devtools OR automation OR productivity OR \"developer tool\"",                       minStars: 5  },
  js:     { label: "JavaScript",  extra: "language:javascript",                                                                       minStars: 5  },
  ts:     { label: "TypeScript",  extra: "language:typescript",                                                                       minStars: 5  },
  python: { label: "Python",      extra: "language:python",                                                                           minStars: 5  },
  rust:   { label: "Rust",        extra: "language:rust",                                                                             minStars: 3  },
  go:     { label: "Go",          extra: "language:go",                                                                               minStars: 3  },
};

function getWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function isSpam(repo) {
  const desc = repo.description ?? "";
  if (!desc) return false;
  const words = desc.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const maxRepeat = words.length > 0 ? Math.max(...Object.values(freq)) : 0;
  return maxRepeat >= 4;
}

function githubFetch(query) {
  const params = new URLSearchParams({ q: query, sort: "stars", order: "desc", per_page: "20" });
  const options = {
    hostname: "api.github.com",
    path: `/search/repositories?${params}`,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-trending-cli/1.0",
    },
  };
  return new Promise((resolve, reject) => {
    https.get(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
    }).on("error", reject);
  });
}

function translateOne(text) {
  const params = new URLSearchParams({ q: text, langpair: "en|ko" });
  const options = {
    hostname: "api.mymemory.translated.net",
    path: `/get?${params}`,
    headers: { "User-Agent": "github-trending-cli/1.0" },
  };
  return new Promise((resolve) => {
    https.get(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const t = json?.responseData?.translatedText;
          resolve(t && t !== text ? t : text);
        } catch { resolve(text); }
      });
    }).on("error", () => resolve(text));
  });
}

async function fetchCategory(key, cat) {
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const minStars = cat.minStars ?? 5;
  const baseQuery = `created:>=${weekAgo} stars:>=${minStars}`;
  const query = cat.extra ? `${baseQuery} ${cat.extra}` : baseQuery;

  const data = await githubFetch(query);
  const items = (data.items ?? []).filter(r => !isSpam(r));
  const top10 = items.slice(0, 10);

  const translated = await Promise.all(
    top10.map((r) => r.description ? translateOne(r.description) : Promise.resolve(null))
  );

  return top10.map((r, i) => ({
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description,
    descKo: translated[i],
    language: r.language,
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    license: r.license?.spdx_id ?? null,
  }));
}

function computeStats(allData) {
  const languages = {};
  for (const repo of (allData.all ?? [])) {
    if (repo.language) languages[repo.language] = (languages[repo.language] || 0) + 1;
  }
  const categoryCount = {};
  for (const [key, repos] of Object.entries(allData)) {
    if (key !== "all") categoryCount[key] = repos.length;
  }
  return { topLanguages: languages, categoryCount };
}

function escapeHtml(str) {
  return (str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function repoCard(repo, rank) {
  const name = escapeHtml(repo.full_name);
  const stars = repo.stargazers_count.toLocaleString();
  const desc = escapeHtml(repo.descKo ?? repo.description ?? "설명 없음");
  const lang = escapeHtml(repo.language ?? "");
  const url = escapeHtml(repo.html_url);
  const license = repo.license ? `<span class="license">${escapeHtml(repo.license)}</span>` : "";
  const rankClass = rank <= 3 ? "top3" : "";

  return `
    <div class="card ${rankClass}">
      <div class="card-rank">${rank}</div>
      <div class="card-body">
        <a class="card-name" href="${url}" target="_blank" rel="noopener">${name}</a>
        <div class="card-meta">
          <span class="stars">★ ${stars}</span>
          ${lang ? `<span class="lang">${lang}</span>` : ""}
          ${license}
        </div>
        <p class="card-desc">${desc}</p>
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
    .lang { background: #21262d; border: 1px solid #30363d; color: #8b949e; font-size: .75rem; padding: .15rem .5rem; border-radius: 4px; }
    .license { background: #1c2d3f; border: 1px solid #1f6feb44; color: #58a6ff; font-size: .72rem; padding: .15rem .5rem; border-radius: 4px; }
    .card-desc { color: #8b949e; font-size: .88rem; line-height: 1.5; }
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

        const weekData = await Promise.all(
          weeks.map(w => fetch("./data/" + w + ".json").then(r => r.json()).catch(() => null))
        );
        const valid = weekData.filter(Boolean);
        if (valid.length === 0) return;

        // 언어 차트
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
              label: lang,
              data: valid.map(d => d.stats.topLanguages[lang] || 0),
              borderColor: COLORS[i], backgroundColor: COLORS[i] + "22",
              tension: 0.3, fill: false,
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

        // 카테고리 차트 (최신 주)
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
      } catch (e) {
        console.error("트렌드 로드 실패:", e);
      }
    }

    loadTrends();
  <\/script>
</body>
</html>`;
}

async function main() {
  const docsDir = path.join(__dirname, "docs");
  const dataDir = path.join(docsDir, "data");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const allData = {};
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    process.stdout.write(`[${key}] 조회 + 번역 중...\n`);
    allData[key] = await fetchCategory(key, cat);
    await new Promise((r) => setTimeout(r, 1000));
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

main().catch((err) => { console.error("오류:", err.message); process.exit(1); });
