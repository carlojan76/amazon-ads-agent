#!/usr/bin/env python3
r"""
check_data_kiosk_access.py — Lupo & Felix

SOLO una verifica di accesso — non e' la pipeline completa (query + polling +
download) del dataset Search Query Performance (punto 2 del roadmap). Prima
di scrivere quella pipeline conviene saperlo: il dataset richiede Brand
Analytics attivo sull'account venditore E il ruolo giusto sull'app SP-API
("Data Kiosk" / "Brand Analytics", a seconda di come Seller Central lo
etichetta). Se manca uno dei due, qualunque codice scritto sopra e' lavoro
sprecato finche' l'autorizzazione non e' sistemata. Questo script lo scopre
in pochi secondi invece che a pipeline finita.

COME FUNZIONA IL PROBE (e perche' e' affidabile anche se la query sotto non
fosse perfetta): Data Kiosk e' REST che avvolge GraphQL (create query, poll
status, get document — stesso schema della Reports API gia' in spapi.py), e
come il resto di SP-API applica il controllo di autorizzazione PRIMA di
validare il corpo della richiesta. Quindi:
  - HTTP 403/401 alla creazione della query  -> problema di autorizzazione
    (manca il ruolo sull'app, o Brand Analytics non e' attivo). Non serve
    che la query sia scritta bene per ottenere questa risposta.
  - HTTP 400 con un errore di validazione GraphQL -> l'autorizzazione e' OK,
    ma la query (nome del dataset, versione, campi) va corretta. E' comunque
    una buona notizia sull'accesso.
  - 200 con un queryId, poi processingStatus FATAL -> l'errore arriva dopo:
    leggi il messaggio, spesso e' li' che si vede la causa precisa.
  - 200 fino a DONE -> accesso confermato, il dataset e' leggibile.

STRUTTURA DELLA QUERY (confermata su documentazione ufficiale SP-API): un
dataset "versioned domain" (es. analytics_searchQueryPerformance_2024_04_09)
va selezionato SENZA argomenti e con UN SOLO campo annidato al suo interno
(es. searchQueryPerformanceByAsin), ed e' quel campo annidato a portare gli
argomenti veri (startDate/endDate/marketplaceIds) e la selezione dei campi
di risposta. Mettere gli argomenti direttamente sul domain, o selezionare
piu' campi diretti sotto il domain, produce l'errore GraphQL "Versioned
domain cannot select multiple query fields." — e' l'errore che questo
script ha effettivamente ricevuto in un run reale prima di questa versione,
confermando che l'account e l'app SONO autorizzati (altrimenti sarebbe
arrivato un 401/403, non un 400 di validazione).

Cio' che NON e' confermato da documentazione, solo dedotto per analogia col
dataset gemello analytics_salesAndTraffic_2024_04_24 (che usa il campo
annidato salesAndTraffic**ByAsin**): il nome esatto del campo annidato qui
sotto, "searchQueryPerformanceByAsin", e la lista di campi di risposta
richiesti (searchQuery, searchQueryScore, searchQueryVolume, ...). Se il
nome del dataset/campo fosse cambiato o diverso, il probe ora dara' un
errore GraphQL specifico tipo "Cannot query field X" invece del generico
errore strutturale di prima — molto piu' facile da correggere. Controlla
la doc SP-API Data Kiosk (o il Data Kiosk Schema Explorer in Seller
Central) e rilancia con --query-file, che sostituisce la query di default
senza toccare il codice.

Uso:
  python check_data_kiosk_access.py --marketplace IT
  python check_data_kiosk_access.py --marketplace IT --start 2026-08-01 --end 2026-08-28
  python check_data_kiosk_access.py --marketplace IT --query-file mia_query.graphql

Non scarica ne' salva alcun documento: si ferma appena l'esito
sull'autorizzazione e' chiaro (o alla conferma che la query e' DONE).
"""

from __future__ import annotations

import argparse
import datetime
import sys
import time
from typing import Optional

import requests

import config
import spapi

# Nome del "versioned domain": va selezionato senza argomenti (vedi docstring).
DATASET = "analytics_searchQueryPerformance_2024_04_09"

# Campo annidato che porta gli argomenti veri: NOME NON CONFERMATO da
# documentazione, dedotto per analogia con salesAndTrafficByAsin del dataset
# gemello analytics_salesAndTraffic_2024_04_24. Se sbagliato, il probe ora
# dara' un errore GraphQL specifico ("Cannot query field ...") invece del
# generico errore strutturale di prima.
QUERY_FIELD = "searchQueryPerformanceByAsin"

DEFAULT_QUERY_TEMPLATE = """query SearchQueryPerformanceAccessProbe {{
  {dataset} {{
    {query_field}(
      startDate: "{start}"
      endDate: "{end}"
      marketplaceIds: ["{marketplace_id}"]
    ) {{
      startDate
      endDate
    }}
  }}
}}"""


def _default_query(marketplace_id: str, start: str, end: str) -> str:
    return DEFAULT_QUERY_TEMPLATE.format(
        dataset=DATASET, query_field=QUERY_FIELD, start=start, end=end,
        marketplace_id=marketplace_id)


def create_query(graphql: str) -> str:
    out = spapi.request("POST", "/dataKiosk/2023-11-15/queries", json_body={"query": graphql})
    return out["queryId"]


