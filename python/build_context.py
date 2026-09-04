#!/usr/bin/env python3
r"""
build_context.py - Lupo & Felix

Assembla un "context pack" per un ASIN pescando tutto via SP-API, cosi' non
devi piu' far leggere la pagina a schermo. Poi (opzionale) chiede a Claude la
copy ottimizzata gia' nel formato che update_listing.py sa applicare.

Fonti (ognuna best-effort: se manca il ruolo o i dati, si salta e si va avanti):
  1. Copy attuale        -> Listings Items 2021-08-01 (item_name/bullet/description)
  2. Limiti caratteri    -> Product Type Definitions (maxLength reali)
  3. Scheda prodotto     -> Catalog Items 2022-04-01 (brand, immagini, dimensioni)
  4. Contenuti A+        -> A+ Content 2020-11-01 (testo dei moduli)
  5. Insight recensioni  -> Customer Feedback 2024-06-01 (topic +/- , snippet, metriche)

Riusa config.py, spapi.py (auth LWA + backoff) e update_listing.py (resolve_sku,
get_listing, get_max_lengths, il contratto degli attributi) - niente duplicazione.

Uso (PowerShell):
  # solo brief leggibile + pack JSON
  python .\build_context.py --asin B0G5JC2YZ2 --marketplace IT

  # ordina i topic recensioni per impatto sulle stelle invece che per menzioni
  python .\build_context.py --asin B0G5JC2YZ2 --marketplace IT --reviews-sort STAR_RATING_IMPACT

  # chiudi il cerchio: genera la copy con Claude nel formato di update_listing
  python .\build_context.py --asin B0G5JC2YZ2 --marketplace IT --generate
  #   -> scrive listings\content\B0G5JC2YZ2_IT.json, poi:
  python .\update_listing.py --content .\listings\content\B0G5JC2YZ2_IT.json --diff

Env SP-API: LWA_CLIENT_ID, LWA_CLIENT_SECRET, LWA_REFRESH_TOKEN, SP_API_SELLER_ID
Env Claude (solo con --generate): ANTHROPIC_API_KEY, ANTHROPIC_MODEL (opzionale)

Ruoli SP-API richiesti sull'app (altrimenti quella fonte da' 403 e viene saltata):
  - "Product Listing"           -> copy attuale + limiti
  - "Brand Analytics"           -> Customer Feedback (review insights)
  - "A+ Content"                -> contenuti A+
Nota: Customer Feedback e' SOLO in inglese (topic e snippet arrivano in EN anche
per IT/FR/DE) e i dati si aggiornano settimanalmente. Coperti IT/FR/DE/ES.
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

import requests

import config
import spapi
import update_listing as ul  # riusa resolve_sku, get_listing, get_max_lengths, LANGUAGE_TAGS
import update_family as ufam  # riusa discover_children (relazione VARIATION)
import listing_signals  # termini di ricerca reali dal report Amazon Ads
import product_image  # MAIN del prodotto, per non far inventare la forma al modello
import check_quality as cq  # stesso controllo offline, lanciato qui subito dopo la generazione


# ----------------------------------------------------------------- HTTP helper


def _safe_get(path: str, params: Dict[str, Any], label: str) -> Optional[Dict[str, Any]]:
    """spapi.request in versione best-effort: logga e restituisce None invece
    di far esplodere tutto se una fonte manca (403 ruolo, 404 nessun dato)."""
    try:
        return spapi.request("GET", path, params=params)
    except requests.HTTPError as exc:
        resp = exc.response
        code = resp.status_code if resp is not None else "?"
        hint = ""
        if code == 403:
            hint = " (manca il ruolo sull'app SP-API: la salto)"
        elif code == 404:
            hint = " (nessun dato per questo ASIN: la salto)"
        print(f"  [{label}] {code}{hint}")
        return None
    except Exception as exc:  # noqa: BLE001 - vogliamo davvero non morire qui
        print(f"  [{label}] errore: {exc} (la salto)")
        return None


# ----------------------------------------------------------------- 1. copy attuale


def fetch_current_copy(sku: str, marketplace_id: str, language_tag: str) -> Dict[str, Any]:
    listing = ul.get_listing(sku, marketplace_id, language_tag)
    attrs = listing.get("attributes", {})

    def _vals(name: str) -> List[str]:
        return [e.get("value", "") for e in attrs.get(name, []) if isinstance(e, dict)]

    item_names = _vals("item_name")
    descriptions = _vals("product_description")
    summaries = listing.get("summaries", [])
    product_type = summaries[0].get("productType") if summaries else None

    return {
        "product_type": product_type,
        "item_name": item_names[0] if item_names else "",
        "bullet_point": _vals("bullet_point"),
        "product_description": descriptions[0] if descriptions else "",
        "issues": [
            f"{i.get('severity')}: {i.get('message')}"
            for i in listing.get("issues", []) or []
        ],
    }


def copy_is_empty(current: Dict[str, Any]) -> bool:
    """True se la copy non ha ne' titolo ne' bullet (scheda 'nuda')."""
    has_title = bool((current.get("item_name") or "").strip())
    has_bullets = any((b or "").strip() for b in current.get("bullet_point") or [])
    return not has_title and not has_bullets


def fetch_reference_copy(asin: str, exclude_market: str,
                         markets: Optional[List[str]] = None):
    """Cerca la copy esistente dello stesso ASIN su un ALTRO mercato.

    Serve quando il mercato target ha la scheda 'nuda' (nessun titolo/bullet):
    senza una fonte testuale Claude inventerebbe il prodotto. Ritorna
    (mercato, copy) del primo mercato con copy non vuota, oppure (None, None).
    """
    for mkt in (markets or ["IT", "DE", "FR", "ES"]):
        if mkt == exclude_market or mkt not in config.MARKETPLACES:
            continue
        try:
            mid = config.MARKETPLACES[mkt]
            ref_sku = ul.resolve_sku(asin, mid)
            cur = fetch_current_copy(ref_sku, mid, ul.LANGUAGE_TAGS[mkt])
            if not copy_is_empty(cur):
                return mkt, cur
        except Exception as exc:  # noqa: BLE001
            print(f"  (riferimento {mkt} non disponibile: {str(exc)[:120]})")
    return None, None


def reference_brief_section(ref_market: str, ref_copy: Dict[str, Any],
                            target_market: str) -> str:
    """Sezione markdown da APPENDERE al brief quando il target e' vuoto."""
    lines = [
        "",
        f"## Copy di RIFERIMENTO dal mercato {ref_market}",
        f"Il mercato target {target_market} NON ha una copy propria. La copy qui sotto",
        f"(mercato {ref_market}) e' l'UNICA fonte di verita' sul prodotto:",
        f"- ADATTALA nella lingua del mercato {target_market} (non tradurla parola per",
        "  parola: ottimizza per come i clienti locali cercano il prodotto);",
        "- NON inventare caratteristiche, materiali o dimensioni che non compaiono qui;",
        "- mantieni lo stesso tipo di prodotto e le stesse specifiche.",
        "",
        f"**Titolo ({ref_market})**",
        f"> {ref_copy.get('item_name', '')}",
        "",
        "**Bullet**",
    ]
    for i, b in enumerate(ref_copy.get("bullet_point") or [], 1):
        lines.append(f"{i}. {b}")
    desc = (ref_copy.get("product_description") or "").strip()
    if desc:
        lines += ["", "**Descrizione**", f"> {desc}"]
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------- 3. catalogo


