#!/usr/bin/env python3
r"""
check_quality.py — Lupo & Felix

Controllo OFFLINE (nessuna chiamata API, nessuna credenziale richiesta) sulla
copy che `build_context.py --generate` ha scritto in listings/content/, PRIMA
di passarla a `update_listing.py --apply`.

Il system prompt di generate_copy() (COPY_CONTRACT, in build_context.py) chiede
a Claude di rispettare i limiti carattere, usare i termini che convertono ed
evitare quelli che non convertono — ma sono istruzioni testuali: Claude puo'
non rispettarle e nessuno se ne accorge finche' non arriva un 400 dalla SP-API
o, peggio, finche' la scheda non e' gia' pubblicata. Questo script rilegge lo
stesso context pack che Claude ha ricevuto (listings/context/<ASIN>_<MKT>.json)
e verifica il risultato:

  1. Limiti caratteri REALI (title/bullet/description) — riusa
     update_listing.validate_lengths(), la stessa funzione che userebbe la
     PATCH vera: niente doppio standard tra "il check dice ok" e "la API
     accetta".
  2. Attributi gestiti: item_name, bullet_point, product_description (stesso
     controllo che generate_copy() fa gia' prima di salvare, ripetuto qui nel
     caso il file sia stato editato a mano dopo).
  3. Termini che convertono (search_terms_meta.top_terms nel context pack):
     devono comparire tutti nel testo; i primi due (per acquisti/click, e'
     l'ordine con cui il context pack li elenca) devono comparire nel titolo.
     Questo controllo e' vincolante SOLO se search_terms_meta.scope == "asin":
     se i termini sono dell'intero account (nessun dato ads ancora per questo
     ASIN), il brief stesso li tratta solo come indizio di linguaggio, non
     come obbligo, e qui li segnaliamo come warning invece che errore.
  4. Termini che NON convertono (search_terms_meta.avoid_terms): mai nel
     titolo (errore). Altrove nel testo e' un warning da rileggere a mano —
     puo' essere pertinente, lo dice anche il brief.
  5. Firma del brand ("Lupo & Felix") in chiusura di descrizione.
  6. Query Search Query Performance con acquisti reali nel periodo
     (sqp_meta.purchase_confirmed_terms) assenti dal testo: SEMPRE warning,
     mai errore — segnale piu' debole dei termini che convertono di Ads (un
     solo periodo, campione spesso piccolo, nessuna attribuzione ad group).

Uso:
  python check_quality.py --content listings/content/B0G5JC2YZ2_IT.json
  python check_quality.py --content listings/content/B0G5JC2YZ2_IT.json \
                          --context listings/context/B0G5JC2YZ2_IT.json
  python check_quality.py --content listings/content     # tutti i .json della cartella

Se --context non e' passato, si cerca il file con lo stesso nome sotto
listings/context/ (la stessa convenzione con cui build_context.py e
update_listing.py si scambiano i file).

Exit code: 1 se c'e' almeno un ERROR (utilizzabile come gate, es. in
apply-listing.yml prima dell'--apply), 0 altrimenti. I WARNING non fanno
fallire il comando: sono punti da rileggere a mano, non blocchi automatici.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import update_listing as ul  # riusa validate_lengths/SUPPORTED_ATTRIBUTES: niente doppio standard


# --------------------------------------------------------------------------- IO

def _load(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _context_path_for(content_path: str) -> str:
    """listings/content/<X>.json -> listings/context/<X>.json.

    Stessa convenzione di cartelle usata da build_context.py per scrivere i due
    file e dai messaggi che stampa a fine corsa ("Verifica con: ...")."""
    d, name = os.path.split(content_path)
    if os.path.basename(d) == "content":
        d = os.path.join(os.path.dirname(d), "context")
    return os.path.join(d, name)


def _full_text(attrs: Dict[str, Any]) -> str:
    """item_name + bullet_point + product_description, minuscolo, per il match dei termini."""
    bp = attrs.get("bullet_point")
    bullets = bp if isinstance(bp, list) else ([bp] if isinstance(bp, str) else [])
    parts = [attrs.get("item_name", "")] + list(bullets) + [attrs.get("product_description", "")]
    return " \n ".join(p for p in parts if isinstance(p, str)).lower()


# --------------------------------------------------------------------- i controlli
# Ogni check ritorna una lista di stringhe "SEVERITA'  messaggio".
# SEVERITA': ERROR (fa fallire il comando), WARNING (da rileggere a mano),
# INFO (solo contesto, non conta ne' per l'exit code ne' per il totale warning).

def check_supported_attrs(attrs: Dict[str, Any]) -> List[str]:
    bad = set(attrs) - set(ul.SUPPORTED_ATTRIBUTES)
    if bad:
        return [f"ERROR    attributi non gestiti nel content JSON: {', '.join(sorted(bad))} "
                f"(gestiti: {', '.join(ul.SUPPORTED_ATTRIBUTES)})"]
    return []


def check_lengths(attrs: Dict[str, Any], max_lengths: Dict[str, int]) -> List[str]:
    return [f"ERROR    limite caratteri: {p}" for p in ul.validate_lengths(attrs, max_lengths or {})]


def check_converting_terms(attrs: Dict[str, Any], meta: Dict[str, Any]) -> List[str]:
    top_terms = meta.get("top_terms") or []
    if not top_terms:
        return []
    scope = meta.get("scope")
    title = (attrs.get("item_name") or "").lower()
    full = _full_text(attrs)
    problems = []

    for term in top_terms:
        if term.lower() not in full:
            sev = "ERROR" if scope == "asin" else "WARNING"
            problems.append(
                f"{sev:<8} termine convertitore assente: '{term}' non compare ne' in titolo, "
                f"ne' nei bullet, ne' in descrizione")

    # "i primi due nel titolo" (COPY_CONTRACT) vale solo quando i termini sono
    # di QUESTO ASIN: se sono dell'intero account il brief li tratta solo come
    # indizio di linguaggio, non come obbligo di posizionamento nel titolo.
    if scope == "asin":
        for term in top_terms[:2]:
            if term.lower() not in title:
                problems.append(
                    f"WARNING  termine convertitore prioritario non nel titolo: '{term}' "
                    f"(e' tra i primi due per acquisti/click)")
    return problems


def check_avoid_terms(attrs: Dict[str, Any], meta: Dict[str, Any]) -> List[str]:
    avoid = meta.get("avoid_terms") or []
    if not avoid:
        return []
    title = (attrs.get("item_name") or "").lower()
    full = _full_text(attrs)

    # Un termine che non converte puo' essere una sotto-frase di uno che converte
    # (es. "amaca gatto" dentro "amaca gatto esterno"): mascheriamo prima i
    # termini convertitori, piu' lunghi per primi, cosi' non generano un falso
    # positivo sul termine da evitare che contengono.
    for t in sorted((meta.get("top_terms") or []), key=len, reverse=True):
        tl = t.lower()
        title = title.replace(tl, " " * len(tl))
        full = full.replace(tl, " " * len(tl))

    problems = []
    for term in avoid:
        t = term.lower()
        if t in title:
            problems.append(
                f"ERROR    termine che NON converte nel titolo: '{term}' "
                f"(traffico pagato, zero acquisti — non puo' stare nel titolo)")
        elif t in full:
            problems.append(
                f"WARNING  termine che NON converte presente nel testo: '{term}' "
                f"— verifica che la foto/il brief confermino davvero la pertinenza")
    return problems


def check_sqp_terms(attrs: Dict[str, Any], meta: Dict[str, Any]) -> List[str]:
    """Query dal report Brand Analytics Search Query Performance
    (sqp_meta.purchase_confirmed_terms nel context pack) su cui QUESTO ASIN
    ha gia' generato almeno un acquisto reale nel periodo — la scala delle
    quote e' confermata (0-100%, verificato su un report reale), ma il
    segnale resta piu' debole dei "termini che convertono" di Ads: qui e' UN
    solo periodo (di norma una settimana), campione spesso piccolo (anche un
    solo acquisto), e senza l'attribuzione esplicita via ad group. Per questo
    resta SEMPRE un WARNING, mai un ERROR, coerente con l'istruzione che il
    COPY_CONTRACT da' gia' al modello: un'opportunita' da valutare, non un
    obbligo di posizionamento."""
    terms = meta.get("purchase_confirmed_terms") or []
    if not terms:
        return []
    full = _full_text(attrs)
    problems = []
    for t in terms:
        query = (t.get("query") or "").strip()
        if not query or query.lower() in full:
            continue
        problems.append(
            f"WARNING  query Search Query Performance con acquisti reali ma assente dal testo: "
            f"'{query}' ({t.get('purchases')} acquisti, volume {t.get('volume')} nel periodo) "
            f"— opportunita' da valutare, non un obbligo")
    return problems


def check_brand_signature(attrs: Dict[str, Any]) -> List[str]:
    desc = (attrs.get("product_description") or "").strip()
    if desc and "lupo & felix" not in desc[-120:].lower():
        return ["WARNING  la descrizione non chiude con la firma del brand (\"Lupo & Felix\")"]
    return []


# ------------------------------------------------------------------------- runner

def check_one(content_path: str, context_path: Optional[str]) -> Tuple[int, int]:
    """Controlla un content JSON. Stampa il report, ritorna (n_error, n_warning)."""
    try:
        content = _load(content_path)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"\n[{content_path}]\n  ERROR    file non leggibile: {exc}")
        return 1, 0

    attrs = content.get("attributes")
    label = f"{content.get('asin', '?')}_{content.get('marketplace', '?')}"
    print(f"\n[{label}] {content_path}")

    if not isinstance(attrs, dict):
        print("  ERROR    manca la chiave 'attributes' (o non e' un oggetto): niente da controllare")
        return 1, 0

    ctx_path = context_path or _context_path_for(content_path)
    if not os.path.isfile(ctx_path):
        print(f"  ERROR    context pack non trovato: {ctx_path} (rigenera con build_context.py)")
        return 1, 0

    try:
        context = _load(ctx_path)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  ERROR    context pack non leggibile: {exc}")
        return 1, 0

    max_lengths = context.get("max_lengths") or {}
    meta = context.get("search_terms_meta") or {}

    problems = check_supported_attrs(attrs) + check_lengths(attrs, max_lengths)

    if meta.get("available"):
        problems += check_converting_terms(attrs, meta)
        if "avoid_terms" in meta:
            problems += check_avoid_terms(attrs, meta)
        else:
            problems.append(
                "WARNING  context pack generato prima del controllo sui termini che non "
                "convertono (manca 'avoid_terms'): rigeneralo con build_context.py per includerlo")
    else:
        problems.append(f"INFO     nessun dato search term nel context pack "
                        f"({meta.get('reason', 'motivo non specificato')})")

    sqp_meta = context.get("sqp_meta") or {}
    if sqp_meta.get("available"):
        problems += check_sqp_terms(attrs, sqp_meta)
    else:
        problems.append(f"INFO     nessun dato Search Query Performance nel context pack "
                        f"({sqp_meta.get('reason', 'motivo non specificato')})")

    problems += check_brand_signature(attrs)

    real = [p for p in problems if not p.startswith("INFO")]
    if not problems:
        print("  OK — nessun problema rilevato")
    else:
        for p in problems:
            print(f"  {p}")
        if not real:
            print("  (nessun ERROR/WARNING — solo informazioni)")

    n_error = sum(1 for p in problems if p.startswith("ERROR"))
    n_warning = sum(1 for p in problems if p.startswith("WARNING"))
    return n_error, n_warning


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Controllo offline sulla copy generata da build_context.py --generate "
                    "(limiti caratteri, termini che convertono, termini da evitare, firma brand).")
    ap.add_argument("--content", required=True,
                    help="JSON della copy generata (listings/content/<ASIN>_<MKT>.json), "
                         "oppure una cartella: controlla tutti i .json dentro")
    ap.add_argument("--context",
                    help="Context pack da usare (default: stesso nome sotto listings/context/). "
                         "Non utilizzabile insieme a --content su una cartella.")
    args = ap.parse_args()

    if os.path.isdir(args.content):
        if args.context:
            print("ERRORE: --context non e' compatibile con --content su una cartella", file=sys.stderr)
            return 2
        paths = sorted(glob.glob(os.path.join(args.content, "*.json")))
        if not paths:
            print(f"Nessun .json in {args.content}", file=sys.stderr)
            return 2
    else:
        if not os.path.isfile(args.content):
            print(f"ERRORE: {args.content} non esiste", file=sys.stderr)
            return 2
        paths = [args.content]

    total_error = total_warning = 0
    for path in paths:
        n_error, n_warning = check_one(path, args.context)
        total_error += n_error
        total_warning += n_warning

    print(f"\n{'=' * 70}")
    print(f"{len(paths)} file controllati — {total_error} error, {total_warning} warning")
    if total_error:
        print("Non procedere con update_listing.py --apply finche' gli ERROR non sono risolti.")

    return 1 if total_error else 0


if __name__ == "__main__":
    sys.exit(main())
