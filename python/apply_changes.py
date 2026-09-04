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
import unicodedata
from datetime import datetime
from pathlib import Path

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
    "create_campaign", "pause_negative", "enable_negative",
}

AUTO_EXPRESSION_TYPES = {
    "QUERY_HIGH_REL_MATCHES", "QUERY_BROAD_REL_MATCHES",
    "ASIN_SUBSTITUTE_RELATED", "ASIN_ACCESSORY_RELATED",
}

# Alias comuni (nomi console/report o inventati dal modello) -> enum API v3
_AUTO_EXPRESSION_ALIASES = {
    "CLOSE_MATCH": "QUERY_HIGH_REL_MATCHES",
    "QUERY_HIGH_REL": "QUERY_HIGH_REL_MATCHES",
    "LOOSE_MATCH": "QUERY_BROAD_REL_MATCHES",
    "QUERY_BROAD_REL": "QUERY_BROAD_REL_MATCHES",
    "SUBSTITUTES": "ASIN_SUBSTITUTE_RELATED",
    "ASIN_SUBSTITUTE": "ASIN_SUBSTITUTE_RELATED",
    "COMPLEMENTS": "ASIN_ACCESSORY_RELATED",
    "ASIN_ACCESSORY": "ASIN_ACCESSORY_RELATED",
}

# L'API SP supporta solo NEGATIVE_EXACT e NEGATIVE_PHRASE:
# il "negative broad" non esiste, lo degradiamo a PHRASE (esclusione piu' ampia disponibile)
_NEGATIVE_MATCH_ALIASES = {
    "NEGATIVE_BROAD": "NEGATIVE_PHRASE",
    "BROAD": "NEGATIVE_PHRASE",
    "PHRASE": "NEGATIVE_PHRASE",
    "EXACT": "NEGATIVE_EXACT",
}


def normalize_actions(actions):
    """Corregge in-place gli alias non-API prodotti dal planner (LLM).

    Ritorna la lista di correzioni applicate (per log/UI)."""
    fixes = []
    for i, a in enumerate(actions):
        if a.get("type") == "add_negative":
            mt = str(a.get("matchType", "NEGATIVE_EXACT")).upper()
            if mt in _NEGATIVE_MATCH_ALIASES:
                a["matchType"] = _NEGATIVE_MATCH_ALIASES[mt]
                if mt != a["matchType"]:
                    fixes.append(f"azione {i}: matchType negativa '{mt}' -> '{a['matchType']}'")
        for j, g in enumerate(a.get("adGroups", []) or []):
            for n in g.get("negatives", []) or []:
                mt = str(n.get("matchType", "NEGATIVE_EXACT")).upper()
                if mt in _NEGATIVE_MATCH_ALIASES:
                    new = _NEGATIVE_MATCH_ALIASES[mt]
                    if new != mt:
                        fixes.append(f"azione {i}.adGroup{j}: negativa '{n.get('keywordText')}' {mt} -> {new}")
                    n["matchType"] = new
            for x in g.get("autoTargets", []) or []:
                et = str(x.get("expressionType", "")).upper()
                if et in _AUTO_EXPRESSION_ALIASES:
                    new = _AUTO_EXPRESSION_ALIASES[et]
                    fixes.append(f"azione {i}.adGroup{j}: expressionType {et} -> {new}")
                    x["expressionType"] = new
    return fixes


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


def _parse_batch(resp, key):
    """Spacchetta la risposta multi-status v3.

    Ritorna (success, error, http_ok, raw): success/error sono None se il corpo
    non e' JSON, e in quel caso raw contiene il testo grezzo.
    """
    try:
        body = resp.json()
    except Exception:
        return None, None, resp.status_code < 300, resp.text[:300]
    blk = body.get(key, {}) or {}
    return blk.get("success", []), blk.get("error", []), resp.status_code < 300, ""


def _error_messages(e):
    """Estrae i messaggi leggibili da una voce di errore v3.

    Il messaggio utile e' annidato in errorValue.<tipo>.message e la forma
    cambia a seconda del tipo di errore: qui si scende in ogni variante nota
    invece di stringificare il dict e tagliarlo, perche' era proprio il
    troncamento a lunghezza fissa a mangiarsi la parte diagnostica.
    """
    items = e.get("errors") if isinstance(e, dict) else None
    if not isinstance(items, list):
        items = [e]
    msgs = []
    for it in items:
        if not isinstance(it, dict):
            msgs.append(str(it))
            continue
        ev = it.get("errorValue") or {}
        inner = {}
        if isinstance(ev, dict):
            for v in ev.values():
                if isinstance(v, dict) and v.get("message"):
                    inner = v
                    break
        msgs.append(str(inner.get("message") or it.get("message")
                        or it.get("errorType") or it))
    return msgs


