#!/usr/bin/env python3
r"""
update_listing.py — Lupo & Felix

Aggiorna item_name / bullet_point / product_description di un'inserzione
via SP-API Listings Items 2021-08-01.

Riusa config.py e spapi.py: auth LWA, cache del token e backoff sui 429
sono gia' li', non li reimplementiamo.

Flusso:
  1. (opzionale) risolve lo SKU dall'ASIN
  2. GET listing -> productType + attributi correnti
  3. GET product type definition -> schema -> maxLength reali
  4. Valida la copy nuova
  5. PATCH in VALIDATION_PREVIEW (dry-run, non scrive)
  6. Con --apply: PATCH in VALIDATION (scrive)

Uso (PowerShell):
  python .\update_listing.py --content .\listings\content\B0G5JC2YZ2.json --diff
  python .\update_listing.py --content .\listings\content\B0G5JC2YZ2.json
  python .\update_listing.py --content .\listings\content\B0G5JC2YZ2.json --apply

Env: LWA_CLIENT_ID, LWA_CLIENT_SECRET, LWA_REFRESH_TOKEN (gia' nel repo)
     SP_API_SELLER_ID (nuovo: Merchant Token da Seller Central)

Ruoli: l'app SP-API deve avere il ruolo "Product Listing", altrimenti 403.
"""

import argparse
import json
import sys
from typing import Any, Dict, List
from urllib.parse import quote

import requests

import config
import spapi

# ---------------------------------------------------------------- costanti

# language_tag per marketplace. Gli ID stanno in config.MARKETPLACES.
LANGUAGE_TAGS = {
    "IT": "it_IT",
    "FR": "fr_FR",
    "DE": "de_DE",
    "ES": "es_ES",
    "UK": "en_GB",
}

# Attributi gestiti e loro forma nel payload.
#   "array"  -> lista di valori (bullet_point)
#   "scalar" -> valore singolo, comunque wrappato in lista
SUPPORTED_ATTRIBUTES = {
    "item_name": "scalar",
    "bullet_point": "array",
    "product_description": "scalar",
}

# Usati solo se lo schema non espone maxLength.
FALLBACK_MAXLEN = {
    "item_name": 200,
    "bullet_point": 500,
    "product_description": 2000,
}


# ---------------------------------------------------------------- helper


def _listings_path(sku: str = "") -> str:
    base = f"/listings/2021-08-01/items/{config.SELLER_ID}"
    return f"{base}/{quote(sku, safe='')}" if sku else base


def _call(method: str, path: str, **kwargs) -> Dict[str, Any]:
    """spapi.request + errori leggibili.

    spapi.request fa raise_for_status sui 4xx, che nasconde il body: ma sui
    listing e' proprio il body a dire *cosa* non va. Lo tiriamo fuori.
    """
    try:
        return spapi.request(method, path, **kwargs)
    except requests.HTTPError as exc:
        resp = exc.response
        detail = resp.text if resp is not None else str(exc)
        code = resp.status_code if resp is not None else "?"
        if code == 403:
            detail += (
                "\n\n>>> 403: manca quasi certamente il ruolo 'Product Listing' "
                "sull'app SP-API.\n    Aggiungilo in Developer Central, ri-autorizza "
                "e aggiorna LWA_REFRESH_TOKEN."
            )
        raise RuntimeError(f"{method} {path} -> {code}\n{detail}") from exc


def resolve_sku(asin: str, marketplace_id: str) -> str:
    out = _call(
        "GET",
        _listings_path(),
        params={
            "marketplaceIds": marketplace_id,
            "identifiers": asin,
            "identifiersType": "ASIN",
            "includedData": "summaries",
            "pageSize": 10,
        },
    )
    items = out.get("items", [])
    if not items:
        raise RuntimeError(f"Nessuno SKU trovato per ASIN {asin} su questo marketplace.")
    if len(items) > 1:
        skus = ", ".join(i.get("sku", "?") for i in items)
        raise RuntimeError(f"Piu' SKU per {asin} ({skus}). Indica 'sku' nel JSON.")
    return items[0]["sku"]


