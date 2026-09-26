"""Test dei limiti di sicurezza di apply_changes.py.

    cd python && python -m unittest discover tests -v
    # oppure
    cd python && python tests/test_guardrails.py

I 29 smoke test JS coprono parse.js e actions.js, cioe' il codice che
DISEGNA le proposte. Questi coprono il codice che le APPLICA: e' l'unico
punto del progetto che puo' spostare soldi veri su un account Amazon, ed
era quello senza rete.

Nessuna dipendenza esterna, nessuna chiamata di rete: tutto gira su fixture.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# agent_api legge l'ambiente all'import: lo neutralizziamo, cosi' i test non
# toccano mai un Worker vero nemmeno per sbaglio.
os.environ.pop("AGENT_API_BASE", None)
os.environ.pop("AGENT_API_TOKEN", None)

import agent_api  # noqa: E402
from apply_changes import (  # noqa: E402
    GUARDRAILS, check_guardrails, check_bid_caps, check_budget_coherence,
    normalize_actions, validate,
)


def bid(**kw):
    a = {"type": "update_bid", "keywordId": "1", "keyword": "kw", "old_bid": 0.50, "new_bid": 0.55}
    a.update(kw)
    return a


def budget(**kw):
    a = {"type": "update_budget", "campaignId": "9", "campaign": "C", "old_budget": 10.0, "new_budget": 12.0}
    a.update(kw)
    return a


class TestGuardrails(unittest.TestCase):
    """Limiti assoluti: proteggono dall'errore di battitura."""

    def test_bid_dentro_i_limiti_passa(self):
        self.assertEqual(check_guardrails([bid()]), [])

    def test_bid_sopra_il_massimo_assoluto(self):
        # 45.00 invece di 0.45: il caso che i guardrail esistono per fermare.
        v = check_guardrails([bid(new_bid=45.00)])
        self.assertTrue(v, "un bid da 45 EUR deve essere bloccato")
        self.assertIn("fuori dall'intervallo", v[0])

    def test_bid_sotto_il_minimo(self):
        self.assertTrue(check_guardrails([bid(new_bid=0.001)]))

    def test_variazione_oltre_il_50_percento(self):
        v = check_guardrails([bid(old_bid=0.50, new_bid=1.00)])
        self.assertTrue(v)
        self.assertIn("100%", v[0])

    def test_variazione_esattamente_al_limite_passa(self):
        self.assertEqual(check_guardrails([bid(old_bid=1.00, new_bid=1.50)]), [])

    def test_budget_fuori_intervallo(self):
        self.assertTrue(check_guardrails([budget(new_budget=500.0)]))
        self.assertTrue(check_guardrails([budget(new_budget=0.50)]))

    def test_troppe_azioni_in_un_run(self):
        troppe = [bid(keywordId=str(i)) for i in range(GUARDRAILS["max_actions"] + 1)]
        v = check_guardrails(troppe)
        self.assertTrue(any("azioni in un solo run" in x for x in v))

    def test_somma_budget_campagne_nuove(self):
        """Quattro campagne da 90 EUR passano una per una, non insieme."""
        quattro = [
            {"type": "create_campaign", "campaign": {"dailyBudget": 90.0}, "adGroups": []}
            for _ in range(4)
        ]
        v = check_guardrails(quattro)
        self.assertTrue(any("sommano" in x for x in v),
                        "il totale dei budget delle campagne nuove deve essere controllato")

    def test_bid_dentro_create_campaign(self):
        """Il blueprint e' editabile a mano: stessi limiti, altra strada."""
        a = {
            "type": "create_campaign",
            "campaign": {"dailyBudget": 10.0},
            "adGroups": [{
                "name": "G", "defaultBid": 0.40,
                "keywords": [{"keywordText": "x", "bid": 45.00}],
                "autoTargets": [],
            }],
        }
        v = check_guardrails([a])
        self.assertTrue(any("45.00" in x for x in v))


