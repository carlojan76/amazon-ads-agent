#!/usr/bin/env python3
"""
Apply Changes — modifica E CREA campagne Amazon Ads PREVIA CONFERMA
===================================================================
Legge un file actions.json con le modifiche/creazioni proposte, mostra
un'anteprima (dry-run), chiede conferma esplicita e solo allora le applica
via API.

Uso:
    python apply_changes.py actions.json --marketplace IT            # anteprima + conferma interattiva
    python apply_changes.py actions.json --marketplace IT --dry-run  # SOLO anteprima, non chiede nulla
    python apply_changes.py actions.json --marketplace IT --yes      # applica senza prompt (per script)

--------------------------------------------------------------------
FORMATO actions.json — due famiglie di azioni:
--------------------------------------------------------------------

1) OTTIMIZZAZIONE campagne esistenti (invariato):
{
  "actions": [
    {"type": "update_bid",     "keywordId": "123", "keyword": "amaca gatto", "old_bid": 0.45, "new_bid": 0.60},
    {"type": "pause_keyword",  "keywordId": "456", "keyword": "letto cane"},
    {"type": "enable_keyword", "keywordId": "789", "keyword": "cuccia squalo"},
    {"type": "add_keyword",    "campaignId": "111", "adGroupId": "222", "keywordText": "amaca gatto", "matchType": "EXACT", "bid": 0.5},
    {"type": "add_negative",   "campaignId": "111", "adGroupId": "222", "keywordText": "gratis", "matchType": "NEGATIVE_PHRASE"},
    {"type": "update_budget",  "campaignId": "111", "campaign": "SP-sdraietta", "old_budget": 10, "new_budget": 15},
    {"type": "pause_campaign", "campaignId": "333", "campaign": "SP-vecchia"},
    {"type": "enable_campaign","campaignId": "444", "campaign": "SP-riattiva"}
  ]
}

2) CREAZIONE campagna nuova (blueprint annidato):
{
  "actions": [
    {
      "type": "create_campaign",
      "campaign": {
        "name": "SP-Manual-AmacaGatto-EXACT",
        "targetingType": "MANUAL",            # MANUAL | AUTO
        "dailyBudget": 8.0,
        "biddingStrategy": "LEGACY_FOR_SALES", # LEGACY_FOR_SALES | AUTO_FOR_SALES | MANUAL
        "state": "ENABLED",                    # ENABLED | PAUSED  (consiglio: PAUSED per rivedere)
        "startDate": "2026-07-19"              # opzionale, default = oggi
      },
      "adGroups": [
        {
          "name": "AG-AmacaGatto-core",
          "defaultBid": 0.45,
          "products": [
            {"sku": "AMACA-GRIGIO-01", "asin": "B0XXXXXX1"},
            {"sku": "AMACA-BEIGE-01",  "asin": "B0XXXXXX2"}
          ],
          "keywords": [                        # solo per MANUAL
            {"keywordText": "amaca gatto",     "matchType": "EXACT",  "bid": 0.55},
            {"keywordText": "amaca per gatti", "matchType": "PHRASE", "bid": 0.45}
          ],
          "negatives": [
            {"keywordText": "cane", "matchType": "NEGATIVE_PHRASE"}
          ],
          "autoTargets": [                     # solo per AUTO (bid per gruppo, opzionale)
            {"expressionType": "QUERY_HIGH_REL_MATCHES",   "bid": 0.40},
            {"expressionType": "ASIN_SUBSTITUTE_RELATED",  "bid": 0.50}
          ]
        }
      ]
    }
  ]
}

Note:
- matchType negative: NEGATIVE_EXACT o NEGATIVE_PHRASE
- adGroupId nelle negative: omettilo per negativa a livello campagna
- i campi "keyword"/"campaign"/"old_*" sono solo descrittivi per l'anteprima
- I product ad da SELLER richiedono lo SKU (l'ASIN e' solo per i vendor):
  se metti solo "asin" lo script prova comunque, ma potrebbe fallire.
"""
import argparse
import json
import sys
from datetime import datetime

