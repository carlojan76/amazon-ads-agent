"""Client Python del Worker Cloudflare (registro azioni, storico, tetti bid).

Usato da weekly_analysis.py e apply_changes.py. Tutto passa da due variabili
d'ambiente:

    AGENT_API_BASE   https://amazon-ads-agent-api.<tuo-subdominio>.workers.dev
    AGENT_API_TOKEN  lo stesso valore messo con `wrangler secret put API_TOKEN`

Se AGENT_API_BASE non e' impostata il modulo si disattiva in silenzio e tutto
continua a funzionare come prima: il repo resta utilizzabile senza Cloudflare.

Due politiche diverse in caso di errore, ed e' voluto:

  - registro e storico sono BEST EFFORT. Se il Worker non risponde si logga e
    si va avanti: non vale la pena far fallire un'analisi da 45 minuti perche'
    un insert non e' passato.

  - i tetti sui bid FALLISCONO CHIUSO. Se hai configurato il Worker e non si
    riesce a leggere i tetti, apply_changes.py si ferma invece di applicare
    bid non verificati. Un tetto che salta proprio quando serve non e' un
    tetto. Si aggira con --ignore-cap-errors, consapevolmente.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

API_BASE = (os.getenv("AGENT_API_BASE") or "").rstrip("/")
API_TOKEN = os.getenv("AGENT_API_TOKEN") or ""
TIMEOUT = int(os.getenv("AGENT_API_TIMEOUT", "20"))

# Cloudflare blocca in blocco lo User-Agent di default di urllib
# ("Python-urllib/3.12") con l'errore 1010, browser_signature_banned: la
# richiesta non arriva nemmeno al Worker, viene fermata prima sul bordo.
# Serve una stringa nostra. Si puo' cambiare da ambiente se un giorno
# anche questa finisse in una lista.
USER_AGENT = os.getenv(
    "AGENT_API_USER_AGENT",
    "amazon-ads-agent/1.0 (+https://github.com/carlojan76/amazon-ads-agent)",
)


class ApiError(RuntimeError):
    pass


def enabled() -> bool:
    return bool(API_BASE)


def _call(path, method="GET", body=None, query=None):
    if not API_BASE:
        raise ApiError("AGENT_API_BASE non impostata")

    url = API_BASE + path
    if query:
        clean = {k: v for k, v in query.items() if v not in (None, "")}
        if clean:
            url += "?" + urllib.parse.urlencode(clean)

    data = None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        # L'errore 1010 arriva da Cloudflare, non dal Worker, ed e' un muro
        # di JSON che non dice niente a chi legge il log. Traducilo.
        if e.code == 403 and "error_1010" in detail:
            raise ApiError(
                f"{method} {path} -> Cloudflare ha bloccato la richiesta prima del Worker "
                f"(errore 1010, User-Agent non gradito). User-Agent inviato: '{USER_AGENT}'. "
                "Cambialo con la variabile AGENT_API_USER_AGENT."
            ) from e
        raise ApiError(f"{method} {path} -> HTTP {e.code}: {detail[:400]}") from e
    except Exception as e:  # rete, DNS, timeout
        raise ApiError(f"{method} {path} -> {e}") from e


# ---------------------------------------------------------------- firme

def signature_of(a: dict) -> str:
    """Stessa firma di actionSignature() in src/actions.js e signatureOf() nel Worker.

    Se cambi l'ordine dei campi in uno dei tre, cambialo in tutti e tre:
    e' l'uguaglianza su cui si regge il confronto proposto/gia'-applicato.
    """
    return "|".join([
        str(a.get("type") or ""),
        str(a.get("keywordId") or ""),
        str(a.get("campaignId") or ""),
        str(a.get("adGroupId") or ""),
        str(a.get("keywordText") or "").strip().lower(),
        str(a.get("matchType") or ""),
    ])


# ---------------------------------------------------------------- registro

def record_applied(marketplace, actions, run_id=None, run_url=None, applied_at=None):
    """Registra le azioni CONFERMATE dall'API. Best effort: non solleva."""
    if not enabled() or not actions:
        return None
    try:
        return _call("/api/applied", "POST", {
            "marketplace": marketplace,
            "actions": actions,
            "run_id": run_id or os.getenv("GITHUB_RUN_ID"),
            "run_url": run_url or _github_run_url(),
            "applied_at": applied_at,
        })
    except ApiError as e:
        print(f"   [registro] insert non riuscito: {e}")
        return None


