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

// Un ASIN (B0 + 8 caratteri) non e' una parola di ricerca.
export const ASIN_RE = /^b0[a-z0-9]{8}$/i;
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

// ---------------------------------------------------------------------------
// Tetti sui bid: DUE vincoli, non uno
//
// GUARDRAILS.maxBid e' un limite ASSOLUTO contro l'errore di battitura (5.00
// invece di 0.50) e non sa niente ne' di margini ne' di budget.
//
// Sopra ci sono due vincoli economici, che rispondono a due domande diverse:
//
//   1. MARGINE — quanto puo' valere un clic per questo prodotto?
//      E' il tetto che imposti a mano, per mercato o per campagna.
//
//   2. BUDGET — quanti clic servono perche' la campagna abbia senso?
//      Una campagna da 3 EUR/giorno con bid a 0,80 compra quattro clic e poi
//      tace fino a mezzanotte: non raccoglie dati, non e' presente nelle ore
//      buone, e per andare in pari deve convertire quasi al primo clic.
//      Il tetto implicito e' budget / clic-minimi-al-giorno.
//
// Il tetto EFFETTIVO e' il piu' stretto dei due. Tenerli separati serve a
// dire quale leva muovere: se lega il budget, alzare il bid non e' la
// risposta — alzare il budget lo e'.
//
// Forma: {
//   market:     number|null,                 tetto da margine, per mercato
//   campaigns:  { [campaignId]: number },     tetto da margine, per campagna
//   budgets:    { [campaignId]: number },     budget giornaliero noto
//   minClicks:  number,                       clic minimi al giorno
// }
// ---------------------------------------------------------------------------

/**
 * Clic al giorno sotto i quali una campagna non ha senso.
 *
 * Dieci non e' un numero magico: e' l'ordine di grandezza sotto cui il budget
 * si esaurisce in poche ore, i dati non bastano a decidere niente, e servirebbe
 * un tasso di conversione irreale per rientrare. Si cambia per mercato dalle
 * impostazioni; questo e' il valore di partenza.
 */
export const MIN_CLICKS_PER_DAY = 10;

export const EMPTY_CAPS = { market: null, campaigns: {}, budgets: {}, minClicks: MIN_CLICKS_PER_DAY };

/** Tetto implicito nel budget: quanto puoi offrire per clic e restare in piedi. */
export function budgetDerivedCap(dailyBudget, minClicks = MIN_CLICKS_PER_DAY) {
  const b = Number(dailyBudget);
  const n = Number(minClicks) || MIN_CLICKS_PER_DAY;
  if (!Number.isFinite(b) || b <= 0 || n <= 0) return null;
  return Math.floor((b / n) * 100) / 100;
}

/**
 * Tetto effettivo e vincolo che lo determina.
 *
 * `budgetOverride` serve alle campagne che non esistono ancora: il planner
 * passa il budget scritto nel blueprint, visto che non c'e' un campaignId da
 * cui risalire.
 *
 * @returns {{ cap: number|null, source: "margine"|"budget"|"entrambi"|null,
 *             marginCap: number|null, budgetCap: number|null, budget: number|null }}
 */
export function capInfo(caps, campaignId, budgetOverride) {
  const empty = { cap: null, source: null, marginCap: null, budgetCap: null, budget: null };
  if (!caps) return empty;

  const cid = String(campaignId || "");
  const perCamp = caps.campaigns || {};
  const marginCap = cid && Number.isFinite(perCamp[cid])
    ? perCamp[cid]
    : (Number.isFinite(caps.market) ? caps.market : null);

  const budget = Number.isFinite(budgetOverride)
    ? budgetOverride
    : (cid && Number.isFinite((caps.budgets || {})[cid]) ? caps.budgets[cid] : null);
  const budgetCap = budget === null ? null : budgetDerivedCap(budget, caps.minClicks);

  if (marginCap === null && budgetCap === null) return empty;
  if (budgetCap === null) return { cap: marginCap, source: "margine", marginCap, budgetCap, budget };
  if (marginCap === null) return { cap: budgetCap, source: "budget", marginCap, budgetCap, budget };

  const cap = Math.min(marginCap, budgetCap);
  const source = Math.abs(marginCap - budgetCap) < 0.005
    ? "entrambi"
    : (cap === budgetCap ? "budget" : "margine");
  return { cap, source, marginCap, budgetCap, budget };
}

/** Tetto applicabile a un'azione. null = nessun tetto configurato. */
export function capFor(caps, campaignId, budgetOverride) {
  return capInfo(caps, campaignId, budgetOverride).cap;
}

