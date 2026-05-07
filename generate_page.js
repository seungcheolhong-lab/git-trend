#!/usr/bin/env node
"use strict";

// GitHub Pages용 HTML 생성기
// github_trending.js 에서 공통 로직을 재사용합니다.

const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("오류: GITHUB_TOKEN 환경변수를 설정해주세요.");
  process.exit(1);
}

const CATEGORIES = {
  all:    { label: "전체",        extra: "" },
  ai:     { label: "AI/ML",      extra: "llm OR \"machine learning\" OR transformer OR \"neural network\" OR \"large language\"" },
  web:    { label: "웹",          extra: "react OR nextjs OR vue OR svelte OR frontend OR tailwind" },
  tool:   { label: "도구",        extra: "cli OR devtools OR automation OR productivity OR \"developer tool\"" },
  js:     { label: "JavaScript",  extra: "language:javascript" },
  ts:     { label: "TypeScript",  extra: "language:typescript" },
  python: { label: "Python",      extra: "language:python" },
  rust:   { label: "Rust",        extra: "language:rust" },
  go:     { label: "Go",          extra: "language:go" },
};

function githubFetch(query) {
  const params = new URLSearchParams({ q: query, sort: "stars", order: "desc", per_page: "10" });
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
  const today = new Date().toISOString().slice(0, 10);
  const baseQuery = `created:>=${today}`;
  const query = cat.extra ? `${baseQuery} ${cat.extra}` : baseQuery;

  let data = await githubFetch(query);
  let items = data.items ?? [];

  if (items.length < 5) {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const fallback = cat.extra
      ? `created:>=${weekAgo} stars:>10 ${cat.extra}`
      : `created:>=${weekAgo} stars:>50`;
    data = await githubFetch(fallback);
    items = data.items ?? [];
  }

  const top10 = items.slice(0, 10);
  const translated = await Promise.all(
    top10.map((r) => r.description ? translateOne(r.description) : Promise.resolve(null))
  );

  return top10.map((r, i) => ({ ...r, descKo: translated[i] }));
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
  const rankClass = rank <= 3 ? "top3" : "";

  return `
    <div class="card ${rankClass}">
      <div class="card-rank">${rank}</div>
      <div class="card-body">
        <a class="card-name" href="${url}" target="_blank" rel="noopener">${name}</a>
        <div class="card-meta">
          <span class="stars">★ ${stars}</span>
          ${lang ? `<span class="lang">${lang}</span>` : ""}
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
    .card-meta { display: flex; align-items: center; gap: .8rem; margin: .3rem 0; }
    .stars { color: #e3b341; font-size: .85rem; font-weight: 600; }
    .lang { background: #21262d; border: 1px solid #30363d; color: #8b949e; font-size: .75rem; padding: .15rem .5rem; border-radius: 4px; }
    .card-desc { color: #8b949e; font-size: .88rem; line-height: 1.5; }
    footer { text-align: center; padding: 2rem; color: #484f58; font-size: .8rem; }
  </style>
</head>
<body>
  <header>
    <h1>🔥 GitHub 핫한 오픈소스 Top 10</h1>
    <span class="badge">LIVE</span>
    <span class="updated">업데이트: ${generatedAt}</span>
  </header>
  <nav class="tabs">
    ${tabButtons}
  </nav>
  ${tabPanels}
  <footer>매일 자동 갱신 · GitHub Actions + GitHub Pages · 설명은 한국어 자동 번역</footer>
  <script>
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn, .tab-panel").forEach(el => el.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      });
    });
  </script>
</body>
</html>`;
}

async function main() {
  const outDir = path.join(__dirname, "docs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const allData = {};
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    process.stdout.write(`[${key}] 조회 + 번역 중...\n`);
    allData[key] = await fetchCategory(key, cat);
    // MyMemory rate limit 회피 (1초 간격)
    await new Promise((r) => setTimeout(r, 1000));
  }

  const generatedAt = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const html = buildHtml(allData, generatedAt);
  fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
  console.log(`\n✅ docs/index.html 생성 완료 (${generatedAt})`);
}

main().catch((err) => { console.error("오류:", err.message); process.exit(1); });
