/**
 * Test di base: `npm test`
 *
 * Copre i punti in cui il codice ha gia' sbagliato in passato:
 * numeri in formato europeo, CSV con punto e virgola, join dei bid reali,
 * estrazione delle azioni dall'output del modello e limiti di sicurezza.
 * Nessuna dipendenza esterna: gira con node da solo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseNumber, parseCSV, processJSON, processCSV } from "../src/parse.js";
import {
  extractActionsFromText, validateAgainstData, validateAction,
  normalizeAction, describeAction, capFor, clampToCap, overCapCount,
  actionsPromptWith, EMPTY_CAPS, stripActionsTail,
  MIN_CLICKS_PER_DAY, budgetDerivedCap, capInfo, explainCap,
} from "../src/actions.js";
import { checkBlueprint } from "../src/blueprintCheck.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log("\nNumeri (europei e anglosassoni)");
test('"12,34" -> 12.34', () => assert.equal(parseNumber("12,34"), 12.34));
test('"1.234,56" -> 1234.56', () => assert.equal(parseNumber("1.234,56"), 1234.56));
test('"1,234.56" -> 1234.56', () => assert.equal(parseNumber("1,234.56"), 1234.56));
test('"€ 8,90" -> 8.9', () => assert.equal(parseNumber("€ 8,90"), 8.9));
test('"1.234" -> 1234 (migliaia)', () => assert.equal(parseNumber("1.234"), 1234));
test('"0.450" -> 0.45 (bid, non migliaia)', () => assert.equal(parseNumber("0.450"), 0.45));
test('"12.50" -> 12.5', () => assert.equal(parseNumber("12.50"), 12.5));
test("vuoto -> 0", () => assert.equal(parseNumber(""), 0));

console.log("\nCSV di Seller Central");
const csv = 'Nome campagna;Parola chiave;Spesa;Vendite;Click;Ordini\n'
  + 'SP-Amaca;"amaca, gatto";12,34;45,60;10;2';
const parsed = parseCSV(csv);
test("rileva il punto e virgola", () => assert.equal(parsed.headers.length, 6));
test("virgola dentro le virgolette", () => assert.equal(parsed.rows[0]["Parola chiave"], "amaca, gatto"));
const mc = processCSV(parsed);
test("spesa 12,34 non diventa 1234", () => assert.equal(mc.totalSpend, 12.34));
test("vendite 45,60 -> 45.6", () => assert.equal(mc.totalSales, 45.6));

console.log("\nJSON dell'API");
const raw = JSON.parse(readFileSync(join(root, "public/data/IT.json"), "utf8"));
const m = processJSON(raw);
test("le keyword conservano il keywordId", () => assert.ok(m.keywords.every((k) => k.keywordId)));
test("le keyword hanno il nome campagna", () => assert.ok(m.keywords.every((k) => k.campaign !== undefined)));
test("gli adGroupId sono indicizzati", () => assert.ok(m.adGroupIds.length > 0));
test("i totali sono numeri finiti", () => assert.ok(Number.isFinite(m.totalSpend) && Number.isFinite(m.acos)));

// Il bid arriva dalla lista strutturale, non dal report: verifica del join.
const synthetic = {
  campaigns: [{ campaignId: "1", name: "SP-Test", state: "ENABLED", budget: 10 }],
  adGroups: [{ adGroupId: "9", campaignId: "1", name: "AG", state: "ENABLED" }],
  keywords: [{ keywordId: "7", campaignId: "1", adGroupId: "9", bid: 0.42, state: "ENABLED" }],
  reports: { keywords: [{ keywordId: "7", campaignId: "1", adGroupId: "9", keyword: "amaca", cost: 3, sales7d: 9, clicks: 6, purchases7d: 1 }] },
};
const ms = processJSON(synthetic);
test("il bid reale finisce nella keyword", () => assert.equal(ms.keywords[0].bid, 0.42));
test("il nome campagna viene risolto dall'ID", () => assert.equal(ms.keywords[0].campaign, "SP-Test"));

console.log("\nAzioni proposte dal modello");
const reply = `Analisi.\n<actions>\n{"actions":[
 {"type":"add_negative","campaignId":"1","keywordText":"gratis","matchType":"NEGATIVE_BROAD"},
 {"type":"update_bid","keywordId":"7","old_bid":0.42,"new_bid":0.50},
 {"type":"update_bid","keywordId":"999","old_bid":0.4,"new_bid":0.5},
 {"type":"pause_campaign","campaignId":"1"},
 {"type":"add_keyword","campaignId":"1","adGroupId":"9","keywordText":"amaca","matchType":"exact","bid":0.45}
]}\n</actions>`;
const { actions, cleanText } = extractActionsFromText(reply);
test("estrae 5 azioni", () => assert.equal(actions.length, 5));
test("toglie il blocco dal testo mostrato", () => assert.ok(!cleanText.includes("<actions>")));
test("NEGATIVE_BROAD -> NEGATIVE_PHRASE", () => assert.equal(actions[0].matchType, "NEGATIVE_PHRASE"));
test("match type minuscolo -> EXACT", () => assert.equal(actions[4].matchType, "EXACT"));

const { kept, rejected } = validateAgainstData(actions, ms);
test("tiene solo le azioni con ID esistenti", () => assert.equal(kept.length, 3));
test("scarta l'ID inventato", () => assert.ok(rejected.some((r) => r.why.includes("999"))));
test("scarta le azioni su intera campagna", () => assert.ok(rejected.some((r) => r.action.type === "pause_campaign")));
test("descrive la variazione in percentuale", () => {
  const d = describeAction(kept.find((a) => a.type === "update_bid"));
  assert.equal(d.delta, "+19%");
});

console.log("\nLimiti di sicurezza");
test("bid fuori intervallo -> errore", () => {
  const { errors } = validateAction(normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.4, new_bid: 9 }));
  assert.ok(errors.length > 0);
});
test("variazione oltre il 50% -> avviso", () => {
  const { warnings } = validateAction(normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.4, new_bid: 0.9 }));
  assert.ok(warnings.some((w) => w.includes("%")));
});
test("keyword senza ID -> non applicabile", () => {
  const { errors } = validateAction(normalizeAction({ type: "pause_keyword" }));
  assert.ok(errors.length > 0);
});


// ---------------------------------------------------------------------------
// Tetti sui bid
// ---------------------------------------------------------------------------
console.log("\nTetti sui bid");

const caps = { market: 0.45, campaigns: { "77": 0.30 } };

test("il tetto di campagna prevale su quello di mercato", () => {
  assert.equal(capFor(caps, "77"), 0.30);
  assert.equal(capFor(caps, "1"), 0.45);
  assert.equal(capFor(caps, null), 0.45);
});
test("nessun tetto configurato -> null", () => {
  assert.equal(capFor(EMPTY_CAPS, "1"), null);
  assert.equal(capFor(null, "1"), null);
});
test("clampToCap abbassa il bid al tetto", () => {
  const a = clampToCap({ type: "update_bid", campaignId: "1", old_bid: 0.4, new_bid: 1.2 }, caps);
  assert.equal(a.new_bid, 0.45);
  assert.equal(a._capped_from, 1.2);
});
test("clampToCap non tocca un bid gia' sotto il tetto", () => {
  const orig = { type: "update_bid", campaignId: "1", old_bid: 0.4, new_bid: 0.44 };
  assert.equal(clampToCap(orig, caps), orig);
});
test("clampToCap agisce sul campo giusto per add_keyword", () => {
  const a = clampToCap({ type: "add_keyword", campaignId: "77", bid: 0.9 }, caps);
  assert.equal(a.bid, 0.30);
});
test("clampToCap arrotonda per difetto, mai sopra il tetto", () => {
  const a = clampToCap({ type: "update_bid", campaignId: "1", new_bid: 2 }, { market: 0.339, campaigns: {} });
  assert.ok(a.new_bid <= 0.339, `${a.new_bid} deve restare sotto il tetto`);
});
test("overCapCount conta le azioni fuori tetto", () => {
  const list = [
    { type: "update_bid", campaignId: "1", new_bid: 1.0 },
    { type: "update_bid", campaignId: "1", new_bid: 0.2 },
    { type: "add_negative", campaignId: "1", keywordText: "x" },
  ];
  assert.equal(overCapCount(list, caps), 1);
});
test("bid sopra il tetto -> errore in validateAction", () => {
  const { errors } = validateAction(
    normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.4, new_bid: 0.9 }),
    { caps });
  assert.ok(errors.some((e) => e.includes("tetto")), errors.join("; "));
});
test("senza tetti il comportamento resta quello di prima", () => {
  const a = normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.4, new_bid: 0.5 });
  assert.equal(validateAction(a).errors.length, 0);
  assert.equal(validateAction(a, { caps: EMPTY_CAPS }).errors.length, 0);
});

// ---------------------------------------------------------------------------
// validateAgainstData: tetti, negative esistenti, registro
// ---------------------------------------------------------------------------
console.log("\nFiltri sulle azioni proposte");

test("una proposta fuori tetto viene ADEGUATA, non scartata", () => {
  const proposte = [normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.42, new_bid: 1.50 })];
  const r = validateAgainstData(proposte, ms, { caps: { market: 0.60, campaigns: {} } });
  assert.equal(r.kept.length, 1, "l'azione deve restare");
  assert.equal(r.kept[0].new_bid, 0.60);
  assert.equal(r.kept[0]._capped_from, 1.50);
});
test("se al tetto il bid non cambia, l'azione viene scartata", () => {
  const proposte = [normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.42, new_bid: 1.50 })];
  const r = validateAgainstData(proposte, ms, { caps: { market: 0.42, campaigns: {} } });
  assert.equal(r.kept.length, 0);
  assert.ok(r.rejected[0].why.includes("coincide"));
});
test("il campaignId viene dedotto dalla keyword per il tetto di campagna", () => {
  // La keyword 7 sta nella campagna 1: il tetto di quella campagna deve valere
  // anche se l'azione non porta il campaignId.
  const proposte = [normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.42, new_bid: 1.50 })];
  const r = validateAgainstData(proposte, ms, { caps: { market: 2.0, campaigns: { "1": 0.50 } } });
  assert.equal(r.kept[0].new_bid, 0.50);
});
test("scarta una negativa gia' presente sulla campagna", () => {
  const conNeg = {
    ...ms,
    negativeKeywords: [{ campaignId: "1", keywordText: "Gratis", matchType: "NEGATIVE_EXACT" }],
  };
  const proposte = [normalizeAction({
    type: "add_negative", campaignId: "1", keywordText: "gratis", matchType: "NEGATIVE_EXACT",
  })];
  const r = validateAgainstData(proposte, conNeg);
  assert.equal(r.kept.length, 0);
  assert.ok(r.rejected[0].why.includes("gia'"));
});
test("una negativa nuova passa", () => {
  const conNeg = {
    ...ms,
    negativeKeywords: [{ campaignId: "1", keywordText: "gratis", matchType: "NEGATIVE_EXACT" }],
  };
  const proposte = [normalizeAction({
    type: "add_negative", campaignId: "1", keywordText: "usato", matchType: "NEGATIVE_EXACT",
  })];
  assert.equal(validateAgainstData(proposte, conNeg).kept.length, 1);
});
test("scarta un'azione gia' nel registro", () => {
  const proposte = [normalizeAction({
    type: "add_negative", campaignId: "1", keywordText: "gratis", matchType: "NEGATIVE_EXACT",
  })];
  const sigs = new Set(["add_negative||1||gratis|NEGATIVE_EXACT"]);
  const r = validateAgainstData(proposte, ms, { appliedSignatures: sigs });
  assert.equal(r.kept.length, 0);
  assert.ok(r.rejected[0].why.includes("registro"));
});
test("la firma JS combacia con quella Python/Worker", () => {
  // agent_api.signature_of e signatureOf nel Worker producono questa stringa.
  const sig = [
    "add_negative", "", "1", "2", "gratis", "NEGATIVE_EXACT",
  ].join("|");
  assert.equal(sig, "add_negative||1|2|gratis|NEGATIVE_EXACT");
});

console.log("\nPrompt con tetti e registro");
test("il prompt include i tetti quando ci sono", () => {
  const p = actionsPromptWith(caps, []);
  assert.ok(p.includes("TETTI MASSIMI"));
  assert.ok(p.includes("0.45"));
  assert.ok(p.includes("0.30"));
});
test("senza tetti il prompt resta quello base", () => {
  const p = actionsPromptWith(EMPTY_CAPS, []);
  assert.ok(!p.includes("TETTI MASSIMI"));
});
test("il prompt elenca il gia' applicato", () => {
  const p = actionsPromptWith(EMPTY_CAPS, new Set(["add_negative||1||gratis|NEGATIVE_EXACT"]));
  assert.ok(p.includes("GIA' APPLICATO"));
});

console.log("\nReport mancanti");
test("report keyword vuoto con keyword configurate -> segnalato", () => {
  const senzaReportKw = {
    campaigns: [{ campaignId: "1", name: "C", state: "ENABLED", budget: 10 }],
    keywords: [{ keywordId: "7", campaignId: "1", adGroupId: "9", bid: 0.4, state: "ENABLED" }],
    reports: { campaigns: [{ campaignId: "1", cost: 3 }], keywords: [] },
  };
  const mm = processJSON(senzaReportKw);
  assert.ok(mm.hasPerformance, "c'e' comunque qualche riga di report");
  assert.ok(mm.missingReports.includes("keywords"), "il report keyword mancante va segnalato");
});
test("nessuna keyword configurata -> nessun report mancante", () => {
  const vuoto = { campaigns: [], keywords: [], reports: {} };
  assert.equal(processJSON(vuoto).missingReports.length, 0);
});

console.log("\nStreaming: il blocco <actions> non deve mai apparire");
test("toglie il blocco completo", () => {
  assert.equal(stripActionsTail('Report.\n<actions>\n{"actions":[]}</actions>'), "Report.");
});
test("toglie il tag ancora incompleto", () => {
  for (const frammento of ["<", "<a", "<act", "<action", "<actions"]) {
    assert.equal(stripActionsTail(`Report.\n${frammento}`), "Report.", `fallito su "${frammento}"`);
  }
});
test("un < nel testo resta dov'e'", () => {
  assert.equal(stripActionsTail("ACoS < 25%"), "ACoS < 25%");
});
test("regge testo vuoto e null", () => {
  assert.equal(stripActionsTail(""), "");
  assert.equal(stripActionsTail(null), "");
});
test("nessun fotogramma dello stream mostra il tag", () => {
  const finale = 'Analisi.\nACoS al 32% < soglia.\n<actions>\n{"actions":[{"type":"add_negative"}]}\n</actions>';
  for (let i = 1; i <= finale.length; i++) {
    const visibile = stripActionsTail(finale.slice(0, i));
    assert.ok(!visibile.includes("<a"), `il tag e' comparso al carattere ${i}: ${JSON.stringify(visibile.slice(-20))}`);
  }
});


// ---------------------------------------------------------------------------
// Coerenza bid/budget: il secondo vincolo
// ---------------------------------------------------------------------------
console.log("\nCoerenza bid/budget");

test("il budget impone un tetto: 3 EUR / 10 clic = 0,30", () => {
  assert.equal(budgetDerivedCap(3, 10), 0.30);
  assert.equal(budgetDerivedCap(8, 10), 0.80);
  assert.equal(budgetDerivedCap(1.5, 10), 0.15);
});
test("arrotonda per difetto, mai sopra", () => {
  // 3.99/10 = 0.399 -> 0.39, non 0.40
  assert.equal(budgetDerivedCap(3.99, 10), 0.39);
});
test("budget assente o assurdo -> nessun tetto", () => {
  assert.equal(budgetDerivedCap(0, 10), null);
  assert.equal(budgetDerivedCap(-5, 10), null);
  assert.equal(budgetDerivedCap(undefined, 10), null);
});
test("clic minimi configurabili", () => {
  assert.equal(budgetDerivedCap(3, 5), 0.60);
  assert.equal(budgetDerivedCap(3, 20), 0.15);
});

console.log("\nIl tetto effettivo e' il piu' stretto dei due");
const capsB = { market: 0.35, campaigns: {}, budgets: { "1": 3, "2": 20 }, minClicks: 10 };

test("con budget basso lega il budget", () => {
  const info = capInfo(capsB, "1");
  assert.equal(info.cap, 0.30);
  assert.equal(info.source, "budget");
});
test("con budget alto lega il margine", () => {
  const info = capInfo(capsB, "2");
  assert.equal(info.cap, 0.35);
  assert.equal(info.source, "margine");
});
test("campagna senza budget noto: vale solo il margine", () => {
  const info = capInfo(capsB, "999");
  assert.equal(info.cap, 0.35);
  assert.equal(info.source, "margine");
});
test("budgetOverride per le campagne che non esistono ancora", () => {
  const info = capInfo(capsB, null, 2);
  assert.equal(info.cap, 0.20, "2 EUR / 10 clic");
  assert.equal(info.source, "budget");
});
test("il tetto di campagna prevale, ma il budget puo' stringerlo ancora", () => {
  const caps = { market: 1.0, campaigns: { "1": 0.50 }, budgets: { "1": 3 }, minClicks: 10 };
  const info = capInfo(caps, "1");
  assert.equal(info.cap, 0.30, "0.30 dal budget batte 0.50 dal margine");
  assert.equal(info.source, "budget");
});
test("explainCap dice quale leva muovere", () => {
  assert.ok(explainCap(capInfo(capsB, "1")).includes("budget"));
  assert.ok(explainCap(capInfo(capsB, "2")).includes("margine"));
});
test("le azioni vengono adeguate al tetto piu' stretto", () => {
  const proposte = [normalizeAction({ type: "update_bid", keywordId: "7", old_bid: 0.10, new_bid: 0.50 })];
  const caps = { market: 0.35, campaigns: {}, budgets: { "1": 3 }, minClicks: 10 };
  const r = validateAgainstData(proposte, ms, { caps });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].new_bid, 0.30, "la keyword 7 sta nella campagna 1, budget 3 EUR");
});

console.log("\nBlueprint: il caso reale delle campagne squalo");
const squalo = (budget, base, kwBid) => ({
  type: "create_campaign",
  campaign: { name: "SP-Squalo", targetingType: "MANUAL", dailyBudget: budget,
    biddingStrategy: "LEGACY_FOR_SALES", state: "PAUSED" },
  adGroups: [{ name: "AG-exact", defaultBid: base, products: [{ asin: "B0X" }],
    keywords: [{ keywordText: "cuccetta per gatti", matchType: "EXACT", bid: kwBid }],
    negatives: [], autoTargets: [] }],
});

test("budget 3 con bid 0,40 e 0,80 -> bloccato, e spiega perche'", () => {
  const r = checkBlueprint([squalo(3, 0.40, 0.80)], { minClicks: 10 });
  assert.ok(r.errors.length >= 2, `attesi almeno 2 errori, trovati ${r.errors.length}`);
  assert.ok(r.errors.some((e) => e.includes("0.30")), "deve indicare il bid corretto");
  assert.ok(r.errors.some((e) => e.includes("alza il budget")), "deve indicare l'altra leva");
});
test("stesso budget con bid coerenti -> passa", () => {
  const r = checkBlueprint([squalo(3, 0.28, 0.30)], { minClicks: 10 });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
});
test("il bid al tetto esatto passa", () => {
  const r = checkBlueprint([squalo(3, 0.30, 0.30)], { minClicks: 10 });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
});
test("alzare il budget sblocca gli stessi bid", () => {
  const r = checkBlueprint([squalo(8, 0.40, 0.80)], { minClicks: 10 });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
});
test("il tetto da margine vale in aggiunta", () => {
  const caps = { market: 0.35, campaigns: {}, budgets: {}, minClicks: 10 };
  const r = checkBlueprint([squalo(8, 0.40, 0.80)], { caps, minClicks: 10 });
  assert.ok(r.errors.some((e) => e.includes("tetto di mercato")), r.errors.join("; "));
});
test("senza tetto da margine il vincolo di budget resta attivo", () => {
  const r = checkBlueprint([squalo(3, 0.50, 0.50)], { caps: null, minClicks: 10 });
  assert.ok(r.errors.length > 0, "il budget non ha bisogno del Worker");
});
test("anche gli auto target sono controllati", () => {
  const a = squalo(3, 0.20, 0.20);
  a.campaign.targetingType = "AUTO";
  a.adGroups[0].keywords = [];
  a.adGroups[0].autoTargets = [{ expressionType: "QUERY_HIGH_REL_MATCHES", bid: 0.75 }];
  const r = checkBlueprint([a], { minClicks: 10 });
  assert.ok(r.errors.some((e) => e.includes("auto target")), r.errors.join("; "));
});

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exit(failed ? 1 : 0);
