"""
Campaign Planner — dall'ASIN al blueprint di una campagna NUOVA
================================================================
Dato un ASIN (e i suoi child), costruisce un "seed" da PIU' fonti e chiede a
Claude di progettare una campagna Sponsored Products nuova. L'output e' un file
pronto per apply_changes.py (action type "create_campaign").

FONTI DI KEYWORD (in ordine di affidabilita'):
  1. Storico ads della famiglia (keyword/search term gia' convertiti, anche da
     campagne CHIUSE) -> dal JSON prodotto da amazon_ads_api.py
  2. Amazon Keyword Recommendations API (POST /sp/targets/keywords/recommendations,
     recommendationType KEYWORDS_FOR_ASINS) -> keyword + bid suggeriti per l'ASIN,
     anche se il prodotto non e' mai stato pubblicizzato. Per IT si usa la v4.
  3. Testo del listing (titolo/bullet/descrizione) incollato -> Claude estrae
     seed keyword nella lingua giusta e capisce le negative.
  4. Recensioni incollate (opzionale) -> long-tail e pain point.
NON crea nulla: produce solo la proposta. La creazione avviene dopo la tua
conferma, via apply_changes.py.

Uso tipico (dal workflow, con fetch fresco e recommendations Amazon):
    python campaign_planner.py --marketplace IT --asin B0XXXX \
        --children B0YYYY,B0ZZZZ --skus B0XXXX=SKU-A,B0YYYY=SKU-B \
        --budget 8 --fetch \
        --listing-file listing.txt --reviews-file reviews.txt

Per un prodotto MAI pubblicizzato bastano recommendations + listing:
    python campaign_planner.py --marketplace IT --asin B0NEW --budget 6 \
        --data-file amazon_ads_IT_20260718.json --listing-file listing.txt
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from amazon_ads_api import fetch_all_data, AmazonAdsAPI, CONFIG  # noqa: E402
from apply_changes import validate  # riusa la validazione del blueprint  # noqa: E402

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

# La v5 delle recommendations NON copre IT: per sicurezza sui marketplace del
# seller (IT/FR/DE) usiamo la v4, disponibile ovunque.
KW_REC_VND = "application/vnd.spkeywordsrecommendation.v4+json"


def _num(v):
    try:
        return float(v)
    except Exception:
        m = re.findall(r"-?\d+\.?\d*", str(v or "").replace(",", ""))
        return float(m[0]) if m else 0.0


# ---------------------------------------------------------------- fonte 1: storico
def build_family_seed(data, family_asins):
    """Estrae dallo storico ads il materiale utile per la famiglia di ASIN."""
    family = {str(a).strip().upper() for a in family_asins if a}
    reports = data.get("reports", {})
    prod = reports.get("products", [])
    kwr = reports.get("keywords", [])
    strp = reports.get("searchTerms", [])

    cstate = {str(c.get("campaignId", "")): str(c.get("state", "")).upper() for c in data.get("campaigns", [])}
    agstate = {str(g.get("adGroupId", "")): str(g.get("state", "")).upper() for g in data.get("adGroups", [])}

    def active(cid, agid):
        return cstate.get(str(cid), "ENABLED") == "ENABLED" and agstate.get(str(agid), "ENABLED") == "ENABLED"

    ag_asins, asin_sku, asin_perf = {}, {}, {}
    for r in prod:
        asin = str(r.get("advertisedAsin", "")).strip().upper()
        agid = str(r.get("adGroupId", "")).strip()
        if not asin or not agid:
            continue
        ag_asins.setdefault(agid, set()).add(asin)
        if asin in family and r.get("advertisedSku"):
            asin_sku[asin] = r.get("advertisedSku")
        if asin in family:
            p = asin_perf.setdefault(asin, {"spend": 0.0, "sales": 0.0, "orders": 0.0, "clicks": 0.0})
            p["spend"] += _num(r.get("cost", r.get("spend", 0)))
            p["sales"] += _num(r.get("sales7d", 0))
            p["orders"] += _num(r.get("purchases7d", 0))
            p["clicks"] += _num(r.get("clicks", 0))

    certain = {agid: next(iter(v)) for agid, v in ag_asins.items() if len(v) == 1}

    win_kw = {}
    for r in kwr:
        agid = str(r.get("adGroupId", "")).strip()
        if certain.get(agid) not in family:
            continue
        orders, sales = _num(r.get("purchases7d", 0)), _num(r.get("sales7d", 0))
        if orders <= 0 and sales <= 0:
            continue
        spend = _num(r.get("cost", r.get("spend", 0)))
        kw = str(r.get("keyword", "")).strip()
        if not kw:
            continue
        key = (kw.lower(), r.get("matchType", ""))
        rec = {"keyword": kw, "matchType": r.get("matchType", ""), "orders": orders, "sales": sales,
               "acos": (spend / sales * 100) if sales > 0 else 999, "cpc": _num(r.get("costPerClick", 0)),
               "active": active(r.get("campaignId", ""), agid)}
        if key not in win_kw or rec["orders"] > win_kw[key]["orders"]:
            win_kw[key] = rec

    win_st = {}
    for r in strp:
        agid = str(r.get("adGroupId", "")).strip()
        if certain.get(agid) not in family:
            continue
        orders = _num(r.get("purchases7d", 0))
        if orders <= 0:
            continue
        term = str(r.get("searchTerm", "")).strip()
        kw = str(r.get("keyword", "")).strip()
        if not term or term.lower() == kw.lower():
            continue
        sales, spend = _num(r.get("sales7d", 0)), _num(r.get("cost", r.get("spend", 0)))
        rec = {"searchTerm": term, "orders": orders, "sales": sales,
               "acos": (spend / sales * 100) if sales > 0 else 999, "cpc": _num(r.get("costPerClick", 0))}
        if term.lower() not in win_st or rec["orders"] > win_st[term.lower()]["orders"]:
            win_st[term.lower()] = rec

    waste_st, seen = [], set()
    for r in strp:
        agid = str(r.get("adGroupId", "")).strip()
        if certain.get(agid) not in family:
            continue
        spend, orders = _num(r.get("cost", r.get("spend", 0))), _num(r.get("purchases7d", 0))
        term = str(r.get("searchTerm", "")).strip()
        if spend > 0.8 and orders == 0 and term and term.lower() not in seen:
            seen.add(term.lower())
            waste_st.append({"searchTerm": term, "spend": spend})

    kws = sorted(win_kw.values(), key=lambda x: (-x["orders"], x["acos"]))[:20]
    sts = sorted(win_st.values(), key=lambda x: (-x["orders"], x["acos"]))[:20]
    waste_st.sort(key=lambda x: -x["spend"])
    all_cpc = [k["cpc"] for k in kws if k["cpc"] > 0] + [s["cpc"] for s in sts if s["cpc"] > 0]
    avg_cpc = round(sum(all_cpc) / len(all_cpc), 2) if all_cpc else 0.0

    return {"family_asins": sorted(family), "asin_sku": asin_sku, "asin_perf": asin_perf,
            "winning_keywords": kws, "winning_search_terms": sts,
            "waste_search_terms": waste_st[:15], "avg_cpc": avg_cpc}


# ---------------------------------------------------------------- fonte 2: recommendations Amazon
def fetch_keyword_recommendations(api, asins, max_recs=150, retries=3):
    """POST /sp/targets/keywords/recommendations (KEYWORDS_FOR_ASINS, v4).

    Ritorna lista di dict {keyword, matchType, suggested_bid, bid_range, imp_share}.
    Gestisce il 429 (comune sulla prima chiamata) con backoff.
    """
    url = f"{api.base_url}/sp/targets/keywords/recommendations"
    headers = api._base_headers()
    headers["Content-Type"] = KW_REC_VND
    headers["Accept"] = KW_REC_VND
    # Alcune combinazioni brand richiedono anche l'AdvertiserId oltre allo Scope.
    headers.setdefault("Amazon-Advertising-API-AdvertiserId", str(api.profile_id))
    payload = {
        "asins": [str(a).strip() for a in asins if a],
        "recommendationType": "KEYWORDS_FOR_ASINS",
        "targets": [],
        "maxRecommendations": max_recs,
        "sortDimension": "CONVERSIONS",
    }

    for attempt in range(retries):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=45)
        except Exception as e:
            print(f"   recommendations: errore di rete ({e})", flush=True)
            return []
        if resp.status_code == 429:
            wait = 5 * (attempt + 1)
            print(f"   recommendations: 429 rate limit, retry tra {wait}s...", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code >= 400:
            print(f"   recommendations: HTTP {resp.status_code}: {resp.text[:250]}", flush=True)
            return []
        break
    else:
        return []

    try:
        body = resp.json()
    except Exception:
        return []

    # Il nome della lista cambia leggermente tra versioni: parsing difensivo.
    items = (body.get("keywordTargetList") or body.get("recommendations")
             or body.get("suggestedKeywords") or [])
    out = []
    for it in items:
        kw = it.get("keyword") or it.get("keywordText") or it.get("query")
        if not kw:
            continue
        mt = it.get("matchType", "")
        # bid: puo' stare in bidInfo[].suggestedBid.suggested, o suggestedBid, o bid
        sug = None
        binfo = it.get("bidInfo") or it.get("bidRecommendations") or []
        if binfo and isinstance(binfo, list):
            sb = binfo[0].get("suggestedBid") or {}
            sug = sb.get("suggested") or binfo[0].get("bid")
        if sug is None:
            sb = it.get("suggestedBid")
            sug = sb.get("suggested") if isinstance(sb, dict) else sb
        out.append({
            "keyword": kw,
            "matchType": mt,
            "suggested_bid": round(_num(sug), 2) if sug is not None else None,
            "imp_share": it.get("searchTermImpressionShare"),
        })
    # dedup per keyword
    seen, dedup = set(), []
    for r in out:
        k = r["keyword"].lower().strip()
        if k and k not in seen:
            seen.add(k)
            dedup.append(r)
    return dedup[:max_recs]


# ---------------------------------------------------------------- prompt
def build_planner_prompt(seed, recs, listing_text, reviews_text, marketplace, budget, target_acos, extra_kw, child_note):
    fam = ", ".join(seed["family_asins"])
    sku_map = ", ".join(f"{a}->{s}" for a, s in seed["asin_sku"].items()) or "(nessuno SKU noto dallo storico ads)"

    perf_lines = "\n".join(
        f'- {a}: {p["orders"]:.0f} ordini, EUR {p["sales"]:.2f} vendite, EUR {p["spend"]:.2f} spesi'
        for a, p in seed["asin_perf"].items()) or "(nessuno storico ads per questi ASIN)"

    kw_lines = "\n".join(
        f'- "{k["keyword"]}" [{k["matchType"]}] {k["orders"]:.0f} ordini, ACoS {k["acos"]:.0f}%, CPC {k["cpc"]:.2f} ({"attiva" if k["active"] else "DA CAMPAGNA CHIUSA"})'
        for k in seed["winning_keywords"]) or "(nessuna keyword vincente storica)"

    st_lines = "\n".join(
        f'- "{s["searchTerm"]}" {s["orders"]:.0f} ordini, ACoS {s["acos"]:.0f}%, CPC {s["cpc"]:.2f}'
        for s in seed["winning_search_terms"]) or "(nessun search term vincente storico)"

    waste_lines = "\n".join(
        f'- "{w["searchTerm"]}" EUR {w["spend"]:.2f} spesi, 0 ordini'
        for w in seed["waste_search_terms"]) or "(nessuno)"

    rec_lines = "\n".join(
        f'- "{r["keyword"]}"' + (f' [{r["matchType"]}]' if r["matchType"] else "") +
        (f' bid suggerito EUR {r["suggested_bid"]}' if r["suggested_bid"] else "") +
        (f' (imp.share {r["imp_share"]})' if r.get("imp_share") else "")
        for r in recs[:60]) or "(nessuna recommendation Amazon disponibile)"

    listing_block = f"\n## Testo del listing (titolo/bullet/descrizione)\n{listing_text.strip()[:3500]}" if listing_text.strip() else ""
    reviews_block = f"\n## Estratti di recensioni (per long-tail e pain point)\n{reviews_text.strip()[:2500]}" if reviews_text.strip() else ""
    extra_line = f'\nKEYWORD FORNITE A MANO: {extra_kw}' if extra_kw else ""
    child_line = f'\nNOTA SUI CHILD: {child_note}' if child_note else ""
    avg_cpc = seed["avg_cpc"] or 0.40

    return f"""Sei un architetto di campagne Amazon Sponsored Products, senior, per un