def poll_query(query_id: str, poll_every: int = 10, timeout: int = 180) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = spapi.request("GET", f"/dataKiosk/2023-11-15/queries/{query_id}")
        status = last.get("processingStatus")
        print(f"  processingStatus={status}")
        if status in ("DONE", "FATAL", "CANCELLED"):
            if status != "DONE":
                # Il dettaglio (se Amazon lo espone) e' l'unica cosa che distingue
                # "dataset non autorizzato" da "query scritta male": stamparlo per
                # intero, non solo lo status.
                print(f"  dettaglio: {last}")
            return last
        time.sleep(poll_every)
    print(f"  (timeout dopo {timeout}s, ultimo stato noto: {last.get('processingStatus')})")
    return last


def _print_http_error(exc: requests.HTTPError, phase: str) -> None:
    resp = exc.response
    code = resp.status_code if resp is not None else "?"
    body = resp.text[:1000] if resp is not None else str(exc)
    print(f"\n{phase}: HTTP {code}")
    print(body)
    if code in (401, 403):
        print(
            "\n>>> DIAGNOSI: accesso negato prima ancora di validare la query. La causa "
            "piu' probabile e' che manchi il ruolo giusto sull'app SP-API (Data Kiosk / "
            "Brand Analytics in Developer Central) oppure che Brand Analytics non sia "
            "attivo su questo account venditore. Verifica entrambi in Seller Central e "
            "Developer Central, poi ri-autorizza l'app e aggiorna LWA_REFRESH_TOKEN se "
            "necessario prima di rilanciare questo script.")
    elif code == 400:
        print(
            "\n>>> DIAGNOSI: la richiesta e' stata AUTORIZZATA (altrimenti sarebbe stata "
            "un 401/403), ma la query GraphQL non e' valida per il dataset attuale. "
            "Controlla il nome/versione del dataset sulla documentazione SP-API Data "
            "Kiosk corrente e rilancia con --query-file. Buona notizia: l'accesso al "
            "dataset di per se' non sembra essere il problema.")
    else:
        print(f"\n>>> DIAGNOSI: errore non riconducibile ad autorizzazione o a un dataset "
              f"sbagliato (HTTP {code}). Leggi il corpo della risposta sopra.")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Verifica SOLO se questo account puo' leggere il dataset Data Kiosk "
                    "Search Query Performance, prima di scrivere la pipeline completa.")
    ap.add_argument("--marketplace", default="IT", help="IT/FR/DE/ES/UK")
    ap.add_argument("--start", default=None, help="YYYY-MM-DD (default: 28 giorni fa)")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (default: oggi)")
    ap.add_argument("--query-file", default=None,
                    help="File con una query GraphQL alternativa, se quella di default "
                         "risulta scaduta (nome/versione dataset cambiati)")
    ap.add_argument("--poll-every", type=int, default=10)
    ap.add_argument("--timeout", type=int, default=180)
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

    today = datetime.date.today()
    end = args.end or today.isoformat()
    start = args.start or (today - datetime.timedelta(days=28)).isoformat()

    if args.query_file:
        with open(args.query_file, encoding="utf-8") as fh:
            graphql = fh.read()
        print(f"Query da {args.query_file}.")
    else:
        graphql = _default_query(marketplace_id, start, end)
        print(f"Query di default (dataset presunto: {DATASET}, campo presunto: "
              f"{QUERY_FIELD}, periodo {start} -> {end}).")
        print("Se non e' quella giusta per il tuo account, usa --query-file.\n")

    print(f"Marketplace: {market} ({marketplace_id})\n")
    print("--- 1. Creo la query ---")
    try:
        query_id = create_query(graphql)
    except requests.HTTPError as exc:
        _print_http_error(exc, "Creazione query")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"Errore inatteso nella creazione della query: {exc}")
        return 1
    print(f"  queryId: {query_id}")

    print("\n--- 2. Polling ---")
    try:
        result = poll_query(query_id, poll_every=args.poll_every, timeout=args.timeout)
    except requests.HTTPError as exc:
        _print_http_error(exc, "Polling query")
        return 1

    status = result.get("processingStatus")
    if status == "DONE":
        doc_id = result.get("dataDocumentId")
        print(f"\n>>> ACCESSO CONFERMATO: la query e' arrivata a DONE (dataDocumentId={doc_id}).")
        print("Il dataset e' leggibile su questo account con queste credenziali: la pipeline")
        print("completa (query mirata + download + parsing) ha senso da scrivere.")
        return 0
    if status == "FATAL":
        print(f"\n>>> ACCESSO INCERTO: la query e' stata accettata ma e' terminata FATAL.")
        print("Il dettaglio dell'errore (se Amazon lo restituisce) e' nella risposta qui sopra")
        print("o va recuperato con una GET su /dataKiosk/2023-11-15/queries/{query_id}: puo'")
        print("essere sia un problema di autorizzazione al dataset specifico, sia la query")
        print("stessa. Se il messaggio parla di permessi/dataset, e' il punto 2 del roadmap")
        print("che si ferma qui; se parla di sintassi/campi, correggi la query e rilancia.")
        return 1
    print(f"\n>>> Esito non conclusivo (status={status}). Rilancia con --timeout piu' alto "
         f"se la query era ancora IN_PROGRESS.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
