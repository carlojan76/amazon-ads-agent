/**
 * GitHub integration: OAuth Device Flow (no client secret, no pasted PAT)
 * + helpers per dispatch dei workflow, stato dei run e lettura file dal repo.
 *
 * Device Flow endpoints (github.com/login/device/code e /login/oauth/access_token)
 * supportano CORS, quindi un'app solo-browser (senza backend) puo' usarli.
 */

const GH_API = "https://api.github.com";

export async function startDeviceFlow(clientId, scope = "repo") {
  const resp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!resp.ok) throw new Error(`Device flow init fallito (${resp.status})`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

/**
 * Polls until the user authorizes the device, or it expires/is denied.
 * onTick(secondsLeft) is called on each poll so the UI can show a countdown.
 */
export async function pollForToken(clientId, deviceCode, intervalSec, expiresInSec, onTick) {
  let interval = intervalSec * 1000;
  const deadline = Date.now() + expiresInSec * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    if (onTick) onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)));

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
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
  const resp = await fetch(`${GH_API}/user`, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!resp.ok) throw new Error(`Token GitHub non valido (${resp.status})`);
  return resp.json();
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
        "Cache-Control": "no-cache",
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
