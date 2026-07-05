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
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
EMAIL_TO = os.getenv("EMAIL_TO", "")

# Marketplaces da analizzare (separati da virgola in env: "IT,FR,DE")
MARKETPLACES = os.getenv("MARKETPLACES", "IT,FR,DE").split(",")
DAYS = int(os.getenv("ANALYSIS_DAYS", "14"))


def build_summary(data):
    """Estrai metriche aggregate dal JSON Amazon.

    Le campagne NON attive (PAUSED / ARCHIVED) sono ESCLUSE da tutti i calcoli
    di costo/performance. Le loro keyword che hanno convertito storicamente
    vengono raccolte a parte, in `keyword_ideas`, come semplici suggerimenti
    da valutare per le campagne attive (nessun giudizio di spreco/costo).
    """
    reports = data.get("reports", {})
    campaigns_report = reports.get("campaigns", [])
    keywords_report = reports.get("keywords", [])
    st_report = reports.get("searchTerms", [])

    def num(v):
        try:
            return float(str(v or 0).replace("€", "").replace("$", "").replace(",", ""))
        except Exception:
            return 0.0

    # ---- Mappa campaignId -> stato (ENABLED / PAUSED / ARCHIVED) ----
    # Fonte primaria: lista strutturale delle campagne (campo `state`).
    # Fallback: colonna `campaignStatus` del report performance.
    state_by_id = {}
    for c in data.get("campaigns", []):
        cid = str(c.get("campaignId", ""))
        state = str(c.get("state", "")).upper()
        if cid and state:
            state_by_id[cid] = state
    for r in campaigns_report:
        cid = str(r.get("campaignId", ""))
        status = str(r.get("campaignStatus", "")).upper()
        if cid and status and cid not in state_by_id:
            state_by_id[cid] = status

    def is_active(campaign_id):
        # Stato ignoto -> per prudenza trattata come attiva (non nasconde costi)
        return state_by_id.get(str(campaign_id), "ENABLED") == "ENABLED"

    # ---- Split campagne: attive vs in pausa/archiviate ----
    active_campaigns = [r for r in campaigns_report if is_active(r.get("campaignId"))]
    paused_report = [r for r in campaigns_report if not is_active(r.get("campaignId"))]

    # ---- Aggregati SOLO su campagne attive ----
    total_spend = sum(num(r.get("cost", r.get("spend", 0))) for r in active_campaigns)
    total_sales = sum(num(r.get("sales7d", 0)) for r in active_campaigns)
    total_clicks = sum(num(r.get("clicks", 0)) for r in active_campaigns)
    total_impr = sum(num(r.get("impressions", 0)) for r in active_campaigns)
    total_orders = sum(num(r.get("purchases7d", 0)) for r in active_campaigns)

    acos = (total_spend / total_sales * 100) if total_sales > 0 else 0
    roas = (total_sales / total_spend) if total_spend > 0 else 0

    # Top campagne (solo attive)
    camp_summary = []
    for r in active_campaigns:
        spend = num(r.get("cost", r.get("spend", 0)))
        sales = num(r.get("sales7d", 0))
        c_acos = (spend / sales * 100) if sales > 0 else (999 if spend > 0 else 0)
        camp_summary.append({
            "campaignId": str(r.get("campaignId", "")),
            "name": r.get("campaignName", "N/A"),
            "spend": spend,
            "sales": sales,
            "acos": c_acos,
            "clicks": num(r.get("clicks", 0)),
            "orders": num(r.get("purchases7d", 0)),
        })
    camp_summary.sort(key=lambda x: x["spend"], reverse=True)

    # Campagne in pausa/archiviate che avevano comunque attività (solo contesto)
    paused_summary = []
    for r in paused_report:
        paused_summary.append({
            "campaignId": str(r.get("campaignId", "")),
            "name": r.get("campaignName", "N/A"),
            "state": state_by_id.get(str(r.get("campaignId", "")), "PAUSED"),
            "spend": num(r.get("cost", r.get("spend", 0))),
            "sales": num(r.get("sales7d", 0)),
            "orders": num(r.get("purchases7d", 0)),
        })
    paused_summary.sort(key=lambda x: x["sales"], reverse=True)

    # ---- Keywords: attive (analisi costi) vs in pausa (solo idee) ----
    kw_summary = []   # da campagne attive
    kw_ideas = []     # da campagne in pausa/archiviate -> suggerimenti
    for r in keywords_report:
        spend = num(r.get("cost", r.get("spend", 0)))
        sales = num(r.get("sales7d", 0))
        clicks = num(r.get("clicks", 0))
        orders = num(r.get("purchases7d", 0))
        kw = r.get("keyword", "")
        mt = r.get("matchType", "")

        if not is_active(r.get("campaignId")):
            # Interessa come idea solo se ha convertito / generato vendite
            if orders > 0 or sales > 0:
                k_acos = (spend / sales * 100) if sales > 0 else 999
                kw_ideas.append({
                    "keyword": kw, "matchType": mt,
                    "orders": orders, "sales": sales, "acos": k_acos,
                })
            continue

        if spend == 0:
            continue
        k_acos = (spend / sales * 100) if sales > 0 else 999
        kw_summary.append({
            "keywordId": str(r.get("keywordId", "")),
            "campaignId": str(r.get("campaignId", "")),
            "adGroupId": str(r.get("adGroupId", "")),
            "keyword": kw, "matchType": mt,
            "spend": spend, "sales": sales,
            "clicks": clicks, "orders": orders, "acos": k_acos,
        })
    kw_summary.sort(key=lambda x: x["spend"], reverse=True)

    # Dedup + ranking idee (priorità: più ordini, poi ACoS più basso)
    seen = set()
    kw_ideas_dedup = []
    for k in sorted(kw_ideas, key=lambda x: (-x["orders"], x["acos"])):
        key = (k["keyword"].lower().strip(), k["matchType"])
        if not k["keyword"].strip() or key in seen:
            continue
        seen.add(key)
        kw_ideas_dedup.append(k)

    # ---- Search terms sprechi: SOLO su campagne attive ----
    # (negativizzare in una campagna spenta non ha senso)
    st_waste = []
    for r in st_report:
        if not is_active(r.get("campaignId")):
            continue
        spend = num(r.get("cost", r.get("spend", 0)))
        orders = num(r.get("purchases7d", 0))
        if spend > 0.5 and orders == 0:
            st_waste.append({
                "campaignId": str(r.get("campaignId", "")),
                "adGroupId": str(r.get("adGroupId", "")),
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
        "paused_campaigns": paused_summary[:10],
        "keywords": kw_summary[:30],
        "waste_kw": [k for k in kw_summary if k["orders"] == 0][:15],
        "best_kw": sorted([k for k in kw_summary if k["orders"] > 0 and k["acos"] < 25], key=lambda x: x["acos"])[:10],
        "keyword_ideas": kw_ideas_dedup[:15],
        "waste_st": st_waste[:15],
        "n_active": len(active_campaigns),
        "n_paused": len(paused_report),
    }


def build_claude_prompt(summary, marketplace, days):
    """Costruisci il prompt per Claude basato sulle metriche."""
    camps = "\n".join([
        f"- [id:{c['campaignId']}] {c['name']}: Spend €{c['spend']:.2f}, Sales €{c['sales']:.2f}, ACoS {c['acos']:.1f}%, Orders {c['orders']:.0f}"
        for c in summary["campaigns"]
    ])
    kws = "\n".join([
        f'- [kwId:{k["keywordId"]} campId:{k["campaignId"]}] "{k["keyword"]}" [{k["matchType"]}] €{k["spend"]:.2f} spend, €{k["sales"]:.2f} sales, ACoS {k["acos"]:.1f}%, {k["clicks"]:.0f} clicks, {k["orders"]:.0f} orders'
        for k in summary["keywords"]
    ])
    waste = "\n".join([
        f'- [kwId:{k["keywordId"]}] "{k["keyword"]}" [{k["matchType"]}] €{k["spend"]:.2f} spesi, {k["clicks"]:.0f} clicks, ZERO ordini'
        for k in summary["waste_kw"]
    ])
    best = "\n".join([
        f'- [kwId:{k["keywordId"]}] "{k["keyword"]}" ACoS {k["acos"]:.1f}%, {k["orders"]:.0f} ordini, €{k["sales"]:.2f} sales'
        for k in summary["best_kw"]
    ])
    st_waste = "\n".join([
        f'- [campId:{s["campaignId"]} adGroupId:{s["adGroupId"]}] "{s["searchTerm"]}" (kw: "{s["keyword"]}") €{s["spend"]:.2f}, {s["clicks"]:.0f} clicks — ZERO ordini'
        for s in summary["waste_st"]
    ])
    paused = "\n".join([
        f'- [id:{p["campaignId"]}] {p["name"]} [{p["state"]}] — €{p["spend"]:.2f} spesi, €{p["sales"]:.2f} sales, {p["orders"]:.0f} ordini (ESCLUSA dai costi)'
        for p in summary.get("paused_campaigns", [])
    ])
    ideas = "\n".join([
        f'- "{k["keyword"]}" [{k["matchType"]}] — storico: {k["orders"]:.0f} ordini, €{k["sales"]:.2f} sales, ACoS {k["acos"]:.1f}%'
        for k in summary.get("keyword_ideas", [])
    ])

    return f"""## Marketplace: {marketplace} | Periodo: ultimi {days} giorni
## Campagne: {summary.get('n_active', 0)} attive analizzate · {summary.get('n_paused', 0)} in pausa/archiviate ESCLUSE dai costi

## Metriche Generali (SOLO campagne attive)
- Spesa: €{summary['total_spend']:.2f}
- Vendite: €{summary['total_sales']:.2f}
- ACoS: {summary['acos']:.1f}%
- ROAS: {summary['roas']:.2f}x
- Impression: {summary['total_impr']:,.0f}
- Click: {summary['total_clicks']:,.0f}
- Ordini: {summary['total_orders']:.0f}

## Top 15 Campagne ATTIVE per Spesa
{camps or "Nessun dato"}

## Top 30 Keywords per Spesa (campagne attive)
{kws or "Nessun dato"}

## Keywords Spreconi (spesa > 0, ZERO ordini) — campagne attive
{waste or "Nessuno"}

## Best Performer (ACoS < 25%) — campagne attive
{best or "Nessuno"}

## Search Terms Spreconi (spesa > €0.5, ZERO ordini) — DA NEGATIVIZZARE (solo campagne attive)
{st_waste or "Nessuno"}

## Campagne IN PAUSA / ARCHIVIATE (NON conteggiate nei costi qui sopra)
{paused or "Nessuna"}

## Keyword-Idee da Campagne in Pausa (SOLO suggerimenti — NON sono sprechi)
Keyword che in passato hanno convertito in campagne ora spente. Sono candidate da aggiungere/testare nelle campagne ATTIVE. Non valutarle come costo né come spreco.
{ideas or "Nessuna"}

---

Sei un consulente PPC Amazon senior. Analizza questi dati e fornisci un REPORT SETTIMANALE con consigli OPERATIVI in italiano.

REGOLE:
- I costi, ACoS, ROAS e le metriche riguardano SOLO le campagne attive. Le campagne in pausa/archiviate NON vanno criticate per la spesa: sono già spente.
- Le "Keyword-Idee da Campagne in Pausa" vanno usate SOLO come suggerimenti da recuperare nelle campagne attive, mai come sprechi da tagliare.

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
Keywords ATTIVE con ottimo ACoS dove aumentare bid o budget, PIÙ eventuali keyword-idee recuperate dalle campagne in pausa da testare nelle attive.

# 💡 Quick Wins
Altre 3-5 ottimizzazioni rapide ad alto impatto.

Sii diretto, specifico, NIENTE teoria generica.

---

# 🤖 AZIONI ESEGUIBILI (formato JSON)

Alla FINE del report, aggiungi UN SOLO blocco `<actions>...</actions>` con un JSON pronto per lo script `apply_changes.py`. Regole:

- Usa SOLO ID reali visibili nei dati sopra (kwId, campId, adGroupId). NON inventare ID. Se un ID manca o è vuoto, NON generare quell'azione.
- Ogni azione va giustificata da un dato concreto visto sopra.
- Massimo 15 azioni totali, prioritizzando ROI e sicurezza.
- Tipi di azione ammessi:
  * `update_bid`: keywordId, keyword, old_bid, new_bid  — variazione max ±30% del bid attuale se noto, o partire da CPC medio della keyword
  * `pause_keyword`: keywordId, keyword — solo se spesa > €3 e ZERO ordini in 14gg
  * `add_negative`: campaignId, adGroupId (opzionale), keywordText, matchType (NEGATIVE_EXACT o NEGATIVE_PHRASE) — per search terms sprechi
  * `update_budget`: campaignId, campaign, old_budget (se noto), new_budget — variazione max ±50%
- NON generare `pause_campaign` / `enable_campaign` in automatico (troppo rischioso, lascia decidere l'umano).
- Se non ci sono azioni ragionevoli, restituisci `{{"actions": []}}`.

Formato ESATTO (nessun testo dentro il blocco, solo JSON valido):

<actions>
{{"actions": [
  {{"type": "add_negative", "campaignId": "123456", "adGroupId": "789", "keywordText": "gratis", "matchType": "NEGATIVE_PHRASE"}},
  {{"type": "pause_keyword", "keywordId": "555", "keyword": "esempio kw sprecona"}},
  {{"type": "update_bid", "keywordId": "666", "keyword": "esempio kw performante", "old_bid": 0.45, "new_bid": 0.55}}
]}}
</actions>"""


def call_claude(prompt):
    """Chiama Claude API."""
    if not ANTHROPIC_API_KEY:
        return "⚠️ ANTHROPIC_API_KEY non configurata"

    print(f"   📤 Invio prompt a Claude ({len(prompt)} caratteri)...", flush=True)
    try:
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
            timeout=120,
        )
    except requests.exceptions.Timeout:
        return "⚠️ Timeout chiamata Claude (>120s)"
    except Exception as e:
        return f"⚠️ Errore connessione Claude: {e}"

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
            <span style="color:#8b949e;font-size:12px;">Ultimi {DAYS} giorni · {s.get('n_active', 0)} campagne attive · {s.get('n_paused', 0)} in pausa escluse</span>
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