import requests

from amazon_ads_api import AmazonAdsAPI, CONFIG

VND = {
    "keyword": "application/vnd.spKeyword.v3+json",
    "negative": "application/vnd.spNegativeKeyword.v3+json",
    "campaign": "application/vnd.spCampaign.v3+json",
    "adGroup": "application/vnd.spAdGroup.v3+json",
    "productAd": "application/vnd.spProductAd.v3+json",
    "target": "application/vnd.spTargetingClause.v3+json",
}

VALID_TYPES = {
    "update_bid", "pause_keyword", "enable_keyword", "add_keyword",
    "add_negative", "update_budget", "pause_campaign", "enable_campaign",
    "create_campaign",
}

AUTO_EXPRESSION_TYPES = {
    "QUERY_HIGH_REL_MATCHES", "QUERY_BROAD_REL_MATCHES",
    "ASIN_SUBSTITUTE_RELATED", "ASIN_ACCESSORY_RELATED",
}


# ---------------------------------------------------------------- helpers
def _put(api, path, payload, vnd):
    headers = api._base_headers()
    headers["Content-Type"] = vnd
    headers["Accept"] = vnd
    return requests.put(f"{api.base_url}{path}", headers=headers, json=payload)


def _post(api, path, payload, vnd):
    headers = api._base_headers()
    headers["Content-Type"] = vnd
    headers["Accept"] = vnd
    return requests.post(f"{api.base_url}{path}", headers=headers, json=payload)


def _result_summary(resp, key):
    """Estrae ok/errori dalla risposta multi-status v3."""
    try:
        body = resp.json()
    except Exception:
        return resp.status_code < 300, resp.text[:300]
    ok = body.get(key, {}).get("success", [])
    ko_all = body.get(key, {}).get("error", [])

    def _is_dup(e):
        return "duplicate" in str(e).lower()

    dup = [e for e in ko_all if _is_dup(e)]
    ko = [e for e in ko_all if not _is_dup(e)]
    parts = [f"{len(ok)} ok"]
    if dup:
        parts.append(f"{len(dup)} gia' presenti (skip)")
    if ko:
        msgs = "; ".join(str(e.get("errors", e))[:150] for e in ko)
        parts.append(f"{len(ko)} errori: {msgs}")
        return False, ", ".join(parts)
    return True, ", ".join(parts)


def _extract_ids(resp, key, id_field):
    """Ritorna (ok, id_by_index, detail).

    Per i create v3, la risposta ha forma:
      {key: {"success": [{"index": 0, id_field: "..."}], "error": [...]}}
    Ritorna un dict {index -> id_creato} per poter concatenare le chiamate.
    """
    try:
        body = resp.json()
    except Exception:
        return resp.status_code < 300, {}, resp.text[:300]
    succ = body.get(key, {}).get("success", [])
    errs = body.get(key, {}).get("error", [])
    id_by_index = {}
    for s in succ:
        idx = s.get("index")
        val = s.get(id_field) or (s.get(id_field.rstrip("Id") + "Id"))
        if idx is not None and val:
            id_by_index[idx] = str(val)
    if errs:
        msgs = "; ".join(str(e.get("errors", e))[:200] for e in errs)
        return (len(succ) > 0), id_by_index, f"{len(succ)} ok, {len(errs)} errori: {msgs}"
    return True, id_by_index, f"{len(succ)} ok"