def applied_signatures(marketplace, since_days=28):
    """Firme gia' applicate di recente. Best effort: in caso d'errore set vuoto."""
    if not enabled():
        return set()
    try:
        r = _call("/api/applied", query={"marketplace": marketplace, "since_days": since_days})
        return set(r.get("signatures") or [])
    except ApiError as e:
        print(f"   [registro] lettura non riuscita: {e}")
        return set()


def applied_recent(marketplace, since_days=28):
    """Righe complete, per poterle mostrare nel prompt con data e valore."""
    if not enabled():
        return []
    try:
        r = _call("/api/applied", query={"marketplace": marketplace, "since_days": since_days})
        return r.get("actions") or []
    except ApiError as e:
        print(f"   [registro] lettura non riuscita: {e}")
        return []


def _github_run_url():
    server = os.getenv("GITHUB_SERVER_URL")
    repo = os.getenv("GITHUB_REPOSITORY")
    run = os.getenv("GITHUB_RUN_ID")
    if server and repo and run:
        return f"{server}/{repo}/actions/runs/{run}"
    return None


# ---------------------------------------------------------------- storico

def record_history(marketplace, point):
    """Salva un punto dello storico. Best effort: non solleva."""
    if not enabled():
        return None
    try:
        payload = dict(point)
        payload["marketplace"] = marketplace
        return _call("/api/history", "POST", payload)
    except ApiError as e:
        print(f"   [storico] insert non riuscito: {e}")
        return None


def history(marketplace, limit=52):
    if not enabled():
        return []
    try:
        return (_call("/api/history", query={"marketplace": marketplace, "limit": limit}) or {}).get("points", [])
    except ApiError as e:
        print(f"   [storico] lettura non riuscita: {e}")
        return []


# ---------------------------------------------------------------- tetti bid

def bid_caps(marketplace, strict=True):
    """Ritorna {"market": float|None, "campaigns": {campaignId: float}}.

    strict=True (default quando il Worker e' configurato) rilancia l'errore:
    meglio bloccare che applicare bid non verificati. Vedi il docstring in cima.
    """
    empty = {"market": None, "campaigns": {}}
    if not enabled():
        return empty
    try:
        r = _call("/api/bid-caps", query={"marketplace": marketplace}) or {}
    except ApiError as e:
        if strict:
            raise
        print(f"   [tetti bid] lettura non riuscita, procedo senza tetti: {e}")
        return empty
    return {
        "market": r.get("market_cap"),
        "campaigns": {
            str(c.get("scope_id")): float(c.get("max_bid"))
            for c in (r.get("campaign_caps") or [])
            if c.get("scope_id") and c.get("max_bid") is not None
        },
    }


def min_clicks_per_day(marketplace, default=10):
    """Clic minimi al giorno sotto cui una campagna non ha senso.

    Dieci non e' un numero magico: e' l'ordine di grandezza sotto cui il
    budget si esaurisce in poche ore, i dati non bastano a decidere niente,
    e servirebbe un tasso di conversione irreale per rientrare.

    Si cambia per mercato dalle impostazioni sul Worker. Senza Worker vale il
    default, che e' sufficiente perche' il vincolo si calcola dal budget e non
    ha bisogno di nessun servizio esterno.
    """
    env = os.getenv("MIN_CLICKS_PER_DAY")
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    if not enabled():
        return default
    try:
        r = _call("/api/settings", query={"marketplace": marketplace}) or {}
        v = (r.get("settings") or {}).get("min_clicks_per_day")
        return max(1, int(v)) if v else default
    except (ApiError, TypeError, ValueError):
        return default


def cap_for(caps, campaign_id=None):
    """Tetto applicabile: la campagna vince sul mercato. None = nessun tetto."""
    if not caps:
        return None
    cid = str(campaign_id or "")
    if cid and cid in (caps.get("campaigns") or {}):
        return caps["campaigns"][cid]
    m = caps.get("market")
    return float(m) if m is not None else None


def describe_caps(caps):
    """Riga leggibile per i log e per il prompt."""
    if not caps or (caps.get("market") is None and not caps.get("campaigns")):
        return "nessun tetto configurato"
    parts = []
    if caps.get("market") is not None:
        parts.append(f"mercato EUR {float(caps['market']):.2f}")
    n = len(caps.get("campaigns") or {})
    if n:
        parts.append(f"{n} campagn{'a' if n == 1 else 'e'} con tetto specifico")
    return ", ".join(parts)
