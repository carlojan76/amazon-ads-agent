// Modello condiviso delle azioni.
// Unico posto in cui si decide cosa e' un'azione valida, come si descrive e
// quanto puo' variare. Prima questa logica era duplicata (e divergente) tra
// ActionsPanel.jsx e apply_changes.py: la UI accettava azioni che lo script
// poi rifiutava, e viceversa.
//
// I limiti qui sotto rispecchiano GUARDRAILS in python/apply_changes.py.
// Se cambi uno, cambia anche l'altro.

export const GUARDRAILS = {
  maxBidChangePct: 50,
  minBid: 0.02,
  maxBid: 5.0,
  maxBudgetChangePct: 50,
  minBudget: 1.0,
  maxBudget: 100.0,
  maxActions: 80,
};

export const KW_MATCH = ["EXACT", "PHRASE", "BROAD"];
export const NEG_MATCH = ["NEGATIVE_EXACT", "NEGATIVE_PHRASE"];

// Alias che i modelli inventano regolarmente -> enum reali dell'API v3.
const NEG_ALIASES = {
  NEGATIVE_BROAD: "NEGATIVE_PHRASE", BROAD: "NEGATIVE_PHRASE",
  PHRASE: "NEGATIVE_PHRASE", EXACT: "NEGATIVE_EXACT",
};

export const ACTION_TYPES = {
  add_negative: {
    label: "Aggiungi negativa", icon: "🚫", tone: "red", group: "Tagliare gli sprechi",
    blurb: "Blocca una ricerca che sta spendendo senza vendere.",
  },
  pause_keyword: {
    label: "Metti in pausa keyword", icon: "⏸", tone: "red", group: "Tagliare gli sprechi",
    blurb: "Ferma una keyword che non converte.",
  },
  update_bid: {
    label: "Modifica bid", icon: "💶", tone: "yellow", group: "Ottimizzare i bid",
    blurb: "Alza o abbassa l'offerta su una keyword esistente.",
  },
  add_keyword: {
    label: "Aggiungi keyword", icon: "➕", tone: "green", group: "Far crescere",
    blurb: "Promuove a keyword un termine di ricerca che ha gia' venduto.",
  },
  enable_keyword: {
    label: "Riattiva keyword", icon: "▶️", tone: "green", group: "Far crescere",
    blurb: "Rimette in gioco una keyword in pausa.",
  },
  update_budget: {
    label: "Modifica budget", icon: "💰", tone: "blue", group: "Budget e campagne",
    blurb: "Cambia il budget giornaliero di una campagna.",
  },
  pause_campaign: {
    label: "Metti in pausa campagna", icon: "⏹", tone: "red", group: "Budget e campagne",
    blurb: "Ferma un'intera campagna. Impatto ampio: da valutare a mano.",
    risky: true,
  },
  enable_campaign: {
    label: "Riattiva campagna", icon: "⏵", tone: "green", group: "Budget e campagne",
    blurb: "Riaccende una campagna ferma. Impatto ampio: da valutare a mano.",
    risky: true,
  },
};

export const GROUP_ORDER = ["Tagliare gli sprechi", "Far crescere", "Ottimizzare i bid", "Budget e campagne"];

const numOrNull = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Ripulisce un'azione: enum in maiuscolo, alias corretti, numeri veri. */
export function normalizeAction(raw) {
  const a = { ...raw };
  a.type = String(a.type || "").trim();

  if (a.type === "add_negative") {
    const mt = String(a.matchType || "NEGATIVE_EXACT").toUpperCase();
    a.matchType = NEG_ALIASES[mt] || (NEG_MATCH.includes(mt) ? mt : "NEGATIVE_EXACT");
  }
  if (a.type === "add_keyword") {
    const mt = String(a.matchType || "EXACT").toUpperCase();
    a.matchType = KW_MATCH.includes(mt) ? mt : "EXACT";
  }
  for (const f of ["new_bid", "old_bid", "new_budget", "old_budget", "bid"]) {
    if (f in a) {
      const n = numOrNull(a[f]);
      if (n === null) delete a[f];
      else a[f] = n;
    }
  }
  for (const f of ["keywordId", "campaignId", "adGroupId"]) {
    if (a[f] !== undefined && a[f] !== null && a[f] !== "") a[f] = String(a[f]).trim();
    else delete a[f];
  }
  if (typeof a.reason === "string") a.reason = a.reason.slice(0, 240);
  return a;
}

