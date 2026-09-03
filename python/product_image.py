"""Immagine principale del prodotto, per darla in pasto al modello che scrive la copy.

Perche' serve: il brief contiene copy attuale, catalogo, A+ e recensioni, ma non
il prodotto. Se la copy esistente descrive male l'oggetto (es. chiama "amaca
sospesa" uno sdraio che sta su quattro gambe), il modello eredita l'errore e lo
rinforza scrivendone una versione piu' convinta. Con la MAIN in input il modello
vede la forma reale e puo' correggere invece di propagare.

La Catalog Items API restituisce per ogni variante (MAIN, PT01, ...) piu'
risoluzioni. Si sceglie la MAIN piu' grande entro MAX_WIDTH: abbastanza definita
perche' si veda com'e' fatto l'oggetto, abbastanza piccola da non sprecare token
ne' sfiorare il limite di 5 MB per immagine della Messages API.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional

import requests

# Oltre questa larghezza non si guadagna nulla di utile e si pagano token.
MAX_WIDTH = 1200
# Limite duro della Messages API: 5 MB per immagine. Si sta sotto con margine.
MAX_BYTES = 3_500_000
ALLOWED_MEDIA = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def pick_main_image(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Sceglie la MAIN piu' grande entro MAX_WIDTH.

    Se non c'e' nessuna MAIN (capita su alcuni child) ripiega sulla prima
    variante disponibile, sempre con lo stesso criterio di dimensione.
    """
    if not candidates:
        return None

    def usable(pool: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not pool:
            return None
        within = [c for c in pool if (c.get("width") or 0) <= MAX_WIDTH]
        # Se tutte superano MAX_WIDTH si prende comunque la piu' piccola.
        return (max(within, key=lambda c: c.get("width") or 0) if within
                else min(pool, key=lambda c: c.get("width") or 0))

    main = [c for c in candidates if str(c.get("variant", "")).upper() == "MAIN"]
    return usable(main) or usable(candidates)


def _media_type(url: str, content_type: str) -> Optional[str]:
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in ALLOWED_MEDIA:
        return ct
    lowered = url.lower()
    for ext, mime in ((".jpg", "image/jpeg"), (".jpeg", "image/jpeg"),
                      (".png", "image/png"), (".gif", "image/gif"),
                      (".webp", "image/webp")):
        if ext in lowered:
            return mime
    return None


def fetch_image_block(url: str, timeout: int = 30) -> Optional[Dict[str, Any]]:
    """Scarica l'immagine e la impacchetta come content block Anthropic.

    Ritorna None (senza sollevare) su qualsiasi problema: l'immagine e' un
    miglioramento del brief, non un requisito. Se non si scarica, la copy si
    genera lo stesso come prima.
    """
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"   [immagine] download fallito: {exc}")
        return None

    media = _media_type(url, resp.headers.get("Content-Type", ""))
    if not media:
        print(f"   [immagine] formato non supportato: {resp.headers.get('Content-Type')}")
        return None
    if len(resp.content) > MAX_BYTES:
        print(f"   [immagine] troppo grande ({len(resp.content) / 1e6:.1f} MB), saltata")
        return None

    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media,
                   "data": base64.standard_b64encode(resp.content).decode("ascii")},
    }


def main_image_block(catalog: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Dal catalogo al content block, con log di cosa e' stato scelto."""
    if not catalog:
        return None
    chosen = pick_main_image(catalog.get("image_candidates") or [])
    if not chosen:
        print("   [immagine] nessuna immagine nel catalogo")
        return None

    print(f"   [immagine] {chosen.get('variant')} "
          f"{chosen.get('width')}x{chosen.get('height')}")
    return fetch_image_block(chosen["link"])
