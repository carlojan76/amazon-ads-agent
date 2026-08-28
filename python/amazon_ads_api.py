"""
Amazon Advertising API Fetcher v2
==================================
Scarica dati completi dalle campagne Sponsored Products via Amazon Advertising API.
Output: JSON strutturato pronto per l'Amazon Ads Agent.

Uso:
    python amazon_ads_api.py                    # Fetch tutti i dati (auto-select profilo)
    python amazon_ads_api.py --days 30          # Ultimi 30 giorni
    python amazon_ads_api.py --marketplace IT   # Solo marketplace IT
    python amazon_ads_api.py --list-profiles    # Lista profili disponibili
"""

import requests
import json
import time
import os
from datetime import datetime, timedelta
from pathlib import Path

# ============================================================
# CONFIG
# ============================================================
CONFIG = {
    "client_id": os.getenv("AMAZON_ADS_CLIENT_ID", ""),
    "client_secret": os.getenv("AMAZON_ADS_CLIENT_SECRET", ""),
    "refresh_token": os.getenv("AMAZON_ADS_REFRESH_TOKEN", ""),
    "profile_id": os.getenv("AMAZON_ADS_PROFILE_ID", ""),
    "region": "eu",
}

ENDPOINTS = {
    "eu": "https://advertising-api-eu.amazon.com",
    "na": "https://advertising-api.amazon.com",
    "fe": "https://advertising-api-fe.amazon.com",
}

TOKEN_URL = "https://api.amazon.com/auth/o2/token"

# L'API di reporting v3 rifiuta gli intervalli superiori a 31 giorni.
MAX_REPORT_DAYS = 31


# ============================================================
# FINESTRE TEMPORALI
# ============================================================
# Una richiesta di report copre al massimo MAX_REPORT_DAYS giorni. Per periodi
# piu' lunghi si scaricano piu' finestre adiacenti e si sommano le metriche.

# Campi additivi: si sommano quando si uniscono due finestre.
_ADDITIVE_FIELDS = {
    "impressions", "clicks", "cost", "spend",
    "purchases7d", "purchases14d", "purchases30d", "orders",
    "sales7d", "sales14d", "sales30d", "sales",
    "unitsSoldClicks7d", "unitsSoldClicks14d", "unitsSoldClicks30d",
    "attributedSales7d", "attributedSales14d",
}

# Come si riconosce "la stessa entita'" in due finestre diverse.
_MERGE_KEYS = {
    "spCampaigns": ("campaignId",),
    "spKeywords": ("keywordId", "campaignId", "adGroupId", "keyword", "matchType"),
    "spSearchTerm": ("campaignId", "adGroupId", "keyword", "matchType", "searchTerm"),
    "spTargeting": ("campaignId", "adGroupId", "keyword", "matchType"),
    "spAdvertisedProduct": ("campaignId", "adGroupId", "advertisedAsin", "advertisedSku"),
}