import re


def extract_actions(analysis_text, summary):
    """Estrae il blocco <actions>...</actions> dall'output di Claude,
    valida ogni azione contro gli ID reali del summary e restituisce
    (actions_json_dict, clean_text_without_block, warnings_list).

    Un'azione viene SCARTATA se:
    - manca un ID obbligatorio
    - l'ID non esiste tra quelli reali del summary (protezione anti-invenzione)
    - il tipo non è supportato dallo script apply_changes.py
    """
    warnings = []
    match = re.search(r"<actions>(.*?)</actions>", analysis_text, re.DOTALL)
    if not match:
        return None, analysis_text, ["Nessun blocco <actions> trovato nell'output Claude"]

    raw = match.group(1).strip()
    clean_text = (analysis_text[:match.start()] + analysis_text[match.end():]).strip()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, clean_text, [f"JSON <actions> non valido: {e}"]

    proposed = parsed.get("actions", [])
    if not isinstance(proposed, list):
        return None, clean_text, ["Campo 'actions' non è una lista"]

    # ID reali dal summary per validare
    valid_kw_ids = {k["keywordId"] for k in summary.get("keywords", []) if k.get("keywordId")}
    valid_kw_ids |= {k["keywordId"] for k in summary.get("waste_kw", []) if k.get("keywordId")}
    valid_kw_ids |= {k["keywordId"] for k in summary.get("best_kw", []) if k.get("keywordId")}
    valid_camp_ids = {c["campaignId"] for c in summary.get("campaigns", []) if c.get("campaignId")}
    valid_camp_ids |= {c["campaignId"] for c in summary.get("paused_campaigns", []) if c.get("campaignId")}
    valid_camp_ids |= {s["campaignId"] for s in summary.get("waste_st", []) if s.get("campaignId")}

    ALLOWED_TYPES = {"update_bid", "pause_keyword", "enable_keyword",
                     "add_negative", "update_budget"}

    validated = []
    for i, a in enumerate(proposed):
        t = a.get("type")
        if t not in ALLOWED_TYPES:
            warnings.append(f"azione {i}: tipo '{t}' non ammesso, scartata")
            continue

        if t in ("update_bid", "pause_keyword", "enable_keyword"):
            kwid = str(a.get("keywordId", ""))
            if not kwid:
                warnings.append(f"azione {i} ({t}): keywordId mancante, scartata")
                continue
            if kwid not in valid_kw_ids:
                warnings.append(f"azione {i} ({t}): keywordId {kwid} non presente nei dati, scartata (anti-hallucination)")
                continue

        if t in ("add_negative", "update_budget"):
            cid = str(a.get("campaignId", ""))
            if not cid:
                warnings.append(f"azione {i} ({t}): campaignId mancante, scartata")
                continue
            if cid not in valid_camp_ids:
                warnings.append(f"azione {i} ({t}): campaignId {cid} non presente nei dati, scartata (anti-hallucination)")
                continue

        if t == "add_negative":
            if not a.get("keywordText"):
                warnings.append(f"azione {i}: keywordText mancante, scartata")
                continue
            mt = a.get("matchType", "NEGATIVE_EXACT")
            if mt not in ("NEGATIVE_EXACT", "NEGATIVE_PHRASE"):
                warnings.append(f"azione {i}: matchType '{mt}' non valido, scartata")
                continue

        if t == "update_bid" and not isinstance(a.get("new_bid"), (int, float)):
            warnings.append(f"azione {i}: new_bid mancante o non numerico, scartata")
            continue

        if t == "update_budget" and not isinstance(a.get("new_budget"), (int, float)):
            warnings.append(f"azione {i}: new_budget mancante o non numerico, scartata")
            continue

        validated.append(a)

    return {"actions": validated}, clean_text, warnings


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

            # Estrai il blocco <actions> JSON e valida gli ID contro i dati reali
            actions_dict, clean_analysis, warns = extract_actions(analysis, summary)
            if warns:
                for w in warns:
                    print(f"   ⚠️ actions: {w}")

            # Sostituisci l'analisi con la versione senza blocco JSON, per l'email
            analyses[mp] = clean_analysis

            # Salva anche su file per debug/storico
            out_dir = Path("reports")
            out_dir.mkdir(exist_ok=True)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M")
            (out_dir / f"{mp}_{timestamp}_analysis.md").write_text(clean_analysis, encoding="utf-8")
            if actions_dict is not None:
                n_act = len(actions_dict.get("actions", []))
                actions_path = out_dir / f"actions_{mp}_{timestamp}.json"
                actions_path.write_text(json.dumps(actions_dict, indent=2, ensure_ascii=False), encoding="utf-8")
                print(f"   💾 Azioni proposte salvate: {actions_path} ({n_act} azioni valide)")
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
    Path("reports").mkdir(exist_ok=True)
    Path("reports/last_email.html").write_text(html, encoding="utf-8")

    send_email(html)
    print("\n✅ Done!")


if __name__ == "__main__":
    main()