/** Frase leggibile sul perche' il tetto e' quello. */
export function explainCap(info) {
  if (!info || info.cap === null) return "nessun tetto";
  const eur = (v) => `€${Number(v).toFixed(2)}`;
  if (info.source === "budget") {
    return `${eur(info.cap)} — lo impone il budget di ${eur(info.budget)}/giorno`
      + `: sopra, la campagna compra meno di ${MIN_CLICKS_PER_DAY} clic al giorno`;
  }
  if (info.source === "entrambi") {
    return `${eur(info.cap)} — margine e budget portano allo stesso limite`;
  }
  return `${eur(info.cap)} — lo impone il margine che hai impostato`;
}

/** Il campo bid rilevante per il tipo di azione. */
export function bidFieldOf(a) {
  if (a?.type === "update_bid") return "new_bid";
  if (a?.type === "add_keyword") return "bid";
  return null;
}

/**
 * Riporta il bid dentro il tetto, arrotondando al centesimo.
 * Ritorna una NUOVA azione; se non c'e' niente da fare ritorna quella di
 * partenza, cosi' chi chiama puo' confrontare per identita'.
 */
export function clampToCap(a, caps) {
  const field = bidFieldOf(a);
  if (!field) return a;
  const cap = capFor(caps, a.campaignId);
  if (cap === null || typeof a[field] !== "number" || a[field] <= cap) return a;
  return { ...a, [field]: Math.floor(cap * 100) / 100, _capped_from: a[field] };
}

/** Quante azioni di una lista sforano il tetto. */
export function overCapCount(actions, caps) {
  return (actions || []).reduce((n, a) => (clampToCap(a, caps) === a ? n : n + 1), 0);
}

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
export function validateAction(a, ctx) {
  const errors = [];
  const warnings = [];
  const meta = ACTION_TYPES[a.type];
  if (!meta) return { errors: [`Tipo "${a.type}" non supportato`], warnings };

  const needId = (field, label) => {
    if (!a[field]) errors.push(`Manca ${label}`);
  };

  // Tetto economico: errore, non avviso. Il senso della funzione e' impedire
  // che una proposta sopra soglia venga applicata per distrazione, quindi la
  // checkbox deve restare disabilitata finche' non si adegua il valore.
  const info = capInfo(ctx?.caps, a.campaignId);
  const bidField = bidFieldOf(a);
  if (info.cap !== null && bidField && typeof a[bidField] === "number" && a[bidField] > info.cap) {
    // Il messaggio dice QUALE leva muovere: se lega il budget, alzare il
    // tetto sul margine non serve a niente.
    const rimedio = info.source === "budget"
      ? `Il budget della campagna e' €${info.budget.toFixed(2)}/giorno: a questo bid comprerebbe `
        + `meno di ${ctx?.caps?.minClicks || MIN_CLICKS_PER_DAY} clic al giorno. `
        + "Abbassa il bid, oppure alza il budget."
      : "Abbassalo, oppure alza il tetto nelle impostazioni.";
    errors.push(`Bid €${a[bidField].toFixed(2)} sopra il tetto di €${info.cap.toFixed(2)}. ${rimedio}`);
  }

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
      // Nelle campagne Auto i termini di ricerca possono essere ASIN. Escluderli
      // come negative KEYWORD non ha effetto: servirebbe un negative product
      // target. L'API accetta l'azione, ma non blocca nulla.
      if (ASIN_RE.test((a.keywordText || "").trim())) {
        warnings.push(
          `"${a.keywordText}" è un ASIN, non una parola di ricerca. Come negative keyword `
          + `non blocca niente: per escludere un prodotto serve un negative product target, `
          + `da impostare a mano in Seller Central.`
        );
      }
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

export const isValidAction = (a, ctx) => validateAction(a, ctx).errors.length === 0;

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
        capped: typeof a._capped_from === "number"
          ? `proposto ${eur(a._capped_from)}, ridotto al tetto`
          : null,
      };
    }
    case "pause_keyword": return { title: `"${kw}"`, detail: "verra' messa in pausa" };
    case "enable_keyword": return { title: `"${kw}"`, detail: "verra' riattivata" };
    case "add_keyword":
      return {
        title: `"${a.keywordText}"`,
        detail: `nuova keyword ${a.matchType} a ${eur(a.bid)} — ad group ${a.adGroupId}`,
        capped: typeof a._capped_from === "number"
          ? `proposto ${eur(a._capped_from)}, ridotto al tetto`
          : null,
      };
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

