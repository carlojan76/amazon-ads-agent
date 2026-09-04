"""
Configurazione centrale.

Le credenziali si leggono da variabili d'ambiente (o da un file .env se hai
python-dotenv installato). NON mettere segreti in questo file.
Vedi .env.example per i nomi.
"""
import os

try:
    from dotenv import load_dotenv  # opzionale
    load_dotenv()
except Exception:
    pass

# --- Credenziali LWA (le stesse che usi gia' in sp_api_fetch.py) -------------
LWA_CLIENT_ID = os.getenv("LWA_CLIENT_ID", "")
LWA_CLIENT_SECRET = os.getenv("LWA_CLIENT_SECRET", "")
LWA_REFRESH_TOKEN = os.getenv("LWA_REFRESH_TOKEN", "")

# Merchant Token del venditore. Usato solo dalla Listings API
# (update_listing.py); la pipeline P&L non ne ha bisogno.
SELLER_ID = os.getenv("SP_API_SELLER_ID", "")

# --- Endpoint ----------------------------------------------------------------
# Sei in regione EU (IT/FR/DE). Da fine 2023 SP-API NON richiede piu' la firma
# AWS SigV4 / assunzione di ruolo IAM: basta il token LWA nell'header
# x-amz-access-token. Quindi qui non c'e' nulla di AWS.
SPAPI_ENDPOINT = os.getenv("SPAPI_ENDPOINT", "https://sellingpartnerapi-eu.amazon.com")
LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"

# --- Marketplace IDs (EU) ----------------------------------------------------
MARKETPLACES = {
    "IT": "APJ6JRA9NG5V4",
    "FR": "A13V1IB3VIYZZH",
    "DE": "A1PA6795UKMFR9",
    "ES": "A1RKKUPIHCS9HS",
    "UK": "A1F83G8C2ARO7P",
}

# Mappa inversa marketplaceId -> codice paese (unica fonte di verita': non
# ridefinirla altrove).
MARKETPLACE_ID_TO_CODE = {v: k for k, v in MARKETPLACES.items()}

# Mercati effettivamente attivi per il business (usati dal registro transazioni
# e dai loop multi-mercato). Per aggiungere ES/UK basta cambiare QUI (o la
# variabile d'ambiente ACTIVE_MARKETS="IT,FR,DE,ES"), non serve toccare altri file.
ACTIVE_MARKETS = [
    m.strip().upper()
    for m in os.getenv("ACTIVE_MARKETS", "IT,FR,DE").split(",")
    if m.strip()
]
ACTIVE_MARKETPLACE_IDS = [MARKETPLACES[m] for m in ACTIVE_MARKETS if m in MARKETPLACES]

# Soglia di allarme per le voci non classificate/generiche (other + unclassified)
# rispetto al valore assoluto movimentato nel mese. Usata da `run.py check`
# e dall'evidenza rossa nel report HTML.
UNCLASSIFIED_MAX_SHARE = float(os.getenv("UNCLASSIFIED_MAX_SHARE", "0.01"))

# Aliquota IVA usata SOLO come stima di fallback (es. IVA sullo storage, che il
# report fornisce al netto). L'IVA su vendite e fee vera arriva dal breakdown.
DEFAULT_VAT_RATE = float(os.getenv("DEFAULT_VAT_RATE", "0.22"))

DB_PATH = os.getenv("PNL_DB_PATH", "lupo_felix_pnl.db")

# --- Backend persistenza -----------------------------------------------------
# 'sqlite' (locale) oppure 'firestore' (online / GitHub Actions).
BACKEND = os.getenv("PNL_BACKEND", "sqlite").lower()
# Prefisso opzionale per i nomi delle collection Firestore (namespacing).
FIRESTORE_PREFIX = os.getenv("FIRESTORE_PREFIX", "")

# --- Regole di classificazione delle foglie del breakdown --------------------
# IMPORTANTE: queste regole vanno verificate/affinate dopo aver guardato un
# dump reale (comando `dump-raw`). Mappano una sottostringa (minuscola) trovata
# nel "path" del breakdown a un bucket. Le foglie il cui path contiene una
# parola in TAX_KEYWORDS vengono instradate su "<bucket>_vat", le altre su
# "<bucket>_base". La prima regola che matcha vince.
CLASSIFY_RULES = [
    ("principal", "sale"),
    ("productcharges", "sale"),
    ("product charges", "sale"),
    ("itemprice", "sale"),
    ("sales", "sale"),
    ("sale", "sale"),
    ("promotion", "promo"),
    ("promo", "promo"),
    ("shipping", "shipping"),
    ("giftwrap", "giftwrap"),
    ("digitalservices", "dst"),
    ("digital services", "dst"),
    ("commission", "referral"),
    ("referralfee", "referral"),
    ("fbaperunitfulfillmentfee", "fba"),
    ("fulfillment", "fba"),
]
TAX_KEYWORDS = ("tax", "vat", "imposta", "tassa")

# Bucket noti -> generano colonne <bucket>_base e <bucket>_vat nel DB.
BUCKETS = ["sale", "referral", "dst", "fba", "promo", "shipping", "giftwrap", "other"]
