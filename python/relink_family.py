"""
Ripara una famiglia di varianti "rotta" su un marketplace.

Caso d'uso: su FR i child hanno perso il legame col parent (compaiono come
prodotti singoli), mentre su IT la famiglia e' integra. Con l'account unificato
EU gli SKU sono gli stessi su tutti i mercati, quindi:

  1. si legge la famiglia dal marketplace SANO (--reference-marketplace, default IT):
     parent SKU, child SKU e variation theme;
  2. sul marketplace ROTTO si verifica che il parent esista ancora;
  3. per ogni child si riscrive l'attributo `child_parent_sku_relationship`
     (e `variation_theme` se noto) puntando al parent — prima in dry-run,
     poi con --apply.

Uso:
  python relink_family.py --parent-asin B0XXXXXXX --marketplace FR --diff
  python relink_family.py --parent-asin B0XXXXXXX --marketplace FR --apply
  # oppure --parent SKU-DEL-PARENT; --reference-marketplace DE se IT non e' sano
  # --children SKU1,SKU2 per forzare la lista child senza leggerla dal riferimento

Se il PARENT e' sparito dal mercato rotto, ripubblicalo prima:
  python relink_family.py --parent-asin B0XXXXXXX --marketplace FR --republish-parent --diff
  python relink_family.py --parent-asin B0XXXXXXX --marketplace FR --republish-parent --apply
  # copia il listing del parent dal mercato sano (PUT createOrFullUpdate);
  # Amazon lo processa in asincrono: aspetta che compaia (di norma 15-60 min,
  # a volte qualche ora), POI rilancia il relink dei child senza --republish-parent.

NOTE ONESTE:
- Se il PARENT non esiste piu' sul mercato rotto, questo script non basta:
  il parent va ricreato (feed/Aggiungi prodotto) prima di ri-linkare i child.
- Alcune categorie richiedono attributi extra sul parent (parentage_level,
  variation_theme): se il dry-run segnala errori 8xxx sul parent, apri un
  caso al supporto venditori citando gli ASIN.
- Come sempre: senza --apply NON viene scritto nulla.
"""
import argparse
import sys
from typing import Any, Dict, List, Optional, Tuple

import config
import update_listing as ul


def _get_family_from_reference(parent_sku: str, ref_mid: str) -> Tuple[List[str], Optional[str], List[str]]:
    """Ritorna (child_skus, theme_name, theme_attrs) dal marketplace sano."""
    out = ul._call(
        "GET", ul._listings_path(parent_sku),
        params={"marketplaceIds": ref_mid, "includedData": "relationships"},
    )
    for block in out.get("relationships", []) or []:
        if block.get("marketplaceId") != ref_mid:
            continue
        for rel in block.get("relationships", []) or []:
            if rel.get("type") == "VARIATION" and rel.get("childSkus"):
                vt = rel.get("variationTheme", {}) or {}
                return rel["childSkus"], vt.get("theme"), vt.get("attributes", []) or []
    return [], None, []


def _current_parent_of(child_sku: str, mid: str, lang: str) -> str:
    """Parent attuale del child sul mercato target ('' se orfano)."""
    listing = ul.get_listing(child_sku, mid, lang)
    for e in listing.get("attributes", {}).get("child_parent_sku_relationship", []) or []:
        if isinstance(e, dict) and e.get("parent_sku"):
            return e["parent_sku"]
    return ""


