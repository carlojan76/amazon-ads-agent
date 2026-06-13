"""
Weekly Amazon Ads Analysis
===========================
1. Fetch dati via API
2. Invia a Claude per analisi
3. Invia email con report HTML

Eseguito automaticamente da GitHub Actions ogni settimana.
"""

import os
import sys
import json
import smtplib
import requests
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# Import il fetcher (stesso folder)
sys.path.insert(0, str(Path(__file__).parent))
from amazon_ads_api import fetch_all_data, CONFIG

# ============================================================
# CONFIG
# ============================================================
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
EMAIL_TO = os.getenv("EMAIL_TO", "")

# Marketplaces da analizzare (separati da virgola in env: "IT,FR,DE")
MARKETPLACES = os.getenv("MARKETPLACES", "IT,FR,DE").split(",")
DAYS = int(os.getenv("ANALYSIS_DAYS", "14"))


def build_summary(data):
    """Estrai metriche aggregate dal JSON Amazon."""
    reports = data.get("reports", {})
    campaigns_report = reports.get("campaigns", [])
    keywords_report = reports.get("keywords", [])
    st_report = reports.get("searchTerms", [])

    def num(v):
        try:
            return float(str(v or 0).replace("€", "").replace("$", "").replace(",", ""))
        except Exception:
            return 0.0

    total_spend = sum(num(r.get("cost", r.get("spend", 0))) for r in campaigns_report)
    total_sales = sum(num(r.get("sales7d", 0)) for r in campaigns_report)
    total_clicks = sum(num(r.get("clicks", 0)) for r in campaigns_report)
    total_impr = sum(num(r.get("impressions", 0)) for r in campaigns_report)
    total_orders = sum(num(r.get("purchases7d", 0)) for r in campaigns_report)

    acos = (total_spend / total_sales * 100) if total_sales > 0 else 0
    roas = (total_sales / total_spend) if total_spend > 0 else 0

    # Top campagne
    camp_summary = []
    for r in campaigns_report:
        spend = num(r.get("cost", r.get("spend", 0)))
        sales = num(r.get("sales7d", 0))
        c_acos = (spend / sales * 100) if sales > 0 else (999 if spend > 0 else 0)
        camp_summary.append({
            "name": r.get("campaignName", "N/A"),
            "spend": spend,
            "sales": sales,
            "acos": c_acos,
            "clicks": num(r.get("clicks", 0)),
            "orders": num(r.get("purchases7d", 0)),
        })
    camp_summary.sort(key=lambda x: x["spend"], reverse=True)

    # Top keywords
    kw_summary = []
    for r in keywords_report:
        spend = num(r.get("cost", r.get("spend", 0)))
        sales = num(r.get("sales7d", 0))
        clicks = num(r.get("clicks", 0))
        orders = num(r.get("purchases7d", 0))
        if spend == 0:
            continue
        k_acos = (spend / sales * 100) if sales > 0 else 999
        kw_summary.append({
            "keyword": r.get("keyword", ""),
            "matchType": r.get("matchType", ""),
            "spend": spend,
            "sales": sales,
            "clicks": clicks,
            "orders": orders,
            "acos": k_acos,
        })
    kw_summary.sort(key=lambda x: x["spend"], reverse=True)

    # Search terms sprechi
    st_waste = []
    for r in st_report:
        spend = num(r.get("cost", r.get("spend", 0)))
        orders = num(r.get("purchases7d", 0))
        if spend > 0.5 and orders == 0:
            st_waste.append({
                "searchTerm": r.get("searchTerm", ""),
                "keyword": r.get("keyword", ""),
                "spend": spend,
                "clicks": num(r.get("clicks", 0)),
            })
    st_waste.sort(key=lambda x: x["spend"], reverse=True)

    return {
        "total_spend": total_spend,
        "total_sales": total_sales,
        "total_clicks": total_clicks,
        "total_impr": total_impr,
        "total_orders": total_orders,
        "acos": acos,
        "roas": roas,
        "campaigns": camp_summary[:15],
        "keywords": kw_summary[:30],
        "waste_kw": [k for k in kw_summary if k["orders"] == 0][:15],
        "best_kw": sorted([k for k in kw_summary if k["orders"] > 0 and k["acos"] < 25], key=lambda x: x["acos"])[:10],
        "waste_st": st_waste[:15],
    }


