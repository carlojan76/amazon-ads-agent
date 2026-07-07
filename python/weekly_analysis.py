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
import threading
import concurrent.futures
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


def build_asin_view(data):
    """Vista per-ASIN con attribuzione CERTA.

    L'ASIN e' certo solo nel report prodotto (spAdvertisedProduct), che lo lega
    all'ad group. Attribuiamo keyword/search-term a un ASIN SOLO quando l'ad group
    di provenienza pubblicizza UN SOLO ASIN (mappatura 1:1). Gli ad group con piu'
    ASIN sono ambigui ed ESCLUSI: nessuna inferenza, solo dati certi.
    """
    import re as _re
    reports = data.get("reports", {})
    prod_report = reports.get("products", [])
    kw_report = reports.get("keywords", [])
    st_report = reports.get("searchTerms", [])

    def num(v):
        try:
            return float(v)
        except Exception:
            m = _re.findall(r"-?\d+\.?\d*", str(v or "").replace(",", ""))
            return float(m[0]) if m else 0.0

    # stato campagne e ad group
    cstate = {}
    for c in data.get("campaigns", []):
        cid = str(c.get("campaignId", ""))
        if cid:
            cstate[cid] = str(c.get("state", "")).upper()
    agstate = {}
    for g in data.get("adGroups", []):
        agid = str(g.get("adGroupId", ""))
        if agid:
            agstate[agid] = str(g.get("state", "")).upper()
    cact = lambda cid: cstate.get(str(cid), "ENABLED") == "ENABLED"
    agact = lambda agid: agstate.get(str(agid), "ENABLED") == "ENABLED"

    # 1) adGroup -> set(ASIN) + aggregati per ASIN dal report prodotto (CERTO)
    ag_asins, asin_sku, asin_agg, asin_active_ags = {}, {}, {}, {}
    for r in prod_report:
        asin = str(r.get("advertisedAsin", "")).strip()
        agid = str(r.get("adGroupId", "")).strip()
        cid = str(r.get("campaignId", "")).strip()
        if not asin or not agid:
            continue
        ag_asins.setdefault(agid, set()).add(asin)
        if r.get("advertisedSku"):
            asin_sku[asin] = r.get("advertisedSku")
        a = asin_agg.setdefault(asin, {"spend": 0.0, "sales": 0.0, "orders": 0.0})
        a["spend"] += num(r.get("cost", r.get("spend", 0)))
        a["sales"] += num(r.get("sales7d", 0))
        a["orders"] += num(r.get("purchases7d", 0))
        if cact(cid) and agact(agid):
            lst = asin_active_ags.setdefault(asin, [])
            if not any(x["adGroupId"] == agid for x in lst):
                lst.append({"campaignId": cid, "adGroupId": agid})

    certain = {agid: next(iter(v)) for agid, v in ag_asins.items() if len(v) == 1}
    ambiguous = sum(1 for v in ag_asins.values() if len(v) > 1)

    # 2) keyword vincenti per ASIN (solo ad group certi)
    win_kw = {}
    for r in kw_report:
        asin = certain.get(str(r.get("adGroupId", "")).strip())
        if not asin:
            continue
        orders, sales = num(r.get("purchases7d", 0)), num(r.get("sales7d", 0))
        if orders <= 0 and sales <= 0:
            continue
        spend = num(r.get("cost", r.get("spend", 0)))
        cid = str(r.get("campaignId", ""))
        win_kw.setdefault(asin, []).append({
            "keyword": r.get("keyword", ""), "matchType": r.get("matchType", ""),
            "orders": orders, "sales": sales,
            "acos": (spend / sales * 100) if sales > 0 else 999,
            "active": cact(cid) and agact(r.get("adGroupId", "")),
        })

    # 3) search term vincenti per ASIN (solo certi, non gia' keyword)
    win_st = {}
    for r in st_report:
        agid = str(r.get("adGroupId", "")).strip()
        asin = certain.get(agid)
        if not asin:
            continue
        orders = num(r.get("purchases7d", 0))
        if orders <= 0:
            continue
        term = str(r.get("searchTerm", "")).strip()
        kw = str(r.get("keyword", "")).strip()
        if term and term.lower() == kw.lower():
            continue
        sales = num(r.get("sales7d", 0))
        spend = num(r.get("cost", r.get("spend", 0)))
        win_st.setdefault(asin, []).append({
            "searchTerm": term, "orders": orders, "sales": sales,
            "acos": (spend / sales * 100) if sales > 0 else 999,
            "cpc": num(r.get("costPerClick", 0)),
        })

    out = []
    for asin, agg in asin_agg.items():
        kws = sorted(win_kw.get(asin, []), key=lambda x: (-x["orders"], x["acos"]))[:8]
        sts = sorted(win_st.get(asin, []), key=lambda x: (-x["orders"], x["acos"]))[:8]
        if not kws and not sts and agg["orders"] == 0:
            continue
        out.append({
            "asin": asin, "sku": asin_sku.get(asin, ""),
            "spend": agg["spend"], "sales": agg["sales"], "orders": agg["orders"],
            "acos": (agg["spend"] / agg["sales"] * 100) if agg["sales"] > 0 else (999 if agg["spend"] > 0 else 0),
            "active_adgroups": asin_active_ags.get(asin, []),
            "winning_keywords": kws, "winning_search_terms": sts,
        })
    out.sort(key=lambda x: x["sales"], reverse=True)
    return {"asins": out[:20], "ambiguous_adgroups": ambiguous}


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
        "asin_view": build_asin_view(data),
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

    asin_view = summary.get("asin_view", {})
    ambn = asin_view.get("ambiguous_adgroups", 0)
    asin_blocks = []
    for a in asin_view.get("asins", []):
        tgt = a["active_adgroups"]
        if tgt:
            tgt_str = f'AD GROUP ATTIVO dove ri-aggiungere -> campId:{tgt[0]["campaignId"]} adGroupId:{tgt[0]["adGroupId"]}'
        else:
            tgt_str = "NESSUN ad group attivo per questo ASIN -> serve riattivazione manuale campagna (NON generare add_keyword)"
        kw_lines = "\n".join(
            f'    - KW "{k["keyword"]}" [{k["matchType"]}] {k["orders"]:.0f} ordini, ACoS {k["acos"]:.0f}% ({"ATTIVA" if k["active"] else "da campagna SPENTA"})'
            for k in a["winning_keywords"]) or "    (nessuna)"
        st_lines = "\n".join(
            f'    - TERMINE "{t["searchTerm"]}" {t["orders"]:.0f} ordini, ACoS {t["acos"]:.0f}%, CPC {t["cpc"]:.2f} (non ancora keyword)'
            for t in a["winning_search_terms"]) or "    (nessuno)"
        asin_blocks.append(
            f'ASIN {a["asin"]} (SKU {a["sku"]}): {a["orders"]:.0f} ordini, {a["sales"]:.2f} sales, ACoS {a["acos"]:.0f}%\n'
            f'  {tgt_str}\n'
            f'  Keyword vincenti:\n{kw_lines}\n'
            f'  Search term vincenti (candidati add_keyword):\n{st_lines}')
    asin_section = "\n\n".join(asin_blocks) or "Nessun dato per-ASIN certo disponibile"

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