def _format_errors(errs, labels=None):
    """Raggruppa gli errori per messaggio, senza troncare il testo di Amazon.

    labels e' la lista degli elementi inviati (stessa lunghezza del payload):
    serve a dire QUALE keyword ha fallito, non solo quante.
    """
    grouped = {}
    for e in errs:
        idx = e.get("index") if isinstance(e, dict) else None
        etichetta = ""
        if labels and isinstance(idx, int) and idx < len(labels):
            etichetta = str(labels[idx])
        for m in _error_messages(e):
            grouped.setdefault(m, []).append(etichetta or f"#{idx}")
    parti = []
    for msg, chi in grouped.items():
        nomi = ", ".join(f"'{c}'" for c in chi if c)
        parti.append(f"{nomi} -> {msg}" if nomi else msg)
    return " | ".join(parti)


def _is_dup(e):
    return "duplicate" in str(e).lower()


def _result_summary(resp, key, labels=None):
    """Estrae ok/errori dalla risposta multi-status v3."""
    ok, ko_all, http_ok, raw = _parse_batch(resp, key)
    if ok is None:
        return http_ok, raw

    dup = [e for e in ko_all if _is_dup(e)]
    ko = [e for e in ko_all if not _is_dup(e)]
    parts = [f"{len(ok)} ok"]
    if dup:
        parts.append(f"{len(dup)} gia' presenti (skip): " + _format_errors(dup, labels))
    if ko:
        parts.append(f"{len(ko)} errori: " + _format_errors(ko, labels))
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


# ---------------------------------------------------------------- confronto testi
def _norm_kw(text):
    """Normalizza un testo keyword per il confronto.

    Accenti e spazi multipli non distinguono una query dall'altra lato Amazon,
    ma creano entita' diverse via API: 'canape chat' e 'canape' accentato
    convivono nello stesso ad group spezzando le statistiche. Qui vengono
    considerati lo stesso termine.
    """
    t = " ".join(str(text or "").split()).casefold()
    return "".join(c for c in unicodedata.normalize("NFD", t)
                   if unicodedata.category(c) != "Mn")


def _phrase_contains(testo_kw, frase):
    """True se la keyword contiene la frase come sequenza di parole.

    Serve a capire se una NEGATIVE_PHRASE spegnerebbe una keyword esistente.
    """
    tk = _norm_kw(testo_kw).split()
    tf = _norm_kw(frase).split()
    if not tf or len(tf) > len(tk):
        return False
    return any(tk[i:i + len(tf)] == tf for i in range(len(tk) - len(tf) + 1))


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
    if t == "pause_negative":
        return f"PAUSA   negativa '{a.get('keyword', a.get('keywordId'))}'"
    if t == "enable_negative":
        return f"RIATTIVA negativa '{a.get('keyword', a.get('keywordId'))}'"
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
        if t in ("pause_negative", "enable_negative") and not a.get("keywordId"):
            errors.append(f"azione {i} ({t}): manca keywordId della negativa")
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


# ---------------------------------------------------------------- preflight & guardrail
# Limiti di sicurezza: valgono ANCHE per le azioni scritte a mano nella UI.
# Servono a rendere impossibile un errore di battitura costoso (es. bid 45.00
# invece di 0.45). Si allentano con --allow-large-changes.
GUARDRAILS = {
    "max_bid_change_pct": 50,
    "min_bid": 0.02,
    "max_bid": 5.00,
    "max_budget_change_pct": 50,
    "min_budget": 1.00,
    "max_budget": 100.00,
    "max_actions": 80,
    "max_new_campaigns": 4,
}


def _list_v3(api, path, vnd, key, payload):
    headers = api._base_headers()
    headers["Content-Type"] = vnd
    headers["Accept"] = vnd
    try:
        resp = requests.post(f"{api.base_url}{path}", headers=headers, json=payload, timeout=60)
    except Exception as e:
        print(f"   preflight: errore di rete su {path}: {e}")
        return []
    if resp.status_code >= 400:
        print(f"   preflight: HTTP {resp.status_code} su {path}: {resp.text[:200]}")
        return []
    try:
        return resp.json().get(key, [])
    except Exception:
        return []


def _list_v3_paged(api, path, vnd, key, payload, max_pages=20):
    """Come _list_v3 ma segue nextToken: un ad group puo' avere centinaia di keyword."""
    out, token, pages = [], None, 0
    while pages < max_pages:
        body = dict(payload)
        if token:
            body["nextToken"] = token
        headers = api._base_headers()
        headers["Content-Type"] = vnd
        headers["Accept"] = vnd
        try:
            resp = requests.post(f"{api.base_url}{path}", headers=headers, json=body, timeout=60)
        except Exception as e:
            print(f"   preflight: errore di rete su {path}: {e}")
            return out
        if resp.status_code >= 400:
            print(f"   preflight: HTTP {resp.status_code} su {path}: {resp.text[:200]}")
            return out
        try:
            data = resp.json()
        except Exception:
            return out
        out.extend(data.get(key, []))
        token = data.get("nextToken")
        pages += 1
        if not token:
            break
    return out


