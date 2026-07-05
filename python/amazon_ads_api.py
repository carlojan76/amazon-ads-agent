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

TOKEN_URL = "https://api.amazon.co.uk/auth/o2/token"


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
        end_date = datetime.now().strftime("%Y-%m-%d")
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
        try:
            resp = self._post(
                "/reporting/reports",
                payload,
                content_type="application/json",
                accept="application/vnd.createAsync.v3+json",
            )
            report_id = resp.get("reportId")
            print(f"   Report ID: {report_id}")
            return report_id
        except Exception as e:
            print(f"   ⚠️ Errore richiesta report: {e}")
            return None

    def poll_report(self, report_id, max_wait=180):
        print(f"⏳ Attesa completamento report {report_id}...", flush=True)
        start = time.time()
        while time.time() - start < max_wait:
            try:
                headers = self._base_headers()
                headers["Accept"] = "application/vnd.createAsync.v3+json"
                resp = requests.get(
                    f"{self.base_url}/reporting/reports/{report_id}",
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                status = data.get("status", "")
                if status == "COMPLETED":
                    url = data.get("url")
                    print("   ✅ Report completato!", flush=True)
                    if url:
                        return self._download_report(url)
                    return []
                elif status == "FAILURE":
                    print(f"   ❌ Report fallito: {data.get('failureReason', 'sconosciuto')}")
                    return []
                else:
                    elapsed = int(time.time() - start)
                    print(f"   ... stato: {status} ({elapsed}s)", flush=True)
                    time.sleep(10)
            except Exception as e:
                print(f"   ⚠️ Errore polling: {e}", flush=True)
                time.sleep(10)
        print("   ⏰ Timeout attesa report", flush=True)
        return []

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

    campaign_report = api.fetch_report("spCampaigns", days)
    keyword_report = api.fetch_report("spKeywords", days)
    search_term_report = api.fetch_report("spSearchTerm", days)
    targeting_report = api.fetch_report("spTargeting", days)
    product_report = api.fetch_report("spAdvertisedProduct", days)

    output = {
        "_meta": {
            "fetched_at": datetime.now().isoformat(),
            "profile_id": str(api.profile_id),
            "marketplace": marketplace or "auto",
            "days": days,
            "region": CONFIG["region"],
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