# ---------------------------------------------------------------- preview
def describe(a):
    t = a["type"]
    if t == "update_bid":
        return f"BID     '{a.get('keyword', a['keywordId'])}': EUR {a.get('old_bid', '?')} -> EUR {a['new_bid']}"
    if t == "pause_keyword":
        return f"PAUSA   keyword '{a.get('keyword', a['keywordId'])}'"
    if t == "enable_keyword":
        return f"RIATTIVA keyword '{a.get('keyword', a['keywordId'])}'"
    if t == "add_keyword":
        return ("AGGIUNGI keyword '" + str(a.get("keywordText")) + "' [" + str(a.get("matchType", "EXACT")) +
                "] bid " + str(a.get("bid", "?")) + " (adGroup " + str(a.get("adGroupId")) + ")")
    if t == "add_negative":
        lvl = "ad group" if a.get("adGroupId") else "campagna"
        return f"NEGATIVA '{a['keywordText']}' [{a.get('matchType', 'NEGATIVE_EXACT')}] a livello {lvl} (camp {a.get('campaign', a['campaignId'])})"
    if t == "update_budget":
        return f"BUDGET  '{a.get('campaign', a['campaignId'])}': EUR {a.get('old_budget', '?')} -> EUR {a['new_budget']}/giorno"
    if t == "pause_campaign":
        return f"PAUSA   campagna '{a.get('campaign', a['campaignId'])}'"
    if t == "enable_campaign":
        return f"RIATTIVA campagna '{a.get('campaign', a['campaignId'])}'"
    if t == "create_campaign":
        return describe_create(a)
    return f"? {t}"


def describe_create(a):
    c = a.get("campaign", {})
    lines = []
    st = c.get("state", "ENABLED")
    warn = "  <-- ATTENZIONE: partira' SUBITO (spesa reale)" if st == "ENABLED" else ""
    lines.append(
        f"CREA CAMPAGNA '{c.get('name', '?')}' [{c.get('targetingType', 'MANUAL')}] "
        f"budget EUR {c.get('dailyBudget', '?')}/giorno, stato {st}{warn}"
    )
    for g in a.get("adGroups", []):
        prods = ", ".join(p.get("sku") or p.get("asin") or "?" for p in g.get("products", []))
        lines.append(f"   ad group '{g.get('name', '?')}' (bid base EUR {g.get('defaultBid', '?')})")
        lines.append(f"      prodotti: {prods or '(nessuno!)'}")
        kws = g.get("keywords", [])
        if kws:
            kw_str = ", ".join(f"{k.get('keywordText')} [{k.get('matchType', 'EXACT')}] EUR {k.get('bid', '?')}" for k in kws[:12])
            lines.append(f"      keyword ({len(kws)}): {kw_str}")
        negs = g.get("negatives", [])
        if negs:
            lines.append(f"      negative ({len(negs)}): " + ", ".join(f"{n.get('keywordText')} [{n.get('matchType', 'NEGATIVE_EXACT')}]" for n in negs))
        ats = g.get("autoTargets", [])
        if ats:
            lines.append(f"      auto targets: " + ", ".join(f"{x.get('expressionType')} EUR {x.get('bid', 'default')}" for x in ats))
    return "\n  ".join(lines)