def get_listing(sku: str, marketplace_id: str, issue_locale: str) -> Dict[str, Any]:
    return _call(
        "GET",
        _listings_path(sku),
        params={
            "marketplaceIds": marketplace_id,
            "issueLocale": issue_locale,
            "includedData": "attributes,summaries,issues",
        },
    )


def get_max_lengths(product_type: str, marketplace_id: str) -> Dict[str, int]:
    """maxLength reali dallo schema del product type. {} se non esposti."""
    definition = _call(
        "GET",
        f"/definitions/2020-09-01/productTypes/{product_type}",
        params={
            "marketplaceIds": marketplace_id,
            "requirements": "LISTING",
            "locale": "it_IT",
        },
    )
    link = definition.get("schema", {}).get("link", {}).get("resource")
    if not link:
        return {}
    # URL S3 pre-firmata: fetch diretto, senza header SP-API.
    schema = requests.get(link, timeout=60).json()

    limits: Dict[str, int] = {}
    props = schema.get("properties", {})
    for attr in SUPPORTED_ATTRIBUTES:
        node = props.get(attr, {})
        max_len = node.get("items", {}).get("properties", {}).get("value", {}).get("maxLength")
        if isinstance(max_len, int):
            limits[attr] = max_len
    return limits


def build_patches(attributes: Dict[str, Any], marketplace_id: str, language_tag: str) -> List[Dict]:
    patches = []
    for attr, value in attributes.items():
        kind = SUPPORTED_ATTRIBUTES.get(attr)
        if kind is None:
            raise ValueError(
                f"Attributo non gestito: '{attr}'. Gestiti: {', '.join(SUPPORTED_ATTRIBUTES)}"
            )
        values = value if kind == "array" else [value]
        patches.append({
            "op": "replace",
            "path": f"/attributes/{attr}",
            "value": [
                {"value": v, "language_tag": language_tag, "marketplace_id": marketplace_id}
                for v in values
            ],
        })
    return patches


def validate_lengths(attributes: Dict[str, Any], limits: Dict[str, int]) -> List[str]:
    problems = []
    for attr, value in attributes.items():
        limit = limits.get(attr, FALLBACK_MAXLEN.get(attr))
        if limit is None:
            continue
        values = value if isinstance(value, list) else [value]
        for i, v in enumerate(values):
            if len(v) > limit:
                label = f"{attr}[{i}]" if isinstance(value, list) else attr
                problems.append(f"{label}: {len(v)} car., limite {limit} (+{len(v) - limit})")
    return problems


def print_diff(current: Dict[str, Any], new: Dict[str, Any]) -> None:
    for attr, value in new.items():
        old_values = [e.get("value", "") for e in current.get(attr, []) if isinstance(e, dict)]
        new_values = value if isinstance(value, list) else [value]
        print(f"\n{'=' * 70}\n{attr}\n{'=' * 70}")
        for i in range(max(len(old_values), len(new_values))):
            old = old_values[i] if i < len(old_values) else "(assente)"
            nuovo = new_values[i] if i < len(new_values) else "(rimosso)"
            if old == nuovo:
                print(f"\n  [{i}] invariato")
                continue
            print(f"\n  [{i}] PRIMA ({len(old)} car.):\n      {old[:400]}")
            print(f"\n  [{i}] DOPO  ({len(nuovo)} car.):\n      {nuovo[:400]}")