def _patch_child(child_sku: str, parent_sku: str, theme_name: Optional[str],
                 mid: str, lang: str, apply: bool) -> Dict[str, Any]:
    listing = ul.get_listing(child_sku, mid, lang)
    summaries = listing.get("summaries", [])
    product_type = summaries[0].get("productType") if summaries else None
    if not product_type:
        return {"sku": child_sku, "ok": False, "stage": "lookup",
                "issues": ["productType non determinabile: il child esiste su questo mercato?"]}

    rel_value = [{"child_relationship_type": "variation",
                  "parent_sku": parent_sku,
                  "marketplace_id": mid}]
    patches = [{"op": "replace", "path": "/attributes/child_parent_sku_relationship",
                "value": rel_value}]
    if theme_name:
        patches.append({"op": "replace", "path": "/attributes/variation_theme",
                        "value": [{"name": theme_name, "marketplace_id": mid}]})

    preview = ul._call(
        "PATCH", ul._listings_path(child_sku),
        params={"marketplaceIds": mid, "issueLocale": lang, "mode": "VALIDATION_PREVIEW"},
        json_body={"productType": product_type, "patches": patches},
    )
    issues = [f"{i.get('severity')} [{i.get('code')}] {i.get('message')}"
              for i in preview.get("issues", []) or []]
    if any(i.get("severity") == "ERROR" for i in preview.get("issues", []) or []):
        return {"sku": child_sku, "ok": False, "stage": "dry-run", "issues": issues}
    if not apply:
        return {"sku": child_sku, "ok": True, "stage": "dry-run",
                "issues": issues, "note": "preview pulita (non scritto)"}

    result = ul._call(
        "PATCH", ul._listings_path(child_sku),
        params={"marketplaceIds": mid, "issueLocale": lang},
        json_body={"productType": product_type, "patches": patches},
    )
    return {"sku": child_sku, "ok": result.get("status") == "ACCEPTED", "stage": "apply",
            "status": result.get("status"), "submissionId": result.get("submissionId"),
            "issues": [f"{i.get('severity')} [{i.get('code')}] {i.get('message')}"
                       for i in result.get("issues", []) or []]}


