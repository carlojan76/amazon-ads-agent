// Controllo del blueprint di campagna PRIMA di lanciare il workflow.
//
// Mirror 1:1 di python/apply_changes.py: _validate_create() + validate() e la
// parte create_campaign di check_guardrails()/GUARDRAILS. Stessa logica, stessi
// messaggi, stesse soglie. Serve perche' il blueprint e' editabile a mano nella
// UI: senza questo, un bid a 0 o una keyword vuota si scoprono solo dopo che il
// run e' partito, e nel caso dei guardrail solo dopo che il workflow ha gia'
// chiamato l'API.
//
// REGOLA: se cambi una soglia o un controllo di la', cambialo anche qui (stesso
// patto che vale tra check_quality.py e qualityCheck.js).

export const GUARDRAILS = {
  min_bid: 0.02,
  max_bid: 5.0,
  min_budget: 1.0,
  max_budget: 100.0,
  max_actions: 80,
  max_new_campaigns: 4,
  max_new_budget_total: 100.0,
};

const AUTO_EXPRESSION_TYPES = [
  "QUERY_HIGH_REL_MATCHES",
  "QUERY_BROAD_REL_MATCHES",
  "ASIN_SUBSTITUTE_RELATED",
  "ASIN_ACCESSORY_RELATED",
];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------- validate
function validateCreate(a, i, errors) {
  const c = a.campaign;
  if (!c || typeof c !== "object") {
    errors.push(`azione ${i} (create_campaign): manca l'oggetto 'campaign'`);
    return;
  }
  if (!c.name) errors.push(`azione ${i} (create_campaign): manca campaign.name`);
  const tt = c.targetingType || "MANUAL";
  if (!["MANUAL", "AUTO"].includes(tt)) {
    errors.push(`azione ${i}: targetingType '${tt}' non valido (MANUAL|AUTO)`);
  }
  if (!isNum(c.dailyBudget) || c.dailyBudget <= 0) {
    errors.push(`azione ${i}: dailyBudget mancante o <= 0`);
  }
  const bs = c.biddingStrategy || "LEGACY_FOR_SALES";
  if (!["LEGACY_FOR_SALES", "AUTO_FOR_SALES", "MANUAL"].includes(bs)) {
    errors.push(`azione ${i}: biddingStrategy '${bs}' non valida`);
  }
  if (!["ENABLED", "PAUSED"].includes(c.state || "ENABLED")) {
    errors.push(`azione ${i}: state '${c.state}' non valido (ENABLED|PAUSED)`);
  }

  const ags = a.adGroups;
  if (!Array.isArray(ags) || ags.length === 0) {
    errors.push(`azione ${i} (create_campaign): serve almeno un ad group`);
    return;
  }
  ags.forEach((g, j) => {
    if (!g.name) errors.push(`azione ${i}.adGroup${j}: manca name`);
    if (!isNum(g.defaultBid)) {
      errors.push(`azione ${i}.adGroup${j}: defaultBid mancante o non numerico`);
    }
    const prods = g.products || [];
    if (!prods.length) {
      errors.push(`azione ${i}.adGroup${j}: nessun prodotto (serve sku o asin)`);
    }
    for (const p of prods) {
      if (!p.sku && !p.asin) {
        errors.push(`azione ${i}.adGroup${j}: un prodotto non ha ne' sku ne' asin`);
      }
    }
    for (const k of g.keywords || []) {
      if (!k.keywordText) errors.push(`azione ${i}.adGroup${j}: keyword senza keywordText`);
      if (!["EXACT", "PHRASE", "BROAD"].includes(k.matchType || "EXACT")) {
        errors.push(`azione ${i}.adGroup${j}: matchType keyword non valido`);
      }
      if (!isNum(k.bid)) {
        errors.push(`azione ${i}.adGroup${j}: keyword '${k.keywordText}' senza bid numerico`);
      }
    }
    for (const n of g.negatives || []) {
      if (!n.keywordText) {
        errors.push(`azione ${i}.adGroup${j}: negativa senza termine`);
      }
      if (!["NEGATIVE_EXACT", "NEGATIVE_PHRASE"].includes(n.matchType || "NEGATIVE_EXACT")) {
        errors.push(`azione ${i}.adGroup${j}: matchType negativa non valido`);
      }
    }
    for (const x of g.autoTargets || []) {
      if (!AUTO_EXPRESSION_TYPES.includes(x.expressionType)) {
        errors.push(`azione ${i}.adGroup${j}: expressionType '${x.expressionType}' non valido`);
      }
    }
    if (tt === "MANUAL" && !(g.keywords || []).length) {
      errors.push(`azione ${i}.adGroup${j}: campagna MANUAL senza keyword nell'ad group`);
    }
    if (tt === "AUTO" && (g.keywords || []).length) {
      errors.push(`azione ${i}.adGroup${j}: campagna AUTO con keyword (le AUTO non accettano keyword positive)`);
    }
  });
}