/**
 * Valida un'azione. Ritorna { errors, warnings }.
 * errors  -> l'azione non e' inviabile (checkbox disabilitata)
 * warnings-> inviabile, ma merita un'occhiata (fuori dai limiti di sicurezza)
 */
export function validateAction(a) {
  const errors = [];
  const warnings = [];
  const meta = ACTION_TYPES[a.type];
  if (!meta) return { errors: [`Tipo "${a.type}" non supportato`], warnings };

  const needId = (field, label) => {
    if (!a[field]) errors.push(`Manca ${label}`);
  };

  switch (a.type) {
    case "update_bid":
      needId("keywordId", "l'ID della keyword");
      if (typeof a.new_bid !== "number") errors.push("Manca il nuovo bid");
      else {
        if (a.new_bid < GUARDRAILS.minBid || a.new_bid > GUARDRAILS.maxBid) {
          errors.push(`Il bid deve stare tra €${GUARDRAILS.minBid.toFixed(2)} e €${GUARDRAILS.maxBid.toFixed(2)}`);
        }
        if (typeof a.old_bid === "number" && a.old_bid > 0) {
          const pct = Math.abs(a.new_bid - a.old_bid) / a.old_bid * 100;
          if (pct > GUARDRAILS.maxBidChangePct) {
            warnings.push(`Variazione del ${pct.toFixed(0)}%: oltre il limite del ${GUARDRAILS.maxBidChangePct}%, lo script la rifiutera'`);
          }
          if (Math.abs(a.new_bid - a.old_bid) < 0.01) warnings.push("Nuovo bid uguale a quello attuale");
        }
      }
      break;
    case "pause_keyword":
    case "enable_keyword":
      needId("keywordId", "l'ID della keyword");
      break;
    case "add_keyword":
      needId("campaignId", "l'ID della campagna");
      needId("adGroupId", "l'ID dell'ad group");
      if (!a.keywordText) errors.push("Manca il testo della keyword");
      if (typeof a.bid !== "number") errors.push("Manca il bid");
      else if (a.bid < GUARDRAILS.minBid || a.bid > GUARDRAILS.maxBid) {
        errors.push(`Il bid deve stare tra €${GUARDRAILS.minBid.toFixed(2)} e €${GUARDRAILS.maxBid.toFixed(2)}`);
      }
      break;
    case "add_negative":
      needId("campaignId", "l'ID della campagna");
      if (!a.keywordText) errors.push("Manca il testo da escludere");
      if (!NEG_MATCH.includes(a.matchType)) errors.push("Match type non valido");
      break;
    case "update_budget":
      needId("campaignId", "l'ID della campagna");
      if (typeof a.new_budget !== "number") errors.push("Manca il nuovo budget");
      else {
        if (a.new_budget < GUARDRAILS.minBudget || a.new_budget > GUARDRAILS.maxBudget) {
          errors.push(`Il budget deve stare tra €${GUARDRAILS.minBudget.toFixed(2)} e €${GUARDRAILS.maxBudget.toFixed(2)}`);
        }
        if (typeof a.old_budget === "number" && a.old_budget > 0) {
          const pct = Math.abs(a.new_budget - a.old_budget) / a.old_budget * 100;
          if (pct > GUARDRAILS.maxBudgetChangePct) {
            warnings.push(`Variazione del ${pct.toFixed(0)}%: oltre il limite del ${GUARDRAILS.maxBudgetChangePct}%, lo script la rifiutera'`);
          }
        }
      }
      break;
    case "pause_campaign":
    case "enable_campaign":
      needId("campaignId", "l'ID della campagna");
      warnings.push("Agisce sull'intera campagna: controlla bene prima di applicare");
      break;
    default:
      break;
  }
  return { errors, warnings };
}