# ---------------------------------------------------------------- validation
def _validate_create(a, i, errors):
    c = a.get("campaign")
    if not isinstance(c, dict):
        errors.append(f"azione {i} (create_campaign): manca l'oggetto 'campaign'")
        return
    if not c.get("name"):
        errors.append(f"azione {i} (create_campaign): manca campaign.name")
    tt = c.get("targetingType", "MANUAL")
    if tt not in ("MANUAL", "AUTO"):
        errors.append(f"azione {i}: targetingType '{tt}' non valido (MANUAL|AUTO)")
    if not isinstance(c.get("dailyBudget"), (int, float)) or c.get("dailyBudget", 0) <= 0:
        errors.append(f"azione {i}: dailyBudget mancante o <= 0")
    bs = c.get("biddingStrategy", "LEGACY_FOR_SALES")
    if bs not in ("LEGACY_FOR_SALES", "AUTO_FOR_SALES", "MANUAL"):
        errors.append(f"azione {i}: biddingStrategy '{bs}' non valida")
    if c.get("state", "ENABLED") not in ("ENABLED", "PAUSED"):
        errors.append(f"azione {i}: state '{c.get('state')}' non valido (ENABLED|PAUSED)")

    ags = a.get("adGroups", [])
    if not isinstance(ags, list) or not ags:
        errors.append(f"azione {i} (create_campaign): serve almeno un ad group")
        return
    for j, g in enumerate(ags):
        if not g.get("name"):
            errors.append(f"azione {i}.adGroup{j}: manca name")
        if not isinstance(g.get("defaultBid"), (int, float)):
            errors.append(f"azione {i}.adGroup{j}: defaultBid mancante o non numerico")
        prods = g.get("products", [])
        if not prods:
            errors.append(f"azione {i}.adGroup{j}: nessun prodotto (serve sku o asin)")
        for p in prods:
            if not (p.get("sku") or p.get("asin")):
                errors.append(f"azione {i}.adGroup{j}: un prodotto non ha ne' sku ne' asin")
        for k in g.get("keywords", []):
            if not k.get("keywordText"):
                errors.append(f"azione {i}.adGroup{j}: keyword senza keywordText")
            if k.get("matchType", "EXACT") not in ("EXACT", "PHRASE", "BROAD"):
                errors.append(f"azione {i}.adGroup{j}: matchType keyword non valido")
            if not isinstance(k.get("bid"), (int, float)):
                errors.append(f"azione {i}.adGroup{j}: keyword '{k.get('keywordText')}' senza bid numerico")
        for n in g.get("negatives", []):
            if n.get("matchType", "NEGATIVE_EXACT") not in ("NEGATIVE_EXACT", "NEGATIVE_PHRASE"):
                errors.append(f"azione {i}.adGroup{j}: matchType negativa non valido")
        for x in g.get("autoTargets", []):
            if x.get("expressionType") not in AUTO_EXPRESSION_TYPES:
                errors.append(f"azione {i}.adGroup{j}: expressionType '{x.get('expressionType')}' non valido")
        if tt == "MANUAL" and not g.get("keywords"):
            errors.append(f"azione {i}.adGroup{j}: campagna MANUAL senza keyword nell'ad group")


def validate(actions):
    errors = []
    for i, a in enumerate(actions):
        t = a.get("type")
        if t not in VALID_TYPES:
            errors.append(f"azione {i}: type '{t}' sconosciuto")
            continue
        if t in ("update_bid", "pause_keyword", "enable_keyword") and not a.get("keywordId"):
            errors.append(f"azione {i} ({t}): manca keywordId")
        if t == "update_bid" and not isinstance(a.get("new_bid"), (int, float)):
            errors.append(f"azione {i}: new_bid mancante o non numerico")
        if t == "add_negative":
            if not a.get("campaignId"):
                errors.append(f"azione {i}: manca campaignId")
            if not a.get("keywordText"):
                errors.append(f"azione {i}: manca keywordText")
            mt = a.get("matchType", "NEGATIVE_EXACT")
            if mt not in ("NEGATIVE_EXACT", "NEGATIVE_PHRASE"):
                errors.append(f"azione {i}: matchType '{mt}' non valido (NEGATIVE_EXACT|NEGATIVE_PHRASE)")
        if t == "add_keyword":
            if not a.get("adGroupId"):
                errors.append(f"azione {i} (add_keyword): manca adGroupId")
            if not a.get("campaignId"):
                errors.append(f"azione {i} (add_keyword): manca campaignId")
            if not a.get("keywordText"):
                errors.append(f"azione {i} (add_keyword): manca keywordText")
            if a.get("matchType", "EXACT") not in ("EXACT", "PHRASE", "BROAD"):
                errors.append(f"azione {i}: matchType non valido (EXACT|PHRASE|BROAD)")
            if not isinstance(a.get("bid"), (int, float)):
                errors.append(f"azione {i} (add_keyword): bid mancante o non numerico")
        if t in ("update_budget", "pause_campaign", "enable_campaign") and not a.get("campaignId"):
            errors.append(f"azione {i} ({t}): manca campaignId")
        if t == "update_budget" and not isinstance(a.get("new_budget"), (int, float)):
            errors.append(f"azione {i}: new_budget mancante o non numerico")
        if t == "create_campaign":
            _validate_create(a, i, errors)
    return errors


