#!/usr/bin/env python3
r"""
check_search_query_performance_access.py — Lupo & Felix

SOLO una verifica di accesso — non e' la pipeline completa (report + polling
+ download + parsing) del dataset Search Query Performance (punto 2 del
roadmap keyword). Prima di scrivere quella pipeline conviene saperlo: il
report richiede il ruolo Brand Analytics sull'app SP-API E la registrazione
dell'account venditore in Amazon Brand Registry. Se manca uno dei due,
qualunque codice scritto sopra e' lavoro sprecato finche' l'autorizzazione
non e' sistemata. Questo script lo scopre in pochi secondi invece che a
pipeline finita.

CORREZIONE DI ROTTA rispetto al probe precedente (check_data_kiosk_access.py):
quel probe interrogava Data Kiosk (l'API GraphQL) e ha ricevuto un HTTP 400
"Query 'analytics_searchQueryPerformance_2024_04_09' is not supported" — non
un errore di sintassi, ma la conferma che quel dataset NON esiste in Data
Kiosk. Verificato sulla documentazione ufficiale SP-API (Report Type Values
- Analytics Reports) e su una fonte indipendente: Search Query Performance
e' un report della Reports API CLASSICA — lo stesso schema create/poll/
download gia' usato altrove in questo progetto (spapi.py, gia' esteso qui
per supportare reportOptions) — con:
  reportType:    GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT
  reportOptions: {"asin": "<ASIN>", "reportPeriod": "WEEK|MONTH|QUARTER"}
  dataStartTime / dataEndTime allineati ai confini del periodo (per WEEK:
  dataStartTime deve essere una domenica, dataEndTime il sabato successivo;
  niente richieste a cavallo di due periodi).
Data Kiosk resta valido per altri dataset (Sales and Traffic, Economics,
Vendor Analytics) ma non per questo — check_data_kiosk_access.py non va
buttato, semplicemente non e' lo strumento giusto per Search Query
Performance.

COME FUNZIONA IL PROBE: come tutta la Reports API, l'autorizzazione viene
controllata PRIMA di elaborare il report. Quindi:
  - HTTP 401/403 alla creazione del report -> problema di autorizzazione
    (manca il ruolo Brand Analytics sull'app SP-API, o l'account non e'
    registrato in Amazon Brand Registry).
  - HTTP 400 -> l'autorizzazione e' probabilmente OK, ma un parametro (ASIN,
    reportPeriod, allineamento delle date al calendario) va corretto.
  - 200 con reportId, poi processingStatus CANCELLED -> nessun dato per
    quell'ASIN/periodo: normale (es. periodo senza vendite/ricerche), NON un
    errore di permessi.
  - 200 fino a DONE -> accesso confermato, il report e' generabile per
    questo ASIN.

Uso:
  python check_search_query_performance_access.py --marketplace IT --asin B0XXXXXXXX
  python check_search_query_performance_access.py --marketplace IT --asin B0XXXXXXXX --period MONTH
  python check_search_query_performance_access.py --marketplace IT --asin B0XXXXXXXX --start 2026-08-09 --end 2026-08-15

Non scarica il documento del report: si ferma appena l'esito
sull'autorizzazione e' chiaro (o alla conferma che il report e' DONE).
"""

from __future__ import annotations

import argparse
import datetime
import sys
import time

import requests

import config
import spapi

REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT"
VALID_PERIODS = ("WEEK", "MONTH", "QUARTER")


def _last_complete_week(today: datetime.date, lag_weeks: int = 2) -> tuple[str, str]:
    """Domenica -> sabato della settimana civile piu' recente considerata
    completa, con un margine (`lag_weeks` settimane) per il ritardo di
    elaborazione dati di Amazon. Restituisce (start, end) come YYYY-MM-DD.
    Se il probe da' un esito non conclusivo per date troppo recenti, rilancia
    con --start/--end espliciti (devono restare domenica -> sabato)."""
    # Saturday = weekday() 5 (Monday=0). La settimana corrente non e' mai
    # "completa": se oggi e' sabato, partiamo comunque dal sabato precedente.
    days_since_saturday = (today.weekday() - 5) % 7
    if days_since_saturday == 0:
        days_since_saturday = 7
    last_saturday = today - datetime.timedelta(days=days_since_saturday)
    end = last_saturday - datetime.timedelta(weeks=lag_weeks - 1)
    start = end - datetime.timedelta(days=6)
    return start.isoformat(), end.isoformat()