def build_claude_prompt(summary, marketplace, days):
    """Costruisci il prompt per Claude basato sulle metriche."""
    camps = "\n".join([
        f"- {c['name']}: Spend €{c['spend']:.2f}, Sales €{c['sales']:.2f}, ACoS {c['acos']:.1f}%, Orders {c['orders']:.0f}"
        for c in summary["campaigns"]
    ])
    kws = "\n".join([
        f'- "{k["keyword"]}" [{k["matchType"]}] €{k["spend"]:.2f} spend, €{k["sales"]:.2f} sales, ACoS {k["acos"]:.1f}%, {k["clicks"]:.0f} clicks, {k["orders"]:.0f} orders'
        for k in summary["keywords"]
    ])
    waste = "\n".join([
        f'- "{k["keyword"]}" [{k["matchType"]}] €{k["spend"]:.2f} spesi, {k["clicks"]:.0f} clicks, ZERO ordini'
        for k in summary["waste_kw"]
    ])
    best = "\n".join([
        f'- "{k["keyword"]}" ACoS {k["acos"]:.1f}%, {k["orders"]:.0f} ordini, €{k["sales"]:.2f} sales'
        for k in summary["best_kw"]
    ])
    st_waste = "\n".join([
        f'- "{s["searchTerm"]}" (kw: "{s["keyword"]}") €{s["spend"]:.2f}, {s["clicks"]:.0f} clicks — ZERO ordini'
        for s in summary["waste_st"]
    ])

    return f"""## Marketplace: {marketplace} | Periodo: ultimi {days} giorni

## Metriche Generali
- Spesa: €{summary['total_spend']:.2f}
- Vendite: €{summary['total_sales']:.2f}
- ACoS: {summary['acos']:.1f}%
- ROAS: {summary['roas']:.2f}x
- Impression: {summary['total_impr']:,.0f}
- Click: {summary['total_clicks']:,.0f}
- Ordini: {summary['total_orders']:.0f}

## Top 15 Campagne per Spesa
{camps or "Nessun dato"}

## Top 30 Keywords per Spesa
{kws or "Nessun dato"}

## Keywords Spreconi (spesa > 0, ZERO ordini)
{waste or "Nessuno"}

## Best Performer (ACoS < 25%)
{best or "Nessuno"}

## Search Terms Spreconi (spesa > €0.5, ZERO ordini) — DA NEGATIVIZZARE
{st_waste or "Nessuno"}

---

Sei un consulente PPC Amazon senior. Analizza questi dati e fornisci un REPORT SETTIMANALE con consigli OPERATIVI in italiano.

Struttura della risposta:

# 📊 Stato Generale
2-3 righe: come va il marketplace nel suo complesso, trend, problemi principali.

# 🔴 Azioni Urgenti (Top 3)
Le 3 cose più importanti da fare QUESTA SETTIMANA. Per ognuna:
- **Azione**: cosa fare esattamente (con nome keyword/campagna)
- **Motivo**: dati che la giustificano
- **Impatto stimato**: risparmio o aumento vendite atteso

# 🚫 Search Terms da Negativizzare
Lista di 5-10 search terms da aggiungere come negative (con match type suggerito).

# 🟢 Keywords da Scalare
Keywords con ottimo ACoS dove aumentare bid o budget.

# 💡 Quick Wins
Altre 3-5 ottimizzazioni rapide ad alto impatto.

Sii diretto, specifico, NIENTE teoria generica."""


def call_claude(prompt):
    """Chiama Claude API."""
    if not ANTHROPIC_API_KEY:
        return "⚠️ ANTHROPIC_API_KEY non configurata"

    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": 4000,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    if resp.status_code != 200:
        return f"⚠️ Errore Claude API ({resp.status_code}): {resp.text[:300]}"
    data = resp.json()
    return "\n".join(b.get("text", "") for b in data.get("content", []))


