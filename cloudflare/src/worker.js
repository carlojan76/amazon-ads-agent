/**
 * amazon-ads-agent — Worker Cloudflare.
 *
 * Fa due lavori distinti che prima non aveva nessuno:
 *
 * 1. DATABASE (D1). Registro delle azioni applicate e storico delle metriche.
 *    Senza questo il sistema riparte da zero ogni lunedi': ripropone quello
 *    che hai gia' fatto e non sa dire se una modifica ha funzionato.
 *
 * 2. PROXY DELLE CHIAVI. La chiave Anthropic e il PAT GitHub stanno qui nei
 *    secrets, non nel browser. Prima la pagina su GitHub Pages — che e'
 *    pubblica — teneva il PAT in localStorage e chiamava api.anthropic.com
 *    direttamente con la chiave dell'utente.
 *
 * Il token che il browser conserva ora raggiunge SOLO questo Worker, che a
 * sua volta puo' lanciare solo i workflow elencati in ALLOWED_WORKFLOWS e
 * solo su GITHUB_REPO. Se te lo rubano, il danno e' limitato a questo.
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

// ---------------------------------------------------------------- CORS

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "null",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Api-Token",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (data, status, request, env) => new Response(
  JSON.stringify(data, null, 2),
  { status: status || 200, headers: { ...JSON_HEADERS, ...corsHeaders(request, env) } },
);

const fail = (msg, status, request, env) => json({ error: msg }, status || 400, request, env);

// ---------------------------------------------------------------- auth

/** Confronto a tempo costante: un === su stringhe segrete perde byte per byte. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ""));
  const y = new TextEncoder().encode(String(b || ""));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

let certsCache = { at: 0, keys: null };

/**
 * Verifica il JWT di Cloudflare Access (cookie CF_Authorization).
 * E' la via consigliata per il browser: nessun token da conservare nella
 * pagina, l'accesso si revoca dalla dashboard Zero Trust.
 */
async function verifyAccessJwt(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = /CF_Authorization=([^;]+)/.exec(cookie);
  const token = m ? m[1] : request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;

  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) return false;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return false;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return false;

    if (!certsCache.keys || Date.now() - certsCache.at > 3600_000) {
      const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      if (!r.ok) return false;
      certsCache = { at: Date.now(), keys: (await r.json()).keys || [] };
    }
    const jwk = certsCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    return false;
  }
}

async function authorize(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = request.headers.get("X-Api-Token") || "";
  const supplied = bearer || header;
  if (env.API_TOKEN && supplied && safeEqual(supplied, env.API_TOKEN)) return true;
  return verifyAccessJwt(request, env);
}

// ---------------------------------------------------------------- helpers

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const nz = (v) => (v === undefined ? null : v);
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Stessa firma di actionSignature() in src/actions.js. Tenerle allineate e'
 * il motivo per cui il confronto proposto/gia'-applicato e' un'uguaglianza
 * secca invece di un fuzzy match che sbaglia.
 */
function signatureOf(a) {
  return [
    a.type || a.action_type || "",
    a.keywordId || a.keyword_id || "",
    a.campaignId || a.campaign_id || "",
    a.adGroupId || a.ad_group_id || "",
    String(a.keywordText || a.keyword_text || "").trim().toLowerCase(),
    a.matchType || a.match_type || "",
  ].join("|");
}

/** Valore "prima"/"dopo" per il tipo di azione, per poterlo mostrare a colpo d'occhio. */
function valuesOf(a) {
  if (a.type === "update_bid") return [numOrNull(a.old_bid), numOrNull(a.new_bid)];
  if (a.type === "update_budget") return [numOrNull(a.old_budget), numOrNull(a.new_budget)];
  if (a.type === "add_keyword") return [null, numOrNull(a.bid)];
  return [null, null];
}

async function bumpUsage(env, kind, limit) {
  const day = today();
  await env.DB.prepare(
    `INSERT INTO usage_counters (day, kind, n) VALUES (?, ?, 1)
     ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`,
  ).bind(day, kind).run();
  const row = await env.DB.prepare(
    "SELECT n FROM usage_counters WHERE day = ? AND kind = ?",
  ).bind(day, kind).first();
  const n = row ? row.n : 0;
  return { n, exceeded: limit > 0 && n > limit };
}

// ---------------------------------------------------------------- rotte: ledger