def fetch_catalog(asin: str, marketplace_id: str) -> Optional[Dict[str, Any]]:
    out = _safe_get(
        f"/catalog/2022-04-01/items/{asin}",
        {
            "marketplaceIds": marketplace_id,
            "includedData": "summaries,images,attributes,salesRanks",
        },
        "catalog",
    )
    if not out:
        return None

    summaries = out.get("summaries", [])
    s0 = summaries[0] if summaries else {}

    images: List[str] = []
    image_candidates: List[Dict[str, Any]] = []
    for block in out.get("images", []):
        for img in block.get("images", []):
            link = img.get("link")
            if link:
                images.append(f"{img.get('variant', '?')}: {link}")
                # Forma strutturata: serve a product_image per scegliere la MAIN
                # alla risoluzione giusta. La lista di stringhe sopra resta
                # com'era perche' la usa build_markdown.
                image_candidates.append({
                    "variant": img.get("variant", ""), "link": link,
                    "width": img.get("width"), "height": img.get("height"),
                })

    ranks: List[str] = []
    for block in out.get("salesRanks", []):
        for r in block.get("displayGroupRanks", []) or block.get("classificationRanks", []):
            ranks.append(f"#{r.get('rank')} in {r.get('title')}")

    return {
        "brand": s0.get("brand", ""),
        "item_name": s0.get("itemName", ""),
        "color": s0.get("color", ""),
        "size": s0.get("size", ""),
        "images": images,
        "image_candidates": image_candidates,
        "sales_ranks": ranks,
    }


# ------------------------------------------------------------- 3b. concorrenti


def fetch_competitors(keyword: str, marketplace_id: str, exclude_asin: str = "",
                      page_size: int = 5) -> List[Dict[str, str]]:
    """searchCatalogItems: stesso endpoint di fetch_catalog(), ma per KEYWORD
    invece che per ASIN (/catalog/2022-04-01/items senza il path-param, con
    'keywords' al posto di 'identifiers'). Stesse credenziali SP-API gia'
    configurate, stesso helper _safe_get.

    Il chiamante deve passare SOLO keyword da search_terms_meta['top_terms']
    (scope 'asin'): sono le uniche su cui sappiamo che qualcuno ha davvero
    comprato QUESTO prodotto. Cercare concorrenti su parole non verificate
    (inventate o dell'intero account) produrrebbe un confronto fuorviante."""
    out = _safe_get(
        "/catalog/2022-04-01/items",
        {"marketplaceIds": marketplace_id, "keywords": keyword,
         "includedData": "summaries", "pageSize": page_size},
        "concorrenti",
    )
    if not out:
        return []

    target = (exclude_asin or "").strip().upper()
    hits: List[Dict[str, str]] = []
    for item in out.get("items", []):
        asin = (item.get("asin") or "").strip()
        if not asin or asin.upper() == target:
            continue  # e' il prodotto stesso, non un concorrente
        s0 = (item.get("summaries") or [{}])[0]
        item_name = s0.get("itemName")
        if not item_name:
            continue
        hits.append({"asin": asin, "brand": s0.get("brand", ""), "item_name": item_name})
    return hits


def fetch_competitors_for_terms(terms: List[str], marketplace_id: str, asin: str,
                                per_term: int = 5, max_terms: int = 10
                                ) -> Dict[str, List[Dict[str, str]]]:
    """Una searchCatalogItems per termine (max_terms, i primi per acquisti/click:
    e' l'ordine con cui top_terms e' gia' ordinato). Salta i termini senza risultati."""
    out: Dict[str, List[Dict[str, str]]] = {}
    for term in terms[:max_terms]:
        hits = fetch_competitors(term, marketplace_id, exclude_asin=asin, page_size=per_term)
        if hits:
            out[term] = hits
    return out


