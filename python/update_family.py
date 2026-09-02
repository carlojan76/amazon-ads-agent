#!/usr/bin/env python3
r"""
update_family.py - Lupo & Felix

Aggiorna un'intera famiglia di variazioni (child che cambiano solo per
colore/taglia) da un unico file. Bullet e descrizione sono condivisi: li scrivi
una volta e valgono per tutti i child. Il titolo si genera da un template in cui
{color}/{size} (o qualunque attributo del variation theme) vengono sostituiti
per ogni child.

Monta tutto su update_listing.py: build_patches, validate_lengths,
get_max_lengths, il dry-run VALIDATION_PREVIEW e l'apply sono gia' li'.

Formato del file famiglia (vedi listings/family/EXAMPLE_family.json):
  {
    "marketplace": "IT",
    "parent_sku": "LF-AMACA-PARENT",        // oppure "parent_asin": "..."
    "shared": {
      "bullet_point": ["...", "..."],
      "product_description": "..."
    },
    "title_template": "Amaca Gatti 2 in 1 {color} {size} - ... - Montaggio Facile",
    "overrides": { "LF-AMACA-GRIGIO-L": { "item_name": "titolo tutto custom" } },
    "children": [ { "sku": "LF-AMACA-GRIGIO-L", "color": "Grigio", "size": "Large" } ]
  }

- "children" e' opzionale: se assente, i child vengono scoperti dal parent via
  la relazione VARIATION (relationships) e colore/taglia letti dai loro attributi.
- "title_template" e' opzionale: se assente, il titolo dei child non viene toccato
  (aggiorni solo bullet/descrizione condivisi).
- "overrides" per-SKU vince su shared e su template.

Uso (PowerShell):
  python .\update_family.py --family .\listings\family\amaca_family.json --diff
  python .\update_family.py --family .\listings\family\amaca_family.json
  python .\update_family.py --family .\listings\family\amaca_family.json --apply
  python .\update_family.py --family .\listings\family\amaca_family.json --only LF-AMACA-GRIGIO-L
"""

import argparse
import json
import string
import sys
from typing import Any, Dict, List, Optional, Tuple

import config
import update_listing as ul  # build_patches, validate_lengths, get_max_lengths, _call, ...


# ----------------------------------------------------------------- helper attributi


def _attr_value(attributes: Dict[str, Any], name: str) -> Optional[str]:
    """Primo valore di un attributo dalla forma {attr: [{value, ...}]}."""
    lst = attributes.get(name)
    if isinstance(lst, list) and lst and isinstance(lst[0], dict):
        return lst[0].get("value")
    return None


def _subs_for_child(child_attrs: Dict[str, Any], theme_attrs: List[str],
                    manual: Dict[str, Any]) -> Dict[str, str]:
    """Costruisce il dizionario di sostituzione per il template titolo.

    Parte dai valori reali degli attributi del variation theme, poi aggiunge
    alias comodi ({color}, {size}, {style}) qualunque sia il nome esatto
    (color_name/size_name/...). I valori passati a mano nel file vincono.
    """
    subs: Dict[str, str] = {}
    for name in theme_attrs:
        val = _attr_value(child_attrs, name)
        if val is not None:
            subs[name] = val
            low = name.lower()
            for alias in ("color", "size", "style"):
                if alias in low:
                    subs.setdefault(alias, val)
    for k, v in manual.items():
        if k not in ("sku", "asin"):
            subs[k] = v
    return subs


def _render_title(template: str, subs: Dict[str, str], sku: str) -> str:
    """Sostituisce i placeholder nel template, avvisando su quelli senza valore."""
    fields = {name for _, name, _, _ in string.Formatter().parse(template) if name}
    missing = [f for f in fields if f not in subs]
    if missing:
        print(f"    ! {sku}: placeholder senza valore {missing} -> lasciati vuoti")
    safe = {f: subs.get(f, "") for f in fields}
    return " ".join(template.format_map(safe).split())  # normalizza spazi doppi


# ----------------------------------------------------------------- discovery child


def discover_children(parent_sku: str, marketplace_id: str) -> Tuple[List[str], List[str]]:
    """Restituisce (child_skus, theme_attrs) leggendo la relazione VARIATION del parent."""
    out = ul._call(
        "GET",
        ul._listings_path(parent_sku),
        params={"marketplaceIds": marketplace_id, "includedData": "relationships"},
    )
    for block in out.get("relationships", []):
        if block.get("marketplaceId") != marketplace_id:
            continue
        for rel in block.get("relationships", []):
            if rel.get("type") == "VARIATION" and rel.get("childSkus"):
                theme = rel.get("variationTheme", {}).get("attributes", [])
                return rel["childSkus"], theme
    return [], []


