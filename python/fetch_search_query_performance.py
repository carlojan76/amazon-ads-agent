#!/usr/bin/env python3
r"""
fetch_search_query_performance.py — Lupo & Felix

Pipeline vera (punto 2 del roadmap keyword), scritta SOLO dopo che
check_search_query_performance_access.py ha confermato l'accesso al report
Brand Analytics Search Query Performance su questo account (report + polling
+ download + parsing, per tutti gli ASIN attivi di un mercato).

COSA FA: per ogni ASIN pubblicizzato in un mercato (scoperto da
public/data/<MKT>.json, lo stesso file che pubblica weekly_analysis.py — non
serve un catalogo statico separato) crea UN report Search Query Performance
per volta (reportOptions.asin = un solo ASIN: lo schema Amazon documenta
"asin" come "a space-separated list", che suggerisce che il multi-ASIN in un
solo report potrebbe aggregare piu' prodotti insieme invece di restituire
righe separate per ASIN — non verificato su questo account, quindi non lo
rischiamo qui. Se in futuro si verifica che il multi-ASIN funziona come
previsto, si puo' ottimizzare per ridurre il numero di report), scarica il
documento (JSON, schema sellingPartnerSearchQueryPerformanceReport) e lo
salva aggregato per mercato.

Formato di output (un file per mercato, reports/sqp/<MKT>.json qui, poi
copiato in public/data/SQP_<MKT>.json dal workflow — stessa convenzione di
weekly_analysis.py/public/data/<MKT>.json):
  {
    "marketplace": "IT", "period": "WEEK", "start": "...", "end": "...",
    "generated_at": "...",
    "by_asin": {"B0XXXXXXXX": [ {searchQuery, searchQueryVolume, ...}, ... ]},
    "errors": {"B0YYYYYYYY": "HTTP 400: ..."}   // ASIN falliti, non fa fallire l'intero run
  }

Consumato da listing_signals.search_query_performance_section(), a sua volta
incluso nel context pack da build_context.py.

Uso:
  python fetch_search_query_performance.py                      # tutti i mercati in config.ACTIVE_MARKETS
  python fetch_search_query_performance.py --marketplace IT
  python fetch_search_query_performance.py --marketplace IT --asin B0G5JC2YZ2 --asin B0YYYYYYYY
  python fetch_search_query_performance.py --marketplace IT --period MONTH --start 2026-07-01 --end 2026-07-31

Ogni ASIN e' best-effort (un errore non ferma gli altri): l'esito di ognuno
finisce in "by_asin" (successo) o "errors" (fallito), mai silenziosamente perso.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

import requests

import config
import listing_signals
import spapi
# Riusa la stessa logica di allineamento date e la stessa costante reportType
# gia' verificate dal probe di accesso: nessuna duplicazione, nessun rischio
# di far divergere le due query nel tempo.
from check_search_query_performance_access import (
    REPORT_TYPE, VALID_PERIODS, _last_complete_week,
)


def _parse_document(text: str) -> List[Dict[str, Any]]:
    """Estrae le righe dal documento JSON del report (schema
    sellingPartnerSearchQueryPerformanceReport: root.dataByAsin[], ognuna con
    searchQueryData/impressionData/clickData/cartAddData/purchaseData)."""
    doc = json.loads(text)
    rows: List[Dict[str, Any]] = []
    for entry in doc.get("dataByAsin", []):
        sq = entry.get("searchQueryData") or {}
        imp = entry.get("impressionData") or {}
        clk = entry.get("clickData") or {}
        cart = entry.get("cartAddData") or {}
        pur = entry.get("purchaseData") or {}
        rows.append({
            "asin": entry.get("asin"),
            "startDate": entry.get("startDate"),
            "endDate": entry.get("endDate"),
            "searchQuery": sq.get("searchQuery", ""),
            "searchQueryScore": sq.get("searchQueryScore"),
            "searchQueryVolume": sq.get("searchQueryVolume"),
            "asinImpressionCount": imp.get("asinImpressionCount"),
            "totalQueryImpressionCount": imp.get("totalQueryImpressionCount"),
            "asinImpressionShare": imp.get("asinImpressionShare"),
            "asinClickCount": clk.get("asinClickCount"),
            "totalClickCount": clk.get("totalClickCount"),
            "asinClickShare": clk.get("asinClickShare"),
            "asinCartAddCount": cart.get("asinCartAddCount"),
            "totalCartAddCount": cart.get("totalCartAddCount"),
            "asinCartAddShare": cart.get("asinCartAddShare"),
            "asinPurchaseCount": pur.get("asinPurchaseCount"),
            "totalPurchaseCount": pur.get("totalPurchaseCount"),
            "asinPurchaseShare": pur.get("asinPurchaseShare"),
        })
    return rows


def fetch_for_asin(asin: str, marketplace_id: str, period: str, start: str, end: str,
                   poll_every: int = 15, timeout: int = 300) -> List[Dict[str, Any]]:
    """Crea + attende + scarica + parsa il report per UN ASIN. Ritorna lista
    vuota se il report finisce CANCELLED (nessun dato per ASIN/periodo: non
    un errore). Propaga le eccezioni al chiamante, che decide come loggarle."""
    report_id = spapi.create_report(
        REPORT_TYPE, [marketplace_id],
        data_start=f"{start}T00:00:00Z", data_end=f"{end}T23:59:59Z",
        report_options={"asin": asin, "reportPeriod": period},
    )
    deadline = time.time() + timeout
    status = None
    doc_id = None
    while time.time() < deadline:
        out = spapi.request("GET", f"/reports/2021-06-30/reports/{report_id}")
        status = out.get("processingStatus")
        if status == "DONE":
            doc_id = out.get("reportDocumentId")
            break
        if status in ("CANCELLED", "FATAL"):
            break
        time.sleep(poll_every)
    else:
        raise TimeoutError(f"report {report_id} non pronto entro {timeout}s (ultimo stato: {status})")

    if status == "CANCELLED":
        return []  # nessun dato per questo ASIN/periodo: non e' un errore
    if status == "FATAL":
        raise RuntimeError(f"report {report_id} terminato FATAL")
    if not doc_id:
        raise RuntimeError(f"report {report_id} DONE ma senza reportDocumentId")

    text = spapi.download_report_document(doc_id)
    return _parse_document(text)


def _default_dates(period: str, start: Optional[str], end: Optional[str]) -> tuple:
    if start or end:
        if not (start and end):
            raise ValueError("--start e --end vanno passati insieme")
        return start, end
    if period == "WEEK":
        return _last_complete_week(datetime.date.today())
    raise ValueError(f"per --period {period} servono --start/--end espliciti "
                     f"allineati al calendario (il default automatico e' solo per WEEK)")


def run_market(market: str, period: str, start: str, end: str,
              asins: List[str], out_dir: str) -> Dict[str, Any]:
    marketplace_id = config.MARKETPLACES[market]
    print(f"\n=== {market} ({marketplace_id}) — periodo {period} {start} -> {end} — "
         f"{len(asins)} ASIN ===")

    by_asin: Dict[str, List[Dict[str, Any]]] = {}
    errors: Dict[str, str] = {}
    for i, asin in enumerate(asins, 1):
        print(f"  ({i}/{len(asins)}) {asin}...", end=" ", flush=True)
        try:
            rows = fetch_for_asin(asin, marketplace_id, period, start, end)
            by_asin[asin] = rows
            print(f"{len(rows)} query")
        except requests.HTTPError as exc:
            resp = exc.response
            code = resp.status_code if resp is not None else "?"
            body = resp.text[:300] if resp is not None else str(exc)
            errors[asin] = f"HTTP {code}: {body}"
            print(f"ERRORE (HTTP {code})")
        except Exception as exc:  # noqa: BLE001 - un ASIN che fallisce non deve fermare gli altri
            errors[asin] = str(exc)
            print(f"ERRORE ({exc})")

    n_rows = sum(len(v) for v in by_asin.values())
    print(f"  Totale: {n_rows} righe su {len(by_asin)} ASIN ok, {len(errors)} falliti.")

    out = {
        "marketplace": market, "period": period, "start": start, "end": end,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "by_asin": by_asin,
        "errors": errors,
    }
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{market}.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(f"  Salvato: {out_path}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Scarica il report Brand Analytics Search Query Performance per gli "
                    "ASIN attivi di uno o piu' mercati (pipeline completa, dopo il probe di accesso).")
    ap.add_argument("--marketplace", default=None,
                    help="Un solo mercato (IT/FR/DE/ES/UK). Default: tutti quelli in "
                         "config.ACTIVE_MARKETS (env ACTIVE_MARKETS)")
    ap.add_argument("--period", default="WEEK", choices=VALID_PERIODS)
    ap.add_argument("--start", default=None, help="YYYY-MM-DD (domenica se --period WEEK)")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (sabato se --period WEEK)")
    ap.add_argument("--data-dir", default="../public/data",
                    help="Dove leggere <MKT>.json (di weekly_analysis.py) per la lista ASIN attivi")
    ap.add_argument("--out-dir", default="reports/sqp",
                    help="Dove scrivere <MKT>.json di output (poi copiato in public/data/SQP_<MKT>.json)")
    ap.add_argument("--asin", action="append", default=None,
                    help="Limita a uno o piu' ASIN specifici invece di scoprirli da <MKT>.json "
                         "(ripetibile: --asin B0... --asin B0...)")
    args = ap.parse_args()

    missing = [n for n, v in (
        ("LWA_CLIENT_ID", config.LWA_CLIENT_ID), ("LWA_CLIENT_SECRET", config.LWA_CLIENT_SECRET),
        ("LWA_REFRESH_TOKEN", config.LWA_REFRESH_TOKEN)) if not v]
    if missing:
        print(f"Variabili d'ambiente mancanti: {', '.join(missing)}", file=sys.stderr)
        return 2

    try:
        start, end = _default_dates(args.period, args.start, args.end)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    markets = [args.marketplace.upper()] if args.marketplace else list(config.ACTIVE_MARKETS)
    unknown = [m for m in markets if m not in config.MARKETPLACES]
    if unknown:
        print(f"Marketplace sconosciuti: {', '.join(unknown)}. Noti: {', '.join(config.MARKETPLACES)}",
              file=sys.stderr)
        return 2

    any_run = False
    for market in markets:
        if args.asin:
            asins = [a.strip().upper() for a in args.asin if a.strip()]
        else:
            data = listing_signals.load_market_data(market, args.data_dir)
            if not data:
                print(f"[{market}] nessun {market}.json in {args.data_dir}: skip "
                     f"(lancia prima weekly_analysis.py, o passa --asin espliciti)")
                continue
            asins = listing_signals.all_advertised_asins(data)
        if not asins:
            print(f"[{market}] nessun ASIN attivo trovato: skip")
            continue
        run_market(market, args.period, start, end, asins, args.out_dir)
        any_run = True

    if not any_run:
        print("\nNessun mercato elaborato.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
