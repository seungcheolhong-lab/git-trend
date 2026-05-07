#!/usr/bin/env node
"use strict";

const https = require("https");
const { execSync } = require("child_process");

// ── 카테고리 정의 ──────────────────────────────────────────────
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

// ── CLI 인수 파싱 ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let category = "all";
  let help = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--category" || args[i] === "-c") {
      category = (args[i + 1] ?? "all").toLowerCase();
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      help = true;
    }
  }
  return { category, help };
}

function printHelp() {
  console.log(`
사용법: node github_trending.js [옵션]

옵션:
  -c, --category <카테고리>   카테고리 필터 (기본: all)
  -h, --help                  도움말 출력

카테고리 목록:
${Object.entries(CATEGORIES).map(([k, v]) => `  ${k.padEnd(10)} ${v.label}`).join("\n")}

예시:
  node github_trending.js
  node github_trending.js --category ai
  node github_trending.js -c python
`);
}

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("오류: GITHUB_TOKEN 환경변수를 설정해주세요.");
  process.exit(1);
}

// Windows ANSI 활성화
if (process.platform === "win32") {
  try { execSync("color", { stdio: "ignore" }); } catch {}
}

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const YELLOW = "\x1b[93m";
const CYAN   = "\x1b[96m";
const GREEN  = "\x1b[92m";

function fetch(query) {
  const params = new URLSearchParams({
    q: query,
    sort: "stars",
    order: "desc",
    per_page: "10",
  });
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
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        } else {
          resolve(JSON.parse(body));
        }
      });
    }).on("error", reject);
  });
}

// ── 번역 (MyMemory 무료 API, 하루 5000단어) ──────────────────
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
          const translated = json?.responseData?.translatedText;
          // 번역 실패 또는 원문과 동일하면 원문 반환
          resolve(translated && translated !== text ? translated : text);
        } catch {
          resolve(text);
        }
      });
    }).on("error", () => resolve(text));
  });
}

async function translateAll(items) {
  // 빈 설명 제외하고 묶음 번역 (순서 유지)
  const results = await Promise.all(
    items.map((repo) => {
      const desc = repo.description;
      if (!desc) return Promise.resolve(null);
      return translateOne(desc);
    })
  );
  return items.map((repo, i) => ({ ...repo, descKo: results[i] }));
}

function starsBar(stars, maxStars, width = 20) {
  if (maxStars === 0) return " ".repeat(width);
  const filled = Math.round((stars / maxStars) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function render(items, label, categoryLabel) {
  const maxStars = items[0]?.stargazers_count ?? 1;

  console.log();
  console.log(`${BOLD}${"─".repeat(62)}${RESET}`);
  const catTag = categoryLabel ? ` [${categoryLabel}]` : "";
  console.log(`${BOLD}  GitHub 핫한 오픈소스 Top 10${YELLOW}${catTag}${RESET}${BOLD}  ${DIM}(${label})${RESET}`);
  console.log(`${BOLD}${"─".repeat(62)}${RESET}`);

  for (let i = 0; i < items.length; i++) {
    const repo = items[i];
    const rank = i + 1;
    const name = repo.full_name;
    const stars = repo.stargazers_count;
    const rawDesc = repo.descKo ?? repo.description ?? "설명 없음";
    const desc = rawDesc.slice(0, 65) + (rawDesc.length > 65 ? "..." : "");
    const lang = repo.language ?? "";
    const bar = starsBar(stars, maxStars);
    const rankColor = rank <= 3 ? YELLOW : CYAN;

    console.log();
    console.log(`  ${rankColor}${BOLD}${String(rank).padStart(2)}.${RESET} ${BOLD}${name}${RESET}`);
    console.log(`      ${GREEN}★ ${stars.toLocaleString()}${RESET}  ${DIM}[${bar}]${RESET}  ${DIM}${lang}${RESET}`);
    console.log(`      ${desc}`);
  }

  console.log();
  console.log(`${BOLD}${"─".repeat(62)}${RESET}`);
  console.log();
}

async function main() {
  const { category, help } = parseArgs();

  if (help) { printHelp(); return; }

  const cat = CATEGORIES[category];
  if (!cat) {
    console.error(`알 수 없는 카테고리: "${category}"`);
    console.error(`사용 가능: ${Object.keys(CATEGORIES).join(", ")}`);
    process.exit(1);
  }

  process.stdout.write(`GitHub API 조회 중... (${cat.label})`);

  const today = new Date().toISOString().slice(0, 10);
  const baseToday = `created:>=${today}`;
  const query = cat.extra ? `${baseToday} ${cat.extra}` : baseToday;

  let data = await fetch(query);
  let items = data.items ?? [];
  let label;

  if (items.length < 5) {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const fallbackQuery = cat.extra
      ? `created:>=${weekAgo} stars:>10 ${cat.extra}`
      : `created:>=${weekAgo} stars:>50`;
    data = await fetch(fallbackQuery);
    items = data.items ?? [];
    label = `최근 7일 기준 · 총 ${(data.total_count ?? 0).toLocaleString()}개 중 Top 10`;
  } else {
    label = `오늘(${today}) 기준 · 총 ${(data.total_count ?? 0).toLocaleString()}개 중 Top 10`;
  }

  process.stdout.write("\r" + " ".repeat(40) + "\r");

  if (items.length === 0) {
    console.error("결과를 찾을 수 없습니다.");
    process.exit(1);
  }

  const top10 = items.slice(0, 10);

  process.stdout.write("설명 번역 중...");
  const translated = await translateAll(top10);
  process.stdout.write("\r" + " ".repeat(20) + "\r");

  render(translated, label, category !== "all" ? cat.label : null);
}

main().catch((err) => {
  console.error("\n오류:", err.message);
  process.exit(1);
});
