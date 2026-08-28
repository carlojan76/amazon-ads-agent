/**
 * GitHub integration.
 *
 * IMPORTANTE — gli endpoint di login (github.com/login/device/code e
 * /login/oauth/access_token) NON inviano l'header Access-Control-Allow-Origin.
 * Il browser blocca quindi la richiesta prima di mandarla, e fetch fallisce con
 * un TypeError "Failed to fetch" (nessun codice HTTP: non e' un errore dell'API).
 * Il Device Flow da app solo-browser NON e' quindi utilizzabile senza un proxy.
 *
 * api.github.com invece espone CORS correttamente: con un token in mano tutto
 * il resto (dispatch dei workflow, stato dei run, lettura file) funziona.
 *
 * Di conseguenza la via principale e' un token personale (PAT) incollato
 * dall'utente. Il Device Flow resta disponibile solo se si configura un proxy
 * che aggiunga gli header CORS.
 */

const GH_API = "https://api.github.com";

/** Riconosce il fallimento di rete/CORS e lo spiega, invece di lasciare "Failed to fetch". */
function explainNetworkError(err, what) {
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err?.message || "")) {
    return new Error(
      `${what}: il browser ha bloccato la richiesta (CORS). Gli endpoint di login di GitHub non `
      + `sono richiamabili da un'app senza backend. Usa un token personale, oppure configura un proxy.`
    );
  }
  return err;
}

export async function startDeviceFlow(clientId, scope = "repo", proxyBase = "") {
  const base = proxyBase ? proxyBase.replace(/\/$/, "") : "https://github.com";
  let resp;
  try {
    resp = await fetch(`${base}/login/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, scope }),
    });
  } catch (err) {
    throw explainNetworkError(err, "Avvio del Device Flow fallito");
  }
  if (!resp.ok) throw new Error(`Avvio del Device Flow fallito (${resp.status})`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

/**
 * Polls until the user authorizes the device, or it expires/is denied.
 * onTick(secondsLeft) is called on each poll so the UI can show a countdown.
 */
export async function pollForToken(clientId, deviceCode, intervalSec, expiresInSec, onTick, proxyBase = "") {
  const base = proxyBase ? proxyBase.replace(/\/$/, "") : "https://github.com";
  let interval = intervalSec * 1000;
  const deadline = Date.now() + expiresInSec * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    if (onTick) onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)));

    let resp;
    try {
      resp = await fetch(`${base}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch (err) {
      throw explainNetworkError(err, "Recupero del token fallito");
    }
    const data = await resp.json();

    if (data.access_token) return data.access_token;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { interval += 5000; continue; }
    if (data.error === "expired_token") throw new Error("Codice scaduto, riprova.");
    if (data.error === "access_denied") throw new Error("Accesso negato su GitHub.");
    throw new Error(data.error_description || data.error || "Errore autenticazione GitHub");
  }
  throw new Error("Tempo scaduto in attesa dell'autorizzazione GitHub.");
}

export async function getUser(token) {
  let resp;
  try {
    resp = await fetch(`${GH_API}/user`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
    });
  } catch (err) {
    throw explainNetworkError(err, "Verifica del token fallita");
  }
  if (resp.status === 401) throw new Error("Token non valido o scaduto.");
  if (!resp.ok) throw new Error(`Verifica del token fallita (${resp.status})`);
  return resp.json();
}

/**
 * Controlla che il token possa davvero lanciare il workflow, PRIMA di provarci.
 * Ritorna { ok, message }: un token senza il permesso Actions fallirebbe
 * altrimenti solo al momento del dispatch, con un 403 poco chiaro.
 */
export async function checkRepoAccess({ token, owner, repo, workflow }) {
  try {
    const r = await fetch(`${GH_API}/repos/${owner}/${repo}/actions/workflows/${workflow}`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
    });
    if (r.status === 404) {
      return { ok: false, message: `Non trovo ${owner}/${repo}/${workflow}. Controlla nome del repo e del file, e che il token abbia accesso a questo repository.` };
    }
    if (r.status === 403) {
      return { ok: false, message: "Il token non ha il permesso Actions su questo repository (serve lettura e scrittura)." };
    }
    if (!r.ok) return { ok: false, message: `Controllo del repository fallito (${r.status}).` };
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: explainNetworkError(err, "Controllo del repository fallito").message };
  }
}

