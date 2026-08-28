#!/usr/bin/env python3
"""Controlla la COMPLETEZZA di un export di amazon_ads_api.py.

Serve a rispondere a una domanda sola: questo file e' utilizzabile, o e' stato
troncato? Verifica i punti in cui il fetcher ha gia' sbagliato in passato.

Uso:
    python check_data.py amazon_ads_IT_20260828_1530.json
"""
import json
import sys
from pathlib import Path


def main():
    if len(sys.argv) < 2:
        sys.exit("Uso: python check_data.py <file.json>")
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    meta = data.get("_meta", {})
    problems = []

    print(f"\n{path.name}")
    print(f"  marketplace {meta.get('marketplace', '?')} | ultimi {meta.get('days', '?')} giorni "
          f"| scaricato {str(meta.get('fetched_at', '?'))[:16]}")

    # 1. Liste troncate: il vecchio bug si riconosce da un conteggio multiplo esatto di 100.
    print("\n  Liste strutturali")
    for key, label in [("campaigns", "campagne"), ("adGroups", "ad group"),
                       ("keywords", "keyword"), ("negativeKeywords", "negative"), ("targets", "target")]:
        n = len(data.get(key, []))
        flag = ""
        if n and n % 100 == 0:
            flag = "  <-- sospetto: multiplo esatto di 100, potrebbe essere troncata"
            problems.append(f"{label}: {n} (multiplo di 100)")
        print(f"    {label:12} {n:5}{flag}")

    # 2. Report performance: se sono tutti vuoti, il file non serve a nulla.
    print("\n  Report performance")
    total_rows = 0
    for key, label in [("campaigns", "campagne"), ("keywords", "keyword"),
                       ("searchTerms", "search term"), ("targeting", "targeting"),
                       ("products", "prodotti")]:
        n = len(data.get("reports", {}).get(key, []))
        total_rows += n
        print(f"    {label:12} {n:5} righe")
    if total_rows == 0:
        problems.append("nessuna riga in NESSUN report: spesa e vendite risultano tutte a zero")
        days = meta.get("days_requested") or meta.get("days")
        if isinstance(days, int) and days > 31:
            problems.append(f"intervallo di {days} giorni: l'API ne accetta al massimo 31, "
                            f"le richieste vengono rifiutate")

    if meta.get("reports_incomplete"):
        problems.append("il fetcher ha segnalato dati incompleti")
        print("\n  ATTENZIONE: dati incompleti")
        for k, label in [("reports_timed_out", "timeout"), ("reports_skipped_425", "saltati (425)"),
                         ("reports_failed", "rifiutati da Amazon"),
                         ("incomplete_lists", "liste troncate")]:
            if meta.get(k):
                print(f"    {label}: {', '.join(meta[k])}")

    # 3. Il join dei bid: senza sovrapposizione tra lista e report, i bid restano a zero.
    struct = {str(k.get("keywordId")) for k in data.get("keywords", []) if k.get("keywordId")}
    report = {str(r.get("keywordId")) for r in data.get("reports", {}).get("keywords", []) if r.get("keywordId")}
    overlap = struct & report
    print("\n  Join dei bid (keyword del report presenti nella lista strutturale)")
    if not report:
        print("    nessuna keyword nel report: niente da unire")
    else:
        pct = len(overlap) / len(report) * 100
        print(f"    {len(overlap)}/{len(report)} ({pct:.0f}%)")
        if pct < 90:
            problems.append(f"solo il {pct:.0f}% delle keyword del report ha il bid: il fetch e' incompleto")
        bids = [k.get("bid") for k in data.get("keywords", []) if str(k.get("keywordId")) in overlap]
        if bids:
            nonzero = sum(1 for b in bids if b)
            print(f"    di queste, {nonzero} hanno un bid diverso da zero")

    # 4. Copertura: le campagne con spesa hanno le loro keyword?
    camp_with_kw = {str(k.get("campaignId")) for k in data.get("keywords", [])}
    camp_total = {str(c.get("campaignId")) for c in data.get("campaigns", [])}
    if camp_total:
        print(f"\n  Campagne con almeno una keyword scaricata: {len(camp_with_kw & camp_total)}/{len(camp_total)}")

    print()
    if problems:
        print("  ESITO: dati da NON usare per decisioni sui bid")
        for p in problems:
            print(f"    - {p}")
        print()
        return 1
    print("  ESITO: il file sembra completo\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