def fetch_current_state(api, actions):
    """Legge lo stato ATTUALE di keyword e campagne toccate dalle azioni.

    Serve a quattro cose: mostrare un'anteprima con i valori veri (non quelli
    dichiarati dal modello), applicare i limiti sulle variazioni, costruire il
    file di rollback, e sapere COM'E' FATTA la destinazione delle aggiunte
    (targeting della campagna e keyword gia' presenti nell'ad group).
    """
    kw_ids = sorted({str(a["keywordId"]) for a in actions if a.get("keywordId")})
    camp_ids = sorted({str(a["campaignId"]) for a in actions if a.get("campaignId")})
    state = {"keywords": {}, "campaigns": {}, "kw_by_adgroup": {}, "camps_fetched": set()}

    for i in range(0, len(kw_ids), 100):
        for k in _list_v3(api, "/sp/keywords/list", VND["keyword"], "keywords",
                          {"keywordIdFilter": {"include": kw_ids[i:i + 100]}, "maxResults": 100}):
            state["keywords"][str(k.get("keywordId"))] = k
    for i in range(0, len(camp_ids), 100):
        for c in _list_v3(api, "/sp/campaigns/list", VND["campaign"], "campaigns",
                          {"campaignIdFilter": {"include": camp_ids[i:i + 100]}, "maxResults": 100}):
            state["campaigns"][str(c.get("campaignId"))] = c

    # Keyword gia' presenti nelle campagne dove stiamo per aggiungere qualcosa:
    # servono a intercettare duplicati e negative che spegnerebbero una keyword
    # attiva dello stesso ad group.
    add_camps = sorted({str(a["campaignId"]) for a in actions
                        if a.get("type") in ("add_keyword", "add_negative") and a.get("campaignId")})
    for i in range(0, len(add_camps), 10):
        blocco = add_camps[i:i + 10]
        for k in _list_v3_paged(api, "/sp/keywords/list", VND["keyword"], "keywords",
                                {"campaignIdFilter": {"include": blocco},
                                 "stateFilter": {"include": ["ENABLED", "PAUSED"]},
                                 "maxResults": 500}):
            state["kw_by_adgroup"].setdefault(str(k.get("adGroupId")), []).append(k)
        state["camps_fetched"].update(blocco)
    return state


def _campaign_budget(c):
    b = c.get("budget")
    if isinstance(b, dict):
        return float(b.get("budget") or 0)
    return float(b or 0)