export async function dispatchWorkflow({ token, owner, repo, workflow, ref = "main", inputs }) {
  const resp = await fetch(
    `${GH_API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs }),
    }
  );
  if (resp.status !== 204) {
    let detail = "";
    try { detail = (await resp.json()).message; } catch { /* ignore */ }
    throw new Error(`Avvio workflow fallito (${resp.status}): ${detail || "verifica repo/permessi/nome workflow"}`);
  }
  return true;
}

/** Best-effort: find the run that was just dispatched, to give the user a direct link. */
export async function findLatestRun({ token, owner, repo, workflow }) {
  const resp = await fetch(
    `${GH_API}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=1`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.workflow_runs?.[0] || null;
}

/** Stato/conclusione di un run specifico. Ritorna { status, conclusion, html_url } o null. */
export async function getRun({ token, owner, repo, runId }) {
  const resp = await fetch(
    `${GH_API}/repos/${owner}/${repo}/actions/runs/${runId}`,
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } }
  );
  if (!resp.ok) return null;
  const d = await resp.json();
  return { status: d.status, conclusion: d.conclusion, html_url: d.html_url };
}

/**
 * Legge un file dal repo via Contents API (CORS-friendly, funziona anche su
 * repo privati col token). Ritorna { json, sha } oppure null se 404.
 * Decodifica il base64 e prova a fare JSON.parse.
 */
export async function getRepoFileContents({ token, owner, repo, path, ref = "main" }) {
  const resp = await fetch(
    `${GH_API}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Lettura file fallita (${resp.status})`);
  const data = await resp.json();
  let text = "";
  try {
    // content e' base64 (con newline). atob gestisce UTF-8 via decodeURIComponent/escape.
    const raw = atob((data.content || "").replace(/\n/g, ""));
    text = decodeURIComponent(escape(raw));
  } catch {
    text = "";
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { json, text, sha: data.sha };
}

/**
 * Trova l'ultimo commit che ha toccato un dato path. La Commits API e' sempre
 * fresca (nessuna cache aggressiva come la Contents API), quindi e' affidabile
 * per rilevare la presenza di un commit nuovo.
 * Ritorna { sha, date, message } dell'ultimo commit, o null se il path non esiste.
 */
export async function getLatestCommitForPath({ token, owner, repo, path, ref = "main" }) {
  const url = `${GH_API}/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1&t=${Date.now()}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) return null;
  const arr = await resp.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const c = arr[0];
  return { sha: c.sha, date: c.commit?.author?.date, message: c.commit?.message };
}

/**
 * ID del run piu' recente per un workflow (o null). Va chiamata PRIMA del
 * dispatch: `findLatestRun` da sola puo' restituire un run vecchio, perche'
 * GitHub impiega qualche secondo a registrare quello appena lanciato.
 */
export async function latestRunId({ token, owner, repo, workflow }) {
  const run = await findLatestRun({ token, owner, repo, workflow });
  return run?.id ?? null;
}

/**
 * Attende che compaia un run PIU' NUOVO di `afterId` e lo restituisce.
 * onTick(secondiTrascorsi) permette alla UI di mostrare l'attesa.
 */
export async function waitForNewRun({ token, owner, repo, workflow, afterId, timeoutMs = 90000, onTick }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    if (onTick) onTick(Math.round((Date.now() - start) / 1000));
    let run = null;
    try {
      run = await findLatestRun({ token, owner, repo, workflow });
    } catch {
      continue;
    }
    if (run && (afterId == null || run.id !== afterId)) return run;
  }
  return null;
}

/**
 * Segue un run fino alla conclusione. onUpdate riceve { status, conclusion, html_url }.
 * Ritorna lo stato finale, oppure l'ultimo noto allo scadere del timeout.
 */
export async function followRun({ token, owner, repo, runId, timeoutMs = 900000, onUpdate }) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const info = await getRun({ token, owner, repo, runId });
    if (info) {
      last = info;
      if (onUpdate) onUpdate(info);
      if (info.status === "completed") return info;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}