export const isValidAction = (a) => validateAction(a).errors.length === 0;

/** Descrizione leggibile: { title, detail, delta } */
export function describeAction(a) {
  const kw = a.keyword || a.keywordText || a.keywordId || "?";
  const camp = a.campaign || a.campaignId || "?";
  const eur = (v) => (typeof v === "number" ? `€${v.toFixed(2)}` : "€?");

  switch (a.type) {
    case "update_bid": {
      const has = typeof a.old_bid === "number" && a.old_bid > 0 && typeof a.new_bid === "number";
      const pct = has ? (a.new_bid - a.old_bid) / a.old_bid * 100 : null;
      return {
        title: `"${kw}"`,
        detail: `bid ${eur(a.old_bid)} → ${eur(a.new_bid)}`,
        delta: pct === null ? null : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`,
        deltaUp: pct !== null && pct > 0,
      };
    }
    case "pause_keyword": return { title: `"${kw}"`, detail: "verra' messa in pausa" };
    case "enable_keyword": return { title: `"${kw}"`, detail: "verra' riattivata" };
    case "add_keyword":
      return { title: `"${a.keywordText}"`, detail: `nuova keyword ${a.matchType} a ${eur(a.bid)} — ad group ${a.adGroupId}` };
    case "add_negative":
      return {
        title: `"${a.keywordText}"`,
        detail: `esclusa in ${a.matchType === "NEGATIVE_PHRASE" ? "frase" : "esatta"} a livello ${a.adGroupId ? "ad group" : "campagna"} — ${camp}`,
      };
    case "update_budget": {
      const has = typeof a.old_budget === "number" && a.old_budget > 0 && typeof a.new_budget === "number";
      const pct = has ? (a.new_budget - a.old_budget) / a.old_budget * 100 : null;
      return {
        title: `${camp}`,
        detail: `budget ${eur(a.old_budget)} → ${eur(a.new_budget)} al giorno`,
        delta: pct === null ? null : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`,
        deltaUp: pct !== null && pct > 0,
      };
    }
    case "pause_campaign": return { title: `${camp}`, detail: "campagna in pausa" };
    case "enable_campaign": return { title: `${camp}`, detail: "campagna riattivata" };
    default: return { title: a.type, detail: "" };
  }
}

/** Campo numerico modificabile inline, se esiste per questo tipo. */
export function editableField(a) {
  if (a.type === "update_bid") return { field: "new_bid", label: "Nuovo bid", prefix: "€", step: 0.01 };
  if (a.type === "update_budget") return { field: "new_budget", label: "Budget/giorno", prefix: "€", step: 0.5 };
  if (a.type === "add_keyword") return { field: "bid", label: "Bid", prefix: "€", step: 0.01 };
  return null;
}

/** Risparmio stimato per il periodo analizzato, se il dato e' disponibile. */
export function estimatedSaving(a) {
  if (typeof a.impact_eur === "number") return a.impact_eur;
  if ((a.type === "add_negative" || a.type === "pause_keyword") && typeof a.wasted_spend === "number") {
    return a.wasted_spend;
  }
  return null;
}

