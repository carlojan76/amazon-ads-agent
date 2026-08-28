# Amazon Ads Agent — Guida Completa

Tutto quello che serve per usare l'app, dalla configurazione iniziale all'uso quotidiano. Nessuna conoscenza tecnica richiesta oltre a saper usare un browser e (occasionalmente) PowerShell.


---

## 1. Cos'è e cosa fa

Amazon Ads Agent è un sistema per gestire le tue campagne Sponsored Products su Amazon (IT, FR, DE e altri marketplace EU). Ha tre modalità:

**Analisi e ottimizzazione** — Carichi i dati delle campagne esistenti (JSON o CSV), l'AI li analizza e propone azioni concrete: alzare/abbassare bid, aggiungere negative, mettere in pausa keyword che sprecano budget, promuovere search term vincenti.

**Creazione campagne nuove** — Dai un ASIN (anche mai pubblicizzato), l'app recupera lo storico passato (incluse campagne chiuse), chiede a Amazon le keyword consigliate, analizza il testo del listing, e genera un piano completo di campagne (auto + manual), che rivedi e modifichi prima di lanciarlo.

**Automazione settimanale** — Ogni lunedì ricevi via email un report AI con analisi e azioni proposte, che puoi confermare dalla UI online senza toccare codice.


---

## 2. Prerequisiti

Prima di usare qualsiasi funzione ti servono:

- **Un account GitHub** con il repo `amazon-ads-agent` pushato (privato va bene)
- **I secret configurati nel repo** (Settings → Secrets and variables → Actions):
  - `AMAZON_ADS_CLIENT_ID` — dal tuo Amazon Advertising account
  - `AMAZON_ADS_CLIENT_SECRET`
  - `AMAZON_ADS_REFRESH_TOKEN`
  - `ANTHROPIC_API_KEY` — la chiave API di Claude
- **Una OAuth App su GitHub** per la connessione dalla UI (vedi sezione 3)
- **Workflow permissions** su "Read and write" (Settings → Actions → General → Workflow permissions)


---

## 3. Configurazione OAuth App di GitHub (una tantum)

La UI ha bisogno di un Client ID per connettersi a GitHub e lanciare i workflow.

1. Vai su **github.com** → icona profilo in alto a destra → **Settings**
2. Scorri in basso a sinistra → **Developer settings**
3. Clicca **OAuth Apps** → **New OAuth App** (oppure usa quella esistente "Amazon Ads Agent")
4. Compila i campi:
   - Application name: `Amazon Ads Agent` (o quello che preferisci)
   - Homepage URL: `https://tuo-utente.github.io/amazon-ads-agent/` oppure `http://localhost:3000`
   - Authorization callback URL: metti lo stesso URL di sopra
5. **Fondamentale**: scorri in basso e spunta **Enable Device Flow**
6. Salva. Nella pagina dell'app trovi il **Client ID** (tipo `Ov23li...`). Copialo, ti servirà nella UI.

Non serve generare il Client Secret.


CONFIGURA TOKE GITHUB
usare un Personal Access Token (PAT) invece del device flow. Lo incolli una volta e resta nel browser.

Crealo così:

GitHub → icona profilo → Settings
In fondo a sinistra → Developer settings
Personal access tokens → Fine-grained tokens → Generate new token
Compila:
Token name: Ads Agent
Expiration: 90 giorni (o quello che preferisci)
Repository access: seleziona Only select repositories → scegli amazon-ads-agent
Permissions → Repository permissions:
Contents: Read and write
Actions: Read and write
Generate token → copia il token (inizia con github_pat_...)

Ora aggiorno CampaignPlanner.jsx per accettare direttamente il PAT (molto più semplice della OAuth App):







---

## 4. Avviare l'app

Hai due opzioni:

**Locale (sviluppo):**
```
cd amazon-ads-agent
npm install
npm run dev
```
Si apre su `http://localhost:3000`.

