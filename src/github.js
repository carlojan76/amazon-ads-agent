/**
 * GitHub integration: OAuth Device Flow (no client secret, no pasted PAT)
 * + helpers to dispatch the "Apply Amazon Ads Changes" workflow and find its run.
 *
 * Device Flow endpoints (github.com/login/device/code and /login/oauth/access_token)
 * support CORS specifically so browser-only apps (no backend) can use them.
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
