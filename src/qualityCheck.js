/**
 * Porting JS di python/check_quality.py, per mostrare l'esito del controllo
 * qualita' direttamente nella UI (ListingPanel) senza dover leggere i log del
 * workflow. Stessa logica, stessi messaggi, stessa severita' (ERROR/WARNING/
 * INFO) — se cambia una delle due versioni, cambia anche l'altra.
 *
 * Legge lo stesso context pack (listings/context/<ASIN>_<MKT>.json) e lo
 * stesso content JSON (listings/content/<ASIN>_<MKT>.json) che produce
 * build_context.py --generate.
 */

export const SUPPORTED_ATTRIBUTES = ["item_name", "bullet_point", "product_description"];

// Usati solo se il context pack non espone max_lengths per l'attributo
// (stessi valori di FALLBACK_MAXLEN in update_listing.py).
const FALLBACK_MAXLEN = { item_name: 200, bullet_point: 500, product_description: 2000 };

function fullText(attrs) {
  const bp = Array.isArray(attrs.bullet_point)
    ? attrs.bullet_point
    : (typeof attrs.bullet_point === "string" ? [attrs.bullet_point] : []);
  const parts = [attrs.item_name || "", ...bp, attrs.product_description || ""];
  return parts.filter((p) => typeof p === "string").join(" \n ").toLowerCase();
}

// Parole comuni (articoli/preposizioni/congiunzioni) nelle lingue dei 5
// marketplace supportati (IT/FR/DE/ES/UK), escluse dal conteggio ripetizioni
// di checkRepeatedWords — specchio di _TITLE_STOPWORDS in check_quality.py.
const TITLE_STOPWORDS = new Set([
  // italiano
  "e", "il", "lo", "la", "i", "gli", "le", "di", "del", "dello", "della",
  "dei", "degli", "delle", "da", "dal", "dallo", "dalla", "dai", "dagli",
  "dalle", "in", "nel", "nello", "nella", "nei", "negli", "nelle", "con",
  "su", "sul", "sullo", "sulla", "sui", "sugli", "sulle", "per", "tra",
  "fra", "un", "uno", "una", "o", "che", "non", "come", "piu", "anche",
  // francese
  "et", "les", "des", "du", "un", "une", "pour", "avec", "dans", "en",
  "au", "aux", "sur", "ou", "que", "ne", "se", "ce", "ces", "son", "sa",
  "ses", "sans",
  // spagnolo
  "y", "el", "los", "las", "de", "del", "para", "con", "en", "una",
  "unos", "unas", "al", "sobre", "o", "que", "sin",
  // tedesco
  "und", "der", "die", "das", "den", "dem", "des", "ein", "eine",
  "einen", "einem", "einer", "eines", "fur", "mit", "auf", "oder",
  "dass", "ohne",
  // inglese
  "and", "for", "with", "on", "of", "a", "an", "to", "or", "the",
]);

// La SP-API (Listings Items) rifiuta un titolo dove la stessa parola compare
// piu' di due volte (issue 100470). Controllo SOLO sul titolo (item_name),
// specchio di check_repeated_words in check_quality.py.
function checkRepeatedWords(attrs) {
  const title = attrs.item_name;
  if (typeof title !== "string" || !title.trim()) return [];
  const words = title.toLowerCase().match(/[^\W\d_]+/gu) || [];
  const counts = {};
  for (const w of words) {
    if (w.length <= 2 || TITLE_STOPWORDS.has(w)) continue;
    counts[w] = (counts[w] || 0) + 1;
  }
  const repeated = Object.keys(counts).filter((w) => counts[w] > 2).sort();
  if (!repeated.length) return [];
  return [{
    severity: "ERROR",
    message: `parola ripetuta piu' di 2 volte nel titolo: ${repeated.join(", ")} — la SP-API rifiuta questi titoli (issue 100470), riformula per usarla al massimo 2 volte`,
  }];
}

function checkSupportedAttrs(attrs) {
  const bad = Object.keys(attrs).filter((k) => !SUPPORTED_ATTRIBUTES.includes(k));
  if (bad.length) {
    return [{ severity: "ERROR", message: `attributi non gestiti nel content JSON: ${bad.join(", ")} (gestiti: ${SUPPORTED_ATTRIBUTES.join(", ")})` }];
  }
  return [];
}