def enrich_with_current_state(actions, state):
    """Riempie old_bid/old_budget con i valori REALI e segnala le no-op.

    Ritorna (notes, skip_indexes): le no-op vengono escluse dall'invio, cosi'
    l'anteprima mostra solo cio' che cambia davvero.
    """
    notes, skip = _detect_pause_add_conflicts(actions, state)
    notes = list(notes)
    for i, a in enumerate(actions):
        if i in skip:
            continue
        t = a.get("type")
        if t in ("update_bid", "pause_keyword", "enable_keyword"):
            k = state["keywords"].get(str(a.get("keywordId", "")))
            if k is None:
                notes.append(f"azione {i}: keywordId {a.get('keywordId')} non trovata sull'account (verra' rifiutata dall'API)")
                continue
            a.setdefault("keyword", k.get("keywordText", ""))
            cur_bid, cur_state = float(k.get("bid") or 0), str(k.get("state", "")).upper()
            if t == "update_bid":
                a["old_bid"] = round(cur_bid, 2)
                if abs(float(a["new_bid"]) - cur_bid) < 0.005:
                    notes.append(f"azione {i}: bid gia' a EUR {cur_bid:.2f}, nulla da fare")
                    skip.add(i)
            elif t == "pause_keyword" and cur_state == "PAUSED":
                notes.append(f"azione {i}: keyword '{a.get('keyword')}' gia' in pausa, nulla da fare")
                skip.add(i)
            elif t == "enable_keyword" and cur_state == "ENABLED":
                notes.append(f"azione {i}: keyword '{a.get('keyword')}' gia' attiva, nulla da fare")
                skip.add(i)
        elif t in ("update_budget", "pause_campaign", "enable_campaign"):
            c = state["campaigns"].get(str(a.get("campaignId", "")))
            if c is None:
                notes.append(f"azione {i}: campaignId {a.get('campaignId')} non trovata sull'account")
                continue
            a.setdefault("campaign", c.get("name", ""))
            cur_state = str(c.get("state", "")).upper()
            if t == "update_budget":
                a["old_budget"] = round(_campaign_budget(c), 2)
                if abs(float(a["new_budget"]) - _campaign_budget(c)) < 0.005:
                    notes.append(f"azione {i}: budget gia' a EUR {a['old_budget']:.2f}, nulla da fare")
                    skip.add(i)
            elif t == "pause_campaign" and cur_state == "PAUSED":
                notes.append(f"azione {i}: campagna gia' in pausa, nulla da fare")
                skip.add(i)
            elif t == "enable_campaign" and cur_state == "ENABLED":
                notes.append(f"azione {i}: campagna gia' attiva, nulla da fare")
                skip.add(i)

        elif t == "add_keyword":
            c = state["campaigns"].get(str(a.get("campaignId", "")))
            if c is None:
                notes.append(f"azione {i}: campaignId {a.get('campaignId')} non trovata sull'account")
                continue
            a.setdefault("campaign", c.get("name", ""))
            # Una campagna AUTO accetta solo negative: le keyword positive
            # vengono rifiutate dall'API ("Only negative keywords and negative
            # product targets are allowed in auto targeting campaigns").
            if str(c.get("targetingType", "")).upper() == "AUTO":
                notes.append(
                    f"azione {i}: '{a.get('keywordText')}' non aggiungibile alla campagna "
                    f"'{c.get('name', a.get('campaignId'))}' perche' e' AUTO (accetta solo negative)")
                skip.add(i)
                continue
            esistenti = state.get("kw_by_adgroup", {}).get(str(a.get("adGroupId", "")), [])
            testo, match = _norm_kw(a.get("keywordText")), str(a.get("matchType", "EXACT")).upper()
            gemella = next((k for k in esistenti
                            if _norm_kw(k.get("keywordText")) == testo
                            and str(k.get("matchType", "")).upper() == match), None)
            if gemella is not None:
                uguale = str(gemella.get("keywordText", "")) == str(a.get("keywordText", ""))
                notes.append(
                    f"azione {i}: '{a.get('keywordText')}' [{match}] gia' presente nell'ad group "
                    f"{a.get('adGroupId')} come '{gemella.get('keywordText')}' "
                    f"(stato {gemella.get('state')})" + ("" if uguale else " — differisce solo per accenti/spazi"))
                if uguale:
                    skip.add(i)  # l'API la rifiuterebbe come duplicato

        elif t == "add_negative":
            testo = a.get("keywordText")
            match = str(a.get("matchType", "NEGATIVE_EXACT")).upper()
            agid = str(a.get("adGroupId", "") or "")
            if agid:
                candidate = state.get("kw_by_adgroup", {}).get(agid, [])
                dove = f"ad group {agid}"
            else:
                cid = str(a.get("campaignId", ""))
                candidate = [k for lst in state.get("kw_by_adgroup", {}).values() for k in lst
                             if str(k.get("campaignId", "")) == cid]
                dove = f"campagna {a.get('campaign') or cid}"
            colpite = []
            for k in candidate:
                if str(k.get("state", "")).upper() != "ENABLED":
                    continue
                kt, km = k.get("keywordText", ""), str(k.get("matchType", "")).upper()
                if match == "NEGATIVE_EXACT" and km == "EXACT" and _norm_kw(kt) == _norm_kw(testo):
                    colpite.append(kt)
                elif match == "NEGATIVE_PHRASE" and _phrase_contains(kt, testo):
                    colpite.append(kt)
            if colpite:
                notes.append(
                    f"azione {i}: la negativa '{testo}' [{match}] spegnerebbe nella stessa {dove} "
                    f"keyword attive ({', '.join(repr(x) for x in colpite[:4])}) — azione rimossa")
                skip.add(i)

    return notes, skip


def _detect_pause_add_conflicts(actions, state, gia_skip=frozenset()):
    """Intercetta pausa e riaggiunta della stessa keyword nello stesso run.

    Il modello puo' vedere lo stesso termine due volte (male come keyword,
    bene come search term) e proporre due azioni opposte: l'API accetta la
    pausa e rifiuta l'aggiunta come duplicato, quindi l'effetto netto e' che
    la keyword resta spenta senza che nessuno se ne accorga.
    """
    notes, skip = [], set()
    in_pausa = {}
    for i, a in enumerate(actions):
        if a.get("type") != "pause_keyword" or i in gia_skip:
            continue
        k = state["keywords"].get(str(a.get("keywordId", "")))
        if not k:
            continue
        chiave = (_norm_kw(k.get("keywordText")), str(k.get("matchType", "")).upper())
        in_pausa[chiave] = (str(k.get("adGroupId", "")), k.get("keywordText", ""))

    for i, a in enumerate(actions):
        if a.get("type") != "add_keyword" or i in gia_skip:
            continue
        chiave = (_norm_kw(a.get("keywordText")), str(a.get("matchType", "EXACT")).upper())
        if chiave not in in_pausa:
            continue
        ag_pausa, testo = in_pausa[chiave]
        if ag_pausa and ag_pausa == str(a.get("adGroupId", "")):
            notes.append(
                f"azione {i}: '{a.get('keywordText')}' viene messa in pausa e riaggiunta "
                f"nello stesso ad group {ag_pausa} — aggiunta rimossa, resta la pausa")
            skip.add(i)
        else:
            notes.append(
                f"azione {i}: '{a.get('keywordText')}' e' in pausa su {ag_pausa or 'altro ad group'} "
                f"e viene aggiunta su {a.get('adGroupId')} — verificare che sia voluto")
    return notes, skip