##  Vincitori per ASIN (attribuzione CERTA: solo ad group con 1 solo ASIN; {ambn} ad group ambigui esclusi)
Per ogni ASIN: performance su TUTTE le campagne (incluse quelle spente se nella finestra dati), i vincitori storici e l'ad group ATTIVO dove ri-aggiungerli.
{asin_section}

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
- SEARCH TERMS VINCENTI -> NUOVE KEYWORD: dai search term con ordini/vendite che NON sono ancora keyword, proponi azioni `add_keyword` per promuoverli (match EXACT). E' la leva di crescita principale.

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
  * `add_keyword`: campaignId, adGroupId, keywordText, matchType (EXACT|PHRASE|BROAD), bid -> per search terms che HANNO GENERATO ORDINI ma non sono ancora keyword. Usa gli ID reali dell'ad group da cui proviene il search term. bid = CPC medio del search term (o 0.30-0.50 se ignoto). Preferisci match EXACT per i termini gia' vincenti.
- NON generare `pause_campaign` / `enable_campaign` in automatico (troppo rischioso, lascia decidere l'umano).
- RIATTIVAZIONE VINCITORI PER ASIN: per un vincitore (keyword da campagna spenta o search term non ancora keyword) usa `add_keyword` SOLO se l'ASIN ha un AD GROUP ATTIVO indicato sopra; punta a quel campId+adGroupId, match EXACT, bid = CPC del termine (o 0.30-0.50). Se l'ASIN non ha ad group attivo, NON generare add_keyword: segnalalo a parole come "riattivare manualmente una campagna per ASIN X".
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


# Lock per stampare il log di ogni marketplace come blocco contiguo
# (senza righe intrecciate tra i thread paralleli).
_print_lock = threading.Lock()


def process_marketplace(mp, days):
    """Elabora UN marketplace. Pensata per girare in un thread separato:
    scrive solo file con nomi specifici per marketplace (nessuna collisione)
    e non muta stato condiviso. Ritorna un dict con l'esito."""
    mp = (mp or "").strip().upper()
    result = {"mp": mp, "ok": False, "analysis": None, "summary": {}}
    if not mp:
        return result

    log = []
    log.append("\n" + "=" * 60)
    log.append(f" MARKETPLACE: {mp}")
    log.append("=" * 60)
    try:
        data = fetch_all_data(marketplace=mp, days=days)
        summary = build_summary(data)
        result["summary"] = summary

        log.append(
            f" Metriche {mp}: Spend {summary['total_spend']:.2f} | "
            f"Sales {summary['total_sales']:.2f} | ACoS {summary['acos']:.1f}%"
        )
        log.append(" Invio a Claude per analisi...")

        prompt = build_claude_prompt(summary, mp, days)
        analysis = call_claude(prompt)
        log.append(f" Analisi {mp} completata ({len(analysis)} caratteri)")

        actions_dict, clean_analysis, warns = extract_actions(analysis, summary)
        for w in (warns or []):
            log.append(f"    actions: {w}")
        result["analysis"] = clean_analysis

        out_dir = Path("reports")
        timestamp = datetime.now().strftime("%Y%m%d_%H%M")
        (out_dir / f"{mp}_{timestamp}_analysis.md").write_text(clean_analysis, encoding="utf-8")
        if actions_dict is not None:
            n_act = len(actions_dict.get("actions", []))
            actions_path = out_dir / f"actions_{mp}_{timestamp}.json"
            actions_path.write_text(
                json.dumps(actions_dict, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            log.append(f"    Azioni proposte salvate: {actions_path} ({n_act} azioni valide)")

        # Copia "latest" per la UI online (GitHub Pages)
        latest_dir = out_dir / "latest"
        publish_payload = dict(data)
        publish_payload["analysis"] = clean_analysis
        publish_payload["actions"] = actions_dict or {"actions": []}
        publish_payload["generated_at"] = datetime.now().isoformat()
        (latest_dir / f"{mp}.json").write_text(
            json.dumps(publish_payload, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        result["ok"] = True
    except Exception as e:
        log.append(f" Errore su {mp}: {e}")
        result["analysis"] = f" Errore durante l'analisi: {e}"
    finally:
        with _print_lock:
            print("\n".join(log), flush=True)
    return result


def main():
    print(f" Weekly Amazon Ads Analysis  {datetime.now()}")
    print(f"   Marketplaces: {MARKETPLACES}")
    print(f"   Giorni: {DAYS}")

    mps = [mp.strip().upper() for mp in MARKETPLACES if mp and mp.strip()]

    # Crea le cartelle UNA volta sola, prima di lanciare i thread
    # (evita race su mkdir e garantisce che i worker trovino i path pronti).
    Path("reports/latest").mkdir(parents=True, exist_ok=True)

    analyses = {}
    summaries = {}
    published_mps = []

    workers = min(len(mps), int(os.getenv("MAX_PARALLEL_MP", "3"))) or 1
    print(f"\n Elaborazione di {len(mps)} marketplace IN PARALLELO ({workers} worker)...")

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(process_marketplace, mp, DAYS): mp for mp in mps}
        for fut in concurrent.futures.as_completed(futures):
            r = fut.result()
            results[r["mp"]] = r

    # Ricompone gli esiti nell'ordine di input (l'email resta deterministica)
    for mp in mps:
        r = results.get(mp)
        if not r:
            continue
        analyses[mp] = r["analysis"]
        summaries[mp] = r["summary"]
        if r["ok"]:
            published_mps.append(mp)

    if published_mps:
        index = {"marketplaces": published_mps, "generated_at": datetime.now().isoformat()}
        Path("reports/latest/index.json").write_text(
            json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"    Dati pubblicati per la UI online: {', '.join(published_mps)}")

    if not analyses:
        print(" Nessuna analisi prodotta, skip email")
        return

    print("\n Costruzione email...")
    html = build_email_html(analyses, summaries)

    Path("reports").mkdir(exist_ok=True)
    Path("reports/last_email.html").write_text(html, encoding="utf-8")

    send_email(html)
    print("\n Done!")


if __name__ == "__main__":
    main()
