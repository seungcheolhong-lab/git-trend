#!/usr/bin/env python3
"""주간 GitHub 트렌드 메일 발송"""

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


def lang_diff_rows(latest, prev):
    curr = latest["stats"]["topLanguages"]
    prev_langs = prev["stats"]["topLanguages"] if prev else {}
    rows = ""
    for lang, count in sorted(curr.items(), key=lambda x: -x[1])[:5]:
        diff = count - prev_langs.get(lang, 0)
        if diff > 0:
            arrow, color = f"▲{diff}", "#3fb950"
        elif diff < 0:
            arrow, color = f"▼{abs(diff)}", "#f78166"
        else:
            arrow, color = "─", "#8b949e"
        rows += f"<tr><td style='padding:6px 8px'>{lang}</td><td style='padding:6px 8px'>{count}개</td><td style='padding:6px 8px;color:{color}'>{arrow}</td></tr>"
    return rows


def build_html(latest, prev):
    week = latest["week"]
    repos = latest["repos"]["all"][:10]

    repo_rows = ""
    for i, r in enumerate(repos, 1):
        url = r["html_url"]
        name = r["full_name"]
        stars = f"{r['stargazers_count']:,}"
        lang = r.get("language") or "-"
        desc = r.get("descKo") or r.get("description") or "설명 없음"
        desc = desc[:80] + ("..." if len(desc) > 80 else "")
        rank_color = "#d29922" if i <= 3 else "#8b949e"
        gained = r.get("stars_gained") or 0
        gained_html = f'<br><span style="color:#3fb950;font-size:11px;">▲ {gained:,} this week</span>' if gained > 0 else ""
        repo_rows += f"""<tr>
          <td style="padding:8px 4px;text-align:center;color:{rank_color};font-weight:800;">{i}</td>
          <td style="padding:8px;">
            <a href="{url}" style="color:#58a6ff;text-decoration:none;font-weight:600;">{name}</a><br>
            <span style="color:#8b949e;font-size:12px;">{desc}</span>
          </td>
          <td style="padding:8px;color:#e3b341;font-size:13px;white-space:nowrap;">★ {stars}{gained_html}</td>
          <td style="padding:8px;color:#8b949e;font-size:12px;">{lang}</td>
        </tr>"""

    lang_section = ""
    if prev:
        lang_section = f"""
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:16px;">
      <h2 style="font-size:1rem;margin:0 0 16px;color:#e6edf3;">📊 언어 트렌드 (전주 대비)</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="border-bottom:1px solid #30363d;color:#8b949e;font-size:12px;">
          <th style="padding:6px 8px;text-align:left;">언어</th>
          <th style="padding:6px 8px;">이번 주</th>
          <th style="padding:6px 8px;">변화</th>
        </tr></thead>
        <tbody>{lang_diff_rows(latest, prev)}</tbody>
      </table>
    </div>"""

    return f"""<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:20px;">
  <div style="max-width:600px;margin:0 auto;">
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:16px;">
      <h1 style="font-size:1.3rem;margin:0 0 4px;">🔥 GitHub 주간 트렌드</h1>
      <p style="color:#8b949e;font-size:13px;margin:0;">{week} 기준 · 최근 7일 핫한 오픈소스</p>
    </div>

    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:16px;">
      <h2 style="font-size:1rem;margin:0 0 16px;color:#e6edf3;">이번 주 Top 10</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="border-bottom:1px solid #30363d;color:#8b949e;font-size:12px;">
          <th style="padding:8px 4px;width:28px;">#</th>
          <th style="padding:8px;text-align:left;">레포지토리</th>
          <th style="padding:8px;">별</th>
          <th style="padding:8px;">언어</th>
        </tr></thead>
        <tbody>{repo_rows}</tbody>
      </table>
    </div>

    {lang_section}

    <div style="text-align:center;padding:8px 0 16px;">
      <a href="{PAGES_URL}" style="background:#1f6feb;color:#fff;text-decoration:none;padding:10px 28px;border-radius:6px;font-size:14px;font-weight:600;">대시보드에서 전체 보기 →</a>
    </div>
    <p style="color:#484f58;font-size:11px;text-align:center;">매주 월요일 자동 발송 · GitHub Actions</p>
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
    msg["Subject"] = f"[GitHub 트렌드] {latest['week']} 주간 오픈소스 Top 10"
    msg["From"] = GMAIL_USER
    msg["To"] = TO_EMAIL
    msg.attach(MIMEText(html, "html", "utf-8"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)

    print(f"✅ 메일 발송 완료 → {TO_EMAIL}")


if __name__ == "__main__":
    main()