# ----------------------------------------------------------------- un child


def _catalog_variation(asin: str, marketplace_id: str) -> Dict[str, Any]:
    """Colore/taglia di una variante dal Catalog Items API. Fallback per quando
    il listing del child non espone questi valori tra i suoi attributi."""
    try:
        out = ul._call("GET", f"/catalog/2022-04-01/items/{asin}",
                       params={"marketplaceIds": marketplace_id, "includedData": "summaries"})
    except Exception:  # noqa: BLE001
        return {}
    for s in out.get("summaries", []) or []:
        return {"color": s.get("color"), "size": s.get("size")}
    return {}


def build_child_attributes(child_sku: str, manual: Dict[str, Any],
                           family: Dict[str, Any], current_attrs: Dict[str, Any],
                           asin: str = None, marketplace_id: str = None) -> Dict[str, Any]:
    """Attributi nuovi per un child = shared + titolo da template + overrides.
    Estratto qui cosi' lo riusa anche il dry-run della web UI, senza duplicare la logica."""
    shared = family.get("shared", {})
    new_attributes: Dict[str, Any] = {}
    for key in ("bullet_point", "product_description", "item_name"):
        if key in shared:
            new_attributes[key] = shared[key]

    template = family.get("title_template")
    theme_attrs = family.get("_theme_attrs", [])
    if template:
        subs = _subs_for_child(current_attrs, theme_attrs, manual)
        # Fallback: se colore/taglia non sono negli attributi del listing del
        # child, leggili dal catalogo (li' Amazon li espone per ogni variante).
        if asin and marketplace_id:
            needed = {f for _, f, _, _ in string.Formatter().parse(template) if f}
            missing = [f for f in needed if f not in subs and f in ("color", "size")]
            if missing:
                cat = _catalog_variation(asin, marketplace_id)
                for f in missing:
                    if cat.get(f):
                        subs[f] = cat[f]
        new_attributes["item_name"] = _render_title(template, subs, child_sku)

    for key, value in family.get("overrides", {}).get(child_sku, {}).items():
        new_attributes[key] = value
    return new_attributes


def process_child(child_sku: str, manual: Dict[str, Any], family: Dict[str, Any],
                  marketplace_id: str, language_tag: str,
                  limits_cache: Dict[str, Dict[str, int]],
                  diff_only: bool, apply: bool) -> str:
    """Elabora un singolo child. Ritorna 'ok' | 'diff' | 'skip' | 'error'."""
    print(f"\n{'-' * 70}\n{child_sku}")

    # listing corrente: serve per product_type, diff e valori colore/taglia
    listing = ul.get_listing(child_sku, marketplace_id, language_tag)
    summaries = listing.get("summaries", [])
    product_type = summaries[0].get("productType") if summaries else None
    current_attrs = listing.get("attributes", {})
    child_asin = summaries[0].get("asin") if summaries else None

    new_attributes = build_child_attributes(child_sku, manual, family, current_attrs,
                                            asin=child_asin, marketplace_id=marketplace_id)

    if not new_attributes:
        print("    niente da aggiornare (ne' shared ne' template)")
        return "skip"

    bad = set(new_attributes) - set(ul.SUPPORTED_ATTRIBUTES)
    if bad:
        print(f"    ! attributi non gestiti: {', '.join(bad)}")
        return "error"

    if diff_only:
        ul.print_diff(current_attrs, new_attributes)
        return "diff"

    # limiti: uguali per tutta la famiglia -> cache per product_type
    if product_type not in limits_cache:
        try:
            limits_cache[product_type] = ul.get_max_lengths(product_type, marketplace_id)
        except Exception:  # noqa: BLE001
            limits_cache[product_type] = {}
    problems = ul.validate_lengths(new_attributes, limits_cache[product_type])
    if problems:
        print("    copy troppo lunga:")
        for p in problems:
            print(f"      - {p}")
        return "error"

    patches = ul.build_patches(new_attributes, marketplace_id, language_tag)

    preview = ul._call(
        "PATCH", ul._listings_path(child_sku),
        params={"marketplaceIds": marketplace_id, "issueLocale": language_tag,
                "mode": "VALIDATION_PREVIEW"},
        json_body={"productType": product_type, "patches": patches},
    )
    print(f"    dry-run: {preview.get('status')}")
    if ul.report_issues(preview):
        print("    dry-run con errori: non applico.")
        return "error"

    if not apply:
        return "ok"

    result = ul._call(
        "PATCH", ul._listings_path(child_sku),
        params={"marketplaceIds": marketplace_id, "issueLocale": language_tag},
        json_body={"productType": product_type, "patches": patches},
    )
    print(f"    APPLY: {result.get('status')} submissionId={result.get('submissionId')}")
    ul.report_issues(result)
    return "ok"


