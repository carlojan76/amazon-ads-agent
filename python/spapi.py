"""
Client SP-API minimale: autenticazione LWA + wrapper richieste con backoff +
helper per la Reports API (crea / attendi / scarica).
"""
import gzip
import io
import time

import requests

import config

_token_cache = {"access_token": None, "expires_at": 0.0}


def get_access_token() -> str:
    """Scambia il refresh token LWA per un access token (valido ~1h), con cache."""
    now = time.time()
    if _token_cache["access_token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["access_token"]

    resp = requests.post(
        config.LWA_TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": config.LWA_REFRESH_TOKEN,
            "client_id": config.LWA_CLIENT_ID,
            "client_secret": config.LWA_CLIENT_SECRET,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    _token_cache["access_token"] = data["access_token"]
    _token_cache["expires_at"] = now + int(data.get("expires_in", 3600))
    return _token_cache["access_token"]


# Timestamp dell'ultima chiamata per "gruppo di throttling" (di norma il primo
# segmento del path, es. '/orders'). Permette a chi chiama di rispettare i rate
# limit SP-API lato client senza duplicare un intero HTTP client altrove.
_last_call_ts = {}


def _throttle(group: str, min_interval: float):
    if min_interval <= 0:
        return
    now = time.time()
    last = _last_call_ts.get(group, 0.0)
    wait = min_interval - (now - last)
    if wait > 0:
        time.sleep(wait)
    _last_call_ts[group] = time.time()


def request(method: str, path: str, params=None, json_body=None,
            max_retries: int = 8, min_interval: float = 0.0):
    """Richiesta SP-API con retry/backoff su 429 e 5xx.

    `min_interval` (secondi) attiva un throttling client-side per gruppo di
    endpoint (primo segmento del path): utile per le API con rate limit basso
    come Orders (getOrder ~0.5 req/s) e Finances (~0.5 req/s).

    createReport ha un rate limit molto basso (~1/min): qui aspettiamo in modo
    paziente (fino a ~90s per tentativo) e rispettiamo l'header Retry-After se
    presente, cosi' i backfill su piu' mesi non vengono interrotti dai 429.
    """
    url = config.SPAPI_ENDPOINT + path
    group = "/" + path.strip("/").split("/")[0]
    backoff = 2.0
    for attempt in range(max_retries):
        _throttle(group, min_interval)
        headers = {
            "x-amz-access-token": get_access_token(),
            "Content-Type": "application/json",
        }
        resp = requests.request(
            method, url, headers=headers, params=params, json=json_body, timeout=60
        )
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt == max_retries - 1:
                resp.raise_for_status()
            ra = resp.headers.get("Retry-After")
            try:
                wait = float(ra) if ra else backoff
            except ValueError:
                wait = backoff
            wait = min(max(wait, backoff), 90)
            print(
                f"  {resp.status_code} su {path}, attendo {wait:.0f}s "
                f"(tentativo {attempt + 1}/{max_retries})..."
            )
            time.sleep(wait)
            backoff = min(backoff * 2, 90)
            continue
        resp.raise_for_status()
        return resp.json() if resp.content else {}
    raise RuntimeError("max_retries esauriti")


# --- Reports API -------------------------------------------------------------

def create_report(report_type: str, marketplace_ids, data_start=None, data_end=None) -> str:
    body = {"reportType": report_type, "marketplaceIds": marketplace_ids}
    if data_start:
        body["dataStartTime"] = data_start
    if data_end:
        body["dataEndTime"] = data_end
    out = request("POST", "/reports/2021-06-30/reports", json_body=body)
    return out["reportId"]


def wait_for_report(report_id: str, poll_every: int = 20, timeout: int = 900) -> str:
    """Attende che il report sia DONE e restituisce il reportDocumentId."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        out = request("GET", f"/reports/2021-06-30/reports/{report_id}")
        status = out.get("processingStatus")
        if status == "DONE":
            return out["reportDocumentId"]
        if status == "CANCELLED":
            # Amazon cancella il report quando non ci sono dati per il periodo
            # (es. nessuna giacenza FBA quel mese): non e' un errore.
            return None
        if status == "FATAL":
            raise RuntimeError(f"Report {report_id} terminato con stato FATAL")
        time.sleep(poll_every)
    raise TimeoutError(f"Report {report_id} non pronto entro {timeout}s")


def download_report_document(document_id: str) -> str:
    """Scarica e restituisce il testo del documento (gestisce GZIP)."""
    out = request("GET", f"/reports/2021-06-30/documents/{document_id}")
    url = out["url"]
    comp = out.get("compressionAlgorithm")
    raw = requests.get(url, timeout=120).content
    if comp == "GZIP":
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    # I report Amazon EU sono di norma latin-1 / cp1252; fallback a utf-8.
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")