def markdown_to_html(md_text):
    """Conversione markdown semplice → HTML."""
    html_lines = []
    in_list = False
    for line in md_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            if in_list:
                html_lines.append("</ul>")
                in_list = False
            html_lines.append("<br>")
            continue
        # Headers
        if stripped.startswith("# "):
            if in_list:
                html_lines.append("</ul>"); in_list = False
            html_lines.append(f'<h2 style="color:#f0883e;margin:24px 0 8px;font-size:18px;border-bottom:1px solid #21262d;padding-bottom:4px;">{stripped[2:]}</h2>')
        elif stripped.startswith("## "):
            if in_list:
                html_lines.append("</ul>"); in_list = False
            html_lines.append(f'<h3 style="color:#58a6ff;margin:16px 0 6px;font-size:15px;">{stripped[3:]}</h3>')
        elif stripped.startswith("### "):
            if in_list:
                html_lines.append("</ul>"); in_list = False
            html_lines.append(f'<h4 style="color:#bc8cff;margin:12px 0 4px;font-size:13px;">{stripped[4:]}</h4>')
        # List items
        elif stripped.startswith("- ") or stripped.startswith("* "):
            if not in_list:
                html_lines.append('<ul style="margin:4px 0 8px 20px;padding:0;">')
                in_list = True
            content = stripped[2:]
            content = content.replace("**", "###BOLD###")
            parts = content.split("###BOLD###")
            html_content = ""
            for i, p in enumerate(parts):
                if i % 2 == 1:
                    html_content += f'<strong style="color:#f0883e;">{p}</strong>'
                else:
                    html_content += p
            html_lines.append(f'<li style="margin:3px 0;font-size:13px;line-height:1.5;">{html_content}</li>')
        else:
            if in_list:
                html_lines.append("</ul>"); in_list = False
            content = stripped.replace("**", "###BOLD###")
            parts = content.split("###BOLD###")
            html_content = ""
            for i, p in enumerate(parts):
                if i % 2 == 1:
                    html_content += f'<strong style="color:#f0883e;">{p}</strong>'
                else:
                    html_content += p
            html_lines.append(f'<p style="margin:6px 0;font-size:13px;line-height:1.6;">{html_content}</p>')
    if in_list:
        html_lines.append("</ul>")
    return "\n".join(html_lines)


def build_email_html(analyses, summaries):
    """Costruisci email HTML con tutti i marketplace."""
    today = datetime.now().strftime("%d/%m/%Y")

    sections = []
    for mp, analysis in analyses.items():
        s = summaries.get(mp, {})
        html_analysis = markdown_to_html(analysis)

        kpi_grid = f"""
        <table style="width:100%;border-collapse:separate;border-spacing:8px;margin:12px 0;">
          <tr>
            <td style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;text-align:center;width:25%;">
              <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;">Spesa</div>
              <div style="font-size:18px;color:#f85149;font-weight:bold;margin-top:4px;">€{s.get('total_spend', 0):.0f}</div>
            </td>
            <td style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;text-align:center;width:25%;">
              <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;">Vendite</div>
              <div style="font-size:18px;color:#3fb950;font-weight:bold;margin-top:4px;">€{s.get('total_sales', 0):.0f}</div>
            </td>
            <td style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;text-align:center;width:25%;">
              <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;">ACoS</div>
              <div style="font-size:18px;color:{'#f85149' if s.get('acos', 0) > 30 else '#3fb950'};font-weight:bold;margin-top:4px;">{s.get('acos', 0):.1f}%</div>
            </td>
            <td style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px;text-align:center;width:25%;">
              <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;">ROAS</div>
              <div style="font-size:18px;color:#58a6ff;font-weight:bold;margin-top:4px;">{s.get('roas', 0):.2f}x</div>
            </td>
          </tr>
        </table>
        """

        sections.append(f"""
        <div style="background:#0d1117;border:1px solid #21262d;border-radius:12px;padding:20px;margin:20px 0;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <div style="background:linear-gradient(135deg,#f0883e,#c6561a);color:white;font-weight:bold;padding:4px 10px;border-radius:6px;font-size:14px;">{mp}</div>
            <span style="color:#8b949e;font-size:12px;">Ultimi {DAYS} giorni</span>
          </div>
          {kpi_grid}
          <div style="margin-top:16px;color:#e6edf3;">
            {html_analysis}
          </div>
        </div>
        """)

    body = f"""
    <html><body style="margin:0;padding:0;background:#06090f;font-family:-apple-system,'Segoe UI',sans-serif;">
      <div style="max-width:700px;margin:0 auto;padding:24px;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="color:#f0883e;font-weight:bold;letter-spacing:3px;font-size:11px;">AMAZON ADS AGENT</div>
          <h1 style="color:#e6edf3;font-size:24px;margin:8px 0;">📊 Report Settimanale</h1>
          <div style="color:#8b949e;font-size:12px;">{today} • Generato da Claude AI</div>
        </div>
        {''.join(sections)}
        <div style="text-align:center;margin-top:32px;padding:16px;color:#484f58;font-size:11px;border-top:1px solid #21262d;">
          🤖 Generato automaticamente da GitHub Actions • Lupo &amp; Felix
        </div>
      </div>
    </body></html>
    """
    return body