**Online (GitHub Pages):**
Se hai abilitato Pages (Settings → Pages → Source: GitHub Actions), l'app è su `https://tuo-utente.github.io/amazon-ads-agent/`. I dati della weekly analysis si caricano da soli.


---

## 5. Analisi campagne esistenti (drag & drop)

Questo è il modo base per analizzare le campagne che hai già attive.

### 5a. Ottenere i dati

Apri PowerShell nella cartella `python` del repo ed esegui:
```powershell
cd amazon-ads-agent\python
python amazon_ads_api.py --marketplace IT --days 14
```
Questo genera un file tipo `amazon_ads_IT_20260718_0900.json` con tutti i dati delle tue campagne IT degli ultimi 14 giorni. Ripeti per FR e DE se vuoi.

### 5b. Caricare nell'app

1. Apri l'app nel browser
2. Nella schermata iniziale, **trascina il file JSON** nell'area di upload (oppure clicca per selezionarlo)
3. L'app mostra subito la dashboard con le metriche: spesa totale, vendite, ACoS, ROAS

### 5c. Navigare le tab

- **📊 Overview** — metriche aggregate a colpo d'occhio
- **📁 Campagne** — lista di tutte le campagne con spesa, vendite, ACoS
- **🔑 Keywords** — tutte le keyword con filtri (tutte, sprecone, top performer, attive) e ordinamenti
- **🔍 Search Terms** — i termini di ricerca reali usati dai clienti
- **🤖 AI Advisor** — qui succede la magia (vedi sotto)
- **✅ Azioni** — le modifiche proposte dall'AI, pronte da confermare

### 5d. Analisi AI

1. Vai alla tab **🤖 AI Advisor**
2. Serve la **Anthropic API Key**: inseriscila nel campo in alto nella landing o nelle impostazioni (⚙️). Resta solo nel tuo browser, non viene salvata da nessuna parte.
3. Clicca **▶ Analizza**
4. Claude analizza tutto (1-2 minuti) e produce un report con:
   - Stato generale del marketplace
   - Le 3 azioni più urgenti
   - Search term da negativizzare
   - Keyword da scalare
   - Quick wins
5. Puoi fare **domande di follow-up** nel campo in basso (es. "Quali search term aggiungo come exact per l'amaca?")


---

## 6. Confermare e applicare le azioni

L'AI propone azioni concrete (modifica bid, aggiungi negative, pausa keyword). Prima di applicarle le rivedi e modifichi.

### 6a. Dalla tab ✅ Azioni

1. Vai alla tab **✅ Azioni**
2. Ogni azione ha una checkbox: **spunta** quelle che vuoi applicare, **deseleziona** quelle che non ti convincono
3. Puoi **modificare i valori** (bid, budget) direttamente nei campi editabili
4. Puoi **rimuovere** azioni singole
5. Puoi **aggiungere azioni manuali** con il pulsante "+ Aggiungi azione manuale"

### 6b. Applicare via GitHub Actions (dalla UI)

1. Connetti GitHub: inserisci il **Client ID**, il tuo **username** (owner) e il nome del **repo** (`amazon-ads-agent`)
2. Clicca **Connetti con GitHub** → si apre una pagina dove inserisci un codice → autorizza
3. Seleziona il marketplace (IT/FR/DE)
4. Clicca **🚀 Applica su Amazon** → la UI lancia il workflow `Apply Amazon Ads Changes` su GitHub
5. Le modifiche vengono applicate via API. Puoi seguire il run cliccando il link

### 6c. Applicare manualmente (alternativa)

Se preferisci non connettere GitHub dalla UI:
1. Clicca **⬇️ Scarica actions.json**
2. Vai su GitHub → tab **Actions** → **Apply Amazon Ads Changes** → **Run workflow**
3. Seleziona il marketplace, incolla il contenuto del JSON nel campo `actions_json`
4. Nel campo `confirm` scrivi `APPLICA` (esattamente così, maiuscolo)
5. Clicca **Run workflow**