seller EU (marketplace {marketplace}). Devi PROGETTARE una campagna NUOVA per
questa famiglia di prodotti. Combina TUTTE le fonti qui sotto per costruire le
keyword; se lo storico e' vuoto (prodotto mai pubblicizzato) appoggiati alle
recommendations Amazon e al testo del listing.

## Famiglia ASIN
{fam}
Mappa ASIN -> SKU (i product ad da SELLER si creano per SKU): {sku_map}

## [Fonte 1] Performance storica per ASIN (tutte le campagne, anche chiuse)
{perf_lines}

## [Fonte 1] Keyword che hanno GIA' convertito (incluse campagne chiuse)
{kw_lines}

## [Fonte 1] Search term vincenti non ancora keyword (candidati EXACT)
{st_lines}

## [Fonte 1] Search term spreconi (candidati NEGATIVE di partenza)
{waste_lines}

## [Fonte 2] Keyword consigliate da Amazon per questi ASIN (con bid suggerito)
Queste vengono dall'API Amazon anche senza storico: sono il punto di partenza
principale per un prodotto mai pubblicizzato. Filtra le poco pertinenti.
{rec_lines}
{listing_block}{reviews_block}

## Parametri richiesti
- Budget giornaliero indicativo: EUR {budget}/giorno (splittabile tra campagne)
- Target ACoS: {target_acos}%
- CPC medio storico famiglia: EUR {avg_cpc} (base bid; se 0, usa i bid suggeriti Amazon){extra_line}{child_line}

