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
  normalizeAction, describeAction,
} from "../src/actions.js";

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

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exit(failed ? 1 : 0);