def report_issues(response: Dict[str, Any]) -> int:
    issues = response.get("issues", [])
    if not issues:
        print("  Nessun issue.")
        return 0
    errors = 0
    for issue in issues:
        sev = issue.get("severity", "?")
        errors += sev == "ERROR"
        print(f"  {sev:<7} [{issue.get('code')}] {issue.get('message')}")
        for attr in issue.get("attributeNames", []) or []:
            print(f"          -> {attr}")
    return errors


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="Aggiorna la copy di un'inserzione via SP-API")
    ap.add_argument("--content", required=True, help="JSON con la copy")
    ap.add_argument("--diff", action="store_true", help="Solo confronto prima/dopo")
    ap.add_argument("--apply", action="store_true", help="Scrive davvero (default: dry-run)")
    args = ap.parse_args()

    missing = [
        name for name, val in (
            ("LWA_CLIENT_ID", config.LWA_CLIENT_ID),
            ("LWA_CLIENT_SECRET", config.LWA_CLIENT_SECRET),
            ("LWA_REFRESH_TOKEN", config.LWA_REFRESH_TOKEN),
            ("SP_API_SELLER_ID", config.SELLER_ID),
        ) if not val
    ]
    if missing:
        print(f"Variabili d'ambiente mancanti: {', '.join(missing)}", file=sys.stderr)
        return 1

    with open(args.content, encoding="utf-8") as fh:
        content = json.load(fh)

    market = content.get("marketplace", "IT")
    if market not in config.MARKETPLACES:
        print(f"Marketplace '{market}' sconosciuto. Noti: {', '.join(config.MARKETPLACES)}",
              file=sys.stderr)
        return 1
    marketplace_id = config.MARKETPLACES[market]
    language_tag = LANGUAGE_TAGS[market]
    new_attributes = content["attributes"]

    # --- SKU
    sku = content.get("sku")
    if not sku:
        print(f"Risolvo lo SKU per ASIN {content['asin']} su {market}...")
        sku = resolve_sku(content["asin"], marketplace_id)
    print(f"SKU: {sku}")

    # --- listing corrente
    listing = get_listing(sku, marketplace_id, language_tag)
    summaries = listing.get("summaries", [])
    product_type = summaries[0].get("productType") if summaries else None
    if not product_type:
        print("productType non determinabile dal listing.", file=sys.stderr)
        return 1
    print(f"Product type: {product_type}")

    if args.diff:
        print_diff(listing.get("attributes", {}), new_attributes)
        return 0

    # --- lunghezze
    try:
        limits = get_max_lengths(product_type, marketplace_id)
        print(f"Limiti da schema: {limits or 'non esposti, uso fallback'}")
    except Exception as exc:
        print(f"Schema non recuperabile ({exc}). Uso i fallback.")
        limits = {}

    problems = validate_lengths(new_attributes, limits)
    if problems:
        print("\nCopy troppo lunga:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("Lunghezze OK.")

    patches = build_patches(new_attributes, marketplace_id, language_tag)

    # --- dry-run
    print("\n--- DRY RUN (VALIDATION_PREVIEW, non scrive) ---")
    preview = _call(
        "PATCH", _listings_path(sku),
        params={"marketplaceIds": marketplace_id, "issueLocale": language_tag,
                "mode": "VALIDATION_PREVIEW"},
        json_body={"productType": product_type, "patches": patches},
    )
    print(f"  status: {preview.get('status')}")
    if report_issues(preview):
        print("\nDry-run con errori: non procedo.")
        return 1

    if not args.apply:
        print("\nDry-run pulito. Rilancia con --apply per scrivere.")
        return 0

    # --- apply
    print("\n--- APPLY (VALIDATION, scrive) ---")
    # NIENTE 'mode': l'enum ammette solo VALIDATION_PREVIEW. Omettendolo,
    # la PATCH persiste davvero. Passare mode=VALIDATION -> 400 InvalidInput.
    result = _call(
        "PATCH", _listings_path(sku),
        params={"marketplaceIds": marketplace_id, "issueLocale": language_tag},
        json_body={"productType": product_type, "patches": patches},
    )
    print(f"  status: {result.get('status')}")
    print(f"  submissionId: {result.get('submissionId')}")
    report_issues(result)
    print("\nInviato. Amazon processa in asincrono: la pagina si aggiorna tipicamente")
    print("entro qualche ora. Rilancia con --diff per verificare.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"\n{exc}", file=sys.stderr)
        sys.exit(1)