## REGOLE DI STRUTTURA (child ASIN) — IMPORTANTISSIME
- Child che differiscono SOLO per colore -> TUTTI nello stesso ad group (la
  ricerca non distingue il colore; splittare frammenta i dati e ti fa competere
  contro te stesso).
- Child che differiscono per MISURA/capacita' con intento diverso (piccolo vs
  grande, S/M/L) -> ad group SEPARATI per cluster di misura.
- Default consigliato: 1 campagna AUTO (tutti i child, discovery low-bid) + 1
  campagna MANUAL con le keyword migliori. NON una campagna per singolo child a
  meno che sia un vero best-seller.
- Bid: keyword gia' vincenti (Fonte 1) prima; poi le migliori recommendations
  Amazon (Fonte 2) con il loro bid suggerito; long-tail da listing/recensioni in
  PHRASE/BROAD con bid piu' bassi. AUTO con bid conservativi.
- Genera 3-6 negative di partenza da search term sprecati e da termini fuori
  intento evidenti nel listing/recensioni.
- Ogni prodotto DEVE avere lo SKU se presente nella mappa; se manca, mettilo con
  "asin" e segnalalo (da seller potrebbe servire lo SKU).

Rispondi PRIMA con una spiegazione breve (6-12 righe) in italiano: struttura
proposta, come hai raggruppato i child, e da quali fonti arrivano le keyword
principali.

