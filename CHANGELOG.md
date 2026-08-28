# Changelog — revisione di agosto 2026

## Bug corretti

### 1. Le liste API non paginavano (dati troncati in silenzio)
`get_keywords`, `get_ad_groups`, `get_negative_keywords` e `get_targets` facevano una sola
chiamata da 100 risultati senza seguire `nextToken`, e filtravano solo le prime 50 campagne.

Nel file `public/data/IT.json` di partenza: **100 keyword esatte, su 3 campagne di 84**.
Dopo la correzione, lo stesso account ne restituisce **792 su 34 campagne**.

**Correzione**: `_list_all()` in `amazon_ads_api.py` pagina con `nextToken` e spezza il filtro
campagne in blocchi da 100 ID.

### 2. Il bid arrivava al modello sempre a €0.00
Il report `spKeywords` non contiene la colonna bid: sta solo nella lista strutturale. Con la
lista troncata (bug 1) il join non trovava nulla — l'intersezione era **0 su 83**. Il prompt
chiedeva "variazione max ±30% del bid attuale" partendo da zero.

**Correzione**: join di bid e stato reali in `build_summary()` (Python) e `processJSON()`
(front-end). Il prompt riceve `bid attuale`, `CPC medio` e `stato` per ogni keyword.

### 3. `add_keyword` veniva scartata dal validatore
Il prompt la definisce "la leva di crescita principale" e la richiede in 6 punti, ma
`ALLOWED_TYPES` in `extract_actions()` non la conteneva: ogni promozione di un search term
vincente finiva nel nulla, senza traccia nei log.

**Correzione**: tipo ammesso, con validazione dell'`adGroupId` contro gli ad group attivi.

### 4. I CSV europei erano sbagliati di 100 volte
`processCSV` faceva `replace(/[,]/g,"")` prima di gestire la virgola decimale: `"12,34"` → `1234`.
Il separatore `;`, standard negli export IT/FR/DE, non era riconosciuto.

**Correzione**: `parseNumber()` gestisce entrambe le convenzioni; `parseCSV()` rileva
tabulazione, punto e virgola e virgola, e le virgolette raddoppiate.

### 5. I report falliti diventavano zeri indistinguibili da "nessuna attività"
Un 425 (report identico già in coda) o un 400 alla creazione restituivano zero righe senza
alcuna segnalazione: `reports_incomplete` restava `false` su export privi di qualsiasi numero.

**Correzione**: ogni fallimento finisce in `_meta.reports_failed` / `reports_skipped_425` e
alza `reports_incomplete`. La UI mostra un avviso esplicito.

### 6. `--days` oltre 31 produceva un file vuoto
L'API di reporting v3 rifiuta gli intervalli superiori a 31 giorni. Con `--days 45` tutte e
cinque le richieste tornavano 400 e l'export usciva con la struttura completa e zero performance.

**Correzione**: la finestra viene limitata a 31 giorni con avviso esplicito, e la cosa è
registrata in `_meta.days_capped_to`.

### 7. Il Device Flow di GitHub non poteva funzionare
Un commento in `github.js` affermava che gli endpoint `github.com/login/*` supportassero CORS.
Non è vero: non inviano `Access-Control-Allow-Origin`, quindi il browser blocca la richiesta e
`fetch` fallisce con "Failed to fetch", senza codice HTTP.

**Correzione**: autenticazione con fine-grained token (api.github.com espone CORS
correttamente), verifica preventiva dei permessi sul workflow, messaggio d'errore che spiega
il problema. Il Device Flow resta disponibile solo configurando un proxy.

### Altri
- Il pannello Azioni non si aggiornava al cambio marketplace (`useState` inizializzato una volta sola).
- `findLatestRun` poteva agganciare un run precedente: ora l'ID viene registrato prima del dispatch.
- Ogni domanda di follow-up al Consulente rispediva l'intero contesto (token moltiplicati).
- Le campagne senza righe di report sparivano dalla tabella.