def format_competitors_md(by_term: Dict[str, List[Dict[str, str]]]) -> str:
    if not by_term:
        return ""
    md = ["\n## Concorrenti sui termini che convertono (Amazon Catalog, ricerca per keyword)\n",
         "Come chiamano il prodotto gli altri venditori che compaiono cercando QUESTI termini "
         "reali (quelli su cui questo ASIN ha gia' generato acquisti). Serve solo a capire il "
         "linguaggio in uso nella categoria, non da copiare: non promettere caratteristiche che "
         "la foto e la scheda di QUESTO prodotto non confermano.\n"]
    for term, hits in by_term.items():
        md.append(f"**\"{term}\":**")
        for h in hits:
            brand = f" — {h['brand']}" if h.get("brand") else ""
            md.append(f"- {h['item_name']}{brand}")
        md.append("")
    return "\n".join(md) + "\n"


# ----------------------------------------------------------------- 4. A+ content


def _walk_text(node: Any, out: List[str]) -> None:
    """Estrae ricorsivamente il testo dai moduli A+ (TextComponent -> .value,
    piu' altText delle immagini, che spesso contiene keyword utili)."""
    if isinstance(node, dict):
        v = node.get("value")
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
        alt = node.get("altText")
        if isinstance(alt, str) and alt.strip():
            out.append(f"[img] {alt.strip()}")
        for k, val in node.items():
            if k in ("value", "altText"):
                continue
            _walk_text(val, out)
    elif isinstance(node, list):
        for item in node:
            _walk_text(item, out)


def fetch_aplus(asin: str, marketplace_id: str, language_tag: str) -> Optional[Dict[str, Any]]:
    records = _safe_get(
        "/aplus/2020-11-01/contentPublishRecords",
        {"marketplaceId": marketplace_id, "asin": asin},
        "aplus",
    )
    if not records:
        return None

    published = records.get("publishRecordList", [])
    if not published:
        print("  [aplus] nessun contenuto A+ pubblicato per questo ASIN")
        return None

    # Preferisci il record nella lingua del marketplace, altrimenti il primo.
    chosen = next((r for r in published if r.get("locale") == language_tag), published[0])
    key = chosen.get("contentReferenceKey")

    doc = _safe_get(
        f"/aplus/2020-11-01/contentDocuments/{key}",
        {"marketplaceId": marketplace_id, "includedDataSet": "CONTENTS"},
        "aplus-doc",
    )
    if not doc:
        return None

    content = doc.get("contentDocument", {})
    texts: List[str] = []
    _walk_text(content.get("contentModuleList", []), texts)

    # dedup preservando l'ordine
    seen, unique = set(), []
    for t in texts:
        if t not in seen:
            seen.add(t)
            unique.append(t)

    return {"name": content.get("name", ""), "locale": chosen.get("locale", ""), "texts": unique}


# ----------------------------------------------------------------- 5. recensioni


def _topic_row(t: Dict[str, Any]) -> Dict[str, Any]:
    m = t.get("asinMetrics", {}) or {}
    return {
        "topic": t.get("topic", ""),
        "mentions": m.get("numberOfMentions"),
        "occurrence_pct": m.get("occurrencePercentage"),
        "star_impact": m.get("starRatingImpact"),
        "snippets": t.get("reviewSnippets", []) or [],
        "subtopics": [
            {
                "subtopic": s.get("subtopic", ""),
                "mentions": (s.get("metrics", {}) or {}).get("numberOfMentions"),
                "snippets": s.get("reviewSnippets", []) or [],
            }
            for s in t.get("subtopics", []) or []
        ],
    }


def fetch_reviews(asin: str, marketplace_id: str, sort_by: str) -> Optional[Dict[str, Any]]:
    out = _safe_get(
        f"/customerFeedback/2024-06-01/items/{asin}/reviews/topics",
        {"marketplaceId": marketplace_id, "sortBy": sort_by},
        "reviews",
    )
    if not out:
        return None

    topics = out.get("topics", {}) or {}
    return {
        "date_range": out.get("dateRange", {}),
        "positive": [_topic_row(t) for t in topics.get("positiveTopics", []) or []],
        "negative": [_topic_row(t) for t in topics.get("negativeTopics", []) or []],
    }


# ----------------------------------------------------------------- brief markdown


def _fmt_topics(rows: List[Dict[str, Any]]) -> str:
    if not rows:
        return "_(nessun dato)_\n"
    lines = []
    for r in rows:
        head = f"- **{r['topic']}**"
        bits = []
        if r.get("mentions") is not None:
            bits.append(f"{r['mentions']} menzioni")
        if r.get("star_impact") is not None:
            bits.append(f"impatto stelle {r['star_impact']}")
        if bits:
            head += f" ({', '.join(bits)})"
        lines.append(head)
        for s in r.get("snippets", [])[:3]:
            lines.append(f"    - \u201c{s}\u201d")
        for st in r.get("subtopics", [])[:3]:
            lines.append(f"    - _{st['subtopic']}_ ({st.get('mentions')} menzioni)")
    return "\n".join(lines) + "\n"


