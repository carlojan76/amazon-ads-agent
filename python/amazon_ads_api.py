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


class AmazonAdsAPI:
    def __init__(self, config):
        self.config = config
        self.base_url = ENDPOINTS[config["region"]]
        self.access_token = None
        self.profile_id = config.get("profile_id", "")

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
    def get_campaigns(self):
        print("📁 Recupero campagne SP...")
        vnd = "application/vnd.spCampaign.v3+json"
        campaigns = []
        next_token = None
        while True:
            payload = {"maxResults": 100}
            if next_token:
                payload["nextToken"] = next_token
            try:
                resp = self._post("/sp/campaigns/list", payload, content_type=vnd, accept=vnd)
                batch = resp.get("campaigns", [])
                campaigns.extend(batch)
                next_token = resp.get("nextToken")
                print(f"   ... {len(campaigns)} campagne trovate")
                if not next_token:
                    break
            except Exception as e:
                print(f"   ⚠️ Errore: {e}")
                break
        return campaigns

    def get_ad_groups(self, campaign_ids=None):
        print("📂 Recupero ad groups...")
        vnd = "application/vnd.spAdGroup.v3+json"
        payload = {"maxResults": 100}
        if campaign_ids:
            payload["campaignIdFilter"] = {"include": campaign_ids[:100]}
        try:
            resp = self._post("/sp/adGroups/list", payload, content_type=vnd, accept=vnd)
            groups = resp.get("adGroups", [])
            print(f"   ... {len(groups)} ad groups trovati")
            return groups
        except Exception as e:
            print(f"   ⚠️ Errore: {e}")
            return []

    def get_keywords(self, campaign_ids=None):
        print("🔑 Recupero keywords...")
        vnd = "application/vnd.spKeyword.v3+json"
        payload = {"maxResults": 100}
        if campaign_ids:
            payload["campaignIdFilter"] = {"include": campaign_ids[:100]}
        try:
            resp = self._post("/sp/keywords/list", payload, content_type=vnd, accept=vnd)
            keywords = resp.get("keywords", [])
            print(f"   ... {len(keywords)} keywords trovate")
            return keywords
        except Exception as e:
            print(f"   ⚠️ Errore: {e}")
            return []

    def get_negative_keywords(self, campaign_ids=None):
        print("🚫 Recupero negative keywords...")
        vnd = "application/vnd.spNegativeKeyword.v3+json"
        payload = {"maxResults": 100}
        if campaign_ids:
            payload["campaignIdFilter"] = {"include": campaign_ids[:100]}
        try:
            resp = self._post("/sp/negativeKeywords/list", payload, content_type=vnd, accept=vnd)
            neg_kws = resp.get("negativeKeywords", [])
            print(f"   ... {len(neg_kws)} negative keywords trovate")
            return neg_kws
        except Exception as e:
            print(f"   ⚠️ Errore: {e}")
            return []

    def get_targets(self, campaign_ids=None):
        print("🎯 Recupero targets...")
        vnd = "application/vnd.spTargetingClause.v3+json"
        payload = {"maxResults": 100}
        if campaign_ids:
            payload["campaignIdFilter"] = {"include": campaign_ids[:100]}
        try:
            resp = self._post("/sp/targets/list", payload, content_type=vnd, accept=vnd)
            targets = resp.get("targetingClauses", [])
            print(f"   ... {len(targets)} targets trovati")
            return targets
        except Exception as e:
            print(f"   ⚠️ Errore: {e}")
            return []

    # --- Reporting v3 ---
    def request_report(self, report_type, days=14):
        # L'API v3 non ha dati consolidati per "oggi": usare endDate = ieri.
        # Richiedere la data odierna e' una causa frequente di report che
        # restano bloccati in PENDING o tornano vuoti.
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
                print(f"   ⏭️  {report_type}: report identico gia' in elaborazione (425), lo salto.")
                return None
            if resp.status_code >= 400:
                print(f"   ⚠️ {report_type} HTTP {resp.status_code}: {resp.text[:300]}")
                return None
            report_id = resp.json().get("reportId")
            print(f"   Report ID: {report_id}")
            return report_id
        except Exception as e:
            print(f"   ⚠️ Errore richiesta report {report_type}: {e}")
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
        self.timed_out_reports = list(pending.keys())
        return results

    def fetch_reports(self, report_types, days=14, max_wait=600):
        """Richiede TUTTI i report in blocco, poi li attende in parallelo.

        report_types: lista di tipi (es. ['spCampaigns', 'spKeywords', ...]).
        Ritorna:      dict {report_type: [righe]}.
        """
        report_map = {}
        for rt in report_types:
            report_map[rt] = self.request_report(rt, days)
        return self.poll_reports(report_map, max_wait=max_wait)

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

    ad_groups = api.get_ad_groups(campaign_ids[:50])
    keywords = api.get_keywords(campaign_ids[:50])
    neg_keywords = api.get_negative_keywords(campaign_ids[:50])
    targets = api.get_targets(campaign_ids[:50])

    print("\n" + "=" * 50)
    print(f"📊 REPORT PERFORMANCE (ultimi {days} giorni)")
    print("=" * 50)

    # Richiede tutti i report in blocco e li attende IN PARALLELO.
    # Il tempo totale ~= report piu' lento, non la somma dei 5.
    report_types = ["spCampaigns", "spKeywords", "spSearchTerm", "spTargeting", "spAdvertisedProduct"]
    reports = api.fetch_reports(report_types, days, max_wait=int(os.getenv("REPORT_MAX_WAIT", "1800")))
    timed_out = getattr(api, "timed_out_reports", [])
    if timed_out:
        print("    ATTENZIONE: report incompleti per timeout: " + ", ".join(timed_out) +
              " -> metriche a zero NON per reale assenza di attivita.", flush=True)
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
            "reports_incomplete": bool(timed_out),
            "reports_timed_out": timed_out,
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