Poi, ALLA FINE, aggiungi UN SOLO blocco <campaign_plan>...</campaign_plan> con
JSON valido nel formato ESATTO di apply_changes.py (nessun testo dentro il
blocco). Piu' campagne = piu' oggetti "create_campaign". Metti "state":
"PAUSED" cosi' le rivedi prima di lanciarle.

<campaign_plan>
{{"actions": [
  {{"type": "create_campaign",
   "campaign": {{"name": "SP-Auto-<fam>", "targetingType": "AUTO", "dailyBudget": 4.0, "biddingStrategy": "LEGACY_FOR_SALES", "state": "PAUSED"}},
   "adGroups": [{{"name": "AG-auto", "defaultBid": {avg_cpc}, "products": [{{"sku": "SKU-A", "asin": "B0XXXX"}}], "autoTargets": [{{"expressionType": "QUERY_HIGH_REL_MATCHES", "bid": {avg_cpc}}}], "negatives": []}}]}},
  {{"type": "create_campaign",
   "campaign": {{"name": "SP-Manual-<fam>-EXACT", "targetingType": "MANUAL", "dailyBudget": 4.0, "biddingStrategy": "LEGACY_FOR_SALES", "state": "PAUSED"}},
   "adGroups": [{{"name": "AG-core", "defaultBid": {avg_cpc}, "products": [{{"sku": "SKU-A", "asin": "B0XXXX"}}], "keywords": [{{"keywordText": "esempio", "matchType": "EXACT", "bid": {avg_cpc}}}], "negatives": []}}]}}
]}}
</campaign_plan>"""


def call_claude(prompt):
    if not ANTHROPIC_API_KEY:
        return "ERRORE: ANTHROPIC_API_KEY non configurata"
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01"},
        json={"model": ANTHROPIC_MODEL, "max_tokens": 4000, "messages": [{"role": "user", "content": prompt}]},
        timeout=120,
    )
    if resp.status_code != 200:
        return f"ERRORE Claude API ({resp.status_code}): {resp.text[:300]}"
    return "\n".join(b.get("text", "") for b in resp.json().get("content", []))


def extract_plan(text, seed):
    warnings = []
    m = re.search(r"<campaign_plan>(.*?)</campaign_plan>", text, re.DOTALL)
    if not m:
        return None, text, ["Nessun blocco <campaign_plan> trovato"]
    clean = (text[:m.start()] + text[m.end():]).strip()
    try:
        plan = json.loads(m.group(1).strip())
    except json.JSONDecodeError as e:
        return None, clean, [f"JSON <campaign_plan> non valido: {e}"]

    sku_map = {a.upper(): s for a, s in seed["asin_sku"].items()}
    for a in plan.get("actions", []):
        for g in a.get("adGroups", []):
            for p in g.get("products", []):
                asin = str(p.get("asin", "")).upper()
                if not p.get("sku") and asin in sku_map:
                    p["sku"] = sku_map[asin]
                if not p.get("sku"):
                    warnings.append(f"prodotto {asin or '?'} senza SKU: da seller aggiungilo prima di applicare")

    errs = validate(plan.get("actions", []))
    warnings.extend(errs)
    return plan, clean, warnings


def _read(path):
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8")
    except Exception as e:
        print(f"   impossibile leggere {path}: {e}", flush=True)
        return ""


def main():
    ap = argparse.ArgumentParser(description="Genera un blueprint di campagna nuova da un ASIN")
    ap.add_argument("--marketplace", required=True)
    ap.add_argument("--asin", required=True, help="ASIN principale (parent o child hero)")
    ap.add_argument("--children", default="")
    ap.add_argument("--skus", default="", help="Mappa ASIN=SKU (es. B0X=SKU-A,B0Y=SKU-B)")
    ap.add_argument("--budget", type=float, default=8.0)
    ap.add_argument("--target-acos", type=float, default=30.0)
    ap.add_argument("--seed-keywords", default="")
    ap.add_argument("--child-note", default="", help="Come differiscono i child (colore/misura)")
    ap.add_argument("--listing-text", default="", help="Testo listing inline")
    ap.add_argument("--listing-file", default="", help="File col testo del listing (titolo/bullet/descrizione)")
    ap.add_argument("--reviews-text", default="", help="Estratti recensioni inline")
    ap.add_argument("--reviews-file", default="", help="File con estratti di recensioni")
    ap.add_argument("--data-file", default="", help="JSON gia' scaricato (consigliato)")
    ap.add_argument("--fetch", action="store_true", help="Scarica dati freschi (richiede secret Ads)")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--no-amazon-recs", action="store_true", help="Salta la Keyword Recommendations API")
    ap.add_argument("--publish-dir", default="", help="Se impostato, scrive un file stabile <dir>/<MP>/<ASIN>.json per la UI")
    args = ap.parse_args()

    # Dati storici
    if args.data_file:
        data = json.loads(Path(args.data_file).read_text(encoding="utf-8"))
    elif args.fetch:
        data = fetch_all_data(marketplace=args.marketplace, days=args.days)
    else:
        sys.exit("Serve --data-file <json> oppure --fetch.")

    family = [args.asin] + [c.strip() for c in args.children.split(",") if c.strip()]
    seed = build_family_seed(data, family)

    for pair in args.skus.split(","):
        if "=" in pair:
            a, s = pair.split("=", 1)
            seed["asin_sku"][a.strip().upper()] = s.strip()

    # Fonte 2: recommendations Amazon (serve auth Ads, indipendente dallo storico)
    recs = []
    if not args.no_amazon_recs:
        try:
            api = AmazonAdsAPI(CONFIG)
            api.authenticate()
            api.select_profile(args.marketplace)
            print("Recupero keyword recommendations Amazon...", flush=True)
            recs = fetch_keyword_recommendations(api, family)
            print(f"   {len(recs)} keyword consigliate da Amazon", flush=True)
        except Exception as e:
            print(f"   recommendations saltate: {e}", flush=True)

    listing_text = args.listing_text or _read(args.listing_file)
    reviews_text = args.reviews_text or _read(args.reviews_file)

    prompt = build_planner_prompt(
        seed, recs, listing_text, reviews_text, args.marketplace, args.budget,
        args.target_acos, args.seed_keywords.strip(), args.child_note.strip(),
    )
    print(f"Invio a Claude ({len(prompt)} caratteri)...", flush=True)
    text = call_claude(prompt)
    plan, clean, warnings = extract_plan(text, seed)

    ts = datetime.now().strftime("%Y%m%d_%H%M")
    out_dir = Path("plans")
    out_dir.mkdir(exist_ok=True)
    (out_dir / f"plan_{args.marketplace}_{args.asin}_{ts}.md").write_text(clean, encoding="utf-8")

    print("\n" + "=" * 60)
    print(clean)
    print("=" * 60)
    if warnings:
        print("\nAVVISI:")
        for w in warnings:
            print("  -", w)

    if plan is not None:
        bp = out_dir / f"blueprint_{args.marketplace}_{args.asin}_{ts}.json"
        bp.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nBlueprint salvato: {bp} ({len(plan.get('actions', []))} campagne proposte)")
        print("Rivedilo, poi incollalo nel workflow 'Apply Amazon Ads Changes' (actions_json).")
    else:
        print("\nNessun blueprint valido generato. Controlla gli avvisi.")

    # File stabile per la UI: <publish-dir>/<MP>/<ASIN>.json con actions + _meta.
    # La UI legge questo file via GitHub Contents API dopo il commit del workflow.
    if args.publish_dir:
        pub = Path(args.publish_dir) / args.marketplace
        pub.mkdir(parents=True, exist_ok=True)
        published = {
            "actions": (plan or {}).get("actions", []),
            "_meta": {
                "generated_at": datetime.now().isoformat(),
                "marketplace": args.marketplace,
                "asin": args.asin,
                "children": [c.strip() for c in args.children.split(",") if c.strip()],
                "explanation": clean,
                "warnings": warnings,
                "recs_count": len(recs),
                "had_history": bool(seed["winning_keywords"] or seed["winning_search_terms"]),
                "status": "ok" if plan is not None else "no_plan",
            },
        }
        pub_file = pub / f"{args.asin}.json"
        pub_file.write_text(json.dumps(published, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Pubblicato per la UI: {pub_file}")


if __name__ == "__main__":
    main()