Puoi anche fare un **dry-run** (solo anteprima senza applicare nulla) spuntando il flag `dry_run`.


---

## 7. Creare una campagna nuova da un ASIN

Questa è la funzione più potente. Funziona anche per prodotti mai pubblicizzati.

### 7a. Aprire il planner

Dalla schermata iniziale clicca il pulsante **"➕ Crea una campagna nuova da un ASIN"**, oppure dall'header quando hai dati caricati clicca **"➕ Nuova campagna"**.

### 7b. Connettere GitHub

Stessa procedura della sezione 6b: Client ID + owner + repo → Connetti. Se ti eri già connesso nella sessione, resta attivo.

### 7c. Compilare il form

| Campo | Cosa metterci | Obbligatorio? |
|---|---|---|
| **Marketplace** | IT, FR, DE, ecc. | Sì |
| **ASIN principale** | L'ASIN del prodotto (parent o child hero) | Sì |
| **Child ASIN** | I child separati da virgola (es. `B0YYY,B0ZZZ`) | No, ma consigliato se hai varianti |
| **Mappa ASIN=SKU** | Associazione ASIN→SKU separata da virgola (es. `B0XXX=SKU-A,B0YYY=SKU-B`). Da seller lo SKU è necessario per creare i product ad. | Fortemente consigliato |
| **Budget/giorno** | Budget giornaliero in EUR (viene splittato tra le campagne) | No (default 8) |
| **Target ACoS** | Il tuo obiettivo di ACoS in percentuale | No (default 30%) |
| **Come differiscono i child?** | Scrivi "solo colore" oppure "misure S/M/L" → guida come l'AI raggruppa i child negli ad group | No, ma molto utile |
| **Testo listing** | Incolla titolo + bullet point + descrizione del prodotto dalla pagina Amazon. Fondamentale per prodotti senza storico ads. | No, ma molto utile |
| **Recensioni** | Incolla estratti di recensioni: l'AI ne estrae keyword long-tail e pain point | No |
| **Salta recommendations Amazon** | Spunta solo se l'endpoint ti dà errori (raro) | No |

**Dove trovo lo SKU?** In Seller Central → Inventario → Gestisci inventario → colonna SKU accanto a ogni prodotto.

**Dove trovo il testo del listing?** Apri la pagina del prodotto su Amazon, copia titolo e bullet point. Oppure in Seller Central → Inventario → Gestisci inventario → Modifica → sezione Descrizione.

### 7d. Generare il piano

1. Clicca **⚡ Genera piano**
2. L'app lancia un workflow su GitHub che:
   - Scarica i dati delle tue campagne (60 giorni di storico, anche campagne chiuse)
   - Chiede ad Amazon le keyword consigliate per l'ASIN (anche se non l'hai mai pubblicizzato)
   - Analizza il testo del listing e le recensioni
   - Invia tutto a Claude che progetta la struttura della campagna
3. Attendi 1-3 minuti. La UI fa polling automatico e ti mostra lo stato. Puoi anche cliccare il link per vedere i log del run su GitHub.

### 7e. Rivedere e modificare il piano

Quando il piano è pronto, la UI mostra:

**In alto:** la spiegazione di Claude — perché ha scelto quella struttura, come ha raggruppato i child, da quali fonti arrivano le keyword principali.

**Sotto:** l'editor del blueprint. Per ogni campagna proposta puoi:
- Cambiare il **nome** della campagna
- Modificare il **budget giornaliero**
- Cambiare il **tipo** (AUTO/MANUAL)
- Cambiare lo **stato iniziale** (consiglio: lascia PAUSED, attivi a mano dopo il controllo)
- Per ogni **ad group**:
  - Modificare il bid base
  - Aggiungere/togliere **prodotti** (SKU + ASIN)
  - Aggiungere/togliere/modificare **keyword** (testo, match type, bid)
  - Aggiungere/togliere **negative**
- **Rimuovere** intere campagne che non ti convincono

### 7f. Creare le campagne su Amazon