/**
 * Identita' di un'azione: due azioni con la stessa firma agiscono sulla stessa
 * cosa e vanno considerate una sola. Serve per il deduplico, perche' analisi
 * successive del Consulente ripropongono spesso gli stessi interventi con una
 * motivazione scritta in modo diverso.
 */
export function actionSignature(a) {
  return [
    a.type, a.keywordId || "", a.campaignId || "", a.adGroupId || "",
    (a.keywordText || "").trim().toLowerCase(), a.matchType || "",
  ].join("|");
}

/** Toglie i doppioni mantenendo la prima occorrenza. */
export function dedupeActions(actions) {
  const seen = new Set();
  const out = [];
  for (const a of actions) {
    const sig = actionSignature(a);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(a);
  }
  return out;
}

export function toPayload(actions) {
  return actions.map((a) => {
    // Campi solo-UI che non devono finire nel JSON inviato allo script.
    const {
      id, included, reason, impact_eur, wasted_spend, source, _capped_from, ...rest
    } = a;
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
 * Il prompt, piu' i tetti sui bid e le azioni gia' applicate.
 *
 * Meglio dirglielo prima che correggerlo dopo: se il modello sa che il tetto
 * su quella campagna e' 0,45 EUR non propone 1,20, e la lista di proposte che
 * arriva e' gia' utilizzabile invece di essere mezza da adeguare.
 */
export function actionsPromptWith(caps, appliedSignatures) {
  let out = ACTIONS_PROMPT;

  const budgets = (caps && caps.budgets) || {};
  const minClicks = (caps && caps.minClicks) || MIN_CLICKS_PER_DAY;
  const hasCaps = caps && (Number.isFinite(caps.market)
    || Object.keys(caps.campaigns || {}).length
    || Object.keys(budgets).length);

  if (hasCaps) {
    const lines = [];
    if (Number.isFinite(caps.market)) {
      lines.push(`- Tetto di mercato (da margine): €${caps.market.toFixed(2)}`);
    }
    for (const [cid, v] of Object.entries(caps.campaigns || {})) {
      lines.push(`- Campagna ${cid}, tetto da margine: €${Number(v).toFixed(2)}`);
    }
    // Il tetto effettivo per campagna: e' quello che conta davvero.
    for (const [cid, b] of Object.entries(budgets)) {
      const info = capInfo(caps, cid);
      if (info.cap === null) continue;
      lines.push(
        `- Campagna ${cid}: budget €${Number(b).toFixed(2)}/giorno -> TETTO EFFETTIVO `
        + `€${info.cap.toFixed(2)} (lo impone ${info.source})`,
      );
    }
    out += `

# TETTI MASSIMI SUI BID (vincolanti)

Il tetto e' il piu' stretto di DUE vincoli, e vale sia per update_bid (new_bid) sia per
add_keyword (bid):

1. MARGINE — quanto un clic puo' valere per quel prodotto. E' il numero impostato a mano.
2. BUDGET — una campagna deve poter comprare almeno ${minClicks} clic al giorno, altrimenti
   esaurisce il budget in poche ore, non raccoglie dati utili e per rientrare dovrebbe
   convertire quasi al primo clic. Quindi: bid massimo = budget giornaliero / ${minClicks}.

${lines.join("\n")}

Se il calcolo che faresti porterebbe sopra il tetto, proponi il tetto stesso e dillo nel
"reason". Se e' il BUDGET a legare e pensi che la keyword meriti di piu', NON alzare il
bid: proponi semmai un update_budget e spiegalo. Se nemmeno al tetto l'azione ha senso,
non generarla.`;
  }

  const sigs = appliedSignatures instanceof Set ? [...appliedSignatures] : (appliedSignatures || []);
  if (sigs.length) {
    out += `

# GIA' APPLICATO DI RECENTE (non riproporre)

Queste modifiche sono gia' state applicate sull'account nelle ultime settimane.
Formato: tipo|keywordId|campaignId|adGroupId|testo|matchType

${sigs.slice(0, 120).join("\n")}

Non rigenerarle. Se i dati suggeriscono che una di queste non ha funzionato, dillo a
parole nel report invece di riproporre la stessa azione.`;
  }

  return out;
}

/**
 * Toglie il blocco <actions> dal testo da mostrare.
 *
 * Serve durante lo streaming: quel blocco e' JSON destinato alla macchina, e
 * vederlo comparire carattere per carattere in coda al report e' solo rumore.
 * Taglia anche il tag INCOMPLETO ("<act"), altrimenti farebbe capolino per
 * una frazione di secondo a ogni pezzo che arriva.
 *
 * Un "<" qualsiasi nel testo (es. "ACoS < 25%") resta dov'e'.
 */
export const stripActionsTail = (t) => {
  const s = t || "";
  const i = s.indexOf("<actions>");
  if (i !== -1) return s.slice(0, i).trimEnd();
  const partial = /<(?:a(?:c(?:t(?:i(?:o(?:n(?:s)?)?)?)?)?)?)?$/.exec(s);
  return partial ? s.slice(0, partial.index).trimEnd() : s;
};

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
export function validateAgainstData(actions, metrics, ctx) {
  const kwIds = new Set((metrics?.keywords || []).map((k) => k.keywordId).filter(Boolean));
  const campIds = new Set(Object.values(metrics?.campaigns || {}).map((c) => c.campaignId).filter(Boolean));
  const agIds = new Set((metrics?.adGroupIds || []));

  // Indice keywordId -> keyword, per poter risalire alla campagna di
  // un'azione che porta solo il keywordId. Serve al tetto per campagna:
  // senza campaignId ricadrebbe sempre sul tetto di mercato.
  const kwById = new Map();
  for (const k of metrics?.keywords || []) {
    if (k.keywordId) kwById.set(String(k.keywordId), k);
  }

  // Negative gia' attive sull'account, normalizzate. Senza questo controllo
  // il Consulente ripropone ogni volta negative che ci sono gia': l'API le
  // scarta comunque come duplicate, ma intanto occupano posto nel carrello.
  const existingNeg = new Set();
  for (const n of metrics?.negativeKeywords || []) {
    const text = String(n.keywordText || n.keyword || "").trim().toLowerCase();
    if (!text) continue;
    const mt = String(n.matchType || "").toUpperCase();
    existingNeg.add(`${String(n.campaignId || "")}|${text}|${mt}`);
    // Anche senza match type: una negativa esatta gia' presente rende inutile
    // riproporla in frase sullo stesso ambito, e viceversa raramente serve.
    existingNeg.add(`${String(n.campaignId || "")}|${text}|`);
  }

  const alreadyApplied = ctx?.appliedSignatures instanceof Set
    ? ctx.appliedSignatures
    : new Set(ctx?.appliedSignatures || []);

  const kept = [];
  const rejected = [];
  for (const raw of actions) {
    // Arricchimento: campagna e nome leggibile dalla keyword, quando mancano.
    let a = raw;
    if (!a.campaignId && a.keywordId && kwById.has(String(a.keywordId))) {
      const k = kwById.get(String(a.keywordId));
      a = {
        ...a,
        campaignId: k.campaignId || a.campaignId,
        adGroupId: a.adGroupId || k.adGroupId,
        campaign: a.campaign || k.campaign,
      };
    }

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
    if (a.type === "add_negative") {
      const text = String(a.keywordText || "").trim().toLowerCase();
      const key = `${String(a.campaignId || "")}|${text}|${String(a.matchType || "").toUpperCase()}`;
      const loose = `${String(a.campaignId || "")}|${text}|`;
      if (existingNeg.has(key) || existingNeg.has(loose)) {
        rejected.push({ action: a, why: `"${a.keywordText}" e' gia' fra le negative di questa campagna` });
        continue;
      }
    }
    if (alreadyApplied.size && alreadyApplied.has(actionSignature(a))) {
      rejected.push({ action: a, why: "gia' applicata di recente (registro delle azioni)" });
      continue;
    }

    // Tetto: qui si ADEGUA, non si scarta. Se il modello propone 1,20 EUR e
    // il tuo tetto e' 0,45 EUR, l'intervento utile e' portare il bid a 0,45,
    // non buttare via il suggerimento. L'unico caso in cui si scarta e'
    // quando dopo l'adeguamento non resta nessuna modifica da fare.
    const capped = clampToCap(a, ctx?.caps);
    if (capped !== a) {
      const field = bidFieldOf(capped);
      if (capped.type === "update_bid"
          && typeof capped.old_bid === "number"
          && Math.abs(capped[field] - capped.old_bid) < 0.01) {
        rejected.push({
          action: a,
          why: `bid proposto €${a.new_bid.toFixed(2)} oltre il tetto; al tetto il valore coincide con quello attuale`,
        });
        continue;
      }
      a = capped;
    }

    if (!isValidAction(a, ctx)) {
      rejected.push({ action: a, why: validateAction(a, ctx).errors.join("; ") });
      continue;
    }
    kept.push(a);
  }
  return { kept, rejected };
}
