#!/usr/bin/env python3
"""
Apply Changes — modifica campagne Amazon Ads PREVIA CONFERMA
=============================================================
Legge un file actions.json con le modifiche proposte, mostra un'anteprima
(dry-run), chiede conferma esplicita e solo allora le applica via API.

Uso:
    python apply_changes.py actions.json --marketplace IT          # anteprima + conferma interattiva
    python apply_changes.py actions.json --marketplace IT --dry-run  # SOLO anteprima, non chiede nulla
    python apply_changes.py actions.json --marketplace IT --yes      # applica senza prompt (per script)

Formato actions.json:
{
  "actions": [
    {"type": "update_bid",        "keywordId": "123", "keyword": "amaca gatto", "old_bid": 0.45, "new_bid": 0.60},
    {"type": "pause_keyword",     "keywordId": "456", "keyword": "letto cane"},
    {"type": "enable_keyword",    "keywordId": "789", "keyword": "cuccia squalo"},
    {"type": "add_negative",      "campaignId": "111", "adGroupId": "222", "keywordText": "gratis", "matchType": "NEGATIVE_PHRASE"},
    {"type": "update_budget",     "campaignId": "111", "campaign": "SP-sdraietta", "old_budget": 10, "new_budget": 15},
    {"type": "pause_campaign",    "campaignId": "333", "campaign": "SP-vecchia"},
    {"type": "enable_campaign",   "campaignId": "444", "campaign": "SP-riattiva"}
  ]
}

Note:
- matchType negative: NEGATIVE_EXACT o NEGATIVE_PHRASE
- adGroupId nelle negative: omettilo per negativa a livello campagna
- i campi "keyword"/"campaign"/"old_*" sono solo descrittivi per l'anteprima
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
}

VALID_TYPES = {
    "update_bid", "pause_keyword", "enable_keyword", "add_keyword",
    "add_negative", "update_budget", "pause_campaign", "enable_campaign",
}


# ---------------------------------------------------------------- helpers
def _put(api, path, payload, vnd):
    headers = api._base_headers()
    headers["Content-Type"] = vnd
    headers["Accept"] = vnd
    resp = requests.put(f"{api.base_url}{path}", headers=headers, json=payload)
    return resp


def _post(api, path, payload, vnd):
    headers = api._base_headers()
    headers["Content-Type"] = vnd
    headers["Accept"] = vnd
    resp = requests.post(f"{api.base_url}{path}", headers=headers, json=payload)
    return resp


def _result_summary(resp, key):
    """Estrae ok/errori dalla risposta multi-status v3."""
    try:
        body = resp.json()
    except Exception:
        return resp.status_code < 300, resp.text[:300]
    ok = body.get(key, {}).get("success", [])
    ko_all = body.get(key, {}).get("error", [])
    # I duplicati NON sono errori: la negative/keyword esiste gia', obiettivo raggiunto.
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
    # Solo successi e/o duplicati -> operazione considerata riuscita.
    return True, ", ".join(parts)


# ---------------------------------------------------------------- preview
def describe(a):
    t = a["type"]
    if t == "update_bid":
        return f"💶 BID     '{a.get('keyword', a['keywordId'])}': €{a.get('old_bid', '?')} → €{a['new_bid']}"
    if t == "pause_keyword":
        return f"⏸  PAUSA   keyword '{a.get('keyword', a['keywordId'])}'"
    if t == "enable_keyword":
        return f"▶️  RIATTIVA keyword '{a.get('keyword', a['keywordId'])}'"
    if t == "add_keyword":
        return " AGGIUNGI keyword '" + str(a.get("keywordText")) + "' [" + str(a.get("matchType", "EXACT")) + "] bid " + str(a.get("bid", "?")) + " (adGroup " + str(a.get("adGroupId")) + ")"
    if t == "add_negative":
        lvl = "ad group" if a.get("adGroupId") else "campagna"
        return f"🚫 NEGATIVA '{a['keywordText']}' [{a.get('matchType', 'NEGATIVE_EXACT')}] a livello {lvl} (camp {a.get('campaign', a['campaignId'])})"
    if t == "update_budget":
        return f"💰 BUDGET  '{a.get('campaign', a['campaignId'])}': €{a.get('old_budget', '?')} → €{a['new_budget']}/giorno"
    if t == "pause_campaign":
        return f"⏸  PAUSA   campagna '{a.get('campaign', a['campaignId'])}'"
    if t == "enable_campaign":
        return f"▶️  RIATTIVA campagna '{a.get('campaign', a['campaignId'])}'"
    return f"? {t}"


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
    return errors


# ---------------------------------------------------------------- apply
def apply_actions(api, actions):
    """Raggruppa per tipo ed esegue. Ritorna lista (azione, ok, dettaglio)."""
    results = []

    # 1. Keywords: bid update + stato (stesso endpoint PUT /sp/keywords)
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

    # 2. Negative keywords (POST /sp/negativeKeywords)
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

    # 2b. Nuove keyword da aggiungere (POST /sp/keywords)
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

    # 3. Campagne: budget + stato (PUT /sp/campaigns)
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


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Applica modifiche alle campagne Amazon Ads (con conferma)")
    ap.add_argument("actions_file", help="File JSON con le azioni proposte")
    ap.add_argument("--marketplace", default="IT", help="Marketplace (IT/FR/DE)")
    ap.add_argument("--dry-run", action="store_true", help="Mostra solo l'anteprima, non applica nulla")
    ap.add_argument("--yes", action="store_true", help="Applica senza chiedere conferma (usare con cautela)")
    args = ap.parse_args()

    with open(args.actions_file, encoding="utf-8") as f:
        actions = json.load(f).get("actions", [])

    if not actions:
        sys.exit("Nessuna azione nel file.")

    errors = validate(actions)
    if errors:
        print("❌ File azioni non valido:")
        for e in errors:
            print("   -", e)
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print(f"📋 ANTEPRIMA — {len(actions)} modifiche proposte su {args.marketplace}")
    print(f"{'=' * 60}")
    for a in actions:
        print("  " + describe(a))
    print(f"{'=' * 60}\n")

    if args.dry_run:
        print("Dry-run: nessuna modifica applicata.")
        return

    if not args.yes:
        answer = input(f"⚠️  Digitare APPLICA per eseguire su {args.marketplace} (qualsiasi altra cosa annulla): ").strip()
        if answer != "APPLICA":
            print("Annullato. Nessuna modifica applicata.")
            return

    # Auth + selezione profilo
    api = AmazonAdsAPI(CONFIG)
    api.authenticate()
    api.select_profile(args.marketplace)

    print("\n🚀 Applicazione modifiche...")
    results = apply_actions(api, actions)

    print("\n📊 RISULTATI:")
    all_ok = True
    for name, ok, detail in results:
        icon = "✅" if ok else "❌"
        print(f"  {icon} {name}: {detail}")
        all_ok = all_ok and ok

    # Log su file
    log = {
        "timestamp": datetime.now().isoformat(),
        "marketplace": args.marketplace,
        "actions": actions,
        "results": [{"op": n, "ok": o, "detail": d} for n, o, d in results],
    }
    log_name = f"apply_log_{args.marketplace}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(log_name, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2, ensure_ascii=False)
    print(f"\n📝 Log salvato: {log_name}")

    sys.exit(0 if all_ok else 2)


if __name__ == "__main__":
    main()
