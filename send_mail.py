#!/usr/bin/env python3
"""주간 GitHub 트렌드 뉴스레터 발송"""

import os
import json
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

GMAIL_USER = os.environ["GMAIL_USER"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]
TO_EMAIL = "seungcheol.hong@likelion.net"
PAGES_URL = "https://seungcheolhong-lab.github.io/git-trend/"


def load_latest_weeks():
    files = sorted(Path("docs/data").glob("????-W??.json"))
    if not files:
        return None, None
    latest = json.loads(files[-1].read_text("utf-8"))
    prev = json.loads(files[-2].read_text("utf-8")) if len(files) >= 2 else None
    return latest, prev


def featured_card(i, r):
    url = r["html_url"]
    name = r["full_name"]
    stars = f"{r['stargazers_count']:,}"
    lang = r.get("language") or ""
    gained = r.get("stars_gained") or 0
    ai_summary = r.get("aiSummary") or r.get("descKo") or r.get("description") or ""
    rank_emoji = ["🥇", "🥈", "🥉"][i - 1] if i <= 3 else f"#{i}"
    lang_badge = f'<span style="background:#21262d;border:1px solid #30363d;color:#8b949e;font-size:11px;padding:2px 7px;border-radius:4px;margin-right:6px;">{lang}</span>' if lang else ""
    gained_badge = f'<span style="color:#3fb950;font-size:12px;">▲ {gained:,} this week</span>' if gained > 0 else ""

    return f"""
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px 24px;margin-bottom:12px;">
      <div style="margin-bottom:10px;">
        <span style="font-size:1.1rem;font-weight:800;color:#e6edf3;">{rank_emoji}&nbsp;
          <a href="{url}" style="color:#58a6ff;text-decoration:none;">{name}</a>
        </span>
      </div>
      <div style="margin-bottom:12px;">
        {lang_badge}
        <span style="color:#e3b341;font-size:12px;margin-right:10px;">★ {stars}</span>
        {gained_badge}
      </div>
      <p style="color:#e6edf3;font-size:14px;line-height:1.7;margin:0;">{ai_summary}</p>
    </div>"""


def brief_row(i, r):
    url = r["html_url"]
    name = r["full_name"]
    gained = r.get("stars_gained") or 0
    lang = r.get("language") or "-"
    gained_str = f"▲{gained:,}" if gained > 0 else ""
    return f"""<tr>
      <td style="padding:7px 6px;color:#8b949e;font-size:12px;width:24px;">{i}</td>
      <td style="padding:7px 6px;"><a href="{url}" style="color:#58a6ff;text-decoration:none;font-size:13px;">{name}</a></td>
      <td style="padding:7px 6px;color:#3fb950;font-size:12px;white-space:nowrap;">{gained_str}</td>
      <td style="padding:7px 6px;color:#8b949e;font-size:12px;">{lang}</td>
    </tr>"""


def lang_diff_rows(latest, prev):
    curr = latest["stats"]["topLanguages"]
    prev_langs = prev["stats"]["topLanguages"] if prev else {}
    rows = ""
    for lang, count in sorted(curr.items(), key=lambda x: -x[1])[:5]:
        diff = count - prev_langs.get(lang, 0)
        arrow, color = ("▲" + str(diff), "#3fb950") if diff > 0 else (("▼" + str(abs(diff)), "#f78166") if diff < 0 else ("─", "#8b949e"))
        rows += f"<tr><td style='padding:6px 8px;color:#e6edf3;font-size:13px;'>{lang}</td><td style='padding:6px 8px;color:#8b949e;font-size:13px;'>{count}개</td><td style='padding:6px 8px;color:{color};font-size:13px;'>{arrow}</td></tr>"
    return rows


def build_html(latest, prev):
    week = latest["week"]
    all_repos = latest["repos"]["all"]

    featured = "".join(featured_card(i + 1, r) for i, r in enumerate(all_repos[:5]))

    brief = "".join(brief_row(i + 6, r) for i, r in enumerate(all_repos[5:10]))
    brief_section = f"""
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px 24px;margin-bottom:12px;">
      <h2 style="font-size:.95rem;margin:0 0 14px;color:#8b949e;font-weight:600;">그 외 주목 레포</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tbody>{brief}</tbody>
      </table>
    </div>""" if all_repos[5:10] else ""

    lang_section = ""
    if prev:
        lang_section = f"""
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px 24px;margin-bottom:12px;">
      <h2 style="font-size:.95rem;margin:0 0 14px;color:#8b949e;font-weight:600;">📊 언어 트렌드 (전주 대비)</h2>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid #30363d;">
          <th style="padding:6px 8px;text-align:left;color:#484f58;font-size:11px;">언어</th>
          <th style="padding:6px 8px;color:#484f58;font-size:11px;">이번 주</th>
          <th style="padding:6px 8px;color:#484f58;font-size:11px;">변화</th>
        </tr></thead>
        <tbody>{lang_diff_rows(latest, prev)}</tbody>
      </table>
    </div>"""

    return f"""<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:20px;">
  <div style="max-width:620px;margin:0 auto;">

    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:12px;">
      <p style="color:#3fb950;font-size:11px;font-weight:700;letter-spacing:.08em;margin:0 0 6px;">WEEKLY GITHUB TREND</p>
      <h1 style="font-size:1.4rem;margin:0 0 4px;color:#e6edf3;">이번 주 주목할 오픈소스</h1>
      <p style="color:#8b949e;font-size:13px;margin:0;">{week} 기준 · GitHub Trending 기반</p>
    </div>

    {featured}
    {brief_section}
    {lang_section}

    <div style="text-align:center;padding:16px 0;">
      <a href="{PAGES_URL}" style="background:#1f6feb;color:#fff;text-decoration:none;padding:11px 30px;border-radius:8px;font-size:14px;font-weight:600;">대시보드 전체 보기 →</a>
    </div>
    <p style="color:#484f58;font-size:11px;text-align:center;margin-top:8px;">매주 자동 발송 · GitHub Actions · AI 요약: Google Gemini</p>
  </div>
</body>
</html>"""


def main():
    latest, prev = load_latest_weeks()
    if not latest:
        print("데이터 없음, 메일 발송 건너뜀")
        return

    html = build_html(latest, prev)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"[GitHub 트렌드] {latest['week']} 주목할 오픈소스 Top 10"
    msg["From"] = GMAIL_USER
    msg["To"] = TO_EMAIL
    msg.attach(MIMEText(html, "html", "utf-8"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)

    print(f"✅ 메일 발송 완료 → {TO_EMAIL}")


if __name__ == "__main__":
    main()