def check_guardrails(actions, g=None):
    """Blocca le variazioni fuori scala. Ritorna lista di violazioni."""
    g = g or GUARDRAILS
    bad = []
    if len(actions) > g["max_actions"]:
        bad.append(f"{len(actions)} azioni in un solo run: il limite e' {g['max_actions']}")
    n_new = sum(1 for a in actions if a.get("type") == "create_campaign")
    if n_new > g["max_new_campaigns"]:
        bad.append(f"{n_new} nuove campagne in un solo run: il limite e' {g['max_new_campaigns']}")

    for i, a in enumerate(actions):
        t = a.get("type")
        if t == "update_bid":
            new = float(a["new_bid"])
            if not (g["min_bid"] <= new <= g["max_bid"]):
                bad.append(f"azione {i}: bid EUR {new:.2f} fuori dall'intervallo consentito "
                           f"(EUR {g['min_bid']:.2f}-{g['max_bid']:.2f})")
            old = a.get("old_bid")
            if isinstance(old, (int, float)) and old > 0:
                delta = abs(new - old) / old * 100
                if delta > g["max_bid_change_pct"]:
                    bad.append(f"azione {i}: bid '{a.get('keyword', '')}' da EUR {old:.2f} a EUR {new:.2f} "
                               f"= {delta:.0f}% di variazione (max {g['max_bid_change_pct']}%)")
        elif t == "add_keyword":
            bid = float(a.get("bid", 0))
            if not (g["min_bid"] <= bid <= g["max_bid"]):
                bad.append(f"azione {i}: bid nuova keyword EUR {bid:.2f} fuori intervallo")
        elif t == "update_budget":
            new = float(a["new_budget"])
            if not (g["min_budget"] <= new <= g["max_budget"]):
                bad.append(f"azione {i}: budget EUR {new:.2f}/giorno fuori dall'intervallo consentito "
                           f"(EUR {g['min_budget']:.2f}-{g['max_budget']:.2f})")
            old = a.get("old_budget")
            if isinstance(old, (int, float)) and old > 0:
                delta = abs(new - old) / old * 100
                if delta > g["max_budget_change_pct"]:
                    bad.append(f"azione {i}: budget '{a.get('campaign', '')}' da EUR {old:.2f} a EUR {new:.2f} "
                               f"= {delta:.0f}% di variazione (max {g['max_budget_change_pct']}%)")
        elif t == "create_campaign":
            c = a.get("campaign", {})
            b = float(c.get("dailyBudget", 0) or 0)
            if b > g["max_budget"]:
                bad.append(f"azione {i}: nuova campagna con budget EUR {b:.2f}/giorno (max {g['max_budget']:.2f})")
    return bad