async function postApplied(request, env) {
  const body = await request.json();
  const mp = String(body.marketplace || "").toUpperCase();
  if (!mp) throw new Error("marketplace mancante");
  const list = Array.isArray(body.actions) ? body.actions : [];
  if (!list.length) return { inserted: 0 };

  const at = body.applied_at || nowIso();
  const stmt = env.DB.prepare(
    `INSERT INTO applied_actions
       (marketplace, action_type, signature, keyword_id, campaign_id, ad_group_id,
        keyword_text, match_type, old_value, new_value, reason, applied_at,
        run_id, run_url, ok, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = list.map((a) => {
    const [oldV, newV] = valuesOf(a);
    return stmt.bind(
      mp, String(a.type || ""), signatureOf(a),
      nz(a.keywordId), nz(a.campaignId), nz(a.adGroupId),
      nz(a.keywordText), nz(a.matchType),
      oldV, newV, nz(a.reason), at,
      nz(body.run_id), nz(body.run_url),
      a.ok === false ? 0 : 1, nz(a.detail),
    );
  });

  await env.DB.batch(batch);
  return { inserted: batch.length, marketplace: mp };
}

async function getApplied(url, env) {
  const mp = (url.searchParams.get("marketplace") || "").toUpperCase();
  const days = parseInt(url.searchParams.get("since_days") || "28", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10), 2000);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const sql = mp
    ? `SELECT * FROM applied_actions
        WHERE marketplace = ? AND applied_at >= ? AND rolled_back = 0 AND ok = 1
        ORDER BY applied_at DESC LIMIT ?`
    : `SELECT * FROM applied_actions
        WHERE applied_at >= ? AND rolled_back = 0 AND ok = 1
        ORDER BY applied_at DESC LIMIT ?`;
  const bound = mp ? [mp, since, limit] : [since, limit];

  const res = await env.DB.prepare(sql).bind(...bound).all();
  const rows = res.results || [];
  return {
    marketplace: mp || null,
    since,
    count: rows.length,
    signatures: [...new Set(rows.map((r) => r.signature))],
    actions: rows,
  };
}

async function markRolledBack(request, env) {
  const body = await request.json();
  const sigs = Array.isArray(body.signatures) ? body.signatures : [];
  const mp = String(body.marketplace || "").toUpperCase();
  if (!mp || !sigs.length) return { updated: 0 };
  const stmt = env.DB.prepare(
    "UPDATE applied_actions SET rolled_back = 1 WHERE marketplace = ? AND signature = ?",
  );
  await env.DB.batch(sigs.map((s) => stmt.bind(mp, s)));
  return { updated: sigs.length };
}

// ---------------------------------------------------------------- rotte: storico

async function postHistory(request, env) {
  const b = await request.json();
  const mp = String(b.marketplace || "").toUpperCase();
  const periodEnd = String(b.period_end || today());
  if (!mp) throw new Error("marketplace mancante");

  await env.DB.prepare(
    `INSERT INTO metrics_history
       (marketplace, period_end, period_start, captured_at, days, spend, sales,
        acos, roas, impressions, clicks, orders, ctr, cvr, cpc, n_campaigns, n_keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(marketplace, period_end) DO UPDATE SET
       period_start = excluded.period_start, captured_at = excluded.captured_at,
       days = excluded.days, spend = excluded.spend, sales = excluded.sales,
       acos = excluded.acos, roas = excluded.roas, impressions = excluded.impressions,
       clicks = excluded.clicks, orders = excluded.orders, ctr = excluded.ctr,
       cvr = excluded.cvr, cpc = excluded.cpc, n_campaigns = excluded.n_campaigns,
       n_keywords = excluded.n_keywords`,
  ).bind(
    mp, periodEnd, nz(b.period_start), b.captured_at || nowIso(), nz(b.days),
    b.spend || 0, b.sales || 0, b.acos || 0, b.roas || 0, b.impressions || 0,
    b.clicks || 0, b.orders || 0, b.ctr || 0, b.cvr || 0, b.cpc || 0,
    b.n_campaigns || 0, b.n_keywords || 0,
  ).run();

  return { ok: true, marketplace: mp, period_end: periodEnd };
}

async function getHistory(url, env) {
  const mp = (url.searchParams.get("marketplace") || "").toUpperCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "52", 10), 520);
  const sql = mp
    ? "SELECT * FROM metrics_history WHERE marketplace = ? ORDER BY period_end DESC LIMIT ?"
    : "SELECT * FROM metrics_history ORDER BY period_end DESC LIMIT ?";
  const res = await env.DB.prepare(sql).bind(...(mp ? [mp, limit] : [limit])).all();
  // Ordine cronologico crescente: e' come lo vuole un grafico.
  return { marketplace: mp || null, points: (res.results || []).reverse() };
}

// ---------------------------------------------------------------- rotte: tetti bid

async function getBidCaps(url, env) {
  const mp = (url.searchParams.get("marketplace") || "").toUpperCase();
  const sql = mp
    ? "SELECT * FROM bid_caps WHERE marketplace = ? ORDER BY scope, scope_id"
    : "SELECT * FROM bid_caps ORDER BY marketplace, scope, scope_id";
  const res = await env.DB.prepare(sql).bind(...(mp ? [mp] : [])).all();
  const rows = res.results || [];
  const market = rows.find((r) => r.scope === "market");
  return {
    marketplace: mp || null,
    market_cap: market ? market.max_bid : null,
    campaign_caps: rows.filter((r) => r.scope === "campaign"),
    caps: rows,
  };
}

async function putBidCap(request, env) {
  const b = await request.json();
  const mp = String(b.marketplace || "").toUpperCase();
  const scope = b.scope === "campaign" ? "campaign" : "market";
  const scopeId = scope === "campaign" ? String(b.scope_id || "").trim() : "";
  const maxBid = Number(b.max_bid);

  if (!mp) throw new Error("marketplace mancante");
  if (scope === "campaign" && !scopeId) throw new Error("scope_id mancante per un tetto di campagna");
  if (!Number.isFinite(maxBid) || maxBid <= 0) throw new Error("max_bid non valido");
  // Stesso intervallo assoluto dei guardrail: un tetto a 40 EUR non e' un tetto.
  if (maxBid < 0.02 || maxBid > 5.0) throw new Error("max_bid fuori dall'intervallo 0.02 - 5.00");

  await env.DB.prepare(
    `INSERT INTO bid_caps (marketplace, scope, scope_id, scope_label, max_bid, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(marketplace, scope, scope_id) DO UPDATE SET
       max_bid = excluded.max_bid, note = excluded.note,
       scope_label = excluded.scope_label, updated_at = excluded.updated_at`,
  ).bind(mp, scope, scopeId, nz(b.scope_label), maxBid, nz(b.note), nowIso()).run();

  return { ok: true, marketplace: mp, scope, scope_id: scopeId, max_bid: maxBid };
}

async function deleteBidCap(url, env) {
  const mp = (url.searchParams.get("marketplace") || "").toUpperCase();
  const scope = url.searchParams.get("scope") === "campaign" ? "campaign" : "market";
  const scopeId = scope === "campaign" ? (url.searchParams.get("scope_id") || "") : "";
  if (!mp) throw new Error("marketplace mancante");
  await env.DB.prepare(
    "DELETE FROM bid_caps WHERE marketplace = ? AND scope = ? AND scope_id = ?",
  ).bind(mp, scope, scopeId).run();
  return { ok: true };
}

// ---------------------------------------------------------------- proxy Anthropic

async function proxyAnthropic(request, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY non configurata sul Worker");

  const limit = parseInt(env.DAILY_LIMIT_ANTHROPIC || "120", 10);
  const usage = await bumpUsage(env, "anthropic", limit);
  if (usage.exceeded) {
    const e = new Error(`Tetto giornaliero di ${limit} chiamate raggiunto (${usage.n} oggi). `
      + "Alza DAILY_LIMIT_ANTHROPIC se e' un uso legittimo.");
    e.status = 429;
    throw e;
  }

  const body = await request.json();
  // Modello e max_tokens li decide il Worker: il client puo' solo mandare la
  // conversazione. Cosi' una pagina compromessa non puo' chiedere run costosi.
  const payload = {
    model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
    max_tokens: parseInt(env.ANTHROPIC_MAX_TOKENS || "16000", 10),
    system: typeof body.system === "string" ? body.system : undefined,
    messages: Array.isArray(body.messages) ? body.messages : [],
  };
  if (!payload.messages.length) throw new Error("messages vuoto");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  return { status: r.status, data: await r.json() };
}

// ---------------------------------------------------------------- proxy GitHub

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "amazon-ads-agent-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function assertWorkflowAllowed(env, workflow) {
  const allowed = String(env.ALLOWED_WORKFLOWS || "").split(",").map((s) => s.trim());
  if (!allowed.includes(workflow)) {
    throw new Error(`Workflow "${workflow}" non consentito. Ammessi: ${allowed.join(", ")}`);
  }
}

async function githubDispatch(request, env) {
  // L'allowlist si controlla PRIMA del token: e' il controllo di sicurezza,
  // e deve dare lo stesso messaggio sia che il Worker abbia le credenziali
  // sia che non le abbia. Altrimenti "GITHUB_TOKEN non configurato" finisce
  // per sembrare la causa di un workflow rifiutato.
  const b = await request.json();
  const workflow = String(b.workflow || "");
  assertWorkflowAllowed(env, workflow);
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN non configurato sul Worker");

  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: b.ref || "main", inputs: b.inputs || {} }),
    },
  );
  if (r.status === 204) return { status: 200, data: { ok: true } };
  return { status: r.status, data: await r.json().catch(() => ({ error: `HTTP ${r.status}` })) };
}

async function githubGet(url, env) {
  const kind = url.searchParams.get("kind") || "";
  const base = `https://api.github.com/repos/${env.GITHUB_REPO}`;
  let target;

  if (kind === "runs") {
    const workflow = url.searchParams.get("workflow") || "";
    assertWorkflowAllowed(env, workflow);
    const per = Math.min(parseInt(url.searchParams.get("per_page") || "5", 10), 30);
    target = `${base}/actions/workflows/${workflow}/runs?per_page=${per}`;
  } else if (kind === "run") {
    const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
    if (!id) throw new Error("id del run mancante");
    target = `${base}/actions/runs/${id}`;
  } else if (kind === "file") {
    const path = url.searchParams.get("path") || "";
    if (!path || path.includes("..")) throw new Error("path non valido");
    target = `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  } else {
    throw new Error(`kind "${kind}" non supportato (runs | run | file)`);
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN non configurato sul Worker");

  const r = await fetch(target, { headers: ghHeaders(env) });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));

  // I file arrivano in base64: li decodifichiamo qui, cosi' il browser non
  // deve gestire atob + UTF-8 (che e' la combinazione che rompe gli accenti).
  if (kind === "file" && data && data.content) {
    try {
      const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
      data.decoded = new TextDecoder().decode(bytes);
      delete data.content;
    } catch { /* lasciamo il base64 grezzo */ }
  }
  return { status: r.status, data };
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (path === "/" || path === "/api/health") {
      return json({ ok: true, service: "amazon-ads-agent-api", time: nowIso() }, 200, request, env);
    }

    if (!(await authorize(request, env))) {
      return fail("Non autorizzato.", 401, request, env);
    }

    try {
      const m = request.method;

      if (path === "/api/applied" && m === "POST") return json(await postApplied(request, env), 200, request, env);
      if (path === "/api/applied" && m === "GET") return json(await getApplied(url, env), 200, request, env);
      if (path === "/api/applied/rollback" && m === "POST") return json(await markRolledBack(request, env), 200, request, env);

      if (path === "/api/history" && m === "POST") return json(await postHistory(request, env), 200, request, env);
      if (path === "/api/history" && m === "GET") return json(await getHistory(url, env), 200, request, env);

      if (path === "/api/bid-caps" && m === "GET") return json(await getBidCaps(url, env), 200, request, env);
      if (path === "/api/bid-caps" && (m === "PUT" || m === "POST")) return json(await putBidCap(request, env), 200, request, env);
      if (path === "/api/bid-caps" && m === "DELETE") return json(await deleteBidCap(url, env), 200, request, env);

      if (path === "/api/anthropic" && m === "POST") {
        const { status, data } = await proxyAnthropic(request, env);
        return json(data, status, request, env);
      }
      if (path === "/api/github/dispatch" && m === "POST") {
        const { status, data } = await githubDispatch(request, env);
        return json(data, status, request, env);
      }
      if (path === "/api/github" && m === "GET") {
        const { status, data } = await githubGet(url, env);
        return json(data, status, request, env);
      }

      return fail(`Rotta non trovata: ${m} ${path}`, 404, request, env);
    } catch (err) {
      return fail(err.message || String(err), err.status || 400, request, env);
    }
  },
};