def build_markdown(pack: Dict[str, Any]) -> str:
    asin = pack["asin"]
    mkt = pack["marketplace"]
    cur = pack["current_copy"]
    limits = pack.get("max_lengths") or {}
    cat = pack.get("catalog")
    aplus = pack.get("aplus")
    rev = pack.get("reviews")

    def lim(attr: str) -> str:
        v = limits.get(attr)
        return f" (max {v})" if v else ""

    md = [f"# Context pack - {asin} / {mkt}\n"]
    if pack.get("sku"):
        md.append(f"SKU: `{pack['sku']}` - product type: `{cur.get('product_type')}`\n")

    md.append("## Copy attuale\n")
    md.append(f"**Titolo**{lim('item_name')} - {len(cur['item_name'])} car.\n")
    md.append(f"> {cur['item_name']}\n")
    md.append(f"\n**Bullet**{lim('bullet_point')}\n")
    for i, b in enumerate(cur["bullet_point"]):
        md.append(f"{i + 1}. ({len(b)} car.) {b}")
    md.append(f"\n**Descrizione**{lim('product_description')} - {len(cur['product_description'])} car.\n")
    md.append(f"> {cur['product_description']}\n")
    if cur.get("issues"):
        md.append("\n**Issue aperti sul listing:**\n")
        for iss in cur["issues"]:
            md.append(f"- {iss}")

    if cat:
        md.append("\n## Scheda prodotto\n")
        md.append(f"- Brand: {cat.get('brand')}")
        if cat.get("color") or cat.get("size"):
            md.append(f"- Variante: colore={cat.get('color') or '-'}, taglia={cat.get('size') or '-'}")
        for r in cat.get("sales_ranks", []):
            md.append(f"- Rank: {r}")
        if cat.get("images"):
            md.append(f"- Immagini ({len(cat['images'])}):")
            for img in cat["images"][:8]:
                md.append(f"    - {img}")

    if aplus:
        md.append(f"\n## Contenuti A+ (locale {aplus.get('locale')})\n")
        for t in aplus.get("texts", [])[:40]:
            md.append(f"- {t}")

    if rev:
        dr = rev.get("date_range", {})
        span = f" ({dr.get('startDate','?')[:10]} -> {dr.get('endDate','?')[:10]})" if dr else ""
        md.append(f"\n## Insight recensioni{span}  \n_topic e snippet sono in inglese (limite API)_\n")
        md.append("**Cosa apprezzano (positivi):**")
        md.append(_fmt_topics(rev.get("positive", [])))
        md.append("**Cosa lamentano (negativi) - obiezioni da anticipare nella copy:**")
        md.append(_fmt_topics(rev.get("negative", [])))

    if pack.get("search_terms_md"):
        md.append(pack["search_terms_md"])

    if pack.get("sqp_md"):
        md.append(pack["sqp_md"])

    if pack.get("competitors_md"):
        md.append(pack["competitors_md"])

    return "\n".join(md) + "\n"


# ----------------------------------------------------------------- Claude (opz.)


COPY_CONTRACT = """Sei il copywriter di Lupo & Felix, brand di accessori per gatti e animali domestici.
Scrivi copy per una scheda prodotto Amazon nella lingua del marketplace indicato.

REGOLE FERREE SUL FORMATO DELL'OUTPUT:
- Rispondi SOLO con un oggetto JSON valido. Nessun preambolo, nessun commento, nessun backtick.
- Struttura esatta:
  {"asin": "...", "sku": null, "marketplace": "XX",
   "attributes": {"item_name": "...", "bullet_point": ["...", "..."], "product_description": "..."}}
- Nessun'altra chiave dentro "attributes": SOLO item_name, bullet_point, product_description.
- Rispetta i limiti caratteri indicati nel brief per ogni campo (se ci sono).

STILE:
- Titolo denso di keyword ma leggibile; benefici concreti, non aggettivi vuoti.
- 5 bullet: ognuno apre con un beneficio in MAIUSCOLO, poi la spiegazione.
- Se ti viene fornita la foto del prodotto, GUARDALA prima di scrivere. Descrivi la
  forma, il materiale e il modo d'uso che vedi, non quelli che afferma la copy attuale:
  una copy sbagliata sull'oggetto va corretta, non riscritta meglio. Non inventare
  caratteristiche che nella foto non si vedono e che nessuna fonte del brief conferma.
- Usa gli insight delle recensioni: rafforza cio' che i clienti apprezzano, anticipa
  le obiezioni dei topic negativi. Non citare mai "recensioni" esplicitamente.
- Se il brief contiene la sezione "Termini che convertono", i termini che hanno
  generato acquisti vanno usati con le PAROLE ESATTE dei clienti: i primi due nel
  titolo, gli altri distribuiti nei bullet. Sono dati di vendita reali, non stime.
  Se pero' quella sezione e' marcata come dati "dell'intero account" e non di questo
  ASIN, trattala solo come indizio sul linguaggio del brand: non promettere
  caratteristiche che il prodotto non ha pur di includere un termine.
- I termini elencati come "traffico che NON converte" NON possono comparire nel titolo.
  Puoi usarli al massimo in un bullet, e solo se la foto e il brief confermano che il
  prodotto risponde davvero a quell'intenzione di ricerca. Se un termine non converte
  perche' la copy attuale descrive male il prodotto, la correzione e' descrivere bene
  il prodotto, non ripetere il termine piu' volte.
- Se il brief contiene la sezione "Concorrenti sui termini che convertono", usala solo per
  capire il linguaggio della categoria (come i venditori concorrenti chiamano un prodotto
  simile). Non copiare le loro affermazioni e non attribuire al TUO prodotto caratteristiche
  che vedi nei loro titoli: quello che scrivi deve restare confermato dalla foto e dalla
  scheda di questo ASIN.
- Se il brief contiene la sezione "Volume di ricerca reale (Search Query Performance)", usala
  per capire QUALI query i clienti cercano davvero sul mercato e con che frequenza, anche
  query su cui non hai mai fatto pubblicita'. NON e' una conferma di acquisto per questo ASIN
  (a differenza di "Termini che convertono"): una query ad alto volume ma bassa quota
  acquisti per questo ASIN e' un'opportunita' da valutare, non un termine da infilare a forza
  nel titolo. Preferisci sempre i "Termini che convertono" quando i due elenchi si sovrappongono.
- Voce del brand: pratica, calda, mai iperbolica. Chiudi la descrizione con la firma Lupo & Felix.
"""