function checkLengths(attrs, maxLengths) {
  const problems = [];
  for (const [attr, value] of Object.entries(attrs)) {
    const limit = (maxLengths && maxLengths[attr] != null) ? maxLengths[attr] : FALLBACK_MAXLEN[attr];
    if (limit == null) continue;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((v, i) => {
      const s = typeof v === "string" ? v : String(v ?? "");
      if (s.length > limit) {
        const label = Array.isArray(value) ? `${attr}[${i}]` : attr;
        problems.push({ severity: "ERROR", message: `limite caratteri: ${label}: ${s.length} car., limite ${limit} (+${s.length - limit})` });
      }
    });
  }
  return problems;
}

function checkConvertingTerms(attrs, meta) {
  const topTerms = meta.top_terms || [];
  if (!topTerms.length) return [];
  const scope = meta.scope;
  const title = (attrs.item_name || "").toLowerCase();
  const full = fullText(attrs);
  const problems = [];

  for (const term of topTerms) {
    if (!full.includes(term.toLowerCase())) {
      problems.push({
        severity: scope === "asin" ? "ERROR" : "WARNING",
        message: `termine convertitore assente: '${term}' non compare ne' in titolo, ne' nei bullet, ne' in descrizione`,
      });
    }
  }
  // "i primi due nel titolo" vale solo quando i termini sono di QUESTO ASIN.
  if (scope === "asin") {
    for (const term of topTerms.slice(0, 2)) {
      if (!title.includes(term.toLowerCase())) {
        problems.push({ severity: "WARNING", message: `termine convertitore prioritario non nel titolo: '${term}' (e' tra i primi due per acquisti/click)` });
      }
    }
  }
  return problems;
}

function checkAvoidTerms(attrs, meta) {
  const avoid = meta.avoid_terms || [];
  if (!avoid.length) return [];
  let title = (attrs.item_name || "").toLowerCase();
  let full = fullText(attrs);

  // Maschera i termini convertitori (piu' lunghi per primi) prima di cercare
  // gli avoid_terms, cosi' un avoid term che e' sottostringa di un termine
  // convertitore (es. "amaca gatto" dentro "amaca gatto esterno") non genera
  // un falso positivo. Stessa logica di check_avoid_terms in check_quality.py.
  const topTerms = [...(meta.top_terms || [])].sort((a, b) => b.length - a.length);
  for (const t of topTerms) {
    const tl = t.toLowerCase();
    if (!tl) continue;
    title = title.split(tl).join(" ".repeat(tl.length));
    full = full.split(tl).join(" ".repeat(tl.length));
  }

  const problems = [];
  for (const term of avoid) {
    const t = term.toLowerCase();
    if (title.includes(t)) {
      problems.push({ severity: "ERROR", message: `termine che NON converte nel titolo: '${term}' (traffico pagato, zero acquisti — non puo' stare nel titolo)` });
    } else if (full.includes(t)) {
      problems.push({ severity: "WARNING", message: `termine che NON converte presente nel testo: '${term}' — verifica che la foto/il brief confermino davvero la pertinenza` });
    }
  }
  return problems;
}

function checkSqpTerms(attrs, meta) {
  const terms = meta.purchase_confirmed_terms || [];
  if (!terms.length) return [];
  const full = fullText(attrs);
  const problems = [];
  for (const t of terms) {
    const query = (t.query || "").trim();
    if (!query || full.includes(query.toLowerCase())) continue;
    problems.push({
      severity: "WARNING",
      message: `query Search Query Performance con acquisti reali ma assente dal testo: '${query}' (${t.purchases} acquisti, volume ${t.volume} nel periodo) — opportunita' da valutare, non un obbligo`,
    });
  }
  return problems;
}

function checkBrandSignature(attrs) {
  const desc = (attrs.product_description || "").trim();
  if (desc && !desc.slice(-120).toLowerCase().includes("lupo & felix")) {
    return [{ severity: "WARNING", message: 'la descrizione non chiude con la firma del brand ("Lupo & Felix")' }];
  }
  return [];
}

