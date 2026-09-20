/**
 * Prova end-to-end dello streaming del Consulente, senza rete.
 *
 *     node cloudflare/test/stream.test.mjs
 *
 * Anthropic e' finto ed emette SSE spezzato in pezzi da 37 byte, cosi' il
 * parser viene messo alla prova su righe tagliate a meta'. Il percorso e'
 * quello vero: src/api.js -> worker.js -> (finto) api.anthropic.com.
 *
 * Lo streaming esiste perche' Cloudflare chiude le connessioni a 100 secondi
 * con l'errore 524, e un'analisi completa ci mette spesso di piu'.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const mkStmt = (sql) => {
  const self = {
    bind(...a) { return { all: () => ({ results: sqlite.prepare(sql).all(...a) }), run: () => { sqlite.prepare(sql).run(...a); return {}; }, first: () => sqlite.prepare(sql).get(...a) ?? null }; },
    all: () => ({ results: sqlite.prepare(sql).all() }), run: () => { sqlite.prepare(sql).run(); return {}; }, first: () => sqlite.prepare(sql).get() ?? null,
  };
  return self;
};
const env = {
  DB: { prepare: mkStmt, batch: async (s) => s.map((x) => x.run()) },
  API_TOKEN: "segreto", ALLOWED_ORIGINS: "https://x.github.io",
  ANTHROPIC_API_KEY: "finta", ANTHROPIC_MODEL: "claude-sonnet-5", ANTHROPIC_MAX_TOKENS: "16000",
};

// Anthropic finto: emette SSE come quello vero.
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Analisi delle "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ragiono..."}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"campagne.\\n<actions>"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"actions\\":[]}</actions>"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join("\n");

let upstreamPayload = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.anthropic.com")) {
    upstreamPayload = JSON.parse(opts.body);
    // Spezza in pezzi arbitrari: il parser deve reggere righe tagliate a metà.
    const enc = new TextEncoder();
    const chunks = [];
    for (let i = 0; i < SSE.length; i += 37) chunks.push(enc.encode(SSE.slice(i, i + 37)));
    const body = new ReadableStream({
      start(c) { chunks.forEach((ch) => c.enqueue(ch)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  return realFetch(url, opts);
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok  ", name); }
  catch (e) { fail++; console.log("  FAIL", name, "\n       " + e.message); }
};

// Il client di src/api.js parla col Worker tramite fetch: lo dirottiamo.
const workerFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("worker.test")) {
    return worker.fetch(new Request(String(url).replace("worker.test", "w.dev"), {
      method: opts?.method || "GET",
      headers: { Origin: "https://x.github.io", ...(opts?.headers || {}) },
      body: opts?.body,
    }), env);
  }
  return workerFetch(url, opts);
};
globalThis.localStorage = {
  _d: { aa_api_base: "https://worker.test", aa_api_token: "segreto" },
  getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; },
};

const api = await import("../../src/api.js");

console.log("\nStreaming Consulente");
let deltas = 0;
await t("il testo viene ricomposto integralmente", async () => {
  const r = await api.askAnthropic("sei un consulente", [{ role: "user", content: "analizza" }], () => deltas++);
  const text = r.content[0].text;
  if (text !== 'Analisi delle campagne.\n<actions>{"actions":[]}</actions>') {
    throw new Error("testo ricomposto male: " + JSON.stringify(text));
  }
});
await t("stop_reason catturato", async () => {
  const r = await api.askAnthropic("s", [{ role: "user", content: "x" }]);
  if (r.stop_reason !== "end_turn") throw new Error("stop_reason = " + r.stop_reason);
});
await t("onDelta chiamato durante lo stream", () => {
  if (deltas < 2) throw new Error("onDelta chiamato " + deltas + " volte");
});
await t("i thinking_delta non finiscono nel testo", async () => {
  const r = await api.askAnthropic("s", [{ role: "user", content: "x" }]);
  if (r.content[0].text.includes("ragiono")) throw new Error("il ragionamento e' finito nella risposta");
});
await t("il Worker chiede stream:true e impone modello e max_tokens", () => {
  if (upstreamPayload.stream !== true) throw new Error("stream non richiesto");
  if (upstreamPayload.model !== "claude-sonnet-5") throw new Error("modello " + upstreamPayload.model);
  if (upstreamPayload.max_tokens !== 16000) throw new Error("max_tokens " + upstreamPayload.max_tokens);
});
await t("il client non puo' imporre il modello", async () => {
  await worker.fetch(new Request("https://w.dev/api/anthropic", {
    method: "POST", headers: { Origin: "https://x.github.io", Authorization: "Bearer segreto" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }], model: "modello-costoso", max_tokens: 999999 }),
  }), env);
  if (upstreamPayload.model === "modello-costoso") throw new Error("il modello del client e' passato!");
  if (upstreamPayload.max_tokens === 999999) throw new Error("max_tokens del client e' passato!");
});
await t("la risposta ha Content-Type text/event-stream e CORS", async () => {
  const r = await worker.fetch(new Request("https://w.dev/api/anthropic", {
    method: "POST", headers: { Origin: "https://x.github.io", Authorization: "Bearer segreto" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  }), env);
  const ct = r.headers.get("Content-Type") || "";
  if (!ct.includes("text/event-stream")) throw new Error("Content-Type: " + ct);
  if (r.headers.get("Access-Control-Allow-Origin") !== "https://x.github.io") throw new Error("CORS mancante");
});
await t("senza token resta 401 anche su questa rotta", async () => {
  const r = await worker.fetch(new Request("https://w.dev/api/anthropic", {
    method: "POST", headers: { Origin: "https://x.github.io" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  }), env);
  if (r.status !== 401) throw new Error("status " + r.status);
});

console.log(`\n${pass} passati, ${fail} falliti\n`);
process.exit(fail ? 1 : 0);