// ---------------------------------------------------------------- guardrail
function guardrailsCreate(a, i, g) {
  const bad = [];
  const c = a.campaign || {};
  const b = Number(c.dailyBudget || 0);
  if (b > g.max_budget) {
    bad.push(`azione ${i}: nuova campagna con budget EUR ${b.toFixed(2)}/giorno (max ${g.max_budget.toFixed(2)})`);
  } else if (b < g.min_budget) {
    bad.push(`azione ${i}: nuova campagna con budget EUR ${b.toFixed(2)}/giorno (min ${g.min_budget.toFixed(2)})`);
  }
  const range = `(EUR ${g.min_bid.toFixed(2)}-${g.max_bid.toFixed(2)})`;
  (a.adGroups || []).forEach((grp, j) => {
    if (isNum(grp.defaultBid) && (grp.defaultBid < g.min_bid || grp.defaultBid > g.max_bid)) {
      bad.push(`azione ${i}.adGroup${j} ('${grp.name || "?"}'): bid base EUR ${grp.defaultBid.toFixed(2)} fuori dall'intervallo consentito ${range}`);
    }
    for (const k of grp.keywords || []) {
      if (isNum(k.bid) && (k.bid < g.min_bid || k.bid > g.max_bid)) {
        bad.push(`azione ${i}.adGroup${j}: keyword '${k.keywordText || "?"}' con bid EUR ${k.bid.toFixed(2)} fuori dall'intervallo consentito ${range}`);
      }
    }
    for (const x of grp.autoTargets || []) {
      if (isNum(x.bid) && (x.bid < g.min_bid || x.bid > g.max_bid)) {
        bad.push(`azione ${i}.adGroup${j}: auto target '${x.expressionType || "?"}' con bid EUR ${x.bid.toFixed(2)} fuori dall'intervallo consentito ${range}`);
      }
    }
  });
  return bad;
}

/**
 * Controlla un blueprint completo.
 * @returns {{errors: string[], warnings: string[], stats: object}}
 *   errors   = bloccanti (il workflow fallirebbe o l'API rifiuterebbe)
 *   warnings = da guardare ma non bloccanti (es. campagne che partono ENABLED)
 *   stats    = numeri per il riepilogo mostrato prima di creare
 */
export function checkBlueprint(actions, { budgetRequested = null } = {}) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(actions) ? actions : [];

  const creates = list.filter((a) => a.type === "create_campaign");

  if (!list.length) errors.push("il piano non contiene nessuna azione");
  if (list.length > GUARDRAILS.max_actions) {
    errors.push(`${list.length} azioni in un solo run: il limite e' ${GUARDRAILS.max_actions}`);
  }
  if (creates.length > GUARDRAILS.max_new_campaigns) {
    errors.push(`${creates.length} nuove campagne in un solo run: il limite e' ${GUARDRAILS.max_new_campaigns}`);
  }

  list.forEach((a, i) => {
    if (a.type === "create_campaign") {
      validateCreate(a, i, errors);
      errors.push(...guardrailsCreate(a, i, GUARDRAILS));
    }
  });

  const totalBudget = creates.reduce((s, a) => s + Number((a.campaign || {}).dailyBudget || 0), 0);
  if (totalBudget > GUARDRAILS.max_new_budget_total) {
    errors.push(`le campagne nuove sommano EUR ${totalBudget.toFixed(2)}/giorno di budget (max ${GUARDRAILS.max_new_budget_total.toFixed(2)} per run)`);
  }
  if (budgetRequested && totalBudget > Number(budgetRequested) + 0.001) {
    warnings.push(`il totale proposto e' EUR ${totalBudget.toFixed(2)}/giorno contro i EUR ${Number(budgetRequested).toFixed(2)}/giorno che avevi chiesto`);
  }

  // Nomi campagna duplicati DENTRO il piano: Amazon li rifiuta.
  const names = creates.map((a) => String((a.campaign || {}).name || "").trim().toLowerCase()).filter(Boolean);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) {
    errors.push(`nomi campagna ripetuti nel piano (Amazon li rifiuta): ${dupes.join(", ")}`);
  }

  const enabled = creates.filter((a) => (a.campaign || {}).state === "ENABLED");
  if (enabled.length) {
    warnings.push(`${enabled.length} campagna/e partiranno SUBITO (stato ENABLED): la spesa inizia appena create`);
  }

  const nAdGroups = creates.reduce((s, a) => s + (a.adGroups || []).length, 0);
  const nKeywords = creates.reduce(
    (s, a) => s + (a.adGroups || []).reduce((t, g) => t + (g.keywords || []).length, 0), 0);
  const nNegatives = creates.reduce(
    (s, a) => s + (a.adGroups || []).reduce((t, g) => t + (g.negatives || []).length, 0), 0);
  const nProducts = creates.reduce(
    (s, a) => s + (a.adGroups || []).reduce((t, g) => t + (g.products || []).length, 0), 0);

  return {
    errors,
    warnings,
    stats: {
      campaigns: creates.length,
      adGroups: nAdGroups,
      keywords: nKeywords,
      negatives: nNegatives,
      products: nProducts,
      totalBudget,
      enabledCount: enabled.length,
    },
  };
}