def send_email(html_body):
    """Invia email via SMTP."""
    if not all([SMTP_USER, SMTP_PASS, EMAIL_TO]):
        print("⚠️ Configurazione SMTP incompleta, salto invio email")
        return False

    msg = MIMEMultipart("alternative")
    msg["From"] = SMTP_USER
    msg["To"] = EMAIL_TO
    msg["Subject"] = f"📊 Amazon Ads Weekly Report — {datetime.now().strftime('%d/%m/%Y')}"
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, EMAIL_TO.split(","), msg.as_string())
        print(f"✅ Email inviata a {EMAIL_TO}")
        return True
    except Exception as e:
        print(f"❌ Errore invio email: {e}")
        return False


def main():
    print(f"🚀 Weekly Amazon Ads Analysis — {datetime.now()}")
    print(f"   Marketplaces: {MARKETPLACES}")
    print(f"   Giorni: {DAYS}")

    analyses = {}
    summaries = {}

    for mp in MARKETPLACES:
        mp = mp.strip().upper()
        if not mp:
            continue
        print(f"\n{'='*60}\n🌍 MARKETPLACE: {mp}\n{'='*60}")
        try:
            data = fetch_all_data(marketplace=mp, days=DAYS)
            summary = build_summary(data)
            summaries[mp] = summary

            print(f"\n📊 Metriche {mp}: Spend €{summary['total_spend']:.2f} | Sales €{summary['total_sales']:.2f} | ACoS {summary['acos']:.1f}%")

            print(f"🤖 Invio a Claude per analisi...")
            prompt = build_claude_prompt(summary, mp, DAYS)
            analysis = call_claude(prompt)
            analyses[mp] = analysis

            print(f"✅ Analisi {mp} completata ({len(analysis)} caratteri)")

            # Salva anche su file per debug/storico
            out_dir = Path("reports")
            out_dir.mkdir(exist_ok=True)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M")
            (out_dir / f"{mp}_{timestamp}_analysis.md").write_text(analysis, encoding="utf-8")
        except Exception as e:
            print(f"❌ Errore su {mp}: {e}")
            analyses[mp] = f"⚠️ Errore durante l'analisi: {e}"
            summaries[mp] = {}

    if not analyses:
        print("❌ Nessuna analisi prodotta, skip email")
        return

    print(f"\n📧 Costruzione email...")
    html = build_email_html(analyses, summaries)

    # Salva anche email su file
    Path("reports/last_email.html").write_text(html, encoding="utf-8")

    send_email(html)
    print("\n✅ Done!")


if __name__ == "__main__":
    main()