def _print_http_error(exc: requests.HTTPError, phase: str) -> None:
    resp = exc.response
    code = resp.status_code if resp is not None else "?"
    body = resp.text[:1000] if resp is not None else str(exc)
    print(f"\n{phase}: HTTP {code}")
    print(body)
    if code in (401, 403):
        print(
            "\n>>> DIAGNOSI: accesso negato prima ancora di elaborare il report. La causa "
            "piu' probabile e' che manchi il ruolo Brand Analytics sull'app SP-API "
            "(Developer Central) oppure che l'account venditore non sia registrato in "
            "Amazon Brand Registry. Verifica entrambi, poi ri-autorizza l'app e aggiorna "
            "LWA_REFRESH_TOKEN se necessario prima di rilanciare questo script.")
    elif code == 400:
        print(
            "\n>>> DIAGNOSI: la richiesta e' probabilmente AUTORIZZATA (altrimenti sarebbe "
            "stata un 401/403), ma un parametro non e' valido: ASIN, reportPeriod, oppure "
            "le date non allineate al calendario (per WEEK: dataStartTime deve essere una "
            "domenica, dataEndTime il sabato successivo, senza superare 7 giorni). Correggi "
            "e rilancia con --start/--end o --period.")
    else:
        print(f"\n>>> DIAGNOSI: errore non riconducibile ad autorizzazione o a parametri "
              f"sbagliati (HTTP {code}). Leggi il corpo della risposta sopra.")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Verifica SOLO se questo account puo' generare il report Brand Analytics "
                    "Search Query Performance per un ASIN, prima di scrivere la pipeline completa.")
    ap.add_argument("--marketplace", default="IT", help="IT/FR/DE/ES/UK")
    ap.add_argument("--asin", required=True, help="ASIN da testare (un solo ASIN per il probe)")
    ap.add_argument("--period", default="WEEK", choices=VALID_PERIODS)
    ap.add_argument("--start", default=None,
                    help="YYYY-MM-DD, deve essere una domenica se --period WEEK "
                         "(default: settimana civile completa piu' recente, con margine)")
    ap.add_argument("--end", default=None,
                    help="YYYY-MM-DD, deve essere il sabato di --start se --period WEEK")
    ap.add_argument("--poll-every", type=int, default=15)
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    market = args.marketplace.upper()
    if market not in config.MARKETPLACES:
        print(f"Marketplace '{market}' sconosciuto. Noti: {', '.join(config.MARKETPLACES)}",
              file=sys.stderr)
        return 2
    marketplace_id = config.MARKETPLACES[market]

    missing = [n for n, v in (
        ("LWA_CLIENT_ID", config.LWA_CLIENT_ID), ("LWA_CLIENT_SECRET", config.LWA_CLIENT_SECRET),
        ("LWA_REFRESH_TOKEN", config.LWA_REFRESH_TOKEN)) if not v]
    if missing:
        print(f"Variabili d'ambiente mancanti: {', '.join(missing)}", file=sys.stderr)
        return 2

    if (args.start is None) != (args.end is None):
        print("--start e --end vanno passati insieme (o nessuno dei due).", file=sys.stderr)
        return 2

    if args.start:
        start, end = args.start, args.end
    elif args.period == "WEEK":
        start, end = _last_complete_week(datetime.date.today())
    else:
        print(f"Per --period {args.period} servono --start/--end espliciti allineati al "
              f"calendario (il default automatico e' calcolato solo per WEEK).", file=sys.stderr)
        return 2

    print(f"Marketplace: {market} ({marketplace_id})")
    print(f"ASIN: {args.asin} | periodo: {args.period} | {start} -> {end}\n")

    print("--- 1. Creo il report ---")
    try:
        report_id = spapi.create_report(
            REPORT_TYPE, [marketplace_id],
            data_start=f"{start}T00:00:00Z", data_end=f"{end}T23:59:59Z",
            report_options={"asin": args.asin, "reportPeriod": args.period},
        )
    except requests.HTTPError as exc:
        _print_http_error(exc, "Creazione report")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"Errore inatteso nella creazione del report: {exc}")
        return 1
    print(f"  reportId: {report_id}")

    print("\n--- 2. Polling ---")
    deadline = time.time() + args.timeout
    status = None
    while time.time() < deadline:
        try:
            out = spapi.request("GET", f"/reports/2021-06-30/reports/{report_id}")
        except requests.HTTPError as exc:
            _print_http_error(exc, "Polling report")
            return 1
        status = out.get("processingStatus")
        print(f"  processingStatus={status}")
        if status in ("DONE", "CANCELLED", "FATAL"):
            if status != "DONE":
                print(f"  dettaglio: {out}")
            break
        time.sleep(args.poll_every)
    else:
        print(f"  (timeout dopo {args.timeout}s, ultimo stato noto: {status})")

    if status == "DONE":
        doc_id = out.get("reportDocumentId")
        print(f"\n>>> ACCESSO CONFERMATO: il report e' arrivato a DONE (reportDocumentId={doc_id}).")
        print("Il report e' generabile su questo account con queste credenziali: la pipeline")
        print("completa (report mirato + download + parsing) ha senso da scrivere.")
        return 0
    if status == "CANCELLED":
        print(f"\n>>> ACCESSO PROBABILMENTE CONFERMATO, ma nessun dato per questo ASIN/periodo.")
        print("CANCELLED e' lo stato che Amazon usa quando non c'e' abbastanza traffico di")
        print("ricerca da riportare per l'ASIN/periodo scelto (non un errore di permessi: se")
        print("fosse un problema di autorizzazione lo avresti visto al passo 1, con un 401/403).")
        print("Riprova con un periodo diverso o un ASIN con piu' storico prima di concludere")
        print("che l'accesso non funzioni.")
        return 0
    if status == "FATAL":
        print(f"\n>>> ACCESSO INCERTO: il report e' stato accettato ma e' terminato FATAL.")
        print("Puo' essere un problema di autorizzazione al report specifico, oppure un")
        print("parametro non valido. Leggi il dettaglio sopra.")
        return 1
    print(f"\n>>> Esito non conclusivo (status={status}). Rilancia con --timeout piu' alto "
         f"se il report era ancora IN_PROGRESS/IN_QUEUE.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