export function toPayload(actions) {
  return actions.map((a) => {
    // Campi solo-UI che non devono finire nel JSON inviato allo script.
    const { id, included, reason, impact_eur, wasted_spend, source, ...rest } = a;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// Estrazione delle azioni dalla risposta dell'AI Advisor
// ---------------------------------------------------------------------------

/** Istruzioni da appendere al prompt perche' il modello produca azioni applicabili. */
export const ACTIONS_PROMPT = `
---

# AZIONI ESEGUIBILI

Dopo il report, aggiungi UN SOLO blocco <actions>...</actions> contenente solo JSON valido.

REGOLE FERREE:
- Usa SOLO gli ID reali che compaiono nei dati qui sopra (kwId, campId, agId). Non inventare mai un ID: le azioni con ID inesistenti vengono scartate automaticamente.
- Se per un consiglio non hai l'ID, NON generare l'azione: lascialo solo a parole nel report.
- Massimo 15 azioni, ordinate per impatto.
- Ogni azione DEVE avere "reason": una frase breve con il dato che la giustifica.
- Aggiungi "impact_eur" (numero) quando puoi stimare il risparmio o il ricavo sul periodo analizzato.
- Variazioni di bid: massimo ±30% del bid attuale mostrato nei dati, mai sotto 0.02 o sopra 5.00.
- Variazioni di budget: massimo ±50%, mai sotto 1.00.
- NON generare pause_campaign o enable_campaign: sono decisioni da prendere a mano.

Tipi ammessi e campi obbligatori:
- update_bid: keywordId, keyword, old_bid (quello REALE mostrato nei dati), new_bid
- pause_keyword: keywordId, keyword — solo con spesa > €3 e zero ordini
- enable_keyword: keywordId, keyword
- add_negative: campaignId, adGroupId (opzionale), keywordText, matchType (NEGATIVE_EXACT | NEGATIVE_PHRASE)
- add_keyword: campaignId, adGroupId, keywordText, matchType (EXACT | PHRASE | BROAD), bid — per i search term che hanno gia' generato ordini
- update_budget: campaignId, campaign, old_budget, new_budget

Esempio di formato (solo JSON dentro il blocco):

<actions>
{"actions": [
  {"type": "add_negative", "campaignId": "123", "adGroupId": "456", "keywordText": "gratis", "matchType": "NEGATIVE_PHRASE", "reason": "€4.20 spesi, 12 click, zero ordini", "impact_eur": 4.2}
]}
</actions>`;

/**
 * Estrae il blocco <actions> dal testo del modello.
 * Ritorna { actions, cleanText, warnings }.
 */
export function extractActionsFromText(text) {
  const warnings = [];
  const m = /<actions>([\s\S]*?)<\/actions>/.exec(text || "");
  if (!m) return { actions: [], cleanText: text, warnings: [] };

  const cleanText = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let parsed;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch (err) {
    return { actions: [], cleanText, warnings: [`Il blocco azioni non e' JSON valido: ${err.message}`] };
  }
  const list = Array.isArray(parsed?.actions) ? parsed.actions : [];
  return { actions: list.map(normalizeAction), cleanText, warnings };
}

/**
 * Scarta le azioni che puntano a ID inesistenti nei dati caricati.
 * E' la protezione contro gli ID inventati: senza di questa una singola cifra
 * sbagliata modificherebbe la keyword di un'altra campagna.
 */
export function validateAgainstData(actions, metrics) {
  const kwIds = new Set((metrics?.keywords || []).map((k) => k.keywordId).filter(Boolean));
  const campIds = new Set(Object.values(metrics?.campaigns || {}).map((c) => c.campaignId).filter(Boolean));
  const agIds = new Set((metrics?.adGroupIds || []));

  const kept = [];
  const rejected = [];
  for (const a of actions) {
    if (a.type === "pause_campaign" || a.type === "enable_campaign") {
      rejected.push({ action: a, why: "azioni sull'intera campagna: da fare a mano" });
      continue;
    }
    if (a.keywordId && kwIds.size && !kwIds.has(String(a.keywordId))) {
      rejected.push({ action: a, why: `keywordId ${a.keywordId} non presente nei dati caricati` });
      continue;
    }
    if (a.campaignId && campIds.size && !campIds.has(String(a.campaignId))) {
      rejected.push({ action: a, why: `campaignId ${a.campaignId} non presente nei dati caricati` });
      continue;
    }
    if (a.adGroupId && agIds.size && !agIds.has(String(a.adGroupId))) {
      rejected.push({ action: a, why: `adGroupId ${a.adGroupId} non presente nei dati caricati` });
      continue;
    }
    if (!isValidAction(a)) {
      rejected.push({ action: a, why: validateAction(a).errors.join("; ") });
      continue;
    }
    kept.push(a);
  }
  return { kept, rejected };
}