# ---------------------------------------------------------------- apply: edit
def apply_edit_actions(api, actions):
    """Applica le azioni di ottimizzazione (non-create). Ritorna lista (nome, ok, dettaglio)."""
    results = []

    kw_updates = []
    for a in actions:
        if a["type"] == "update_bid":
            kw_updates.append({"keywordId": a["keywordId"], "bid": float(a["new_bid"])})
        elif a["type"] == "pause_keyword":
            kw_updates.append({"keywordId": a["keywordId"], "state": "PAUSED"})
        elif a["type"] == "enable_keyword":
            kw_updates.append({"keywordId": a["keywordId"], "state": "ENABLED"})
    if kw_updates:
        resp = _put(api, "/sp/keywords", {"keywords": kw_updates}, VND["keyword"])
        ok, detail = _result_summary(resp, "keywords")
        results.append((f"PUT /sp/keywords ({len(kw_updates)} modifiche)", ok, detail))

    negatives = []
    for a in actions:
        if a["type"] == "add_negative":
            item = {
                "campaignId": a["campaignId"],
                "keywordText": a["keywordText"],
                "matchType": a.get("matchType", "NEGATIVE_EXACT"),
                "state": "ENABLED",
            }
            if a.get("adGroupId"):
                item["adGroupId"] = a["adGroupId"]
            negatives.append(item)
    if negatives:
        resp = _post(api, "/sp/negativeKeywords", {"negativeKeywords": negatives}, VND["negative"])
        ok, detail = _result_summary(resp, "negativeKeywords")
        results.append((f"POST /sp/negativeKeywords ({len(negatives)} negative)", ok, detail))

    new_keywords = []
    for a in actions:
        if a["type"] == "add_keyword":
            new_keywords.append({
                "campaignId": a["campaignId"],
                "adGroupId": a["adGroupId"],
                "keywordText": a["keywordText"],
                "matchType": a.get("matchType", "EXACT"),
                "state": "ENABLED",
                "bid": float(a["bid"]),
            })
    if new_keywords:
        resp = _post(api, "/sp/keywords", {"keywords": new_keywords}, VND["keyword"])
        ok, detail = _result_summary(resp, "keywords")
        results.append((f"POST /sp/keywords ({len(new_keywords)} nuove keyword)", ok, detail))

    camp_updates = {}
    for a in actions:
        if a["type"] == "update_budget":
            camp_updates.setdefault(a["campaignId"], {"campaignId": a["campaignId"]})[
                "budget"] = {"budget": float(a["new_budget"]), "budgetType": "DAILY"}
        elif a["type"] == "pause_campaign":
            camp_updates.setdefault(a["campaignId"], {"campaignId": a["campaignId"]})["state"] = "PAUSED"
        elif a["type"] == "enable_campaign":
            camp_updates.setdefault(a["campaignId"], {"campaignId": a["campaignId"]})["state"] = "ENABLED"
    if camp_updates:
        payload = {"campaigns": list(camp_updates.values())}
        resp = _put(api, "/sp/campaigns", payload, VND["campaign"])
        ok, detail = _result_summary(resp, "campaigns")
        results.append((f"PUT /sp/campaigns ({len(camp_updates)} campagne)", ok, detail))

    return results