def _date_windows(days, max_days=MAX_REPORT_DAYS, today=None):
    """Finestre adiacenti che coprono `days` giorni fino a IERI.

    Ritorna una lista di (start_date, end_date) in formato YYYY-MM-DD, dalla
    piu' recente alla piu' vecchia. Con days <= max_days la lista ha un solo
    elemento, identico a quello che si otteneva prima.
    """
    today = today or datetime.now()
    end = today - timedelta(days=1)          # ieri: l'ultimo giorno consolidato
    remaining = max(1, int(days))
    windows = []
    while remaining > 0:
        span = min(remaining, max_days)
        start = end - timedelta(days=span - 1)
        windows.append((start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")))
        end = start - timedelta(days=1)
        remaining -= span
    return windows


def _merge_key(row, report_type):
    fields = _MERGE_KEYS.get(report_type)
    if not fields:
        # Tipo sconosciuto: chiave su tutti i campi non numerici, cosi' nel
        # dubbio si duplica invece di sommare cose diverse.
        fields = tuple(sorted(k for k in row if k not in _ADDITIVE_FIELDS))
    return tuple(str(row.get(f, "")) for f in fields)


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _merge_report_rows(existing, new_rows, report_type):
    """Unisce le righe di due finestre sommando le metriche additive.

    I campi non additivi (nomi, stati, match type) restano quelli della prima
    occorrenza. Le metriche derivate che sappiamo ricalcolare (CPC) vengono
    ricalcolate sul totale, invece di restare quelle di una finestra sola.
    """
    merged = {}
    order = []
    for row in list(existing) + list(new_rows):
        key = _merge_key(row, report_type)
        if key not in merged:
            merged[key] = dict(row)
            order.append(key)
            continue
        target = merged[key]
        for field, value in row.items():
            if field in _ADDITIVE_FIELDS:
                target[field] = _num(target.get(field)) + _num(value)
            elif field not in target or target[field] in ("", None):
                target[field] = value

    out = [merged[k] for k in order]
    for row in out:
        clicks = _num(row.get("clicks"))
        if "costPerClick" in row:
            cost = _num(row.get("cost", row.get("spend", 0)))
            row["costPerClick"] = round(cost / clicks, 4) if clicks else 0
    return out


class AmazonAdsAPI:
    def __init__(self, config):
        self.config = config
        self.base_url = ENDPOINTS[config["region"]]
        self.access_token = None
        self.profile_id = config.get("profile_id", "")
        # Tracciamento della COMPLETEZZA dei dati: distingue "zero reale" da
        # "non siamo riusciti a scaricarlo". Letto da fetch_all_data -> _meta.
        self.incomplete_lists = []
        self.timed_out_reports = []
        self.skipped_reports = []
        self.failed_reports = []
        self.clamped_days = None
        self.report_windows = []

    def authenticate(self):
        print("🔐 Autenticazione in corso...")
        resp = requests.post(TOKEN_URL, data={
            "grant_type": "refresh_token",
            "client_id": self.config["client_id"],
            "client_secret": self.config["client_secret"],
            "refresh_token": self.config["refresh_token"],
        })
        if resp.status_code != 200:
            raise Exception(f"Auth fallita ({resp.status_code}): {resp.text}")
        self.access_token = resp.json()["access_token"]
        print("✅ Autenticazione riuscita")

    def _base_headers(self):
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Amazon-Advertising-API-ClientId": self.config["client_id"],
            "Amazon-Advertising-API-Scope": str(self.profile_id),
        }

    def _get(self, path, accept="application/json"):
        headers = self._base_headers()
        headers["Accept"] = accept
        resp = requests.get(f"{self.base_url}{path}", headers=headers)
        resp.raise_for_status()
        return resp.json()

    def _post(self, path, payload=None, content_type="application/json", accept="application/json"):
        headers = self._base_headers()
        headers["Content-Type"] = content_type
        headers["Accept"] = accept
        resp = requests.post(f"{self.base_url}{path}", headers=headers, json=payload)
        if resp.status_code >= 400:
            print(f"      HTTP {resp.status_code}: {resp.text[:500]}")
        resp.raise_for_status()
        return resp.json()

    # --- Profiles ---
    def list_profiles(self):
        print("📋 Recupero profili advertising...")
        profiles = self._get("/v2/profiles")
        for p in profiles:
            market = p.get("countryCode", "??")
            pid = p["profileId"]
            ptype = p.get("accountInfo", {}).get("type", "")
            mid = p.get("accountInfo", {}).get("marketplaceStringId", "")
            print(f"   {market} | Profile ID: {pid} | Type: {ptype} | {mid}")
        return profiles

    def select_profile(self, marketplace=None):
        profiles = self.list_profiles()
        if self.profile_id:
            print(f"✅ Usando profile_id configurato: {self.profile_id}")
            return
        if marketplace:
            match = [p for p in profiles if p.get("countryCode", "").upper() == marketplace.upper()]
            if match:
                self.profile_id = match[0]["profileId"]
                print(f"✅ Selezionato profilo {marketplace}: {self.profile_id}")
                return
            # FAIL LOUDLY: nessun fallback silenzioso su un profilo di altro paese
            available = ", ".join(sorted({p.get("countryCode", "??") for p in profiles})) or "nessuno"
            raise Exception(
                f"Nessun profilo advertising per marketplace '{marketplace}'. "
                f"Profili disponibili: {available}. "
                f"Verifica che il refresh token sia stato autorizzato con l'account che possiede il profilo Ads {marketplace}."
            )
        # Solo se NON e' stato richiesto un marketplace specifico, si sceglie di default
        sellers = [p for p in profiles if p.get("accountInfo", {}).get("type") == "seller"]
        if sellers:
            self.profile_id = sellers[0]["profileId"]
            cc = sellers[0].get("countryCode", "??")
            print(f"✅ Auto-selezionato profilo seller ({cc}): {self.profile_id}")
        elif profiles:
            self.profile_id = profiles[0]["profileId"]
            print(f"✅ Auto-selezionato primo profilo: {self.profile_id}")
        else:
            raise Exception("Nessun profilo advertising trovato")

    # --- SP v3 endpoints ---
    def _list_all(self, path, vnd, result_key, label, campaign_ids=None, extra_filter=None):
        """Lista COMPLETA di una risorsa v3: pagina con nextToken e spezza il
        filtro campagne in blocchi da 100 ID.

        Prima questa parte non paginava: con piu' di 100 keyword (o ad group,
        negative, target) i dati venivano troncati silenziosamente e l'analisi
        girava su un sottoinsieme dell'account, senza alcun avviso.
        """
        ids = [str(c) for c in (campaign_ids or []) if c]
        chunks = [ids[i:i + 100] for i in range(0, len(ids), 100)] or [None]

        items = []
        truncated = False
        for chunk in chunks:
            next_token = None
            pages = 0
            while True:
                payload = {"maxResults": 100}
                if chunk:
                    payload["campaignIdFilter"] = {"include": chunk}
                if extra_filter:
                    payload.update(extra_filter)
                if next_token:
                    payload["nextToken"] = next_token
                try:
                    resp = self._post(path, payload, content_type=vnd, accept=vnd)
                except Exception as e:
                    print(f"   ⚠️ Errore {label}: {e}")
                    truncated = True
                    break
                items.extend(resp.get(result_key, []))
                next_token = resp.get("nextToken")
                pages += 1
                if not next_token:
                    break
                if pages >= 100:  # paracadute anti-loop
                    print(f"   ⚠️ {label}: interrotto dopo 100 pagine")
                    truncated = True
                    break
        print(f"   ... {len(items)} {label} trovati{' (INCOMPLETI)' if truncated else ''}")
        if truncated:
            self.incomplete_lists.append(label)
        return items

    def get_campaigns(self):
        print("📁 Recupero campagne SP...")
        return self._list_all("/sp/campaigns/list", "application/vnd.spCampaign.v3+json",
                              "campaigns", "campagne")

    def get_ad_groups(self, campaign_ids=None):
        print("📂 Recupero ad groups...")
        return self._list_all("/sp/adGroups/list", "application/vnd.spAdGroup.v3+json",
                              "adGroups", "ad groups", campaign_ids)

    def get_keywords(self, campaign_ids=None):
        print("🔑 Recupero keywords...")
        return self._list_all("/sp/keywords/list", "application/vnd.spKeyword.v3+json",
                              "keywords", "keywords", campaign_ids)

    def get_negative_keywords(self, campaign_ids=None):
        print("🚫 Recupero negative keywords...")
        return self._list_all("/sp/negativeKeywords/list", "application/vnd.spNegativeKeyword.v3+json",
                              "negativeKeywords", "negative keywords", campaign_ids)

    def get_targets(self, campaign_ids=None):
        print("🎯 Recupero targets...")
        return self._list_all("/sp/targets/list", "application/vnd.spTargetingClause.v3+json",
                              "targetingClauses", "targets", campaign_ids)

    # --- Reporting v3 ---
    def request_report(self, report_type, days=14, start_date=None, end_date=None):
        """Richiede un report. O si passano date esplicite, o un numero di giorni.

        Con `days` la finestra viene limitata a MAX_REPORT_DAYS, perche' l'API
        rifiuta gli intervalli piu' lunghi. Per coprire periodi maggiori si usa
        fetch_reports(), che spezza il periodo in finestre e le unisce.
        """
        if start_date is None or end_date is None:
            # L'API v3 non ha dati consolidati per "oggi": usare endDate = ieri.
            # Richiedere la data odierna e' una causa frequente di report che
            # restano bloccati in PENDING o tornano vuoti.
            if days > MAX_REPORT_DAYS:
                print(f"   ⚠️ {days} giorni richiesti, ma una singola richiesta ne accetta al massimo "
                      f"{MAX_REPORT_DAYS}: uso {MAX_REPORT_DAYS} giorni.", flush=True)
                self.clamped_days = days
                days = MAX_REPORT_DAYS
            end_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
            start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")

        columns_map = {
            "spCampaigns": [
                "campaignName", "campaignId", "campaignStatus", "campaignBudgetAmount",
                "impressions", "clicks", "spend", "purchases7d",
                "sales7d", "unitsSoldClicks7d", "costPerClick",
            ],
            "spKeywords": [
                "keywordId", "keyword", "matchType",
                "impressions", "clicks", "cost", "purchases7d", "sales7d",
                "unitsSoldClicks7d", "adGroupName", "adGroupId",
                "campaignId",
            ],
            "spSearchTerm": [
                "searchTerm", "keyword", "matchType",
                "campaignId", "adGroupName", "adGroupId",
                "impressions", "clicks", "spend", "purchases7d", "sales7d",
                "unitsSoldClicks7d", "costPerClick",
            ],
            "spTargeting": [
                "keyword", "matchType",
                "campaignId", "adGroupName", "adGroupId",
                "impressions", "clicks", "cost", "purchases7d", "sales7d",
                "unitsSoldClicks7d", "costPerClick",
            ],
            "spAdvertisedProduct": [
                "advertisedAsin", "advertisedSku",
                "campaignId", "adGroupName", "adGroupId",
                "impressions", "clicks", "cost",
                "purchases7d", "sales7d", "unitsSoldClicks7d",
            ],
        }

        group_map = {
            "spCampaigns": ["campaign"],
            "spKeywords": ["adGroup"],
            "spSearchTerm": ["searchTerm"],
            "spTargeting": ["targeting"],
            "spAdvertisedProduct": ["advertiser"],
        }

        payload = {
            "startDate": start_date,
            "endDate": end_date,
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": group_map.get(report_type, ["campaign"]),
                "columns": columns_map.get(report_type, []),
                "reportTypeId": report_type,
                "timeUnit": "SUMMARY",
                "format": "GZIP_JSON",
            },
        }

        print(f"📊 Richiesta report {report_type} ({start_date} → {end_date})...")
        headers = self._base_headers()
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "application/vnd.createAsync.v3+json"
        try:
            resp = requests.post(
                f"{self.base_url}/reporting/reports",
                headers=headers,
                json=payload,
                timeout=30,
            )
            # 425 = richiesta identica gia' in coda (report generato di recente,
            # non ancora scaduto). Non e' un errore: Amazon evita i duplicati.
            if resp.status_code == 425:
                # ATTENZIONE: saltare qui significa metriche a ZERO per questo
                # report. Va segnalato, altrimenti l'analisi legge "nessuna
                # spesa" dove in realta' mancano i dati.
                print(f"   ⏭️  {report_type}: report identico gia' in elaborazione (425), lo salto.")
                self.skipped_reports.append(report_type)
                return None
            if resp.status_code >= 400:
                # Qualsiasi errore qui significa ZERO righe per questo report.
                # Va registrato: altrimenti l'export sembra completo e "spesa 0"
                # viene letto come "nessuna attivita'".
                print(f"   ⚠️ {report_type} HTTP {resp.status_code}: {resp.text[:300]}")
                self.failed_reports.append(f"{report_type} (HTTP {resp.status_code})")
                return None
            report_id = resp.json().get("reportId")
            print(f"   Report ID: {report_id}")
            return report_id
        except Exception as e:
            print(f"   ⚠️ Errore richiesta report {report_type}: {e}")
            self.failed_reports.append(f"{report_type} ({e})")
            return None

    def _check_report(self, report_id):
        """Controlla lo stato di un singolo report (una sola chiamata, no attesa).

        Ritorna una tupla (status, url):
          - ("COMPLETED", url)  -> pronto, scaricabile
          - ("FAILURE", None)   -> fallito
          - ("PENDING"/"PROCESSING", None) -> ancora in lavorazione
          - ("ERROR", None)     -> errore di rete/HTTP su questa chiamata
        """
        try:
            headers = self._base_headers()
            headers["Accept"] = "application/vnd.createAsync.v3+json"
            resp = requests.get(
                f"{self.base_url}/reporting/reports/{report_id}",
                headers=headers,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status", "")
            if status == "COMPLETED":
                return "COMPLETED", data.get("url")
            if status == "FAILURE":
                print(f"   ❌ Report {report_id} fallito: {data.get('failureReason', 'sconosciuto')}", flush=True)
                return "FAILURE", None
            return status or "PENDING", None
        except Exception as e:
            print(f"   ⚠️ Errore polling {report_id}: {e}", flush=True)
            return "ERROR", None

    def poll_reports(self, report_map, max_wait=600, interval=15):
        """Attende IN PARALLELO piu' report richiesti in precedenza.

        report_map: dict {report_type: report_id} gia' creati con request_report.
        Ritorna:    dict {report_type: [righe]}  (lista vuota se timeout/fallito).

        A differenza del vecchio polling sequenziale (che aspettava fino a
        max_wait secondi PER OGNI report, sommando i tempi), qui tutti i report
        vengono richiesti prima e poi interrogati insieme: il tempo totale e'
        circa quello del report piu' lento, non la somma di tutti.
        """
        pending = {rt: rid for rt, rid in report_map.items() if rid}
        results = {rt: [] for rt in report_map}  # default vuoto anche per i falliti
        if not pending:
            return results

        print(f"⏳ Attesa in parallelo di {len(pending)} report (max {max_wait}s)...", flush=True)
        start = time.time()
        while pending and (time.time() - start) < max_wait:
            elapsed = int(time.time() - start)
            done_now = []
            for rt, rid in list(pending.items()):
                status, url = self._check_report(rid)
                if status == "COMPLETED":
                    print(f"   ✅ {rt} completato ({elapsed}s)", flush=True)
                    results[rt] = self._download_report(url) if url else []
                    done_now.append(rt)
                elif status == "FAILURE":
                    results[rt] = []
                    done_now.append(rt)
                # PENDING/PROCESSING/ERROR -> resta in coda per il giro dopo
            for rt in done_now:
                pending.pop(rt, None)
            if pending:
                still = ", ".join(pending.keys())
                print(f"   ... in attesa ({elapsed}s): {still}", flush=True)
                time.sleep(interval)

        if pending:
            print(f"   ⏰ Timeout: report ancora in PENDING dopo {max_wait}s: {', '.join(pending.keys())}", flush=True)
        # Traccia i report NON arrivati: distingue 'zero reale' da 'timeout'.
        # extend, non assegnazione: con piu' finestre i timeout si accumulano
        for rt in pending:
            if rt not in self.timed_out_reports:
                self.timed_out_reports.append(rt)
        return results

    def fetch_reports(self, report_types, days=14, max_wait=600):
        """Scarica i report coprendo `days` giorni, anche oltre il limite dell'API.

        Una singola richiesta accetta al massimo MAX_REPORT_DAYS giorni. Per
        periodi piu' lunghi il periodo viene spezzato in finestre adiacenti,
        scaricate una dopo l'altra e poi UNITE sommando le metriche.

        L'unione e' necessaria, non cosmetica: i report SUMMARY restituiscono
        una riga per entita' PER FINESTRA, quindi concatenarle darebbe la stessa
        keyword ripetuta N volte, e a valle verrebbe contata N volte.

        Nota sull'attribuzione: le conversioni sono attribuite alla data del
        CLICK, quindi sommare finestre adiacenti e' corretto. Restano poco
        attribuiti gli ultimi giorni della finestra piu' recente, dove la
        finestra di attribuzione a 7 giorni non si e' ancora chiusa: e' lo
        stesso limite che avrebbe una singola richiesta.
        """
        windows = _date_windows(days)
        self.report_windows = [list(w) for w in windows]

        if len(windows) > 1:
            print(f"📆 {days} giorni richiesti: il periodo supera il limite di {MAX_REPORT_DAYS} "
                  f"giorni per richiesta, lo divido in {len(windows)} finestre.", flush=True)
            for s, e in windows:
                print(f"     {s} → {e}", flush=True)

        merged = {rt: [] for rt in report_types}
        for i, (start, end) in enumerate(windows, 1):
            if len(windows) > 1:
                print(f"\n--- Finestra {i}/{len(windows)}: {start} → {end} ---", flush=True)
            report_map = {rt: self.request_report(rt, start_date=start, end_date=end)
                          for rt in report_types}
            results = self.poll_reports(report_map, max_wait=max_wait)
            for rt, rows in results.items():
                merged[rt] = _merge_report_rows(merged[rt], rows, rt)

        if len(windows) > 1:
            print("\n📊 Righe dopo l'unione delle finestre:", flush=True)
            for rt, rows in merged.items():
                print(f"     {rt}: {len(rows)}", flush=True)
        return merged

    def poll_report(self, report_id, max_wait=600, interval=15):
        """Compatibilita': attende un singolo report riusando il polling batch."""
        res = self.poll_reports({"_single": report_id}, max_wait=max_wait, interval=interval)
        return res.get("_single", [])

    def _download_report(self, url):
        import gzip
        print("   📥 Download report...")
        resp = requests.get(url, stream=True)
        resp.raise_for_status()
        try:
            decompressed = gzip.decompress(resp.content)
            data = json.loads(decompressed)
            rows = data if isinstance(data, list) else data.get("rows", data.get("records", [data]))
            print(f"   📄 {len(rows)} righe scaricate")
            return rows
        except Exception:
            try:
                data = resp.json()
                return data if isinstance(data, list) else [data]
            except Exception:
                print("   ⚠️ Formato report non riconosciuto")
                return []

    def fetch_report(self, report_type, days=14):
        report_id = self.request_report(report_type, days)
        if not report_id:
            return []
        return self.poll_report(report_id)


def fetch_all_data(marketplace=None, days=14):
    api = AmazonAdsAPI(CONFIG)
    api.authenticate()
    api.select_profile(marketplace)

    campaigns = api.get_campaigns()
    campaign_ids = [str(c.get("campaignId", "")) for c in campaigns if c.get("campaignId")]

    # Nessun taglio a 50 campagne: _list_all spezza da solo il filtro in
    # blocchi da 100 ID e pagina i risultati.
    ad_groups = api.get_ad_groups(campaign_ids)
    keywords = api.get_keywords(campaign_ids)
    neg_keywords = api.get_negative_keywords(campaign_ids)
    targets = api.get_targets(campaign_ids)

    print("\n" + "=" * 50)
    print(f"📊 REPORT PERFORMANCE (ultimi {days} giorni)")
    print("=" * 50)

    # Richiede tutti i report in blocco e li attende IN PARALLELO.
    # Il tempo totale ~= report piu' lento, non la somma dei 5.
    report_types = ["spCampaigns", "spKeywords", "spSearchTerm", "spTargeting", "spAdvertisedProduct"]
    reports = api.fetch_reports(report_types, days, max_wait=int(os.getenv("REPORT_MAX_WAIT", "1800")))
    timed_out = getattr(api, "timed_out_reports", [])
    skipped = getattr(api, "skipped_reports", [])
    failed = getattr(api, "failed_reports", [])
    incomplete_lists = getattr(api, "incomplete_lists", [])
    if timed_out or skipped or failed or incomplete_lists:
        print("    ATTENZIONE — dati INCOMPLETI, le metriche a zero non significano assenza di attivita':", flush=True)
        if timed_out:
            print("      - report in timeout: " + ", ".join(timed_out), flush=True)
        if skipped:
            print("      - report saltati (425, richiesta identica gia' in coda): " + ", ".join(skipped), flush=True)
        if failed:
            print("      - report RIFIUTATI da Amazon: " + ", ".join(failed), flush=True)
        if incomplete_lists:
            print("      - liste troncate da errori API: " + ", ".join(sorted(set(incomplete_lists))), flush=True)
    campaign_report = reports.get("spCampaigns", [])
    keyword_report = reports.get("spKeywords", [])
    search_term_report = reports.get("spSearchTerm", [])
    targeting_report = reports.get("spTargeting", [])
    product_report = reports.get("spAdvertisedProduct", [])

    output = {
        "_meta": {
            "fetched_at": datetime.now().isoformat(),
            "profile_id": str(api.profile_id),
            "marketplace": marketplace or "auto",
            "days": days,
            "region": CONFIG["region"],
            "reports_incomplete": bool(timed_out or skipped or failed or incomplete_lists),
            "reports_timed_out": timed_out,
            "reports_skipped_425": skipped,
            "reports_failed": failed,
            "incomplete_lists": sorted(set(incomplete_lists)),
            "days_requested": days,
            "report_windows": getattr(api, "report_windows", []),
        },
        "campaigns": [
            {
                "campaignId": str(c.get("campaignId", "")),
                "name": c.get("name", ""),
                "state": c.get("state", ""),
                "budget": c.get("budget", {}).get("budget", 0) if isinstance(c.get("budget"), dict) else c.get("budget", 0),
                "budgetType": c.get("budget", {}).get("budgetType", "") if isinstance(c.get("budget"), dict) else "",
                "targetingType": c.get("targetingType", ""),
                "startDate": c.get("startDate", ""),
                "endDate": c.get("endDate", ""),
                "bidding": c.get("bidding", {}),
            }
            for c in campaigns
        ],
        "adGroups": [
            {
                "adGroupId": str(g.get("adGroupId", "")),
                "campaignId": str(g.get("campaignId", "")),
                "name": g.get("name", ""),
                "state": g.get("state", ""),
                "defaultBid": g.get("defaultBid", 0),
            }
            for g in ad_groups
        ],
        "keywords": [
            {
                "keywordId": str(k.get("keywordId", "")),
                "campaignId": str(k.get("campaignId", "")),
                "adGroupId": str(k.get("adGroupId", "")),
                "keywordText": k.get("keywordText", ""),
                "matchType": k.get("matchType", ""),
                "state": k.get("state", ""),
                "bid": k.get("bid", 0),
            }
            for k in keywords
        ],
        "negativeKeywords": [
            {
                "keywordText": nk.get("keywordText", ""),
                "matchType": nk.get("matchType", ""),
                "campaignId": str(nk.get("campaignId", "")),
                "state": nk.get("state", ""),
            }
            for nk in neg_keywords
        ],
        "targets": [
            {
                "targetId": str(t.get("targetId", "")),
                "campaignId": str(t.get("campaignId", "")),
                "expression": t.get("expression", []),
                "expressionType": t.get("expressionType", ""),
                "state": t.get("state", ""),
                "bid": t.get("bid", 0),
            }
            for t in targets
        ],
        "reports": {
            "campaigns": campaign_report,
            "keywords": keyword_report,
            "searchTerms": search_term_report,
            "targeting": targeting_report,
            "products": product_report,
        },
    }

    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    mp = marketplace or "all"
    filename = f"amazon_ads_{mp}_{timestamp}.json"
    Path(filename).write_text(json.dumps(output, indent=2, ensure_ascii=False, default=str))

    print("\n" + "=" * 50)
    print(f"✅ EXPORT COMPLETATO: {filename}")
    print(f"   Campagne: {len(campaigns)}")
    print(f"   Ad Groups: {len(ad_groups)}")
    print(f"   Keywords: {len(keywords)}")
    print(f"   Negative KW: {len(neg_keywords)}")
    print(f"   Targets: {len(targets)}")
    print(f"   Report Keyword: {len(keyword_report)} righe")
    print(f"   Report Search Term: {len(search_term_report)} righe")
    print("=" * 50)
    print(f"\n📂 Carica '{filename}' nell'Amazon Ads Agent per l'analisi AI.")
    return output


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Amazon Advertising API Fetcher")
    parser.add_argument("--days", type=int, default=14, help="Giorni da analizzare (default: 14)")
    parser.add_argument("--marketplace", type=str, default=None, help="Marketplace: IT, DE, FR, ES, UK")
    parser.add_argument("--list-profiles", action="store_true", help="Lista profili ed esci")
    args = parser.parse_args()

    if args.list_profiles:
        api = AmazonAdsAPI(CONFIG)
        api.authenticate()
        api.list_profiles()
    else:
        fetch_all_data(marketplace=args.marketplace, days=args.days)