/**
 * Controlla il content JSON contro il context pack. Ritorna
 * { problems: [{severity, message}], nError, nWarning }.
 * Specchio di check_one()/check_quality.py, senza la parte di I/O su file.
 */
export function checkContent(attrs, context) {
  if (!attrs || typeof attrs !== "object") {
    return { problems: [{ severity: "ERROR", message: "manca la chiave 'attributes' nel content JSON" }], nError: 1, nWarning: 0 };
  }

  const maxLengths = context?.max_lengths || {};
  const meta = context?.search_terms_meta || {};
  const sqpMeta = context?.sqp_meta || {};

  let problems = [...checkSupportedAttrs(attrs), ...checkLengths(attrs, maxLengths), ...checkRepeatedWords(attrs)];

  if (meta.available) {
    problems = problems.concat(checkConvertingTerms(attrs, meta));
    if ("avoid_terms" in meta) {
      problems = problems.concat(checkAvoidTerms(attrs, meta));
    } else {
      problems.push({ severity: "WARNING", message: "context pack generato prima del controllo sui termini che non convertono (manca 'avoid_terms'): rigeneralo con build_context.py per includerlo" });
    }
  } else {
    problems.push({ severity: "INFO", message: `nessun dato search term nel context pack (${meta.reason || "motivo non specificato"})` });
  }

  if (sqpMeta.available) {
    problems = problems.concat(checkSqpTerms(attrs, sqpMeta));
  } else {
    problems.push({ severity: "INFO", message: `nessun dato Search Query Performance nel context pack (${sqpMeta.reason || "motivo non specificato"})` });
  }

  problems = problems.concat(checkBrandSignature(attrs));

  const nError = problems.filter((p) => p.severity === "ERROR").length;
  const nWarning = problems.filter((p) => p.severity === "WARNING").length;
  return { problems, nError, nWarning };
}

// ------------------------------------------------------------- modalita' famiglia
// Specchio di check_family_*()/check_quality.py --family: controlla la copy
// CONDIVISA di una famiglia (shared.bullet_point, shared.product_description),
// non un content JSON singolo. Il titolo per-child (dal title_template) NON si
// controlla qui: dipende da colore/taglia di ogni child, noti solo a runtime —
// lo valida per davvero update_family.py (VALIDATION_PREVIEW) prima di ogni
// --apply, lato server.

function familyFullText(shared) {
  const bp = Array.isArray(shared.bullet_point)
    ? shared.bullet_point
    : (typeof shared.bullet_point === "string" ? [shared.bullet_point] : []);
  const parts = [...bp, shared.product_description || ""];
  return parts.filter((p) => typeof p === "string").join(" \n ").toLowerCase();
}

function checkFamilySupportedKeys(shared) {
  const bad = Object.keys(shared).filter((k) => !SUPPORTED_ATTRIBUTES.includes(k));
  if (bad.length) {
    return [{ severity: "ERROR", message: `chiavi non gestite in 'shared': ${bad.join(", ")} (gestite: ${SUPPORTED_ATTRIBUTES.join(", ")})` }];
  }
  return [];
}

function checkFamilyLengths(shared, maxLengths, hasTemplate) {
  // Se c'e' un title_template, shared.item_name (se presente) non e' il testo
  // che finisce sul listing (il titolo vero e' quello renderizzato dal
  // template): non ha senso controllarne la lunghezza qui.
  const checkable = {};
  for (const [k, v] of Object.entries(shared)) {
    if (k === "item_name" && hasTemplate) continue;
    checkable[k] = v;
  }
  return checkLengths(checkable, maxLengths).map((p) => ({
    ...p, message: p.message.replace("limite caratteri:", "limite caratteri (proxy dal parent):"),
  }));
}

function checkFamilyConvertingTerms(shared, meta) {
  const topTerms = meta.top_terms || [];
  if (!topTerms.length) return [];
  const scope = meta.scope;
  const full = familyFullText(shared);
  const problems = [];
  // 'family' = aggregato dai child con dati ads propri: ASIN reali della
  // famiglia, non rumore dell'intero account — stesso peso di 'asin'. Solo
  // 'marketplace' resta un WARNING. Specchio esatto di check_family_converting_terms.
  for (const term of topTerms) {
    if (!full.includes(term.toLowerCase())) {
      problems.push({
        severity: scope === "asin" || scope === "family" ? "ERROR" : "WARNING",
        message: `termine convertitore assente dal testo condiviso: '${term}' non compare ne' nei bullet ne' in descrizione`,
      });
    }
  }
  // Nessun controllo "primi due nel titolo": il titolo e' per-child, non condiviso.
  return problems;
}