# ---------------------------------------------------------------- apply: create
def create_campaign_blueprint(api, action):
    """Crea una campagna completa (cascata v3). Ritorna (results, created_ids).

    Ordine: campaign -> ad group -> [product ads, keyword/auto target, negative].
    Ogni step legge gli ID generati dallo step precedente. Se un ad group
    fallisce, gli step figli di QUEL solo ad group vengono saltati.
    """
    results = []
    created = {"campaignId": None, "adGroups": []}
    c = action["campaign"]

    start = c.get("startDate") or datetime.now().strftime("%Y-%m-%d")
    camp_payload = {"campaigns": [{
        "name": c["name"],
        "targetingType": c.get("targetingType", "MANUAL"),
        "state": c.get("state", "ENABLED"),
        "dynamicBidding": {"strategy": c.get("biddingStrategy", "LEGACY_FOR_SALES")},
        "startDate": start,
        "budget": {"budget": float(c["dailyBudget"]), "budgetType": "DAILY"},
    }]}
    resp = _post(api, "/sp/campaigns", camp_payload, VND["campaign"])
    ok, ids, detail = _extract_ids(resp, "campaigns", "campaignId")
    results.append((f"POST /sp/campaigns ('{c['name']}')", ok, detail))
    if not ok or 0 not in ids:
        results.append(("--> STOP: campagna non creata, salto ad group/keyword", False, "campaignId mancante"))
        return results, created
    cid = ids[0]
    created["campaignId"] = cid

    for g in action.get("adGroups", []):
        ag_payload = {"adGroups": [{
            "name": g["name"],
            "campaignId": cid,
            "state": "ENABLED",
            "defaultBid": float(g["defaultBid"]),
        }]}
        resp = _post(api, "/sp/adGroups", ag_payload, VND["adGroup"])
        ok, ids, detail = _extract_ids(resp, "adGroups", "adGroupId")
        results.append((f"POST /sp/adGroups ('{g['name']}')", ok, detail))
        if not ok or 0 not in ids:
            results.append((f"--> salto figli dell'ad group '{g['name']}'", False, "adGroupId mancante"))
            continue
        agid = ids[0]
        created["adGroups"].append({"name": g["name"], "adGroupId": agid})

        # Product ads (SELLER = sku; fallback asin)
        pads = []
        for p in g.get("products", []):
            item = {"campaignId": cid, "adGroupId": agid, "state": "ENABLED"}
            if p.get("sku"):
                item["sku"] = p["sku"]
            elif p.get("asin"):
                item["asin"] = p["asin"]
            else:
                continue
            pads.append(item)
        if pads:
            resp = _post(api, "/sp/productAds", {"productAds": pads}, VND["productAd"])
            ok, detail = _result_summary(resp, "productAds")
            results.append((f"POST /sp/productAds ('{g['name']}', {len(pads)} prod.)", ok, detail))

        # Keyword (MANUAL)
        kws = []
        for k in g.get("keywords", []):
            kws.append({
                "campaignId": cid, "adGroupId": agid,
                "keywordText": k["keywordText"],
                "matchType": k.get("matchType", "EXACT"),
                "state": "ENABLED", "bid": float(k["bid"]),
            })
        if kws:
            resp = _post(api, "/sp/keywords", {"keywords": kws}, VND["keyword"])
            ok, detail = _result_summary(resp, "keywords")
            results.append((f"POST /sp/keywords ('{g['name']}', {len(kws)} kw)", ok, detail))

        # Auto targeting clauses (AUTO) — bid per gruppo, opzionale
        ats = []
        for x in g.get("autoTargets", []):
            clause = {
                "campaignId": cid, "adGroupId": agid,
                "expressionType": "AUTO", "state": "ENABLED",
                "expression": [{"type": x["expressionType"]}],
            }
            if isinstance(x.get("bid"), (int, float)):
                clause["bid"] = float(x["bid"])
            ats.append(clause)
        if ats:
            resp = _post(api, "/sp/targets", {"targetingClauses": ats}, VND["target"])
            ok, detail = _result_summary(resp, "targetingClauses")
            results.append((f"POST /sp/targets ('{g['name']}', {len(ats)} auto)", ok, detail))

        # Negative keyword
        negs = []
        for n in g.get("negatives", []):
            negs.append({
                "campaignId": cid, "adGroupId": agid,
                "keywordText": n["keywordText"],
                "matchType": n.get("matchType", "NEGATIVE_EXACT"),
                "state": "ENABLED",
            })
        if negs:
            resp = _post(api, "/sp/negativeKeywords", {"negativeKeywords": negs}, VND["negative"])
            ok, detail = _result_summary(resp, "negativeKeywords")
            results.append((f"POST /sp/negativeKeywords ('{g['name']}', {len(negs)} neg.)", ok, detail))

    return results, created