class TestBidCaps(unittest.TestCase):
    """Tetti economici: proteggono dalla marginalita', non dal refuso."""

    CAPS = {"market": 0.45, "campaigns": {"77": 0.30}}

    def test_nessun_tetto_nessuna_violazione(self):
        self.assertEqual(check_bid_caps([bid(new_bid=4.00)], None), [])
        self.assertEqual(check_bid_caps([bid(new_bid=4.00)], {"market": None, "campaigns": {}}), [])

    def test_bid_sotto_il_tetto_passa(self):
        self.assertEqual(check_bid_caps([bid(new_bid=0.40, campaignId="9")], self.CAPS), [])

    def test_bid_sopra_il_tetto_di_mercato(self):
        v = check_bid_caps([bid(new_bid=0.80, campaignId="9")], self.CAPS)
        self.assertTrue(v)
        self.assertIn("0.45", v[0])

    def test_tetto_di_campagna_prevale(self):
        # 0.40 e' sotto il tetto di mercato (0.45) ma sopra quello della
        # campagna 77 (0.30): deve essere bloccato.
        v = check_bid_caps([bid(new_bid=0.40, campaignId="77")], self.CAPS)
        self.assertTrue(v, "il tetto della campagna deve prevalere su quello di mercato")
        self.assertIn("0.30", v[0])

    def test_esattamente_al_tetto_passa(self):
        self.assertEqual(check_bid_caps([bid(new_bid=0.45, campaignId="9")], self.CAPS), [])
        self.assertEqual(check_bid_caps([bid(new_bid=0.30, campaignId="77")], self.CAPS), [])

    def test_add_keyword_usa_il_campo_bid(self):
        a = {"type": "add_keyword", "campaignId": "77", "adGroupId": "5",
             "keywordText": "x", "matchType": "EXACT", "bid": 0.50}
        self.assertTrue(check_bid_caps([a], self.CAPS))

    def test_create_campaign_usa_il_tetto_di_mercato(self):
        """Una campagna nuova non ha ancora un campaignId: vale il mercato."""
        a = {
            "type": "create_campaign",
            "campaign": {"dailyBudget": 10.0},
            "adGroups": [{
                "name": "G", "defaultBid": 0.90,
                "keywords": [{"keywordText": "x", "bid": 0.20}],
                "autoTargets": [{"expressionType": "QUERY_HIGH_REL_MATCHES", "bid": 1.10}],
            }],
        }
        v = check_bid_caps([a], self.CAPS)
        self.assertEqual(len(v), 2, f"attese 2 violazioni (defaultBid e autoTarget), trovate: {v}")

    def test_tetto_non_si_aggira_con_allow_large_changes(self):
        """check_bid_caps non guarda i flag: e' voluto.

        --allow-large-changes allenta i guardrail assoluti, che sono una
        protezione dal refuso. I tetti nascono dal margine del prodotto: non
        esiste una circostanza in cui superarli "consapevolmente" va bene.
        """
        self.assertTrue(check_bid_caps([bid(new_bid=2.00)], self.CAPS))


class TestCapResolution(unittest.TestCase):
    def test_cap_for(self):
        caps = {"market": 0.50, "campaigns": {"1": 0.20}}
        self.assertEqual(agent_api.cap_for(caps, "1"), 0.20)
        self.assertEqual(agent_api.cap_for(caps, "2"), 0.50)
        self.assertEqual(agent_api.cap_for(caps, None), 0.50)
        self.assertIsNone(agent_api.cap_for({"market": None, "campaigns": {}}, "1"))
        self.assertIsNone(agent_api.cap_for(None, "1"))

    def test_signature_stabile(self):
        """La firma deve combaciare con actionSignature() in src/actions.js."""
        a = {"type": "add_negative", "campaignId": "1", "adGroupId": "2",
             "keywordText": "  Gratis  ", "matchType": "NEGATIVE_EXACT"}
        self.assertEqual(agent_api.signature_of(a), "add_negative||1|2|gratis|NEGATIVE_EXACT")

    def test_api_disattivata_senza_base_url(self):
        self.assertFalse(agent_api.enabled())
        self.assertEqual(agent_api.applied_signatures("IT"), set())
        self.assertEqual(agent_api.bid_caps("IT"), {"market": None, "campaigns": {}})