def build_rollback(outcomes, state, created):
    """Costruisce un actions.json che ANNULLA quanto e' stato applicato DAVVERO.

    outcomes = le azioni confermate dall'API (con l'ID generato dove esiste),
    non quelle pianificate: una keyword rifiutata non deve comparire nelle
    istruzioni di undo. Grazie all'ID restituito dalle POST, keyword e negative
    aggiunte ora si annullano da sole; resta manuale solo cio' che l'API non ha
    identificato.
    Le campagne create si annullano mettendole in pausa.
    """
    undo, manual = [], []
    for e in outcomes:
        a = e["action"] if isinstance(e, dict) and "action" in e else e
        nuovo_id = e.get("id") if isinstance(e, dict) else None
        t = a.get("type")
        if t == "update_bid":
            k = state["keywords"].get(str(a.get("keywordId", "")))
            if k is not None:
                undo.append({"type": "update_bid", "keywordId": a["keywordId"],
                             "keyword": a.get("keyword", ""), "old_bid": a.get("new_bid"),
                             "new_bid": round(float(k.get("bid") or 0), 2)})
        elif t in ("pause_keyword", "enable_keyword"):
            k = state["keywords"].get(str(a.get("keywordId", "")))
            if k is not None:
                prev = str(k.get("state", "")).upper()
                undo.append({"type": "pause_keyword" if prev == "PAUSED" else "enable_keyword",
                             "keywordId": a["keywordId"], "keyword": a.get("keyword", "")})
        elif t == "update_budget":
            c = state["campaigns"].get(str(a.get("campaignId", "")))
            if c is not None:
                undo.append({"type": "update_budget", "campaignId": a["campaignId"],
                             "campaign": a.get("campaign", ""), "old_budget": a.get("new_budget"),
                             "new_budget": round(_campaign_budget(c), 2)})
        elif t in ("pause_campaign", "enable_campaign"):
            c = state["campaigns"].get(str(a.get("campaignId", "")))
            if c is not None:
                prev = str(c.get("state", "")).upper()
                undo.append({"type": "pause_campaign" if prev == "PAUSED" else "enable_campaign",
                             "campaignId": a["campaignId"], "campaign": a.get("campaign", "")})
        elif t == "add_negative":
            if nuovo_id:
                undo.append({"type": "pause_negative", "keywordId": nuovo_id,
                             "keyword": f"{a.get('keywordText')} [{a.get('matchType', 'NEGATIVE_EXACT')}]"})
            else:
                manual.append(f"rimuovere a mano la negativa '{a.get('keywordText')}' dalla campagna {a.get('campaign') or a.get('campaignId')}")
        elif t == "add_keyword":
            if nuovo_id:
                undo.append({"type": "pause_keyword", "keywordId": nuovo_id,
                             "keyword": f"{a.get('keywordText')} [{a.get('matchType', 'EXACT')}]"})
            else:
                manual.append(f"mettere in pausa a mano la keyword '{a.get('keywordText')}' aggiunta all'ad group {a.get('adGroupId')}")
        elif t == "pause_negative":
            undo.append({"type": "enable_negative", "keywordId": a.get("keywordId"),
                         "keyword": a.get("keyword", "")})
    for c in created:
        undo.append({"type": "pause_campaign", "campaignId": c["campaignId"],
                     "campaign": "(campagna creata da questo run)"})
    return {"actions": undo, "_manual_undo": manual}


# ---------------------------------------------------------------- apply: edit
def _collect_outcomes(resp, key, sources, id_field="keywordId"):
    """Associa ogni azione inviata al suo esito reale.

    Le risposte v3 portano l'indice dell'elemento nell'array inviato: e' l'unico
    modo per sapere QUALI azioni sono passate. Senza questo passaggio il
    rollback veniva costruito sul piano, e finiva per elencare keyword mai
    create davvero.
    """
    succ, errs, _http_ok, _raw = _parse_batch(resp, key)
    esiti = []
    if succ is None:  # risposta non JSON: nessuna certezza, meglio non dedurre
        return esiti
    for s in succ:
        idx = s.get("index")
        if isinstance(idx, int) and idx < len(sources):
            esiti.append({"action": sources[idx], "id": str(s.get(id_field) or "") or None})
    return esiti