def apply_actions(api, actions):
    """Esegue prima i create_campaign (cascata) e poi le modifiche. Ritorna (results, created_list)."""
    results = []
    created_list = []

    creates = [a for a in actions if a["type"] == "create_campaign"]
    edits = [a for a in actions if a["type"] != "create_campaign"]

    for a in creates:
        res, created = create_campaign_blueprint(api, a)
        results.extend(res)
        if created.get("campaignId"):
            created_list.append(created)

    if edits:
        results.extend(apply_edit_actions(api, edits))

    return results, created_list


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Applica/crea campagne Amazon Ads (con conferma)")
    ap.add_argument("actions_file", help="File JSON con le azioni proposte")
    ap.add_argument("--marketplace", default="IT", help="Marketplace (IT/FR/DE/ES/...)")
    ap.add_argument("--dry-run", action="store_true", help="Mostra solo l'anteprima, non applica nulla")
    ap.add_argument("--yes", action="store_true", help="Applica senza chiedere conferma (usare con cautela)")
    args = ap.parse_args()

    with open(args.actions_file, encoding="utf-8") as f:
        actions = json.load(f).get("actions", [])

    if not actions:
        sys.exit("Nessuna azione nel file.")

    errors = validate(actions)
    if errors:
        print("File azioni non valido:")
        for e in errors:
            print("   -", e)
        sys.exit(1)

    n_create = sum(1 for a in actions if a["type"] == "create_campaign")
    print(f"\n{'=' * 60}")
    print(f"ANTEPRIMA — {len(actions)} azioni su {args.marketplace} ({n_create} nuove campagne)")
    print(f"{'=' * 60}")
    for a in actions:
        print("  " + describe(a))
    print(f"{'=' * 60}\n")

    if args.dry_run:
        print("Dry-run: nessuna modifica applicata.")
        return

    if not args.yes:
        answer = input(f"Digitare APPLICA per eseguire su {args.marketplace} (qualsiasi altra cosa annulla): ").strip()
        if answer != "APPLICA":
            print("Annullato. Nessuna modifica applicata.")
            return

    api = AmazonAdsAPI(CONFIG)
    api.authenticate()
    api.select_profile(args.marketplace)

    print("\nApplicazione in corso...")
    results, created = apply_actions(api, actions)

    print("\nRISULTATI:")
    all_ok = True
    for name, ok, detail in results:
        icon = "OK " if ok else "ERR"
        print(f"  [{icon}] {name}: {detail}")
        all_ok = all_ok and ok

    if created:
        print("\nCAMPAGNE CREATE:")
        for c in created:
            print(f"  campaignId {c['campaignId']}")
            for g in c["adGroups"]:
                print(f"     adGroup '{g['name']}' -> {g['adGroupId']}")

    log = {
        "timestamp": datetime.now().isoformat(),
        "marketplace": args.marketplace,
        "actions": actions,
        "results": [{"op": n, "ok": o, "detail": d} for n, o, d in results],
        "created": created,
    }
    log_name = f"apply_log_{args.marketplace}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(log_name, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2, ensure_ascii=False)
    print(f"\nLog salvato: {log_name}")

    sys.exit(0 if all_ok else 2)


if __name__ == "__main__":
    main()
