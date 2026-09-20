-- Schema D1 per amazon-ads-agent.
--
-- Applicalo con:
--   wrangler d1 execute amazon-ads --local  --file=./cloudflare/schema.sql
--   wrangler d1 execute amazon-ads --remote --file=./cloudflare/schema.sql
--
-- Tutte le CREATE sono IF NOT EXISTS: rilanciarlo e' sicuro.

-- ---------------------------------------------------------------------------
-- 1. Registro delle azioni applicate davvero sull'account.
--
-- Una riga per azione CONFERMATA dall'API Amazon (non per azione proposta).
-- Serve a tre cose: non riproporre ogni lunedi' quello che hai gia' fatto,
-- sapere quando una modifica e' stata fatta quando poi guardi l'andamento,
-- e ricostruire lo storico anche quando l'artefatto del run e' scaduto.
--
-- `signature` ha la stessa forma di actionSignature() in src/actions.js:
--   tipo|keywordId|campaignId|adGroupId|keywordText|matchType
-- cosi' il confronto fra proposto e gia'-applicato e' una uguaglianza secca.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applied_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace   TEXT    NOT NULL,
  action_type   TEXT    NOT NULL,
  signature     TEXT    NOT NULL,
  keyword_id    TEXT,
  campaign_id   TEXT,
  ad_group_id   TEXT,
  keyword_text  TEXT,
  match_type    TEXT,
  old_value     REAL,
  new_value     REAL,
  reason        TEXT,
  applied_at    TEXT    NOT NULL,
  run_id        TEXT,
  run_url       TEXT,
  ok            INTEGER NOT NULL DEFAULT 1,
  detail        TEXT,
  rolled_back   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_applied_mp_time
  ON applied_actions (marketplace, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_applied_sig
  ON applied_actions (marketplace, signature);

-- ---------------------------------------------------------------------------
-- 2. Storico delle metriche aggregate, una riga per marketplace per run.
--
-- Volutamente NON archivia il dump completo (IT.json pesa 460 KB: in un anno
-- sarebbero 24 MB). Qui stanno solo i numeri che servono per il confronto
-- settimana su settimana, che e' il dato che manca del tutto oggi.
--
-- La chiave e' (marketplace, period_end) e non la data del run: se rilanci
-- l'analisi due volte sulla stessa finestra sovrascrivi, non duplichi.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics_history (
  marketplace   TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  period_start  TEXT,
  captured_at   TEXT NOT NULL,
  days          INTEGER,
  spend         REAL DEFAULT 0,
  sales         REAL DEFAULT 0,
  acos          REAL DEFAULT 0,
  roas          REAL DEFAULT 0,
  impressions   REAL DEFAULT 0,
  clicks        REAL DEFAULT 0,
  orders        REAL DEFAULT 0,
  ctr           REAL DEFAULT 0,
  cvr           REAL DEFAULT 0,
  cpc           REAL DEFAULT 0,
  n_campaigns   INTEGER DEFAULT 0,
  n_keywords    INTEGER DEFAULT 0,
  PRIMARY KEY (marketplace, period_end)
);

CREATE INDEX IF NOT EXISTS idx_history_mp
  ON metrics_history (marketplace, period_end DESC);

-- ---------------------------------------------------------------------------
-- 3. Tetti massimi sui bid.
--
-- Due livelli: 'market' (scope_id = '') e 'campaign' (scope_id = campaignId).
-- Il piu' specifico vince. Il tetto NON e' un suggerimento: viene passato a
-- Claude nel prompt cosi' non propone nemmeno bid sopra soglia, viene
-- controllato nella UI prima di mandare le azioni, e viene ricontrollato in
-- apply_changes.py prima di toccare l'API — tre livelli, perche' il primo
-- e' un modello linguistico e il secondo gira nel browser dell'utente.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bid_caps (
  marketplace   TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('market', 'campaign')),
  scope_id      TEXT NOT NULL DEFAULT '',
  scope_label   TEXT,
  max_bid       REAL NOT NULL,
  note          TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (marketplace, scope, scope_id)
);

-- ---------------------------------------------------------------------------
-- 4. Contatori d'uso del proxy.
--
-- Il Worker espone la chiave Anthropic a chiunque superi l'autenticazione:
-- un tetto giornaliero per tipo di chiamata evita che un token finito nel
-- posto sbagliato bruci il credito prima che tu te ne accorga.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
  day   TEXT    NOT NULL,
  kind  TEXT    NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
