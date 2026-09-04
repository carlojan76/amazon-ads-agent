"""Segnali dal report search term di Amazon Ads, per il brief della copy.

Legge i JSON che `weekly_analysis.py` pubblica in `public/data/<MKT>.json` e ne
ricava i termini di ricerca reali con click, conversioni, spesa e ACoS.

Perche' questa fonte e non un tool di keyword research: sono le parole che i
clienti hanno digitato *e* su cui hanno comprato questo prodotto, non stime di
volume. Se un termine converte, deve stare nel titolo o nei primi bullet.

Attribuzione all'ASIN: le righe search term portano `adGroupId` ma non l'ASIN.
Il report prodotti (`reports.products`) ha sia `adGroupId` sia `advertisedAsin`,
quindi si costruisce la mappa adGroup -> ASIN e si filtra. Se l'ASIN non ha
ancora speso in ads, si ricade sui termini dell'intero marketplace, ma il blocco
lo dichiara esplicitamente cosi' il modello non li scambia per dati del prodotto.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

# Chiavi numeriche da sommare quando lo stesso termine compare in piu' ad group.
_SUM_FIELDS = ("impressions", "clicks", "spend", "sales7d", "purchases7d",
               "unitsSoldClicks7d")


def _num(value: Any) -> float:
    """I report Amazon restituiscono None quando la metrica non e' disponibile."""
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def load_market_data(marketplace: str, data_dir: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(data_dir, f"{marketplace.upper()}.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def all_advertised_asins(data: Dict[str, Any]) -> List[str]:
    """ASIN distinti pubblicizzati in questo mercato (fonte: reports.products,
    lo stesso report che alimenta adgroups_for_asin). E' la lista di 'ASIN
    attivi' che fetch_search_query_performance.py usa per sapere su quali
    prodotti girare, senza bisogno di un catalogo statico separato."""
    products = (data.get("reports") or {}).get("products") or []
    seen: List[str] = []
    seen_set = set()
    for row in products:
        asin = str(row.get("advertisedAsin", "")).strip().upper()
        if asin and asin not in seen_set:
            seen_set.add(asin)
            seen.append(asin)
    return seen


def adgroups_for_asin(data: Dict[str, Any], asin: str) -> set:
    """Ad group in cui questo ASIN e' pubblicizzato."""
    products = (data.get("reports") or {}).get("products") or []
    target = (asin or "").strip().upper()
    return {
        str(row.get("adGroupId"))
        for row in products
        if str(row.get("advertisedAsin", "")).strip().upper() == target
        and row.get("adGroupId") is not None
    }


def collect_search_terms(data: Dict[str, Any],
                         asin: Optional[str] = None) -> Tuple[List[Dict[str, Any]], str]:
    """Ritorna (righe aggregate per termine, scope).

    scope vale "asin" se si e' riusciti a filtrare sugli ad group dell'ASIN,
    "marketplace" se si e' ricaduti su tutto il mercato, "" se non c'e' nulla.
    """
    rows = (data.get("reports") or {}).get("searchTerms") or []
    if not rows:
        return [], ""

    scope = "marketplace"
    if asin:
        groups = adgroups_for_asin(data, asin)
        filtered = [r for r in rows if str(r.get("adGroupId")) in groups]
        if filtered:
            rows, scope = filtered, "asin"

    agg: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        term = (row.get("searchTerm") or "").strip()
        if not term:
            continue
        entry = agg.setdefault(term, {"searchTerm": term, "matchTypes": set(),
                                      **{f: 0.0 for f in _SUM_FIELDS}})
        for field in _SUM_FIELDS:
            entry[field] += _num(row.get(field))
        if row.get("matchType"):
            entry["matchTypes"].add(str(row["matchType"]))

    out = []
    for entry in agg.values():
        clicks, spend, sales = entry["clicks"], entry["spend"], entry["sales7d"]
        entry["cpc"] = spend / clicks if clicks else 0.0
        entry["acos"] = spend / sales if sales else None
        entry["cvr"] = entry["purchases7d"] / clicks if clicks else 0.0
        entry["matchTypes"] = sorted(entry["matchTypes"])
        out.append(entry)

    # Chi converte prima, poi chi ha traffico: e' l'ordine in cui servono al copy.
    out.sort(key=lambda e: (e["purchases7d"], e["clicks"], e["impressions"]),
             reverse=True)
    return out, scope


def converting_terms(terms: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [t for t in terms if t["purchases7d"] > 0]


def avoid_terms(terms: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Termini con click e spesa ma zero acquisti: traffico che paghiamo e non converte.

    Stesso ordine (spesa decrescente) con cui compaiono nel brief markdown, cosi'
    "avoid_terms" nel context pack rispecchia esattamente cio' che il modello ha letto."""
    out = [t for t in terms if t["purchases7d"] == 0 and t["clicks"] > 0]
    out.sort(key=lambda e: e["spend"], reverse=True)
    return out


def format_search_terms_md(terms: List[Dict[str, Any]], scope: str,
                           marketplace: str, asin: str,
                           top: int = 20, generated_at: str = "") -> str:
    """Blocco markdown da appendere al brief. Stringa vuota se non c'e' nulla."""
    if not terms:
        return ""

    converting = converting_terms(terms)
    if scope == "asin":
        intro = (f"Termini di ricerca reali su cui **questo ASIN** ({asin}) e' stato "
                 f"pubblicizzato su {marketplace}.")
    else:
        intro = (f"⚠️ Questo ASIN non ha ancora dati ads propri: i termini sotto sono "
                 f"dell'intero account su {marketplace} e valgono solo come contesto "
                 f"di brand, NON come performance di questo prodotto.")

    md = ["\n## Termini che convertono (report search term Amazon Ads)\n", intro]
    if generated_at:
        md.append(f"\n_Dati al {generated_at[:10]}._")
    md.append("")

    if converting:
        md.append("**Hanno generato acquisti — devono comparire nel titolo o nei primi bullet:**\n")
        md.append("| Termine | Click | Acquisti | CVR | CPC | ACoS |")
        md.append("|---|---:|---:|---:|---:|---:|")
        for t in converting[:top]:
            acos = f"{t['acos'] * 100:.0f}%" if t["acos"] is not None else "-"
            md.append(f"| {t['searchTerm']} | {t['clicks']:.0f} | {t['purchases7d']:.0f} "
                      f"| {t['cvr'] * 100:.0f}% | {t['cpc']:.2f} € | {acos} |")
        md.append("")

    spenders = avoid_terms(terms)
    if spenders:
        md.append("**Traffico che NON converte — la copy non risponde a questa intenzione, "
                  "o il prodotto non e' pertinente:**\n")
        for t in spenders[:top]:
            md.append(f"- {t['searchTerm']} — {t['clicks']:.0f} click, "
                      f"{t['spend']:.2f} € spesi, 0 acquisti")
        md.append("")

    md.append("Usa i termini della prima lista con le parole esatte dei clienti. "
              "Per la seconda: se l'intenzione e' pertinente al prodotto, chiariscila "
              "nella copy; se non lo e', non forzarla nel testo.")
    return "\n".join(md) + "\n"


def search_terms_section(marketplace: str, asin: str, data_dir: str,
                         top: int = 20) -> Tuple[str, Dict[str, Any]]:
    """Wrapper usato da build_context: ritorna (markdown, meta)."""
    data = load_market_data(marketplace, data_dir)
    if not data:
        return "", {"available": False, "reason": f"nessun {marketplace}.json in {data_dir}"}

    terms, scope = collect_search_terms(data, asin)
    if not terms:
        return "", {"available": False, "reason": "report search term vuoto"}

    md = format_search_terms_md(terms, scope, marketplace, asin, top=top,
                                generated_at=data.get("generated_at", ""))
    meta = {
        "available": True,
        "scope": scope,
        "terms_total": len(terms),
        "terms_converting": len(converting_terms(terms)),
        "top_terms": [t["searchTerm"] for t in converting_terms(terms)[:top]],
        # Stessi termini mostrati nel brief sotto "traffico che NON converte":
        # check_quality.py li usa per segnalare se sono finiti nel titolo.
        "avoid_terms": [t["searchTerm"] for t in avoid_terms(terms)[:top]],
    }
    return md, meta


# --------------------------------------------------------- Search Query Performance
#
# Fonte separata da quella sopra: i "termini che convertono" arrivano dai TUOI
# report Amazon Ads (solo query su cui hai gia' fatto pubblicita'). Questa
# sezione arriva invece dal report Brand Analytics "Search Query Performance"
# (fetch_search_query_performance.py, SP-API Reports API) e mostra il volume
# di ricerca REALE di mercato per query, con la quota che QUESTO ASIN ne
# cattura — utile anche per query su cui non hai MAI fatto pubblicita'.


def load_sqp_data(marketplace: str, data_dir: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(data_dir, f"SQP_{marketplace.upper()}.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _fmt_share(value: Any) -> str:
    """La documentazione Amazon non specifica se le quote (asin*Share) sono
    espresse come frazione (0-1) o gia' in percentuale (0-100): trattiamo
    <=1 come frazione (moltiplico per 100) e il resto come gia' in scala
    percentuale, cosi' il numero mostrato resta leggibile in entrambi i casi
    senza dare per scontata una convenzione non confermata."""
    if value is None:
        return "-"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "-"
    return f"{v * 100:.1f}%" if v <= 1 else f"{v:.1f}%"


def search_query_performance_section(marketplace: str, asin: str, data_dir: str,
                                     top: int = 15) -> Tuple[str, Dict[str, Any]]:
    """Wrapper usato da build_context: ritorna (markdown, meta). Stringa vuota
    se fetch_search_query_performance.py non e' ancora stato lanciato per
    questo mercato/ASIN (fonte best-effort, come le altre)."""
    data = load_sqp_data(marketplace, data_dir)
    if not data:
        return "", {"available": False,
                    "reason": f"nessun SQP_{marketplace.upper()}.json in {data_dir} "
                             f"(lancia prima fetch_search_query_performance.py)"}

    by_asin = data.get("by_asin") or {}
    rows = by_asin.get(asin.upper()) or by_asin.get(asin) or []
    if not rows:
        return "", {"available": False,
                    "reason": "nessuna riga Search Query Performance per questo ASIN "
                             "(nessun dato Amazon per il periodo, o ASIN non incluso nel fetch)"}

    ranked = sorted(rows, key=lambda r: (r.get("searchQueryVolume") or 0), reverse=True)

    md = ["\n## Volume di ricerca reale (Search Query Performance, non stima)\n",
         f"Quanto i clienti cercano davvero ogni query su {marketplace} e la quota che "
         f"QUESTO ASIN ne cattura (impression/click/carrello/acquisti), periodo "
         f"{data.get('start', '?')} -> {data.get('end', '?')}. A differenza dei 'Termini "
         "che convertono' sopra (solo dati delle TUE campagne ads), qui il volume e' di "
         "mercato: mostra anche query che i clienti cercano ma su cui non hai mai fatto "
         "pubblicita'. Rank 1 = query piu' rilevante per il TUO catalogo brand secondo Amazon.\n"]
    md.append("| Query | Volume ricerca | Rank | Quota impression | Quota click | Quota acquisti |")
    md.append("|---|---:|---:|---:|---:|---:|")
    for r in ranked[:top]:
        md.append(
            f"| {r.get('searchQuery', '')} | {r.get('searchQueryVolume', '-')} | "
            f"{r.get('searchQueryScore', '-')} | {_fmt_share(r.get('asinImpressionShare'))} | "
            f"{_fmt_share(r.get('asinClickShare'))} | {_fmt_share(r.get('asinPurchaseShare'))} |")
    md.append("\nQueste query NON sono confermate come acquirenti di QUESTO prodotto (a "
             "differenza di 'Termini che convertono'): usale per capire cosa cerca il "
             "mercato, non come sostituto dei termini con acquisti reali gia' verificati.\n")

    meta = {
        "available": True,
        "queries_total": len(rows),
        "period": data.get("period"),
        "start": data.get("start"),
        "end": data.get("end"),
        "top_queries_by_volume": [r.get("searchQuery", "") for r in ranked[:top]],
    }
    return "\n".join(md) + "\n", meta