def _localize_attributes(attrs: Dict[str, Any], ref_mid: str, mid: str,
                         lang: str) -> Dict[str, Any]:
    """Adatta gli attributi letti dal mercato sano al mercato target:
    riscrive marketplace_id e language_tag ovunque compaiano (deep-walk)."""
    def walk(node):
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k == "marketplace_id":
                    out[k] = mid
                elif k == "language_tag":
                    out[k] = lang
                else:
                    out[k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node
    return walk(attrs)


def republish_parent(parent_sku: str, ref_mid: str, ref_market: str,
                     mid: str, market: str, lang: str, apply: bool) -> int:
    """Ricrea il parent sul mercato rotto copiandolo dal mercato sano (PUT)."""
    print(f"Leggo il listing completo del parent da {ref_market}...")
    ref_lang = ul.LANGUAGE_TAGS[ref_market]
    listing = ul._call(
        "GET", ul._listings_path(parent_sku),
        params={"marketplaceIds": ref_mid, "issueLocale": ref_lang,
                "includedData": "attributes,summaries"},
    )
    summaries = listing.get("summaries", [])
    product_type = summaries[0].get("productType") if summaries else None
    attrs = listing.get("attributes", {})
    if not product_type or not attrs:
        print(f"Impossibile leggere productType/attributi del parent su {ref_market}: "
              "senza questi non posso ripubblicare.", file=sys.stderr)
        return 1
    print(f"  productType: {product_type} - attributi: {len(attrs)}")

    # un parent non deve avere ne' offerta ne' relazione verso un altro parent
    for k in ("purchasable_offer", "child_parent_sku_relationship",
              "fulfillment_availability", "merchant_suggested_asin"):
        attrs.pop(k, None)
    attrs = _localize_attributes(attrs, ref_mid, mid, ref_lang, lang)

    body = {"productType": product_type, "requirements": "LISTING", "attributes": attrs}

    print(f"\n--- DRY RUN ripubblicazione parent su {market} (non scrive) ---")
    preview = ul._call(
        "PUT", ul._listings_path(parent_sku),
        params={"marketplaceIds": mid, "issueLocale": lang, "mode": "VALIDATION_PREVIEW"},
        json_body=body,
    )
    print(f"  status: {preview.get('status')}")
    errors = 0
    for i in preview.get("issues", []) or []:
        print(f"  {i.get('severity')} [{i.get('code')}] {i.get('message')}")
        errors += i.get("severity") == "ERROR"
    if errors:
        print("\nPreview con errori: non procedo. Se gli errori riguardano attributi", file=sys.stderr)
        print("obbligatori mancanti in lingua, valuta la ripubblicazione manuale da", file=sys.stderr)
        print("Seller Central (vedi guida) o apri un caso al supporto venditori.", file=sys.stderr)
        return 1
    if not apply:
        print("\nPreview pulita. Rilancia con --apply per ripubblicare davvero.")
        return 0

    print(f"\n--- APPLY: ripubblico il parent su {market} ---")
    result = ul._call(
        "PUT", ul._listings_path(parent_sku),
        params={"marketplaceIds": mid, "issueLocale": lang},
        json_body=body,
    )
    print(f"  status: {result.get('status')}")
    print(f"  submissionId: {result.get('submissionId')}")
    for i in result.get("issues", []) or []:
        print(f"  {i.get('severity')} [{i.get('code')}] {i.get('message')}")
    print("\nInviato. Amazon processa in ASINCRONO: il parent compare di norma in")
    print("15-60 minuti (a volte qualche ora). Quando lo vedi su Seller Central,")
    print("rilancia il relink dei child SENZA --republish-parent:")
    print(f"  python relink_family.py --parent {parent_sku} --marketplace {market} --diff")
    print("\nNOTA: il titolo del parent e' stato copiato dalla lingua del mercato di")
    print(f"riferimento: dopo il relink, adattalo con la webui o update_listing.py.")
    return 0


def _localize_attributes(obj, ref_mid: str, mid: str, ref_lang: str, lang: str):
    """Copia ricorsiva degli attributi sostituendo marketplace_id e language_tag
    del mercato sano con quelli del mercato da riparare."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "marketplace_id" and v == ref_mid:
                out[k] = mid
            elif k == "language_tag" and v == ref_lang:
                out[k] = lang
            else:
                out[k] = _localize_attributes(v, ref_mid, mid, ref_lang, lang)
        return out
    if isinstance(obj, list):
        return [_localize_attributes(v, ref_mid, mid, ref_lang, lang) for v in obj]
    return obj


def main() -> int:
    ap = argparse.ArgumentParser(description="Ri-collega i child orfani al parent su un marketplace")
    ap.add_argument("--parent", default=None, help="SKU del parent")
    ap.add_argument("--parent-asin", default=None, help="ASIN del parent (alternativa a --parent)")
    ap.add_argument("--marketplace", required=True, help="Mercato ROTTO da riparare (es. FR)")
    ap.add_argument("--reference-marketplace", default="IT",
                    help="Mercato SANO da cui leggere la famiglia (default IT)")
    ap.add_argument("--children", default=None,
                    help="Lista SKU child separati da virgola (salta la lettura dal riferimento)")
    ap.add_argument("--republish-parent", action="store_true",
                    help="Ricrea il parent sul mercato rotto copiandolo dal mercato sano, "
                         "poi esci (i child si ricollegano in un secondo momento)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--diff", action="store_true", help="Solo verifica (non scrive)")
    g.add_argument("--apply", action="store_true", help="Scrive davvero su Amazon")
    args = ap.parse_args()

    market = args.marketplace.upper()
    ref = args.reference_marketplace.upper()
    for m in (market, ref):
        if m not in config.MARKETPLACES:
            print(f"Marketplace '{m}' sconosciuto.", file=sys.stderr)
            return 1
    if market == ref:
        print("Il mercato da riparare e quello di riferimento coincidono.", file=sys.stderr)
        return 1
    mid, lang = config.MARKETPLACES[market], ul.LANGUAGE_TAGS[market]
    ref_mid = config.MARKETPLACES[ref]

    # --- parent SKU
    parent_sku = args.parent
    if not parent_sku:
        if not args.parent_asin:
            print("Serve --parent (SKU) oppure --parent-asin.", file=sys.stderr)
            return 1
        print(f"Risolvo lo SKU del parent {args.parent_asin} su {ref}...")
        parent_sku = ul.resolve_sku(args.parent_asin, ref_mid)
    print(f"Parent SKU: {parent_sku}")

    # --- ripubblicazione del parent (percorso separato: si esce dopo)
    if args.republish_parent:
        return republish_parent(parent_sku, ref_mid, ref, mid, market, lang, args.apply)

    # --- famiglia dal riferimento
    if args.children:
        child_skus = [s.strip() for s in args.children.split(",") if s.strip()]
        theme_name, theme_attrs = None, []
        print(f"Child forniti a mano: {len(child_skus)}")
    else:
        print(f"Leggo la famiglia dal mercato di riferimento {ref}...")
        child_skus, theme_name, theme_attrs = _get_family_from_reference(parent_sku, ref_mid)
        if not child_skus:
            print(f"Nessuna relazione VARIATION trovata su {ref}: la famiglia e' rotta "
                  f"anche li', o il parent SKU non e' giusto. Puoi passare --children.",
                  file=sys.stderr)
            return 1
        print(f"  child: {len(child_skus)} - theme: {theme_name or '(non esposto)'} "
              f"{theme_attrs or ''}")

    # --- parent esiste sul mercato rotto?
    try:
        pl = ul.get_listing(parent_sku, mid, lang)
        p_type = (pl.get("summaries") or [{}])[0].get("productType")
        if not p_type:
            raise RuntimeError("nessun summary")
        print(f"Parent presente su {market} (productType {p_type}).")
    except Exception as exc:  # noqa: BLE001
        print(f"\nIl parent {parent_sku} non risulta su {market} ({str(exc)[:120]}).")
        if not args.republish_parent:
            print("Rilancia aggiungendo --republish-parent per ricrearlo copiandolo",
                  file=sys.stderr)
            print(f"dal mercato {ref}, oppure ripubblicalo da Seller Central "
                  "(file di inventario).", file=sys.stderr)
            return 1
        print(f"--republish-parent attivo: lo ricreo copiandolo da {ref}.")
        return republish_parent(parent_sku, ref_mid, ref, mid, market, lang, args.apply)

    # --- stato attuale + patch child per child
    mode = "APPLY (scrive)" if args.apply else "DRY-RUN (non scrive)"
    print(f"\n--- {mode} su {market} ---")
    ok = ko = already = 0
    for child in child_skus:
        try:
            cur_parent = _current_parent_of(child, mid, lang)
        except Exception as exc:  # noqa: BLE001
            print(f"  ? {child}: non leggibile su {market} ({str(exc)[:100]})")
            ko += 1
            continue
        if cur_parent == parent_sku:
            print(f"  = {child}: gia' collegato al parent, salto")
            already += 1
            continue
        state = f"orfano" if not cur_parent else f"collegato a '{cur_parent}'"
        res = _patch_child(child, parent_sku, theme_name, mid, lang, args.apply)
        mark = "✓" if res["ok"] else "✗"
        extra = res.get("submissionId") or res.get("note") or ""
        print(f"  {mark} {child} ({state}) -> {res['stage']} {extra}")
        for iss in res.get("issues", []) or []:
            print(f"      {iss}")
        ok += res["ok"]
        ko += not res["ok"]

    print(f"\nEsito: {ok} ok, {already} gia' a posto, {ko} con problemi.")
    if not args.apply and ok:
        print("Dry-run pulito: rilancia con --apply per scrivere.")
    if args.apply and ok:
        print("Amazon processa in asincrono: verifica su Seller Central tra qualche ora.")
    return 0 if ko == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