function checkFamilyAvoidTerms(shared, meta) {
  const avoid = meta.avoid_terms || [];
  if (!avoid.length) return [];
  let full = familyFullText(shared);
  const topTerms = [...(meta.top_terms || [])].sort((a, b) => b.length - a.length);
  for (const t of topTerms) {
    const tl = t.toLowerCase();
    if (!tl) continue;
    full = full.split(tl).join(" ".repeat(tl.length));
  }
  const problems = [];
  for (const term of avoid) {
    if (full.includes(term.toLowerCase())) {
      problems.push({ severity: "WARNING", message: `termine che NON converte presente nel testo condiviso: '${term}' — verifica che sia davvero pertinente per tutta la famiglia` });
    }
  }
  return problems;
}

function checkFamilySqpTerms(shared, meta) {
  const terms = meta.purchase_confirmed_terms || [];
  if (!terms.length) return [];
  const full = familyFullText(shared);
  const problems = [];
  for (const t of terms) {
    const query = (t.query || "").trim();
    if (!query || full.includes(query.toLowerCase())) continue;
    problems.push({
      severity: "WARNING",
      message: `query Search Query Performance con acquisti reali ma assente dal testo condiviso: '${query}' (${t.purchases} acquisti, volume ${t.volume} nel periodo) — opportunita' da valutare, non un obbligo`,
    });
  }
  return problems;
}

function checkFamilyBrandSignature(shared) {
  const desc = (shared.product_description || "").trim();
  if (desc && !desc.slice(-120).toLowerCase().includes("lupo & felix")) {
    return [{ severity: "WARNING", message: 'la descrizione condivisa non chiude con la firma del brand ("Lupo & Felix")' }];
  }
  return [];
}

/**
 * Controlla la copy condivisa di una famiglia (shared + title_template)
 * contro il context pack del parent. Ritorna { problems, nError, nWarning }.
 * Specchio di check_family_one()/check_quality.py --family.
 */
export function checkFamily(family, context) {
  const shared = (family && typeof family.shared === "object" && family.shared) || {};
  const hasTemplate = !!family?.title_template;

  if (!Object.keys(shared).length && !hasTemplate && !family?.overrides) {
    return {
      problems: [{ severity: "ERROR", message: "niente da controllare: mancano 'shared', 'title_template' e 'overrides'" }],
      nError: 1, nWarning: 0,
    };
  }

  const maxLengths = context?.max_lengths || {};
  const meta = context?.search_terms_meta || {};
  const sqpMeta = context?.sqp_meta || {};

  let problems = [...checkFamilySupportedKeys(shared), ...checkFamilyLengths(shared, maxLengths, hasTemplate)];

  if (meta.available) {
    problems = problems.concat(checkFamilyConvertingTerms(shared, meta));
    if ("avoid_terms" in meta) {
      problems = problems.concat(checkFamilyAvoidTerms(shared, meta));
    }
  } else if (context) {
    problems.push({ severity: "INFO", message: `nessun dato search term nel context pack del parent (${meta.reason || "motivo non specificato"})` });
  }

  if (sqpMeta.available) {
    problems = problems.concat(checkFamilySqpTerms(shared, sqpMeta));
  } else if (context) {
    problems.push({ severity: "INFO", message: `nessun dato Search Query Performance nel context pack del parent (${sqpMeta.reason || "motivo non specificato"})` });
  }

  problems = problems.concat(checkFamilyBrandSignature(shared));

  if (hasTemplate) {
    problems.push({ severity: "INFO", message: "title_template presente: il titolo per-child NON e' controllato qui, lo valida update_family.py (VALIDATION_PREVIEW) prima di ogni --apply" });
  }

  const nError = problems.filter((p) => p.severity === "ERROR").length;
  const nWarning = problems.filter((p) => p.severity === "WARNING").length;
  return { problems, nError, nWarning };
}
