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


# Firme dei formati accettati dalla Messages API. Si guarda il contenuto reale e
# non l'estensione dell'URL: un CDN puo' rispondere 200 con una pagina di errore,
# e dichiararla "image/jpeg" fa fallire la chiamata con un 400 poco leggibile.
_MAGIC = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def sniff_media_type(data: bytes) -> Optional[str]:
    """Riconosce il formato dai primi byte. None se non e' un'immagine valida."""
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def fetch_image_block(url: str, timeout: int = 30) -> Optional[Dict[str, Any]]:
    """Scarica l'immagine e la impacchetta come content block Anthropic.

    Ritorna None (senza sollevare) su qualsiasi problema: l'immagine e' un
    miglioramento del brief, non un requisito. Se non si scarica, la copy si
    genera lo stesso come prima.
    """
    try:
        # Alcuni CDN rispondono in modo diverso senza User-Agent riconoscibile.
        resp = requests.get(url, timeout=timeout,
                            headers={"User-Agent": "lupo-felix-listing/1.0"})
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"   [immagine] download fallito: {exc}")
        return None

    data = resp.content
    media = sniff_media_type(data)
    if not media:
        head = data[:16]
        print(f"   [immagine] i byte scaricati non sono un'immagine "
              f"(Content-Type={resp.headers.get('Content-Type')!r}, "
              f"{len(data)} byte, inizio={head!r}) - salto la foto")
        return None
    if len(data) > MAX_BYTES:
        print(f"   [immagine] troppo grande ({len(data) / 1e6:.1f} MB), saltata")
        return None

    print(f"   [immagine] {media}, {len(data) / 1024:.0f} KB")
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media,
                   "data": base64.standard_b64encode(data).decode("ascii")},
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