# ----------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="Aggiorna una famiglia di variazioni via SP-API")
    ap.add_argument("--family", required=True, help="JSON della famiglia")
    ap.add_argument("--diff", action="store_true", help="Solo confronto prima/dopo")
    ap.add_argument("--apply", action="store_true", help="Scrive davvero (default: dry-run)")
    ap.add_argument("--only", default=None, help="Elabora un solo child (SKU)")
    args = ap.parse_args()

    missing = [n for n, v in (
        ("LWA_CLIENT_ID", config.LWA_CLIENT_ID),
        ("LWA_CLIENT_SECRET", config.LWA_CLIENT_SECRET),
        ("LWA_REFRESH_TOKEN", config.LWA_REFRESH_TOKEN),
        ("SP_API_SELLER_ID", config.SELLER_ID),
    ) if not v]
    if missing:
        print(f"Variabili d'ambiente mancanti: {', '.join(missing)}", file=sys.stderr)
        return 1

    with open(args.family, encoding="utf-8") as fh:
        family = json.load(fh)

    market = family.get("marketplace", "IT")
    if market not in config.MARKETPLACES:
        print(f"Marketplace '{market}' sconosciuto. Noti: {', '.join(config.MARKETPLACES)}",
              file=sys.stderr)
        return 1
    marketplace_id = config.MARKETPLACES[market]
    language_tag = ul.LANGUAGE_TAGS[market]

    # --- elenco child (esplicito o auto-discovery dal parent)
    children = family.get("children")
    theme_attrs: List[str] = []
    if children:
        child_map = {c["sku"]: c for c in children if c.get("sku")}
        # se serve il template, ci servono i nomi degli attributi theme: se non
        # sono passati a mano, li scopriamo comunque dal parent (se presente).
        if family.get("title_template") and family.get("parent_sku"):
            _, theme_attrs = discover_children(family["parent_sku"], marketplace_id)
    else:
        parent_sku = family.get("parent_sku")
        if not parent_sku and family.get("parent_asin"):
            print(f"Risolvo lo SKU del parent per ASIN {family['parent_asin']}...")
            parent_sku = ul.resolve_sku(family["parent_asin"], marketplace_id)
        if not parent_sku:
            print("Serve 'children' oppure 'parent_sku'/'parent_asin' nel file.", file=sys.stderr)
            return 1
        print(f"Scopro i child dal parent {parent_sku}...")
        child_skus, theme_attrs = discover_children(parent_sku, marketplace_id)
        if not child_skus:
            print("Nessun child trovato: il parent ha una relazione VARIATION?", file=sys.stderr)
            return 1
        child_map = {sku: {"sku": sku} for sku in child_skus}
        print(f"  {len(child_skus)} child: {', '.join(child_skus)}")
        print(f"  variation theme: {theme_attrs or '(non esposto)'}")

    family["_theme_attrs"] = theme_attrs

    if args.only:
        if args.only not in child_map:
            print(f"'{args.only}' non e' tra i child della famiglia.", file=sys.stderr)
            return 1
        child_map = {args.only: child_map[args.only]}

    # --- loop child (un errore su un child non blocca gli altri)
    limits_cache: Dict[str, Dict[str, int]] = {}
    tally = {"ok": 0, "diff": 0, "skip": 0, "error": 0}
    for sku, manual in child_map.items():
        try:
            outcome = process_child(sku, manual, family, marketplace_id, language_tag,
                                    limits_cache, args.diff, args.apply)
        except Exception as exc:  # noqa: BLE001 - isola il singolo child
            print(f"    ERRORE: {exc}")
            outcome = "error"
        tally[outcome] += 1

    print(f"\n{'=' * 70}")
    print(f"Fatto: {tally['ok']} ok, {tally['diff']} diff, {tally['skip']} saltati, "
          f"{tally['error']} errori.")
    if not args.diff and not args.apply and tally["ok"]:
        print("Dry-run pulito. Rilancia con --apply per scrivere.")
    if args.apply and tally["ok"]:
        print("Inviato. Amazon processa in asincrono; verifica dopo con --diff.")
    return 1 if tally["error"] else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"\n{exc}", file=sys.stderr)
        sys.exit(1)