1. Clicca **🚀 Crea le campagne**
2. L'app chiede conferma, poi lancia il workflow `Apply Amazon Ads Changes`
3. Il workflow crea tutto in cascata: campagna → ad group → product ad → keyword → negative
4. Le campagne partono nello stato che hai scelto (di default PAUSED)
5. Vai su Amazon Seller Central → Advertising → Campaign Manager per verificare e poi attivarle

Puoi anche scaricare il blueprint come JSON (**⬇️ Scarica blueprint.json**) e applicarlo manualmente dal workflow su GitHub.


---

## 8. Automazione settimanale (email ogni lunedì)

Se hai configurato i secret email nel repo, ogni lunedì alle 07:00 UTC ricevi un'email con l'analisi AI di tutti i tuoi marketplace.

### Configurazione (una tantum)

Aggiungi questi secret nel repo (Settings → Secrets):
- `SMTP_USER` — il tuo indirizzo Gmail (o altro provider SMTP)
- `SMTP_PASS` — la password app di Gmail (non la password normale; vai su Google Account → Sicurezza → Password per le app)
- `EMAIL_TO` — l'indirizzo dove ricevere il report

Puoi anche specificare i marketplace da analizzare con la variabile `MARKETPLACES` (default: `IT,FR,DE`).

### Cosa ricevi

Un'email HTML con per ogni marketplace:
- Dashboard con metriche chiave
- Le azioni più urgenti
- Search term da negativizzare
- Keyword da scalare
- Un file `actions_*.json` allegato con le azioni pronte da applicare

### Test manuale

Per testare senza aspettare lunedì: vai su GitHub → Actions → **Weekly Amazon Ads Analysis** → **Run workflow** → seleziona il branch e clicca Run.

### Dati pubblicati per la UI online

La weekly analysis pubblica automaticamente i dati in `public/data/`. Se hai GitHub Pages attivo, apri l'app online e trovi i pulsanti con i marketplace (es. 📊 IT, 📊 FR) pronti per l'analisi senza upload manuale.


---

## 9. Capire la logica dei child e degli ad group

Questa è la parte che più spesso confonde. Ecco le regole:

**Child che differiscono solo per colore** (stessa misura, stesso uso, prezzo simile) → vanno **TUTTI nello stesso ad group**. Perché? Perché nessuno cerca "amaca gatto grigia" — cercano "amaca gatto". Quando l'utente clicca, atterra sulla pagina e sceglie il colore lì. Mettere ogni colore in una campagna separata significa frammentare i dati, rallentare il learning e competere contro te stesso nelle stesse aste.

**Child che differiscono per misura/capacità** (S/M/L, 30cm/50cm, 2kg/5kg) → vanno in **ad group separati**, perché l'intento di ricerca cambia. Chi cerca "tiragraffi grande" non vuole quello piccolo. Separando per misura, ogni ad group ha le keyword giuste per la variante giusta.

**Default sano:** 1 campagna AUTO (tutti i child, budget basso, discovery) + 1 campagna MANUAL (child insieme o splittati per misura) con le keyword migliori. NON una campagna per singolo child a meno che sia un best-seller con volume sufficiente.


---

## 10. Tipi di azione supportati

| Azione | Cosa fa | Quando la usi |
|---|---|---|
| **update_bid** | Cambia il bid di una keyword | Keyword buona ma troppo costosa, oppure ottima che vuoi scalare |
| **pause_keyword** | Mette in pausa una keyword | Keyword che spende ma non converte (€3+ spesi, 0 ordini in 14gg) |
| **enable_keyword** | Riattiva una keyword in pausa | Keyword che vuoi ritestare |
| **add_keyword** | Aggiunge una nuova keyword a un ad group | Search term vincente che promuovi a keyword esatta |
| **add_negative** | Aggiunge una negative keyword | Search term irrilevante che sta mangiando budget |
| **update_budget** | Cambia il budget giornaliero di una campagna | Campagna che va bene e vuoi scalare, o che spreca e vuoi ridurre |
| **pause_campaign** | Mette in pausa un'intera campagna | Campagna che non funziona |
| **enable_campaign** | Riattiva una campagna | Campagna da ritestare |
| **create_campaign** | Crea una campagna nuova completa | Nuovo prodotto o nuova strategia |