class TestNormalizeAndValidate(unittest.TestCase):
    def test_validate_scarta_tipo_sconosciuto(self):
        self.assertTrue(validate([{"type": "lancia_missile"}]))

    def test_normalize_non_esplode_su_input_vuoto(self):
        self.assertEqual(normalize_actions([]), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestNegativeRidondanti(unittest.TestCase):
    """La coppia PHRASE+EXACT sullo stesso testo fa fallire il batch.

    Caso reale del 20/09: 'borsa da viaggio per cani' proposta sia in frase
    sia in esatta sullo stesso ad group. Amazon ha rifiutato la seconda con
    "Keyword is invalid" e l'intero invio di 7 negative e' risultato fallito,
    trascinando in rosso un run in cui 16 modifiche su 17 erano passate.
    """

    def _neg(self, testo, match, camp="1", ag="9"):
        return {"type": "add_negative", "campaignId": camp, "adGroupId": ag,
                "keywordText": testo, "matchType": match}

    def test_toglie_la_esatta_coperta_dalla_frase(self):
        azioni = [
            self._neg("borsa da viaggio per cani", "NEGATIVE_PHRASE"),
            self._neg("borsa da viaggio per cani", "NEGATIVE_EXACT"),
        ]
        fixes = normalize_actions(azioni)
        self.assertEqual(len(azioni), 1)
        self.assertEqual(azioni[0]["matchType"], "NEGATIVE_PHRASE")
        self.assertTrue(any("rimossa" in f for f in fixes))

    def test_il_confronto_ignora_maiuscole_e_spazi(self):
        azioni = [
            self._neg("borsa da viaggio", "NEGATIVE_PHRASE"),
            self._neg("  Borsa Da Viaggio  ", "NEGATIVE_EXACT"),
        ]
        normalize_actions(azioni)
        self.assertEqual(len(azioni), 1)

    def test_ad_group_diversi_restano_entrambe(self):
        azioni = [
            self._neg("x", "NEGATIVE_PHRASE", ag="A"),
            self._neg("x", "NEGATIVE_EXACT", ag="B"),
        ]
        normalize_actions(azioni)
        self.assertEqual(len(azioni), 2, "ambiti diversi: nessuna delle due e' ridondante")

    def test_campagne_diverse_restano_entrambe(self):
        azioni = [
            self._neg("x", "NEGATIVE_PHRASE", camp="1"),
            self._neg("x", "NEGATIVE_EXACT", camp="2"),
        ]
        normalize_actions(azioni)
        self.assertEqual(len(azioni), 2)

    def test_senza_frase_la_esatta_resta(self):
        azioni = [self._neg("x", "NEGATIVE_EXACT")]
        normalize_actions(azioni)
        self.assertEqual(len(azioni), 1)

    def test_testi_diversi_restano(self):
        azioni = [
            self._neg("borsa cane", "NEGATIVE_PHRASE"),
            self._neg("cuccia gatto", "NEGATIVE_EXACT"),
        ]
        normalize_actions(azioni)
        self.assertEqual(len(azioni), 2)


class TestCoerenzaBudget(unittest.TestCase):
    """Bid e budget devono stare in rapporto.

    Caso reale del 26/09: campagne 'squalo' con budget 3 EUR/giorno e bid a
    0,40 e 0,80. A quei bid la campagna compra quattro clic e poi tace fino a
    mezzanotte: non raccoglie dati, non e' presente nelle ore buone, e per
    rientrare dovrebbe convertire quasi al primo clic.
    """

    def _camp(self, budget, base, kw_bid=None, auto_bid=None):
        grp = {"name": "AG-exact", "defaultBid": base,
               "products": [{"asin": "B0X"}], "keywords": [], "autoTargets": []}
        if kw_bid is not None:
            grp["keywords"] = [{"keywordText": "cuccetta per gatti",
                                "matchType": "EXACT", "bid": kw_bid}]
        if auto_bid is not None:
            grp["autoTargets"] = [{"expressionType": "QUERY_HIGH_REL_MATCHES", "bid": auto_bid}]
        return {"type": "create_campaign",
                "campaign": {"name": "SP-Squalo", "dailyBudget": budget},
                "adGroups": [grp]}

    def test_il_caso_reale_viene_bloccato(self):
        v = check_budget_coherence([self._camp(3, 0.40, 0.80)], min_clicks=10)
        self.assertEqual(len(v), 2, f"bid base e keyword, trovate: {v}")
        self.assertTrue(any("0.30" in x for x in v), "deve dire qual e' il bid giusto")
        self.assertTrue(any("porta il budget" in x for x in v), "deve dire l'altra leva")

    def test_bid_coerenti_passano(self):
        self.assertEqual(check_budget_coherence([self._camp(3, 0.28, 0.30)], min_clicks=10), [])

    def test_al_tetto_esatto_passa(self):
        self.assertEqual(check_budget_coherence([self._camp(3, 0.30, 0.30)], min_clicks=10), [])

    def test_alzare_il_budget_sblocca(self):
        self.assertEqual(check_budget_coherence([self._camp(8, 0.40, 0.80)], min_clicks=10), [])

    def test_auto_target_controllati(self):
        v = check_budget_coherence([self._camp(3, 0.20, None, 0.75)], min_clicks=10)
        self.assertTrue(any("auto target" in x for x in v), v)

    def test_clic_minimi_configurabili(self):
        # Con 5 clic minimi, 3 EUR consentono 0,60: gli stessi bid passano.
        self.assertEqual(check_budget_coherence([self._camp(3, 0.40, 0.50)], min_clicks=5), [])
        self.assertTrue(check_budget_coherence([self._camp(3, 0.40, 0.50)], min_clicks=20))

    def test_azioni_su_campagne_esistenti(self):
        """Per update_bid serve il budget letto dall'account."""
        azioni = [{"type": "update_bid", "keywordId": "1", "campaignId": "77",
                   "keyword": "kw", "old_bid": 0.20, "new_bid": 0.50}]
        # Senza budget noto non si indovina: nessuna violazione.
        self.assertEqual(check_budget_coherence(azioni, min_clicks=10), [])
        # Con il budget, il vincolo scatta.
        v = check_budget_coherence(azioni, min_clicks=10, budgets={"77": 2.0})
        self.assertTrue(v, "2 EUR / 10 clic = 0,20: un bid da 0,50 e' incoerente")
        self.assertIn("0.20", v[0])

    def test_budget_mancante_non_esplode(self):
        self.assertEqual(check_budget_coherence([self._camp(0, 0.40)], min_clicks=10), [])
        self.assertEqual(check_budget_coherence([{"type": "update_bid"}], min_clicks=10), [])

    def test_indipendente_dal_tetto_da_margine(self):
        """I due vincoli sono separati: questo non ha bisogno del Worker."""
        azioni = [self._camp(3, 0.40)]
        self.assertEqual(check_bid_caps(azioni, None), [], "nessun tetto da margine")
        self.assertTrue(check_budget_coherence(azioni, min_clicks=10), "ma il budget lega comunque")
