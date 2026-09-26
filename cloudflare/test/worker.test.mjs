/**
 * Test del Worker senza wrangler e senza rete.
 *
 *     node cloudflare/test/worker.test.mjs
 *
 * D1 e' rimpiazzato da node:sqlite (Node >= 22.5) con lo schema vero, quindi
 * le query testate sono esattamente quelle che gireranno in produzione: gli
 * upsert, l'ordine cronologico dello storico, la precedenza del tetto di
 * campagna, l'allowlist dei workflow.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

const mkStmt = (sql) => {
  const self = {
    _args: [],
    bind(...a) { return { ...self, _args: a, bind: self.bind, all: () => self._all(a), run: () => self._run(a), first: () => self._first(a) }; },
    _all(a) { return { results: sqlite.prepare(sql).all(...a) }; },
    _run(a) { sqlite.prepare(sql).run(...a); return { success: true }; },
    _first(a) { return sqlite.prepare(sql).get(...a) ?? null; },
    all: () => self._all([]), run: () => self._run([]), first: () => self._first([]),
  };
  return self;
};
const DB = {
  prepare: mkStmt,
  batch: async (stmts) => stmts.map((s) => s.run()),
};

const env = {
  DB,
  API_TOKEN: "segreto",
  ALLOWED_ORIGINS: "https://carlojan76.github.io",
  GITHUB_REPO: "carlojan76/amazon-ads-agent",
  ALLOWED_WORKFLOWS: "apply-actions.yml",
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok  ", name); }
  catch (e) { fail++; console.log("  FAIL", name, "\n       " + e.message); }
};
const call = (path, { method = "GET", body, token = "segreto" } = {}) =>
  worker.fetch(new Request("https://w.dev" + path, {
    method,
    headers: { Origin: "https://carlojan76.github.io", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);

console.log("\nWorker: auth e CORS");
await t("health non richiede token", async () => {
  const r = await call("/api/health", { token: "" });
  if (r.status !== 200) throw new Error("status " + r.status);
});
await t("senza token -> 401", async () => {
  const r = await call("/api/history", { token: "" });
  if (r.status !== 401) throw new Error("status " + r.status);
});
await t("token sbagliato -> 401", async () => {
  const r = await call("/api/history", { token: "altro" });
  if (r.status !== 401) throw new Error("status " + r.status);
});
await t("CORS rispecchia l'origine ammessa", async () => {
  const r = await call("/api/health", { token: "" });
  const o = r.headers.get("Access-Control-Allow-Origin");
  if (o !== "https://carlojan76.github.io") throw new Error("origin " + o);
});
await t("OPTIONS -> 204", async () => {
  const r = await call("/api/history", { method: "OPTIONS", token: "" });
  if (r.status !== 204) throw new Error("status " + r.status);
});

console.log("\nWorker: tetti sui bid");
await t("PUT tetto di mercato", async () => {
  const r = await call("/api/bid-caps", { method: "PUT", body: { marketplace: "it", scope: "market", max_bid: 0.45 } });
  const d = await r.json();
  if (d.max_bid !== 0.45 || d.marketplace !== "IT") throw new Error(JSON.stringify(d));
});
await t("PUT tetto di campagna", async () => {
  const r = await call("/api/bid-caps", { method: "PUT", body: { marketplace: "IT", scope: "campaign", scope_id: "77", scope_label: "SP-Cuccia", max_bid: 0.30 } });
  if (r.status !== 200) throw new Error(JSON.stringify(await r.json()));
});
await t("GET restituisce mercato + campagne", async () => {
  const d = await (await call("/api/bid-caps?marketplace=IT")).json();
  if (d.market_cap !== 0.45) throw new Error("market " + d.market_cap);
  if (d.campaign_caps.length !== 1 || d.campaign_caps[0].scope_id !== "77") throw new Error(JSON.stringify(d.campaign_caps));
});
await t("tetto fuori intervallo rifiutato", async () => {
  const r = await call("/api/bid-caps", { method: "PUT", body: { marketplace: "IT", scope: "market", max_bid: 40 } });
  if (r.status !== 400) throw new Error("status " + r.status);
});
await t("tetto di campagna senza scope_id rifiutato", async () => {
  const r = await call("/api/bid-caps", { method: "PUT", body: { marketplace: "IT", scope: "campaign", max_bid: 0.3 } });
  if (r.status !== 400) throw new Error("status " + r.status);
});
await t("DELETE rimuove il tetto di campagna", async () => {
  await call("/api/bid-caps?marketplace=IT&scope=campaign&scope_id=77", { method: "DELETE" });
  const d = await (await call("/api/bid-caps?marketplace=IT")).json();
  if (d.campaign_caps.length !== 0) throw new Error("ancora " + d.campaign_caps.length);
});

console.log("\nWorker: registro azioni");
await t("POST registra e GET restituisce le firme", async () => {
  await call("/api/applied", { method: "POST", body: {
    marketplace: "IT", run_id: "42",
    actions: [
      { type: "add_negative", campaignId: "1", keywordText: " Gratis ", matchType: "NEGATIVE_EXACT" },
      { type: "update_bid", keywordId: "7", campaignId: "1", old_bid: 0.4, new_bid: 0.5 },
    ],
  }});
  const d = await (await call("/api/applied?marketplace=IT&since_days=7")).json();
  if (d.count !== 2) throw new Error("count " + d.count);
  if (!d.signatures.includes("add_negative||1||gratis|NEGATIVE_EXACT")) throw new Error(JSON.stringify(d.signatures));
});
await t("i valori old/new vengono estratti", async () => {
  const d = await (await call("/api/applied?marketplace=IT")).json();
  const ub = d.actions.find((a) => a.action_type === "update_bid");
  if (ub.old_value !== 0.4 || ub.new_value !== 0.5) throw new Error(JSON.stringify(ub));
});
await t("rollback nasconde la riga", async () => {
  await call("/api/applied/rollback", { method: "POST", body: { marketplace: "IT", signatures: ["update_bid|7|1|||"] } });
  const d = await (await call("/api/applied?marketplace=IT")).json();
  if (d.count !== 1) throw new Error("count " + d.count);
});

console.log("\nWorker: storico");
await t("POST + upsert sulla stessa finestra", async () => {
  await call("/api/history", { method: "POST", body: { marketplace: "IT", period_end: "2026-09-18", spend: 100, sales: 400, acos: 25 } });
  await call("/api/history", { method: "POST", body: { marketplace: "IT", period_end: "2026-09-18", spend: 120, sales: 400, acos: 30 } });
  await call("/api/history", { method: "POST", body: { marketplace: "IT", period_end: "2026-09-11", spend: 90, sales: 300, acos: 30 } });
  const d = await (await call("/api/history?marketplace=IT")).json();
  if (d.points.length !== 2) throw new Error("punti " + d.points.length);
  if (d.points[0].period_end !== "2026-09-11") throw new Error("ordine cronologico sbagliato: " + d.points[0].period_end);
  if (d.points[1].spend !== 120) throw new Error("upsert non ha aggiornato: " + d.points[1].spend);
});

console.log("\nWorker: impostazioni");
await t("default se non impostato niente", async () => {
  const d = await (await call("/api/settings?marketplace=IT")).json();
  if (d.settings.min_clicks_per_day !== 10) throw new Error(JSON.stringify(d.settings));
});
await t("PUT e rilettura", async () => {
  await call("/api/settings", { method: "PUT", body: { marketplace: "IT", key: "min_clicks_per_day", value: 15 } });
  const d = await (await call("/api/settings?marketplace=IT")).json();
  if (d.settings.min_clicks_per_day !== 15) throw new Error(JSON.stringify(d.settings));
});
await t("i tetti riportano i clic minimi, per non disallinearsi", async () => {
  const d = await (await call("/api/bid-caps?marketplace=IT")).json();
  if (d.min_clicks_per_day !== 15) throw new Error("min_clicks_per_day = " + d.min_clicks_per_day);
});
await t("valore fuori scala rifiutato", async () => {
  const r = await call("/api/settings", { method: "PUT", body: { marketplace: "IT", key: "min_clicks_per_day", value: 1 } });
  if (r.status !== 400) throw new Error("status " + r.status);
});
await t("chiave sconosciuta rifiutata", async () => {
  const r = await call("/api/settings", { method: "PUT", body: { marketplace: "IT", key: "pippo", value: 1 } });
  if (r.status !== 400) throw new Error("status " + r.status);
});
await t("un altro mercato non eredita l'impostazione", async () => {
  const d = await (await call("/api/settings?marketplace=FR")).json();
  if (d.settings.min_clicks_per_day !== 10) throw new Error(JSON.stringify(d.settings));
});

console.log("\nWorker: proxy");
await t("workflow non in elenco -> rifiutato", async () => {
  const r = await call("/api/github/dispatch", { method: "POST", body: { workflow: "pericoloso.yml", inputs: {} } });
  if (r.status !== 400) throw new Error("status " + r.status);
  const d = await r.json();
  if (!d.error.includes("non consentito")) throw new Error(d.error);
});
await t("rotta inesistente -> 404", async () => {
  const r = await call("/api/pippo");
  if (r.status !== 404) throw new Error("status " + r.status);
});

console.log(`\n${pass} passati, ${fail} falliti\n`);
process.exit(fail ? 1 : 0);