def _claude_json(system: str, user: str, max_tokens: int = 4096,
                 images: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """POST unico verso la Messages API; ritorna il JSON parsato dalla risposta.
    Impone JSON puro (niente backtick/preamboli) via system prompt del chiamante.
    Se la risposta arriva troncata (stop_reason=max_tokens o JSON incompleto),
    riprova UNA volta raddoppiando il limite."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY non impostata: non posso generare la copy.")
    # os.getenv(..., default) usa il default SOLO se la var non esiste. In GitHub
    # Actions, "ANTHROPIC_MODEL: ${{ secrets.ANTHROPIC_MODEL }}" imposta comunque
    # la var, a stringa vuota se il secret non e' configurato nel repo: il default
    # non scatta e il model finisce vuoto (da cui l'errore "String should have at
    # least 1 character"). Con "or" il default scatta anche su stringa vuota.
    model = os.getenv("ANTHROPIC_MODEL") or "claude-sonnet-5"
    max_tokens = int(os.getenv("ANTHROPIC_MAX_TOKENS", max_tokens))

    # Immagini prima del testo: la Messages API rende meglio con questo ordine.
    content: Any = user if not images else [*images, {"type": "text", "text": user}]

    def _call(mt: int):
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": model, "max_tokens": mt, "system": system,
                  "messages": [{"role": "user", "content": content}]},
            timeout=180,
        )
        if resp.status_code >= 400:
            # raise_for_status() scarta il corpo, che e' l'unico posto dove l'API
            # dice cosa non va (modello inesistente, immagine illeggibile, ...).
            raise RuntimeError(
                f"Anthropic API {resp.status_code} (model={model!r}, "
                f"{len(content) if isinstance(content, list) else 1} blocchi): "
                f"{resp.text[:600]}")
        data = resp.json()
        text = "".join(b.get("text", "") for b in data.get("content", [])
                       if b.get("type") == "text")
        text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        return text, data.get("stop_reason")

    text, stop = _call(max_tokens)
    if stop == "max_tokens":
        print(f"  (risposta troncata a {max_tokens} token: riprovo con {max_tokens * 2})")
        text, stop = _call(max_tokens * 2)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # ultimo tentativo: la troncatura puo' non risultare da stop_reason
        # (es. proxy); riprova una volta col limite raddoppiato.
        if stop != "max_tokens":
            print("  (JSON incompleto: riprovo con limite token raddoppiato)")
            text, _ = _call(max_tokens * 2)
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"Risposta del modello non parsabile come JSON ({exc}). "
                    f"Inizio risposta: {text[:200]!r}") from exc
        raise RuntimeError(
            f"Risposta troncata anche con {max_tokens * 2} token: riduci la copy "
            f"richiesta o alza ANTHROPIC_MAX_TOKENS.")


def generate_copy(brief_md: str, asin: str, marketplace: str,
                  image: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Copy per un singolo prodotto, nel formato che update_listing.py applica."""
    img_note = (
        "\n\nIn testa al messaggio trovi la FOTO PRINCIPALE del prodotto. "
        "E' la fonte piu' affidabile su com'e' fatto l'oggetto: se la copy attuale "
        "la contraddice, la foto ha ragione e la copy va corretta.\n\n"
        if image else "\n\n"
    )
    user_msg = (
        f"Marketplace: {marketplace}. ASIN: {asin}.{img_note}"
        f"Ecco il brief con copy attuale, scheda prodotto e insight recensioni:\n\n{brief_md}\n\n"
        "Riscrivi item_name, bullet_point (5) e product_description. Restituisci solo il JSON."
    )
    copy = _claude_json(COPY_CONTRACT, user_msg, images=[image] if image else None)
    copy["asin"] = asin
    copy["marketplace"] = marketplace
    copy.setdefault("sku", None)
    bad = set(copy.get("attributes", {})) - set(ul.SUPPORTED_ATTRIBUTES)
    if bad:
        raise ValueError(f"Claude ha prodotto attributi non gestiti: {', '.join(bad)}")
    return copy


FAMILY_CONTRACT = """Sei il copywriter di Lupo & Felix, brand di accessori per gatti e animali domestici.
Scrivi la copy CONDIVISA di una famiglia di varianti (child che cambiano solo per colore/taglia)
per una scheda prodotto Amazon, nella lingua del marketplace indicato.

REGOLE FERREE SUL FORMATO DELL'OUTPUT:
- Rispondi SOLO con un oggetto JSON valido. Nessun preambolo, nessun commento, nessun backtick.
- Struttura esatta:
  {"shared": {"bullet_point": ["...", "..."], "product_description": "..."},
   "title_template": "... {color} {size} ..."}
- "shared" contiene SOLO bullet_point (5 elementi) e product_description: sono identici per tutte le varianti.
- "title_template" e' il titolo con i segnaposto {color} e {size} dove andranno colore e taglia del child.
  Il template DEVE contenere sia {color} sia {size}. Rispetta il limite caratteri del titolo tenendo conto
  che colore e taglia aggiungono ~15-25 caratteri.

STILE:
- Bullet: ognuno apre con un beneficio in MAIUSCOLO, poi la spiegazione. Non citare colori/taglie specifici
  (sono condivisi tra le varianti).
- Se ti viene fornita la foto del prodotto, GUARDALA prima di scrivere. Descrivi la
  forma, il materiale e il modo d'uso che vedi, non quelli che afferma la copy attuale:
  una copy sbagliata sull'oggetto va corretta, non riscritta meglio. Non inventare
  caratteristiche che nella foto non si vedono e che nessuna fonte del brief conferma.
- Usa gli insight delle recensioni: rafforza cio' che i clienti apprezzano, anticipa le obiezioni negative.
  Non citare mai "recensioni" esplicitamente.
- Voce del brand: pratica, calda, mai iperbolica. Chiudi la descrizione con la firma Lupo & Felix.
"""


def generate_family_copy(brief_md: str, marketplace: str,
                         image: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Copy condivisa + template titolo per una famiglia (formato di update_family.py)."""
    img_note = ("In testa trovi la FOTO PRINCIPALE del parent: descrive la forma reale "
                "del prodotto e prevale sulla copy attuale se la contraddice.\n\n"
                if image else "")
    user_msg = (
        f"Marketplace: {marketplace}.\n\n{img_note}"
        f"Brief della famiglia (copy attuale del parent + insight recensioni):\n\n{brief_md}\n\n"
        "Scrivi shared.bullet_point (5), shared.product_description e title_template. Solo JSON."
    )
    out = _claude_json(FAMILY_CONTRACT, user_msg, images=[image] if image else None)
    shared = out.get("shared", {})
    bad = set(shared) - {"bullet_point", "product_description"}
    if bad:
        raise ValueError(f"Claude ha prodotto chiavi shared non gestite: {', '.join(bad)}")
    return out


def build_family_json(marketplace: str, shared: Dict[str, Any],
                      title_template: Optional[str] = None,
                      parent_sku: Optional[str] = None,
                      parent_asin: Optional[str] = None) -> Dict[str, Any]:
    """Compone il dict del file famiglia che update_family.py sa consumare."""
    fam: Dict[str, Any] = {"marketplace": marketplace, "shared": shared}
    if title_template:
        fam["title_template"] = title_template
    if parent_sku:
        fam["parent_sku"] = parent_sku
    elif parent_asin:
        fam["parent_asin"] = parent_asin
    return fam


def assemble_pack(asin: str, marketplace: str, sku: Optional[str] = None,
                  want_catalog: bool = True, want_aplus: bool = True,
                  want_reviews: bool = True, reviews_sort: str = "MENTIONS",
                  reviews: Optional[Dict[str, Any]] = None,
                  search_terms_dir: Optional[str] = None,
                  search_terms_top: int = 20,
                  sqp_dir: Optional[str] = None,
                  sqp_top: int = 15) -> Dict[str, Any]:
    """Raccoglie tutte le fonti per un ASIN e restituisce il pack. Se 'reviews'
    e' passato (cache condivisa tra mercati), non le riscarica."""
    marketplace_id = config.MARKETPLACES[marketplace]
    language_tag = ul.LANGUAGE_TAGS[marketplace]
    if not sku:
        sku = ul.resolve_sku(asin, marketplace_id)

    current = fetch_current_copy(sku, marketplace_id, language_tag)
    try:
        max_lengths = ul.get_max_lengths(current["product_type"], marketplace_id)
    except Exception:  # noqa: BLE001
        max_lengths = {}

    catalog = fetch_catalog(asin, marketplace_id) if want_catalog else None
    aplus = fetch_aplus(asin, marketplace_id, language_tag) if want_aplus else None
    if reviews is None and want_reviews:
        reviews = fetch_reviews(asin, marketplace_id, reviews_sort)

    search_terms_md, search_terms_meta = "", {"available": False}
    if search_terms_dir:
        search_terms_md, search_terms_meta = listing_signals.search_terms_section(
            marketplace, asin, search_terms_dir, top=search_terms_top)
        if not search_terms_meta.get("available"):
            print(f"   [search term] nessun dato: {search_terms_meta.get('reason')}",
                  file=sys.stderr)
        else:
            print(f"   [search term] scope={search_terms_meta['scope']}, "
                  f"{search_terms_meta['terms_converting']} termini con acquisti "
                  f"su {search_terms_meta['terms_total']}", file=sys.stderr)

    sqp_md, sqp_meta = "", {"available": False}
    if sqp_dir:
        sqp_md, sqp_meta = listing_signals.search_query_performance_section(
            marketplace, asin, sqp_dir, top=sqp_top)
        if not sqp_meta.get("available"):
            print(f"   [sqp] nessun dato: {sqp_meta.get('reason')}", file=sys.stderr)
        else:
            print(f"   [sqp] {sqp_meta['queries_total']} query di mercato", file=sys.stderr)

    return {
        "asin": asin, "sku": sku, "marketplace": marketplace,
        "current_copy": current, "max_lengths": max_lengths,
        "catalog": catalog, "aplus": aplus, "reviews": reviews,
        "search_terms_md": search_terms_md, "search_terms_meta": search_terms_meta,
        "sqp_md": sqp_md, "sqp_meta": sqp_meta,
    }


def skeleton_single(pack: Dict[str, Any]) -> Dict[str, Any]:
    """JSON singolo NON generato: usa la copy attuale (utile senza API key)."""
    cur = pack["current_copy"]
    return {
        "asin": pack["asin"], "sku": None, "marketplace": pack["marketplace"],
        "_note": "copy attuale non modificata (generazione Claude disattivata)",
        "attributes": {
            "item_name": cur["item_name"],
            "bullet_point": cur["bullet_point"],
            "product_description": cur["product_description"],
        },
    }


def skeleton_family(pack: Dict[str, Any], parent_sku: Optional[str],
                    parent_asin: Optional[str]) -> Dict[str, Any]:
    """family.json NON generato: shared dalla copy attuale, template dal titolo attuale."""
    cur = pack["current_copy"]
    shared = {"bullet_point": cur["bullet_point"], "product_description": cur["product_description"]}
    return build_family_json(pack["marketplace"], shared, title_template=None,
                             parent_sku=parent_sku, parent_asin=parent_asin)


# ----------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="Assembla il context pack di un ASIN via SP-API")
    ap.add_argument("--asin", required=True)
    ap.add_argument("--marketplace", default="IT", help="IT/FR/DE/ES/UK")
    ap.add_argument("--sku", default=None, help="Se noto, salta il lookup ASIN->SKU")
    ap.add_argument("--reviews-sort", default="MENTIONS",
                    choices=["MENTIONS", "STAR_RATING_IMPACT"])
    ap.add_argument("--no-catalog", action="store_true")
    ap.add_argument("--no-aplus", action="store_true")
    ap.add_argument("--no-reviews", action="store_true")
    ap.add_argument("--outdir", default="listings/context")
    ap.add_argument("--generate", action="store_true",
                    help="Chiedi a Claude la copy e scrivila in listings/content")
    ap.add_argument("--source-marketplace", default=None,
                    help="Mercato da cui prendere la copy di riferimento (es. IT) "
                         "quando il target e' vuoto o vuoi adattare una copy esistente")
    ap.add_argument("--family", action="store_true",
                    help="Tratta --asin/--sku come parent: scopre i child e produce un family.json")
    ap.add_argument("--data-dir", default="../public/data",
                    help="Cartella dei JSON pubblicati da weekly_analysis.py "
                         "(report search term). '' o --no-search-terms per saltare.")
    ap.add_argument("--no-image", action="store_true",
                    help="Non passare la foto del prodotto al modello (solo con --generate)")
    ap.add_argument("--no-search-terms", action="store_true",
                    help="Non includere i termini di ricerca nel brief")
    ap.add_argument("--search-terms-top", type=int, default=20)
    ap.add_argument("--sqp-dir", default="../public/data",
                    help="Cartella dei JSON pubblicati da fetch_search_query_performance.py "
                         "(SQP_<MKT>.json, volume di ricerca reale). '' o --no-sqp per saltare.")
    ap.add_argument("--no-sqp", action="store_true",
                    help="Non includere il volume di ricerca reale (Search Query Performance) nel brief")
    ap.add_argument("--sqp-top", type=int, default=15)
    ap.add_argument("--no-competitors", action="store_true",
                    help="Non cercare i concorrenti sui termini che convertono (searchCatalogItems)")
    args = ap.parse_args()

    market = args.marketplace.upper()
    if market not in config.MARKETPLACES:
        print(f"Marketplace '{market}' sconosciuto. Noti: {', '.join(config.MARKETPLACES)}",
              file=sys.stderr)
        return 1
    marketplace_id = config.MARKETPLACES[market]
    language_tag = ul.LANGUAGE_TAGS[market]

    # --- SKU
    sku = args.sku
    if not sku:
        print(f"Risolvo lo SKU per ASIN {args.asin} su {market}...")
        sku = ul.resolve_sku(args.asin, marketplace_id)
    print(f"SKU: {sku}\n")

    # --- 1+2 copy + limiti (obbligatori: se falliscono, e' un problema vero)
    print("Fonti:")
    current = fetch_current_copy(sku, marketplace_id, language_tag)
    print("  [copy] ok")
    try:
        max_lengths = ul.get_max_lengths(current["product_type"], marketplace_id)
        print(f"  [limiti] {max_lengths or 'non esposti'}")
    except Exception as exc:  # noqa: BLE001
        print(f"  [limiti] non recuperabili ({exc})")
        max_lengths = {}

    # --- 3/4/5 best-effort
    catalog = None if args.no_catalog else fetch_catalog(args.asin, marketplace_id)
    if catalog:
        print("  [catalog] ok")
    aplus = None if args.no_aplus else fetch_aplus(args.asin, marketplace_id, language_tag)
    if aplus:
        print(f"  [aplus] {len(aplus['texts'])} blocchi di testo")
    reviews = None if args.no_reviews else fetch_reviews(args.asin, marketplace_id, args.reviews_sort)
    if reviews:
        print(f"  [reviews] {len(reviews['positive'])} topic +, {len(reviews['negative'])} topic -")

    st_md, st_meta = "", {"available": False, "reason": "disattivato"}
    if not args.no_search_terms and args.data_dir:
        st_md, st_meta = listing_signals.search_terms_section(
            market, args.asin, args.data_dir, top=args.search_terms_top)
    if st_meta.get("available"):
        scope_label = ("dell'ASIN" if st_meta["scope"] == "asin"
                       else "dell'account (ASIN senza dati propri)")
        print(f"  [search term] {scope_label}: {st_meta['terms_converting']} con acquisti "
              f"su {st_meta['terms_total']} termini")
    else:
        print(f"  [search term] non inclusi ({st_meta.get('reason')})")

    sqp_md, sqp_meta = "", {"available": False, "reason": "disattivato"}
    if not args.no_sqp and args.sqp_dir:
        sqp_md, sqp_meta = listing_signals.search_query_performance_section(
            market, args.asin, args.sqp_dir, top=args.sqp_top)
    if sqp_meta.get("available"):
        print(f"  [sqp] {sqp_meta['queries_total']} query di mercato (periodo "
              f"{sqp_meta.get('start', '?')} -> {sqp_meta.get('end', '?')})")
    else:
        print(f"  [sqp] non incluso ({sqp_meta.get('reason')})")

    # Concorrenti SOLO sui termini che convertono di questo ASIN (scope 'asin'):
    # se i termini sono dell'intero account (nessun dato ads ancora per l'ASIN)
    # non sono confermati come intento di ricerca per questo prodotto, quindi
    # cercare "concorrenti" su quelle parole confronterebbe cose a caso.
    competitors, competitors_md = {}, ""
    if not args.no_competitors and st_meta.get("available") and st_meta.get("scope") == "asin":
        competitors = fetch_competitors_for_terms(st_meta["top_terms"], marketplace_id, args.asin)
        competitors_md = format_competitors_md(competitors)
        n_hits = sum(len(v) for v in competitors.values())
        print(f"  [concorrenti] {n_hits} risultati su {len(competitors)}/{len(st_meta['top_terms'])} termini")

    pack = {
        "asin": args.asin,
        "sku": sku,
        "marketplace": market,
        "current_copy": current,
        "max_lengths": max_lengths,
        "catalog": catalog,
        "aplus": aplus,
        "reviews": reviews,
        "search_terms_md": st_md,
        "search_terms_meta": st_meta,
        "sqp_md": sqp_md,
        "sqp_meta": sqp_meta,
        "competitors": competitors,
        "competitors_md": competitors_md,
    }

    main_img = None
    if args.generate and not args.no_image:
        main_img = product_image.main_image_block(catalog)
        if main_img is None:
            print("  [immagine] non disponibile: la copy sara' generata senza foto")

    os.makedirs(args.outdir, exist_ok=True)
    base = os.path.join(args.outdir, f"{args.asin}_{market}")
    with open(base + ".json", "w", encoding="utf-8") as fh:
        json.dump(pack, fh, ensure_ascii=False, indent=2)
    brief = build_markdown(pack)
    with open(base + ".md", "w", encoding="utf-8") as fh:
        fh.write(brief)
    print(f"\nContext pack salvato:\n  {base}.json\n  {base}.md")

    # --- modalita' FAMIGLIA: produce un family.json per update_family.py
    if args.family:
        child_skus, _theme = ufam.discover_children(sku, marketplace_id)
        print(f"\nParent {sku}: {len(child_skus)} child ({', '.join(child_skus) or 'nessuno'})")
        # Il parent spesso non ha bullet/descrizione: se mancano, prendo quelli del primo child.
        if not current["bullet_point"] and child_skus:
            child_copy = fetch_current_copy(child_skus[0], marketplace_id, language_tag)
            pack["current_copy"] = child_copy
            brief = build_markdown(pack)
            print(f"  (copy assente sul parent -> uso il child {child_skus[0]} per il brief)")

        os.makedirs("listings/family", exist_ok=True)
        fam_out = os.path.join("listings", "family", f"{args.asin}_{market}.json")
        if args.generate:
            print("Chiedo a Claude la copy condivisa della famiglia...")
            fc = generate_family_copy(brief, market, image=main_img)
            family = build_family_json(market, fc["shared"], fc.get("title_template"),
                                       parent_sku=sku)
        else:
            family = skeleton_family(pack, parent_sku=sku, parent_asin=None)
        with open(fam_out, "w", encoding="utf-8") as fh:
            json.dump(family, fh, ensure_ascii=False, indent=2)
        print(f"Family file salvato in {fam_out}")
        print(f"Verifica con:\n  python .\\update_family.py --family .\\{fam_out} --diff")
        return 0

    # --- generate opzionale (singolo prodotto)
    if args.generate:
        # Copy di riferimento da un altro mercato: esplicita (--source-marketplace)
        # o automatica se la copy del target e' vuota (senza una fonte testuale
        # Claude inventerebbe il prodotto).
        src_mkt = (args.source_marketplace or "").upper() or None
        if src_mkt or copy_is_empty(current):
            markets = [src_mkt] if src_mkt else None
            ref_mkt, ref_copy = fetch_reference_copy(args.asin, market, markets)
            if ref_mkt:
                brief += reference_brief_section(ref_mkt, ref_copy, market)
                print(f"Copy di riferimento: mercato {ref_mkt}.")
            elif copy_is_empty(current):
                print("ERRORE: la copy e' vuota sul mercato target E su tutti gli altri", file=sys.stderr)
                print("mercati: Claude non ha una fonte e inventerebbe il prodotto.", file=sys.stderr)
                print("Compila almeno il titolo su un mercato, oppure indica", file=sys.stderr)
                print("--source-marketplace di un mercato che ha la copy.", file=sys.stderr)
                return 1
        print("\nChiedo la copy a Claude...")
        copy = generate_copy(brief, args.asin, market, image=main_img)
        os.makedirs("listings/content", exist_ok=True)
        out = os.path.join("listings", "content", f"{args.asin}_{market}.json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(copy, fh, ensure_ascii=False, indent=2)
        print(f"Copy generata in {out}")

        # Stesso controllo di check_quality.py, lanciato qui in automatico: non e' un
        # gate (non fa fallire la build, che deve comunque committare per la UI), solo
        # un avviso ben visibile nel log se la copy non rispetta il brief che ha letto.
        print("\nControllo qualita':")
        n_error, n_warning = cq.check_one(out, f"{base}.json")
        if n_error:
            print(f"\n{n_error} ERROR nel controllo qualita': rileggi la copy prima di applicarla "
                 f"con update_listing.py (o rilancia:\n  python .\\check_quality.py --content .\\{out})")

        print(f"\nVerifica con:\n  python .\\update_listing.py --content .\\{out} --diff")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"\n{exc}", file=sys.stderr)
        sys.exit(1)