## Applicazione supervisionata dei suggerimenti

Prima le azioni esistevano solo nei dati settimanali pubblicati: caricando un JSON proprio, il
Consulente scriveva un report e la tab Azioni restava vuota. Ora il Consulente emette azioni
strutturate, validate nel browser contro gli ID realmente presenti nei dati.

**Flusso a tre passi obbligati:**

1. **Rivedi** — azioni raggruppate per intento, con variazione %, motivo agganciato al dato e
   impatto stimato in €. Selezione per gruppo, ricerca, filtri, modifica inline. Le scelte
   sopravvivono al refresh.
2. **Anteprima** — workflow in sola lettura: legge lo stato attuale su Amazon, scarta le azioni
   già allineate, scrive un riepilogo leggibile nel summary del run.
3. **Applica** — si sblocca solo dopo un'anteprima riuscita *e solo per quella selezione*. Se
   cambi una spunta, l'anteprima decade. Serve comunque digitare `APPLICA`.

### Limiti di sicurezza (`apply_changes.py`)

| Cosa | Limite |
|---|---|
| Variazione bid | ±50%, comunque tra €0.02 e €5.00 |
| Variazione budget | ±50%, comunque tra €1 e €100/giorno |
| Azioni per run | max 80 |
| Nuove campagne per run | max 4 |

Valgono anche per le azioni scritte a mano. Si scavalcano con `--allow-large-changes`.

### Rollback
Ogni applicazione produce `rollback_<MP>_<data>.json` tra gli artefatti del run: rilanciandolo
si riportano bid, budget e stati com'erano. Negative e keyword aggiunte non hanno azione inversa
via API e sono elencate a parte come promemoria.

## Interfaccia

- Monospace riservato a numeri e ID; testo e controlli in font di sistema (prima era tutto
  monospace a 10-11px).
- Azioni raggruppate per intento invece che elencate alla rinfusa.
- Stati vuoti che dicono cosa fare; messaggi d'errore che distinguono "dati senza ID" da
  "dati senza performance".
- Focus da tastiera visibile, `prefers-reduced-motion` rispettato, label ARIA sui controlli.
- Stato del run GitHub seguito in tempo reale, con link al log.

## File nuovi

| File | Ruolo |
|---|---|
| `src/parse.js` | Parsing JSON/CSV, estratto da App.jsx per essere testabile |
| `src/actions.js` | Modello azioni: tipi, validazione, limiti, descrizioni, estrazione |
| `python/check_data.py` | Verifica la completezza di un export prima di usarlo |
| `tests/smoke.mjs` | 29 test senza dipendenze — `npm test` |
| `CHANGELOG.md` | Questo file |

## Non toccato

`CampaignPlanner.jsx` è rimasto com'era: funziona, ha una sua logica di editing del blueprint,
e rifarlo nello stesso passaggio avrebbe reso impossibile isolare le regressioni. Beneficia
comunque dei nuovi token del tema. È il candidato naturale per il prossimo giro: la creazione
di campagne è l'operazione più costosa se qualcosa va storto, e non ha ancora un equivalente
del flusso anteprima-poi-applica.

## Stato dei dati in `public/data`

I file inclusi rispecchiano quelli sul repo al 28 agosto 2026, e **nessuno dei due è
utilizzabile** per decisioni sui bid:

| File | Problema |
|---|---|
| `IT.json` | fetch del 28/8 con la paginazione corretta (792 keyword) ma `--days 45`: zero righe di performance |
| `FR.json` | fetch del 24/8 con la vecchia paginazione: 100 keyword, troncato |
| `DE.json` | fetch del 24/8: 48 keyword (completo), ma report vuoti |

Vanno rigenerati: `python amazon_ads_api.py --marketplace IT --days 30`, poi
`python check_data.py <file>` per verificare prima di usarli.