def apply_edit_actions(api, actions):
    """Applica le azioni di ottimizzazione (non-create).

    Ritorna (results, outcomes): results per il log a schermo, outcomes = le
    sole azioni confermate dall'API, con l'ID generato dove esiste.
    """
    results, outcomes = [], []

    kw_updates, kw_src = [], []
    for a in actions:
        if a["type"] == "update_bid":
            kw_updates.append({"keywordId": a["keywordId"], "bid": float(a["new_bid"])})
        elif a["type"] == "pause_keyword":
            kw_updates.append({"keywordId": a["keywordId"], "state": "PAUSED"})
        elif a["type"] == "enable_keyword":
            kw_updates.append({"keywordId": a["keywordId"], "state": "ENABLED"})
        elif a["type"] in ("pause_negative", "enable_negative"):
            continue
        else:
            continue
        kw_src.append(a)
    if kw_updates:
        resp = _put(api, "/sp/keywords", {"keywords": kw_updates}, VND["keyword"])
        etichette = [a.get("keyword") or a.get("keywordId") for a in kw_src]
        ok, detail = _result_summary(resp, "keywords", etichette)
        results.append((f"PUT /sp/keywords ({len(kw_updates)} modifiche)", ok, detail))
        outcomes.extend(_collect_outcomes(resp, "keywords", kw_src))

    neg_updates, neg_upd_src = [], []
    for a in actions:
        if a["type"] in ("pause_negative", "enable_negative"):
            stato = "PAUSED" if a["type"] == "pause_negative" else "ENABLED"
            neg_updates.append({"keywordId": a["keywordId"], "state": stato})
            neg_upd_src.append(a)
    if neg_updates:
        resp = _put(api, "/sp/negativeKeywords", {"negativeKeywords": neg_updates}, VND["negative"])
        etichette = [a.get("keyword") or a.get("keywordId") for a in neg_upd_src]
        ok, detail = _result_summary(resp, "negativeKeywords", etichette)
        results.append((f"PUT /sp/negativeKeywords ({len(neg_updates)} stati)", ok, detail))
        outcomes.extend(_collect_outcomes(resp, "negativeKeywords", neg_upd_src))

    negatives, neg_src = [], []
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
            neg_src.append(a)
    if negatives:
        resp = _post(api, "/sp/negativeKeywords", {"negativeKeywords": negatives}, VND["negative"])
        ok, detail = _result_summary(resp, "negativeKeywords", [a["keywordText"] for a in neg_src])
        results.append((f"POST /sp/negativeKeywords ({len(negatives)} negative)", ok, detail))
        outcomes.extend(_collect_outcomes(resp, "negativeKeywords", neg_src))

    new_keywords, new_src = [], []
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
            new_src.append(a)
    if new_keywords:
        resp = _post(api, "/sp/keywords", {"keywords": new_keywords}, VND["keyword"])
        ok, detail = _result_summary(resp, "keywords", [a["keywordText"] for a in new_src])
        results.append((f"POST /sp/keywords ({len(new_keywords)} nuove keyword)", ok, detail))
        outcomes.extend(_collect_outcomes(resp, "keywords", new_src))

    camp_updates, camp_src = {}, {}
    for a in actions:
        if a["type"] == "update_budget":
            camp_updates.setdefault(a["campaignId"], {"campaignId": a["campaignId"]})[
                "budget"] = {"budget": float(a["new_budget"]), "budgetType": "DAILY"}
        elif a["type"] == "pause_campaign":
            camp_updates.setdefault(a["campaignId"], {"campaignId": a["campaignId"]})["state"] = "PAUSED"
        elif a["type"] == "enable_campaign":
            camp_updates.setdefault(a["campaignId"], {"campaignId": a["campaignId"]})["state"] = "ENABLED"
        else:
            continue
        camp_src.setdefault(a["campaignId"], []).append(a)
    if camp_updates:
        ordine = list(camp_updates.keys())
        payload = {"campaigns": [camp_updates[c] for c in ordine]}
        resp = _put(api, "/sp/campaigns", payload, VND["campaign"])
        etichette = [camp_src[c][0].get("campaign") or c for c in ordine]
        ok, detail = _result_summary(resp, "campaigns", etichette)
        results.append((f"PUT /sp/campaigns ({len(camp_updates)} campagne)", ok, detail))
        # una sola voce per campagna puo' coprire piu' azioni (budget + stato)
        for e in _collect_outcomes(resp, "campaigns", ordine, "campaignId"):
            for a in camp_src.get(e["action"], []):
                outcomes.append({"action": a, "id": e["action"]})

    return results, outcomes


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
    """Esegue prima i create_campaign (cascata) e poi le modifiche.

    Ritorna (results, created_list, outcomes), dove outcomes elenca le sole
    azioni confermate dall'API: e' la base del file di rollback.
    """
    results = []
    created_list = []
    outcomes = []

    creates = [a for a in actions if a["type"] == "create_campaign"]
    edits = [a for a in actions if a["type"] != "create_campaign"]

    for a in creates:
        res, created = create_campaign_blueprint(api, a)
        results.extend(res)
        if created.get("campaignId"):
            created_list.append(created)

    if edits:
        res, out = apply_edit_actions(api, edits)
        results.extend(res)
        outcomes.extend(out)

    return results, created_list, outcomes


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Applica/crea campagne Amazon Ads (con conferma)")
    ap.add_argument("actions_file", help="File JSON con le azioni proposte")
    ap.add_argument("--marketplace", default="IT", help="Marketplace (IT/FR/DE/ES/...)")
    ap.add_argument("--dry-run", action="store_true", help="Mostra solo l'anteprima, non applica nulla")
    ap.add_argument("--yes", action="store_true", help="Applica senza chiedere conferma (usare con cautela)")
    ap.add_argument("--offline", action="store_true",
                    help="Anteprima senza contattare Amazon (solo controllo del formato)")
    ap.add_argument("--allow-large-changes", action="store_true",
                    help="Disattiva i limiti su variazioni di bid/budget (sconsigliato)")
    ap.add_argument("--json-out", default="",
                    help="Scrive anteprima ed esito in un JSON strutturato (per la UI)")
    args = ap.parse_args()

    with open(args.actions_file, encoding="utf-8") as f:
        actions = json.load(f).get("actions", [])

    if not actions:
        sys.exit("Nessuna azione nel file.")

    report = {"timestamp": datetime.now().isoformat(), "marketplace": args.marketplace,
              "dry_run": bool(args.dry_run), "fixes": [], "notes": [], "guardrails": [],
              "preview": [], "skipped": [], "results": [], "created": [], "applied": False}

    def dump_report():
        if args.json_out:
            Path(args.json_out).write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str),
                                           encoding="utf-8")

    fixes = normalize_actions(actions)
    report["fixes"] = fixes
    if fixes:
        print("Correzioni automatiche applicate:")
        for fx in fixes:
            print("   -", fx)

    errors = validate(actions)
    if errors:
        print("File azioni non valido:")
        for e in errors:
            print("   -", e)
        report["errors"] = errors
        dump_report()
        sys.exit(1)

    # --- Preflight: stato reale sull'account -------------------------------
    api = None
    state = {"keywords": {}, "campaigns": {}}
    if not args.offline:
        api = AmazonAdsAPI(CONFIG)
        api.authenticate()
        api.select_profile(args.marketplace)
        print("\nLettura dello stato attuale delle campagne toccate...")
        state = fetch_current_state(api, actions)
        notes, skip = enrich_with_current_state(actions, state)
        report["notes"] = notes
        for n in notes:
            print("   -", n)
        if skip:
            report["skipped"] = [describe(actions[i]) for i in sorted(skip)]
            actions = [a for i, a in enumerate(actions) if i not in skip]
            print(f"   {len(skip)} azioni gia' allineate: rimosse dall'invio.")
        if not actions:
            print("\nNiente da applicare: tutte le azioni erano gia' in linea con lo stato attuale.")
            dump_report()
            return

    # --- Limiti di sicurezza ------------------------------------------------
    violations = [] if args.allow_large_changes else check_guardrails(actions)
    report["guardrails"] = violations
    if violations:
        print("\nBLOCCATO dai limiti di sicurezza:")
        for v in violations:
            print("   -", v)
        print("\nCorreggi i valori, oppure rilancia con --allow-large-changes se sei sicuro.")
        dump_report()
        sys.exit(3)

    n_create = sum(1 for a in actions if a["type"] == "create_campaign")
    print(f"\n{'=' * 60}")
    print(f"ANTEPRIMA — {len(actions)} azioni su {args.marketplace} ({n_create} nuove campagne)")
    if args.offline:
        print("(modalita' offline: i valori 'attuali' sono quelli dichiarati nel file, non verificati)")
    print(f"{'=' * 60}")
    for a in actions:
        line = describe(a)
        report["preview"].append(line)
        print("  " + line)
    print(f"{'=' * 60}\n")

    if args.dry_run:
        print("Dry-run: nessuna modifica applicata.")
        dump_report()
        return

    if not args.yes:
        answer = input(f"Digitare APPLICA per eseguire su {args.marketplace} (qualsiasi altra cosa annulla): ").strip()
        if answer != "APPLICA":
            print("Annullato. Nessuna modifica applicata.")
            dump_report()
            return

    if api is None:  # --offline + --yes: serve comunque autenticarsi per applicare
        api = AmazonAdsAPI(CONFIG)
        api.authenticate()
        api.select_profile(args.marketplace)

    print("\nApplicazione in corso...")
    results, created, outcomes = apply_actions(api, actions)
    report["applied"] = True

    print("\nRISULTATI:")
    all_ok = True
    for name, ok, detail in results:
        icon = "OK " if ok else "ERR"
        print(f"  [{icon}] {name}: {detail}")
        all_ok = all_ok and ok
    report["results"] = [{"op": n, "ok": o, "detail": d} for n, o, d in results]
    report["created"] = created

    if created:
        print("\nCAMPAGNE CREATE:")
        for c in created:
            print(f"  campaignId {c['campaignId']}")
            for g in c["adGroups"]:
                print(f"     adGroup '{g['name']}' -> {g['adGroupId']}")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log = {
        "timestamp": datetime.now().isoformat(),
        "marketplace": args.marketplace,
        "actions": actions,
        "confirmed": [{"action": e["action"], "id": e.get("id")} for e in outcomes],
        "results": report["results"],
        "created": created,
    }
    log_name = f"apply_log_{args.marketplace}_{ts}.json"
    Path(log_name).write_text(json.dumps(log, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nLog salvato: {log_name}")

    # --- Rollback: come tornare indietro -----------------------------------
    rollback = build_rollback(outcomes, state, created)
    n_inviate = sum(1 for a in actions if a["type"] != "create_campaign")
    if len(outcomes) < n_inviate:
        print(f"   nota: {n_inviate - len(outcomes)} azioni non confermate dall'API, escluse dal rollback")
    if rollback["actions"] or rollback["_manual_undo"]:
        rb_name = f"rollback_{args.marketplace}_{ts}.json"
        Path(rb_name).write_text(json.dumps(rollback, indent=2, ensure_ascii=False), encoding="utf-8")
        report["rollback_file"] = rb_name
        print(f"Rollback salvato: {rb_name}")
        print(f"   Per annullare: python apply_changes.py {rb_name} --marketplace {args.marketplace}")
        for m in rollback["_manual_undo"]:
            print("   (a mano) " + m)

    dump_report()
    sys.exit(0 if all_ok else 2)


if __name__ == "__main__":
    main()