---

## 11. Glossario rapido

- **ACoS** (Advertising Cost of Sales): spesa pubblicitaria diviso vendite da pubblicità, in percentuale. Sotto il 25% è generalmente buono; il target ideale dipende dal tuo margine.
- **ROAS** (Return on Ad Spend): vendite diviso spesa. È l'inverso dell'ACoS. ROAS 4x = ACoS 25%.
- **CPC** (Cost Per Click): quanto paghi per ogni click sull'annuncio.
- **Impression**: quante volte l'annuncio è stato mostrato.
- **Search term**: la frase esatta digitata dal cliente su Amazon.
- **Keyword**: la parola/frase che tu scegli come target nella campagna.
- **Negative keyword**: una parola che ESCLUDI — se un utente la cerca, il tuo annuncio non appare.
- **Match type**: EXACT (solo quella frase), PHRASE (contiene quella frase), BROAD (varianti e sinonimi).
- **SKU**: il codice identificativo del tuo prodotto nel tuo inventario (diverso dall'ASIN che è di Amazon).
- **ASIN parent**: il prodotto "contenitore" che raggruppa tutte le varianti.
- **ASIN child**: una singola variante (es. colore rosso, misura M).
- **Ad group**: un contenitore dentro la campagna che raggruppa prodotti + keyword.
- **Blueprint**: il piano di una campagna nuova generato dall'AI, che rivedi prima di creare.


---

## 12. Troubleshooting

**"Device flow disabled"** quando provi a connettere GitHub → Vai nella tua OAuth App (Settings → Developer settings → OAuth Apps → la tua app → Edit), scorri in basso, spunta "Enable Device Flow", salva.

**Il workflow non riesce a committare** → Verifica che in Settings → Actions → General → Workflow permissions sia selezionato "Read and write permissions".

**Le keyword recommendations tornano vuote** → Può capitare se l'ASIN è troppo nuovo o se Amazon non ha abbastanza dati. L'AI usa le altre fonti (listing, storico, keyword manuali). Prova a inserire più keyword nel campo "Keyword note a mano".

**Product ad non creato (errore SKU)** → Da seller i product ad si creano con lo SKU, non l'ASIN. Assicurati di compilare il campo "Mappa ASIN=SKU" nel form, oppure aggiungilo nell'editor del blueprint prima di applicare.

**429 Too Many Requests sulle recommendations** → L'API Amazon ha rate limit aggressivi. Lo script fa già retry automatico. Se persiste, spunta "Salta le keyword recommendations di Amazon" e usa listing + keyword manuali.

**Il piano non arriva dopo 3 minuti** → Clicca il link "apri il run su GitHub" per vedere i log. Le cause più comuni: secret mancanti, timeout del report Amazon (se è il primo run del giorno), errore di autenticazione Ads.

**L'app online non mostra i dati pubblicati** → Verifica che GitHub Pages sia abilitato con source "GitHub Actions" e che la weekly analysis sia andata a buon fine almeno una volta.


---

## 13. Checklist primo utilizzo

1. Repo pushato su GitHub con tutti i file (python/, src/, .github/workflows/)
2. Secret configurati nel repo (AMAZON_ADS_*, ANTHROPIC_API_KEY)
3. Workflow permissions su "Read and write" → Save
4. OAuth App con Device Flow abilitato → Client ID copiato
5. `npm install && npm run dev` (locale) oppure Pages abilitato (online)
6. Primo test: trascina un JSON nella UI → tab AI Advisor → Analizza
7. Primo test planner: ➕ Nuova campagna → connetti GitHub → inserisci un ASIN → Genera piano
8. Primo test weekly: Actions → Weekly Amazon Ads Analysis → Run workflow
