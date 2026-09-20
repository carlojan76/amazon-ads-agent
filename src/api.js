/**
 * Client del Worker Cloudflare.
 *
 * Tutto quello che prima usciva dal browser con una credenziale dell'utente
 * (chiave Anthropic, PAT GitHub) passa ora da qui. Il browser conserva al
 * massimo il token del Worker, che raggiunge solo il Worker e non puo' fare
 * nient'altro che le rotte elencate in cloudflare/src/worker.js.
 *
 * Se il Worker non e' configurato, le funzioni lanciano un errore
 * riconoscibile (`isNotConfigured`) e la UI ricade sul percorso vecchio:
 * cosi' il progetto continua a funzionare anche prima del deploy.
 */

const ENV_BASE = typeof import.meta !== "undefined"
  ? (import.meta.env?.VITE_API_BASE || "")
  : "";

const LS_BASE = "aa_api_base";
const LS_TOKEN = "aa_api_token";

const ls = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* quota */ } },
};

export const getApiBase = () => (ls.get(LS_BASE) || ENV_BASE || "").replace(/\/+$/, "");
export const setApiBase = (v) => ls.set(LS_BASE, (v || "").trim().replace(/\/+$/, ""));
export const getApiToken = () => ls.get(LS_TOKEN);
export const setApiToken = (v) => ls.set(LS_TOKEN, (v || "").trim());
export const isConfigured = () => Boolean(getApiBase());

export class NotConfiguredError extends Error {
  constructor() {
    super("Worker non configurato: imposta l'indirizzo nelle impostazioni (⚙).");
    this.name = "NotConfiguredError";
    this.isNotConfigured = true;
  }
}

async function call(path, { method = "GET", body, query } = {}) {
  const base = getApiBase();
  if (!base) throw new NotConfiguredError();

  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const headers = {};
  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let resp;
  try {
    resp = await fetch(url.toString(), {
      method,
      headers,
      // Serve per Cloudflare Access: il cookie CF_Authorization viaggia solo
      // con credentials: "include".
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Non riesco a contattare il Worker (${url.origin}). Controlla l'indirizzo e che `
      + `l'origine di questa pagina sia in ALLOWED_ORIGINS. Dettaglio: ${err.message}`,
    );
  }

  let data = null;
  try { data = await resp.json(); } catch { /* risposta non JSON */ }

  if (!resp.ok) {
    const detail = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new Error(`Worker: non autorizzato. Controlla il token. (${detail})`);
    if (resp.status === 429) throw new Error(`Worker: ${detail}`);
    throw new Error(`Worker: ${detail}`);
  }
  return data;
}

// ---------------------------------------------------------------- registro azioni

export const fetchAppliedSignatures = async (marketplace, sinceDays = 28) => {
  const r = await call("/api/applied", { query: { marketplace, since_days: sinceDays } });
  return { signatures: new Set(r.signatures || []), actions: r.actions || [], since: r.since };
};

export const recordApplied = (marketplace, actions, meta = {}) =>
  call("/api/applied", { method: "POST", body: { marketplace, actions, ...meta } });

// ---------------------------------------------------------------- storico

export const fetchHistory = (marketplace, limit = 52) =>
  call("/api/history", { query: { marketplace, limit } });

// ---------------------------------------------------------------- tetti bid

export const fetchBidCaps = (marketplace) =>
  call("/api/bid-caps", { query: { marketplace } });

export const saveBidCap = (payload) =>
  call("/api/bid-caps", { method: "PUT", body: payload });

export const deleteBidCap = (marketplace, scope, scopeId = "") =>
  call("/api/bid-caps", { method: "DELETE", query: { marketplace, scope, scope_id: scopeId } });

// ---------------------------------------------------------------- Anthropic

export const askAnthropic = (system, messages) =>
  call("/api/anthropic", { method: "POST", body: { system, messages } });

// ---------------------------------------------------------------- GitHub

export const ghDispatch = (workflow, inputs, ref = "main") =>
  call("/api/github/dispatch", { method: "POST", body: { workflow, inputs, ref } });

export const ghRuns = (workflow, perPage = 5) =>
  call("/api/github", { query: { kind: "runs", workflow, per_page: perPage } });

export const ghRun = (id) =>
  call("/api/github", { query: { kind: "run", id } });

/** Ritorna { json, text } come getRepoFileContents, ma senza PAT nel browser. */
export const ghFile = async (path) => {
  const r = await call("/api/github", { query: { kind: "file", path } });
  const text = r?.decoded || "";
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non e' JSON */ }
  return { json: parsed, text, sha: r?.sha || "" };
};

export const health = () => call("/api/health");
