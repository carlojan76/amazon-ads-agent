import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { C, F, T, S, R, button, input, card, GLOBAL_CSS } from "./theme";
import ActionsPanel from "./ActionsPanel";
import CampaignPlanner from "./CampaignPlanner";
import { ACTIONS_PROMPT, extractActionsFromText, validateAgainstData, actionSignature, dedupeActions } from "./actions";
import { parseCSV, processJSON, processCSV } from "./parse";

const ENV_KEY = typeof import.meta !== "undefined" ? import.meta.env?.VITE_ANTHROPIC_API_KEY : "";
const BASE_URL = typeof import.meta !== "undefined" ? import.meta.env.BASE_URL : "/";
const MODEL = "claude-sonnet-5";

// I modelli recenti ragionano prima di rispondere, e i token del ragionamento
// contano DENTRO max_tokens. Con un tetto basso (4000) il budget si esauriva
// nel ragionamento e la risposta arrivava senza testo, con stop_reason
// "max_tokens". Il tetto va quindi tenuto largo abbastanza da coprire
// ragionamento + report + blocco azioni.
const MAX_TOKENS = 16000;

// ---------------------------------------------------------------- UI comuni

const eur = (v) => `€${(v || 0).toFixed(2)}`;

function Metric({ label, value, sub, color, icon }) {
  return (
    <div style={{ ...card, padding: "14px 16px", flex: "1 1 148px", minWidth: 136, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${color}, transparent)` }} />
      <div style={{ fontSize: T.micro, color: C.textDim, letterSpacing: 0.6, marginBottom: 6, fontFamily: F.ui, fontWeight: 600 }}>
        <span aria-hidden>{icon}</span> {label}
      </div>
      <div style={{ fontSize: T.h2, fontWeight: 700, color: C.text, fontFamily: F.mono, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: T.micro, color: C.textMuted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Banner({ tone = "blue", children, action }) {
  const colors = { blue: [C.blueDim, C.blue], red: [C.redDim, C.red], green: [C.greenDim, C.green], yellow: [C.yellowDim, C.yellow] };
  const [bg, fg] = colors[tone] || colors.blue;
  return (
    <div style={{
      background: bg, borderLeft: `3px solid ${fg}`, borderRadius: R.md,
      padding: `${S.md}px ${S.lg}px`, marginBottom: S.md, display: "flex",
      alignItems: "center", gap: S.md, flexWrap: "wrap", fontSize: T.small, color: C.text, lineHeight: 1.55,
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>{children}</div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- AI Advisor

function AiAdvisor({ metrics, sourceType, apiKey, onActions, onGoToActions }) {
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState([]);
  const [lastResult, setLastResult] = useState(null); // { kept, rejected }

  const buildContext = () => {
    const campSum = Object.values(metrics.campaigns)
      .sort((a, b) => b.spend - a.spend).slice(0, 20)
      .map((d) => {
        const acos = d.sales > 0 ? ((d.spend / d.sales) * 100).toFixed(1) : "∞";
        return `- [campId:${d.campaignId || "?"}] ${d.name}: spesa ${eur(d.spend)}, vendite ${eur(d.sales)}, ACoS ${acos}%, ${d.clicks} click, ${d.orders} ordini`
          + `${d.budget ? `, budget ${eur(d.budget)}/g` : ""}${d.targetingType ? `, ${d.targetingType}` : ""}${d.status ? `, stato ${d.status}` : ""}`;
      }).join("\n");

    const kwLine = (k) =>
      `- [kwId:${k.keywordId || "?"} campId:${k.campaignId || "?"} agId:${k.adGroupId || "?"}] "${k.keyword}" [${k.matchType}]`
      + ` bid attuale ${eur(k.bid)}, CPC ${eur(k.cpc)}, stato ${k.state || "?"}`
      + ` | ${eur(k.spend)} spesa, ${eur(k.sales)} vendite, ACoS ${k.acos.toFixed(1)}%, ${k.clicks} click, ${k.orders} ordini`;

    const topKw = metrics.keywords.filter((k) => k.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 35).map(kwLine).join("\n");
    const waste = metrics.keywords.filter((k) => k.spend > 0 && k.orders === 0).sort((a, b) => b.spend - a.spend).slice(0, 20).map(kwLine).join("\n");
    const best = metrics.keywords.filter((k) => k.orders > 0 && k.acos < 25).sort((a, b) => a.acos - b.acos).slice(0, 15).map(kwLine).join("\n");

    let stSection = "";
    if (metrics.searchTerms?.length) {
      const stLine = (s) =>
        `- [campId:${s.campaignId || "?"} agId:${s.adGroupId || "?"}] "${s.searchTerm}" → kw "${s.keyword}" [${s.matchType}]`
        + ` | ${eur(s.spend)}, ${s.clicks} click, ${s.orders} ordini, ACoS ${s.acos.toFixed(1)}%`;
      const topST = metrics.searchTerms.filter((s) => s.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 25).map(stLine).join("\n");
      stSection = `\n## Search term (top 25 per spesa)\n${topST || "N/D"}`;
      const wasteST = metrics.searchTerms.filter((s) => s.spend > 1 && s.orders === 0).sort((a, b) => b.spend - a.spend).slice(0, 15).map(stLine).join("\n");
      if (wasteST) stSection += `\n\n## Search term con spesa e ZERO ordini (candidati a negativa)\n${wasteST}`;
      const winST = metrics.searchTerms.filter((s) => s.orders > 0 && s.searchTerm.toLowerCase() !== s.keyword.toLowerCase())
        .sort((a, b) => b.orders - a.orders).slice(0, 15).map(stLine).join("\n");
      if (winST) stSection += `\n\n## Search term che hanno VENDUTO ma non sono ancora keyword (candidati add_keyword)\n${winST}`;
    }

    const negSection = metrics.negativeKeywords?.length
      ? `\n## Negative gia' attive (${metrics.negativeKeywords.length})\n`
        + metrics.negativeKeywords.slice(0, 30).map((n) => `- "${n.keywordText}" [${n.matchType}]`).join("\n")
      : "";

    const prodSection = metrics.products?.length
      ? `\n## Performance per ASIN\n`
        + metrics.products.filter((p) => p.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 15)
          .map((p) => `- ASIN ${p.asin} (${p.sku || "N/D"}, agId:${p.adGroupId || "?"}): ${eur(p.spend)} spesa, ${eur(p.sales)} vendite, ${p.orders} ordini`).join("\n")
      : "";

    return `## Metriche generali
- Spesa ${eur(metrics.totalSpend)} | Vendite ${eur(metrics.totalSales)} | ACoS ${metrics.acos.toFixed(1)}% | ROAS ${(metrics.totalSpend > 0 ? metrics.totalSales / metrics.totalSpend : 0).toFixed(2)}x
- Impression ${metrics.totalImpress.toLocaleString("it-IT")} | Click ${metrics.totalClicks.toLocaleString("it-IT")} | CTR ${metrics.ctr.toFixed(2)}% | CVR ${metrics.cvr.toFixed(1)}% | CPC ${eur(metrics.cpc)} | Ordini ${metrics.totalOrders}
- Fonte: ${sourceType}${metrics.meta?.days ? ` | ultimi ${metrics.meta.days} giorni` : ""}${metrics.meta?.marketplace ? ` | marketplace ${metrics.meta.marketplace}` : ""}
${metrics.meta?.reports_incomplete ? "- ATTENZIONE: alcuni report non sono stati scaricati del tutto. Dove vedi zero, potrebbe mancare il dato: non trattarlo come assenza di attivita'.\n" : ""}
## Campagne (top 20 per spesa)
${campSum || "N/D"}

## Top 35 keyword per spesa
${topKw || "N/D"}

## Keyword con spesa e ZERO ordini
${waste || "Nessuna"}

## Keyword con ACoS sotto il 25%
${best || "Nessuna"}${stSection}${negSection}${prodSection}`;
  };

  const askAI = useCallback(async (customQ) => {
    if (!apiKey) { setError("Inserisci la tua API key Anthropic nelle impostazioni (icona ⚙ in alto)."); return; }
    setLoading(true); setError(null);

    const sys = `Sei un consulente senior di Amazon PPC per marketplace europei (IT, FR, DE, ES).
Analizza i dati e dai consigli CONCRETI e applicabili, in italiano.

Per ogni consiglio indica: azione esatta, motivo con il dato che la sostiene, impatto atteso in euro.

Categorie: 🔴 negativizzare · 🟢 scalare · 🟡 bid · 🔵 match type · 📊 struttura · 🔍 search term · 💡 quick win.

Sii diretto e operativo, niente teoria generica. Usa tabelle markdown dove aiutano.`;

    // Il contesto completo viaggia solo nel primo messaggio: nelle domande
    // successive il modello lo ha gia' in cronologia, rimandarlo ogni volta
    // moltiplicava i token (e il costo) di ogni follow-up.
    const first = history.length === 0;
    const msg = first
      ? `${buildContext()}\n\n---\n${customQ ? `DOMANDA: ${customQ}` : "Analisi completa con consigli operativi per tutte le categorie."}\n${ACTIONS_PROMPT}`
      : `${customQ || "Continua l'analisi."}\n${ACTIONS_PROMPT}`;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL, max_tokens: MAX_TOKENS, system: sys,
          messages: [...history, { role: "user", content: msg }],
        }),
      });

      let data;
      try {
        data = await resp.json();
      } catch {
        throw new Error(`Risposta non leggibile dall'API (HTTP ${resp.status}). `
          + `Se sei dietro una VPN o un proxy aziendale, potrebbe stare bloccando la chiamata.`);
      }

      // Prima l'errore veniva cercato solo in data.error, e qualsiasi altro
      // caso finiva in un generico "Nessuna risposta" che non diceva nulla.
      if (!resp.ok || data.type === "error" || data.error) {
        const e = data.error || {};
        const hint = resp.status === 401
          ? " La chiave API non è valida o è stata revocata."
          : resp.status === 400 && /credit|balance/i.test(e.message || "")
            ? " Il piano non ha credito residuo: controlla la fatturazione su console.anthropic.com."
            : resp.status === 429
              ? " Hai superato il limite di richieste: riprova tra qualche minuto."
              : "";
        throw new Error(`API Anthropic — HTTP ${resp.status}${e.type ? ` (${e.type})` : ""}: `
          + `${e.message || "errore non specificato"}.${hint}`);
      }

      const blocks = Array.isArray(data.content) ? data.content : [];
      const text = blocks.map((b) => b.text || "").join("\n").trim();
      if (!text) {
        // Console: utile per capire cosa è arrivato davvero.
        console.warn("Risposta senza testo dall'API Anthropic:", data);
        const kinds = blocks.map((b) => b.type).filter(Boolean).join(", ") || "nessuno";
        const why = data.stop_reason === "max_tokens"
          ? ` Il budget di ${MAX_TOKENS} token si è esaurito nel ragionamento, prima della risposta: `
            + `fai una domanda più circoscritta, oppure alza MAX_TOKENS in App.jsx.`
          : "";
        throw new Error(`Il modello ha risposto senza testo (blocchi ricevuti: ${kinds}; `
          + `motivo di arresto: ${data.stop_reason || "ignoto"}).${why}`);
      }

      const { actions, cleanText, warnings } = extractActionsFromText(text);
      const { kept, rejected } = validateAgainstData(actions, metrics);
      setAdvice(cleanText || text);
      setHistory((p) => [...p, { role: "user", content: msg }, { role: "assistant", content: text }]);
      setLastResult({ kept: kept.length, rejected, warnings });
      if (kept.length) onActions(kept.map((a) => ({ ...a, source: "ai" })));
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }, [metrics, history, apiKey]); // eslint-disable-line

  const renderMarkdown = (text) => text.split("\n").map((line, i) => {
    if (line.startsWith("###")) return <h4 key={i} style={{ color: C.accent, margin: "16px 0 6px", fontSize: T.body, fontWeight: 700 }}>{line.replace(/^###\s*/, "")}</h4>;
    if (line.startsWith("##")) return <h3 key={i} style={{ color: C.accent, margin: "18px 0 8px", fontSize: T.lead, fontWeight: 700 }}>{line.replace(/^##\s*/, "")}</h3>;
    if (line.startsWith("#")) return <h2 key={i} style={{ color: C.text, margin: "20px 0 8px", fontSize: T.h3, fontWeight: 700 }}>{line.replace(/^#\s*/, "")}</h2>;
    if (line.startsWith("|")) {
      if (line.includes("---")) return null;
      const cells = line.split("|").filter((c) => c.trim());
      return (
        <div key={i} style={{ display: "grid", gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: 1, fontSize: T.small, borderBottom: `1px solid ${C.border}` }}>
          {cells.map((c, j) => <div key={j} style={{ padding: "5px 8px", color: C.textMuted, fontFamily: F.mono }}>{c.trim()}</div>)}
        </div>
      );
    }
    const parts = line.replace(/\*\*(.*?)\*\*/g, "«B»$1«/B»").split(/(«B».*?«\/B»)/g);
    return (
      <p key={i} style={{ margin: "4px 0", fontSize: T.body, lineHeight: 1.7, color: C.text }}>
        {parts.map((p, j) => p.startsWith("«B»")
          ? <strong key={j} style={{ color: C.accent }}>{p.replace(/«\/?B»/g, "")}</strong>
          : p)}
      </p>
    );
  });

  return (
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: `${S.md}px ${S.lg}px`, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: S.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: S.md }}>
          <div aria-hidden style={{ width: 34, height: 34, borderRadius: R.md, background: `linear-gradient(135deg, ${C.accent}, ${C.accentDim})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>🤖</div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: T.body }}>Consulente campagne</div>
            <div style={{ color: C.textDim, fontSize: T.micro }}>Analizza i dati caricati e propone azioni pronte da rivedere</div>
          </div>
        </div>
        {!loading && (
          <button onClick={() => askAI(null)} style={button("primary")}>
            {advice ? "Rianalizza" : "Analizza le campagne"}
          </button>
        )}
      </div>

      {metrics.hasPerformance === false ? (
        <div style={{ padding: `${S.md}px ${S.lg}px`, background: C.redDim, fontSize: T.small, color: C.text, lineHeight: 1.6 }}>
          <strong>Il file non contiene dati di performance.</strong> Struttura delle campagne presente
          ({metrics.structuralKeywords || 0} keyword, {Object.keys(metrics.campaigns).length} campagne),
          ma zero righe nei report: spesa, click e vendite risultano tutti a zero.
          {metrics.meta?.reports_failed?.length
            ? ` Amazon ha rifiutato i report: ${metrics.meta.reports_failed.join(", ")}.`
            : ""}
          {metrics.meta?.days > 31 && !(metrics.meta?.report_windows?.length > 1)
            ? " L'intervallo supera i 31 giorni ed e' stato chiesto in una sola richiesta: aggiorna amazon_ads_api.py, che ora spezza il periodo in finestre."
            : " Rilancia il fetch e controlla l'output con check_data.py."}
        </div>
      ) : !metrics.hasIds ? (
        <div style={{ padding: `${S.sm}px ${S.lg}px`, background: C.yellowDim, fontSize: T.micro, color: C.text }}>
          Questi dati non contengono gli ID delle keyword (tipico dei CSV di Seller Central): i consigli resteranno
          testuali e non potranno essere applicati automaticamente. Per l'applicazione serve il JSON prodotto da <code>amazon_ads_api.py</code>.
        </div>
      ) : null}

      {loading && (
        <div style={{ padding: S.xxl, textAlign: "center" }}>
          <div style={{ width: 34, height: 34, border: `3px solid ${C.border}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin .7s linear infinite", margin: "0 auto 12px" }} />
          <div style={{ color: C.accent, fontWeight: 600, fontSize: T.body }}>Analisi in corso…</div>
          <div style={{ color: C.textDim, fontSize: T.micro, marginTop: 4 }}>
            {metrics.keywords.length} keyword · {Object.keys(metrics.campaigns).length} campagne · {(metrics.searchTerms || []).length} search term
          </div>
        </div>
      )}

      {error && <div style={{ padding: S.lg, color: C.red, fontSize: T.small }}>⚠ {error}</div>}

      {advice && (
        <div>
          {lastResult?.kept > 0 && (
            <div style={{ padding: `${S.md}px ${S.lg}px`, background: C.greenDim, display: "flex", alignItems: "center", gap: S.md, flexWrap: "wrap" }}>
              <div style={{ flex: 1, fontSize: T.small, color: C.text, minWidth: 220 }}>
                <strong>{lastResult.kept} azioni</strong> sono pronte da rivedere e applicare.
                {lastResult.rejected?.length > 0 && (
                  <span style={{ color: C.textMuted }}> ({lastResult.rejected.length} scartate perche' l'ID non esisteva nei dati)</span>
                )}
              </div>
              <button onClick={onGoToActions} style={button("primary", { small: true })}>Vai alle azioni →</button>
            </div>
          )}
          {lastResult?.kept === 0 && lastResult?.rejected?.length > 0 && (
            <div style={{ padding: `${S.sm}px ${S.lg}px`, background: C.yellowDim, fontSize: T.micro, color: C.text }}>
              Nessuna azione applicabile: {lastResult.rejected.length} proposte facevano riferimento a ID non presenti nei dati e sono state scartate.
            </div>
          )}
          <div style={{ padding: `${S.lg}px ${S.xl}px`, maxHeight: 520, overflowY: "auto" }}>{renderMarkdown(advice)}</div>
          <div style={{ padding: `${S.md}px ${S.lg}px`, borderTop: `1px solid ${C.border}`, display: "flex", gap: S.sm }}>
            <input value={question} onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && question.trim()) { askAI(question.trim()); setQuestion(""); } }}
              placeholder="Domanda specifica… es. quali search term promuovo a exact?"
              aria-label="Domanda al consulente"
              style={{ ...input, flex: 1 }} />
            <button onClick={() => { if (question.trim()) { askAI(question.trim()); setQuestion(""); } }}
              disabled={!question.trim()} style={button("ghost", { disabled: !question.trim() })}>Chiedi</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- App

export default function App() {
  const [metrics, setMetrics] = useState(null);
  const [fileName, setFileName] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState("overview");
  const [kwSort, setKwSort] = useState("spend");
  const [kwFilter, setKwFilter] = useState("all");
  const [apiKey, setApiKey] = useState(ENV_KEY || "");
  const [showSettings, setShowSettings] = useState(false);
  const [publishedIndex, setPublishedIndex] = useState(null);
  const [loadingMp, setLoadingMp] = useState(null);
  const [showPlanner, setShowPlanner] = useState(false);
  const [aiActions, setAiActions] = useState([]);
  const [selectedCount, setSelectedCount] = useState(0);
  const [parseError, setParseError] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    fetch(`${BASE_URL}data/index.json`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setPublishedIndex)
      .catch(() => setPublishedIndex(null));
  }, []);

  const resetForNewData = () => { setAiActions([]); setTab("overview"); setParseError(null); };

  const loadPublished = useCallback((mp) => {
    setLoadingMp(mp);
    fetch(`${BASE_URL}data/${mp}.json`)
      .then((r) => r.json())
      .then((json) => {
        setMetrics(processJSON(json));
        setFileName(`${mp}.json`);
        setSourceType(`Pubblicato · ${mp} · ${json._meta?.days || "?"} giorni`);
        resetForNewData();
      })
      .catch(() => setParseError(`Non sono riuscito a caricare i dati di ${mp}.`))
      .finally(() => setLoadingMp(null));
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      try {
        const json = JSON.parse(text);
        if (json._meta || json.reports || json.campaigns) {
          setMetrics(processJSON(json));
          setSourceType(`API · ${json._meta?.marketplace || "auto"} · ${json._meta?.days || "?"} giorni`);
        } else throw new Error("non e' un export dell'API");
      } catch {
        const parsed = parseCSV(text);
        if (!parsed.rows.length) { setParseError("Il file non contiene righe leggibili. Attesi: JSON da amazon_ads_api.py oppure CSV/TSV da Seller Central."); return; }
        setMetrics(processCSV(parsed));
        setSourceType("CSV caricato");
      }
      resetForNewData();
    };
    reader.readAsText(file);
  }, []);

  const addAiActions = useCallback((actions) => {
    // Deduplico sulla FIRMA, non sull'oggetto intero: due analisi successive
    // propongono spesso lo stesso intervento con una motivazione diversa, e
    // confrontando l'oggetto per intero finivano entrambe nell'elenco.
    setAiActions((prev) => {
      const seen = new Set(prev.map(actionSignature));
      return [...prev, ...actions.filter((a) => !seen.has(actionSignature(a)))];
    });
  }, []);

  const allProposed = useMemo(
    () => dedupeActions([...(metrics?.proposedActions || []), ...aiActions]),
    [metrics?.proposedActions, aiActions]
  );

  if (showPlanner) return <CampaignPlanner onClose={() => setShowPlanner(false)} />;

  // ---------------- schermata iniziale ----------------
  if (!metrics) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: S.xl, fontFamily: F.ui }}>
        <style>{GLOBAL_CSS}</style>
        <div style={{ maxWidth: 640, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: S.xxl }}>
            <div style={{ fontSize: T.micro, color: C.accent, fontWeight: 700, letterSpacing: 3, marginBottom: S.sm }}>AMAZON ADS</div>
            <h1 style={{ fontSize: T.h1, fontWeight: 800, color: C.text, margin: "0 0 10px", letterSpacing: -0.8 }}>
              Campaign Agent <span style={{ color: C.accent }}>⚡</span>
            </h1>
            <p style={{ color: C.textMuted, fontSize: T.body, lineHeight: 1.6, margin: 0 }}>
              Carica i dati delle campagne, ottieni consigli motivati dai numeri,<br />
              rivedili uno per uno e applicali quando sei convinto.
            </p>
          </div>

          {parseError && <Banner tone="red">{parseError}</Banner>}

          {publishedIndex?.marketplaces?.length > 0 && (
            <div style={{ ...card, padding: S.lg, marginBottom: S.lg }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: S.md, gap: S.sm, flexWrap: "wrap" }}>
                <div style={{ fontSize: T.body, fontWeight: 600, color: C.text }}>Ultimi dati pubblicati</div>
                <div style={{ fontSize: T.micro, color: C.textDim }}>
                  {publishedIndex.generated_at ? new Date(publishedIndex.generated_at).toLocaleString("it-IT") : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: S.sm, flexWrap: "wrap" }}>
                {publishedIndex.marketplaces.map((mp) => (
                  <button key={mp} onClick={() => loadPublished(mp)} disabled={!!loadingMp}
                    style={button("accentGhost", { disabled: !!loadingMp })}>
                    {loadingMp === mp ? "Carico…" : mp}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
            role="button" tabIndex={0}
            style={{
              border: `2px dashed ${dragOver ? C.accent : C.borderStrong}`, borderRadius: R.lg,
              padding: "44px 28px", cursor: "pointer", background: dragOver ? C.accentGlow : C.surface,
              transition: "all 0.2s", textAlign: "center", marginBottom: S.lg,
            }}>
            <div aria-hidden style={{ fontSize: 30, marginBottom: S.sm }}>{dragOver ? "📂" : "🚀"}</div>
            <div style={{ color: C.text, fontWeight: 600, fontSize: T.lead, marginBottom: 4 }}>Trascina qui il file dei dati</div>
            <div style={{ color: C.textMuted, fontSize: T.small }}>
              JSON da <code style={{ fontFamily: F.mono }}>amazon_ads_api.py</code>, oppure CSV/TSV da Seller Central
            </div>
            <input ref={fileRef} type="file" accept=".json,.csv,.tsv,.txt" hidden onChange={(e) => handleFile(e.target.files[0])} />
          </div>

          <button onClick={() => setShowPlanner(true)}
            style={{ ...button("accentGhost"), width: "100%", justifyContent: "center", flexDirection: "column", padding: S.lg, marginBottom: S.lg }}>
            <span>➕ Crea una campagna nuova da un ASIN</span>
            <span style={{ fontSize: T.micro, color: C.textMuted, fontWeight: 400 }}>
              Usa lo storico, i suggerimenti di Amazon e il testo del listing
            </span>
          </button>

          <details style={{ ...card, padding: S.md }}>
            <summary style={{ cursor: "pointer", fontSize: T.small, color: C.textMuted }}>Chiave API Anthropic</summary>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="sk-ant-…"
              style={{ ...input, width: "100%", marginTop: S.sm, fontFamily: F.mono }} />
            <div style={{ fontSize: T.micro, color: C.textDim, marginTop: 6 }}>
              Serve solo per il consulente. Resta nel browser e non viene salvata; in alternativa usa VITE_ANTHROPIC_API_KEY nel file .env.
            </div>
          </details>
        </div>
      </div>
    );
  }

  // ---------------- schermata dati ----------------
  const wasteKws = metrics.keywords.filter((k) => k.spend > 0 && k.orders === 0).sort((a, b) => b.spend - a.spend);
  const bestKws = metrics.keywords.filter((k) => k.orders > 0 && k.acos < 25).sort((a, b) => a.acos - b.acos);
  const wasteST = (metrics.searchTerms || []).filter((s) => s.spend > 0.5 && s.orders === 0).sort((a, b) => b.spend - a.spend);

  const sortedKws = [...metrics.keywords].filter((k) => {
    if (kwFilter === "waste") return k.spend > 0 && k.orders === 0;
    if (kwFilter === "top") return k.orders > 0 && k.acos < 25;
    if (kwFilter === "active") return k.spend > 0;
    return true;
  }).sort((a, b) => {
    if (kwSort === "spend") return b.spend - a.spend;
    if (kwSort === "acos") return (a.acos || 999) - (b.acos || 999);
    if (kwSort === "sales") return b.sales - a.sales;
    if (kwSort === "clicks") return b.clicks - a.clicks;
    return 0;
  });

  const pendingActions = allProposed.length;
  const tabs = [
    { id: "overview", label: "Riepilogo" },
    { id: "campaigns", label: "Campagne" },
    { id: "keywords", label: "Keyword" },
    ...(metrics.searchTerms?.length ? [{ id: "searchterms", label: "Search term" }] : []),
    { id: "ai", label: "Consulente" },
    { id: "actions", label: "Azioni", badge: pendingActions || null },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: S.md, fontFamily: F.ui, color: C.text }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {/* Intestazione */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: S.lg, flexWrap: "wrap", gap: S.md }}>
          <div>
            <div style={{ fontSize: T.micro, color: C.accent, fontWeight: 700, letterSpacing: 2 }}>AMAZON ADS AGENT</div>
            <div style={{ fontSize: T.small, color: C.textMuted, marginTop: 3 }}>
              {fileName} · {sourceType} · {metrics.keywords.length} keyword
            </div>
          </div>
          <div style={{ display: "flex", gap: S.sm }}>
            <button onClick={() => setShowPlanner(true)} style={button("accentGhost", { small: true })}>➕ Nuova campagna</button>
            <button onClick={() => setShowSettings((v) => !v)} aria-label="Impostazioni" style={button("ghost", { small: true })}>⚙</button>
            <button onClick={() => { setMetrics(null); resetForNewData(); }} style={button("ghost", { small: true })}>Cambia file</button>
          </div>
        </div>

        {showSettings && (
          <div style={{ ...card, padding: S.lg, marginBottom: S.md }}>
            <div style={{ fontSize: T.small, fontWeight: 600, marginBottom: S.sm }}>Chiave API Anthropic</div>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="sk-ant-…"
              style={{ ...input, width: "100%", fontFamily: F.mono }} />
          </div>
        )}

        {metrics.meta?.reports_incomplete && (
          <Banner tone="yellow">
            Alcuni report non sono arrivati completi da Amazon
            {metrics.meta.reports_timed_out?.length ? ` (timeout: ${metrics.meta.reports_timed_out.join(", ")})` : ""}
            {metrics.meta.reports_skipped_425?.length ? ` (saltati: ${metrics.meta.reports_skipped_425.join(", ")})` : ""}.
            Dove vedi zero potrebbe mancare il dato, non l'attivita'.
          </Banner>
        )}

        {/* Schede */}
        <div role="tablist" style={{ display: "flex", gap: S.xs, marginBottom: S.lg, overflowX: "auto", paddingBottom: 2 }}>
          {tabs.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} role="tab" aria-selected={on} onClick={() => setTab(t.id)}
                style={{
                  ...button(on ? "accentGhost" : "quiet", { small: true }),
                  borderBottom: on ? `2px solid ${C.accent}` : "2px solid transparent",
                  borderRadius: `${R.sm}px ${R.sm}px 0 0`, whiteSpace: "nowrap",
                }}>
                {t.label}
                {t.badge ? (
                  <span style={{ background: C.accent, color: "#0b0d12", borderRadius: R.pill, padding: "1px 7px", fontSize: T.micro, fontWeight: 700 }}>
                    {t.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Riepilogo */}
        {tab === "overview" && (
          <div>
            <div style={{ display: "flex", gap: S.md, flexWrap: "wrap", marginBottom: S.md }}>
              <Metric label="Spesa" value={eur(metrics.totalSpend)} color={C.red} icon="💸" />
              <Metric label="Vendite" value={eur(metrics.totalSales)} color={C.green} icon="💰" />
              <Metric label="ACoS" value={`${metrics.acos.toFixed(1)}%`} sub={metrics.acos > 30 ? "sopra la soglia" : "in linea"} color={metrics.acos > 30 ? C.red : C.green} icon="📉" />
              <Metric label="ROAS" value={`${(metrics.totalSpend > 0 ? metrics.totalSales / metrics.totalSpend : 0).toFixed(2)}x`} color={C.blue} icon="📈" />
            </div>
            <div style={{ display: "flex", gap: S.md, flexWrap: "wrap", marginBottom: S.lg }}>
              <Metric label="Impression" value={metrics.totalImpress.toLocaleString("it-IT")} color={C.textDim} icon="👁" />
              <Metric label="Click" value={metrics.totalClicks.toLocaleString("it-IT")} color={C.blue} icon="🖱" />
              <Metric label="CTR" value={`${metrics.ctr.toFixed(2)}%`} color={C.blue} icon="🎯" />
              <Metric label="CPC" value={eur(metrics.cpc)} color={C.accent} icon="💶" />
              <Metric label="Ordini" value={metrics.totalOrders} color={C.green} icon="📦" />
              <Metric label="CVR" value={`${metrics.cvr.toFixed(1)}%`} color={C.green} icon="✅" />
            </div>

            <div style={{ ...card, padding: S.lg }}>
              <div style={{ fontSize: T.lead, fontWeight: 700, marginBottom: S.md }}>Da guardare per prime</div>
              <div style={{ display: "flex", flexDirection: "column", gap: S.sm }}>
                {wasteKws.length > 0 && (
                  <Banner tone="red" action={<button onClick={() => { setKwFilter("waste"); setTab("keywords"); }} style={button("ghost", { small: true })}>Vedi</button>}>
                    <strong>{wasteKws.length} keyword</strong> hanno speso {eur(wasteKws.reduce((s, k) => s + k.spend, 0))} senza un solo ordine.
                  </Banner>
                )}
                {wasteST.length > 0 && (
                  <Banner tone="red" action={<button onClick={() => setTab("searchterms")} style={button("ghost", { small: true })}>Vedi</button>}>
                    <strong>{wasteST.length} search term</strong> con spesa e zero ordini: candidati a diventare negative.
                  </Banner>
                )}
                {metrics.acos > 35 && (
                  <Banner tone="red">ACoS al {metrics.acos.toFixed(1)}%: conviene abbassare i bid o tagliare le ricerche fuori intento.</Banner>
                )}
                {bestKws.length > 0 && (
                  <Banner tone="green" action={<button onClick={() => { setKwFilter("top"); setTab("keywords"); }} style={button("ghost", { small: true })}>Vedi</button>}>
                    <strong>{bestKws.length} keyword</strong> sotto il 25% di ACoS: c'e' spazio per spingere.
                  </Banner>
                )}
                {metrics.negativeKeywords?.length > 0 && (
                  <Banner tone="blue">{metrics.negativeKeywords.length} negative gia' attive sull'account.</Banner>
                )}
                <Banner tone="blue" action={<button onClick={() => setTab("ai")} style={button("primary", { small: true })}>Analizza</button>}>
                  Il consulente trasforma questi numeri in azioni che puoi rivedere e applicare una per una.
                </Banner>
              </div>
            </div>
          </div>
        )}

        {/* Campagne */}
        {tab === "campaigns" && (
          <div style={{ ...card, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr repeat(5, 1fr)", padding: `${S.sm}px ${S.lg}px`, borderBottom: `1px solid ${C.border}`, fontSize: T.micro, color: C.textDim, fontWeight: 600 }}>
              <div>Campagna</div><div>Spesa</div><div>Vendite</div><div>ACoS</div><div>ROAS</div><div>Ordini</div>
            </div>
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {Object.values(metrics.campaigns).sort((a, b) => b.spend - a.spend).map((d, i) => {
                const acos = d.sales > 0 ? ((d.spend / d.sales) * 100).toFixed(1) : "∞";
                const roas = d.spend > 0 ? (d.sales / d.spend).toFixed(2) : "0";
                const acosC = parseFloat(acos) > 40 ? C.red : parseFloat(acos) > 25 ? C.accent : C.green;
                return (
                  <div key={d.campaignId || d.name} style={{ display: "grid", gridTemplateColumns: "2fr repeat(5, 1fr)", padding: `${S.md}px ${S.lg}px`, borderBottom: `1px solid ${C.border}`, fontSize: T.small, background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                      {d.status === "PAUSED" ? "⏸ " : ""}{d.name}
                    </div>
                    <div style={{ color: C.textMuted, fontFamily: F.mono }}>{eur(d.spend)}</div>
                    <div style={{ color: C.textMuted, fontFamily: F.mono }}>{eur(d.sales)}</div>
                    <div style={{ color: acosC, fontWeight: 600, fontFamily: F.mono }}>{acos}%</div>
                    <div style={{ color: C.textMuted, fontFamily: F.mono }}>{roas}x</div>
                    <div style={{ color: C.textMuted, fontFamily: F.mono }}>{d.orders}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Keyword */}
        {tab === "keywords" && (
          <div>
            <div style={{ display: "flex", gap: S.sm, marginBottom: S.md, flexWrap: "wrap", alignItems: "center" }}>
              {[["all", "Tutte"], ["waste", "Sprechi"], ["top", "Migliori"], ["active", "Con spesa"]].map(([v, l]) => (
                <button key={v} onClick={() => setKwFilter(v)} style={button(kwFilter === v ? "accentGhost" : "ghost", { small: true })}>{l}</button>
              ))}
              <div style={{ flex: 1 }} />
              <select value={kwSort} onChange={(e) => setKwSort(e.target.value)} aria-label="Ordina le keyword"
                style={{ ...input, padding: "6px 9px", fontSize: T.small }}>
                <option value="spend">Ordina per spesa</option>
                <option value="acos">Ordina per ACoS</option>
                <option value="sales">Ordina per vendite</option>
                <option value="clicks">Ordina per click</option>
              </select>
            </div>
            <div style={{ ...card, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr repeat(6, 1fr)", padding: `${S.sm}px ${S.md}px`, borderBottom: `1px solid ${C.border}`, fontSize: T.micro, color: C.textDim, fontWeight: 600 }}>
                <div>Keyword</div><div>Spesa</div><div>Vendite</div><div>ACoS</div><div>Click</div><div>Bid</div><div>Match</div>
              </div>
              <div style={{ maxHeight: 440, overflowY: "auto" }}>
                {sortedKws.slice(0, 100).map((k, i) => {
                  const acosC = k.orders === 0 && k.spend > 0 ? C.red : k.acos < 25 ? C.green : k.acos < 40 ? C.accent : C.red;
                  return (
                    <div key={k.keywordId || `${k.keyword}-${i}`} style={{ display: "grid", gridTemplateColumns: "2fr repeat(6, 1fr)", padding: `${S.sm}px ${S.md}px`, borderBottom: `1px solid ${C.border}`, fontSize: T.small, background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={k.campaign}>
                        {k.state === "PAUSED" ? "⏸ " : ""}{k.keyword}
                      </div>
                      <div style={{ color: C.textMuted, fontFamily: F.mono }}>{eur(k.spend)}</div>
                      <div style={{ color: C.textMuted, fontFamily: F.mono }}>{eur(k.sales)}</div>
                      <div style={{ color: acosC, fontWeight: 600, fontFamily: F.mono }}>{k.acos > 900 ? "∞" : `${k.acos.toFixed(1)}%`}</div>
                      <div style={{ color: C.textMuted, fontFamily: F.mono }}>{k.clicks}</div>
                      <div style={{ color: k.bid ? C.textMuted : C.textDim, fontFamily: F.mono }}>{k.bid ? eur(k.bid) : "—"}</div>
                      <div style={{ color: C.textDim, fontSize: T.micro }}>{k.matchType}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ padding: `${S.sm}px ${S.md}px`, borderTop: `1px solid ${C.border}`, fontSize: T.micro, color: C.textDim }}>
                {Math.min(100, sortedKws.length)} di {sortedKws.length} keyword
              </div>
            </div>
          </div>
        )}

        {/* Search term */}
        {tab === "searchterms" && metrics.searchTerms?.length > 0 && (
          <div style={{ ...card, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr repeat(4, 1fr)", padding: `${S.sm}px ${S.md}px`, borderBottom: `1px solid ${C.border}`, fontSize: T.micro, color: C.textDim, fontWeight: 600 }}>
              <div>Ricerca dell'utente</div><div>Keyword</div><div>Spesa</div><div>Ordini</div><div>ACoS</div><div>Match</div>
            </div>
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              {metrics.searchTerms.filter((s) => s.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 80).map((s, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr repeat(4, 1fr)", padding: `${S.sm}px ${S.md}px`, borderBottom: `1px solid ${C.border}`, fontSize: T.small, background: s.orders === 0 ? C.redDim : i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.searchTerm}</div>
                  <div style={{ color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: T.micro }}>{s.keyword}</div>
                  <div style={{ color: C.textMuted, fontFamily: F.mono }}>{eur(s.spend)}</div>
                  <div style={{ color: s.orders > 0 ? C.green : C.red, fontWeight: 600, fontFamily: F.mono }}>{s.orders}</div>
                  <div style={{ color: s.orders === 0 ? C.red : s.acos < 25 ? C.green : C.accent, fontFamily: F.mono }}>{s.acos > 900 ? "∞" : `${s.acos.toFixed(1)}%`}</div>
                  <div style={{ color: C.textDim, fontSize: T.micro }}>{s.matchType}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Consulente */}
        {tab === "ai" && (
          <AiAdvisor metrics={metrics} sourceType={sourceType} apiKey={apiKey}
            onActions={addAiActions} onGoToActions={() => setTab("actions")} />
        )}

        {/* Azioni */}
        {tab === "actions" && (
          <div>
            {metrics.weeklyAnalysis && (
              <details style={{ ...card, padding: S.lg, marginBottom: S.md }}>
                <summary style={{ cursor: "pointer", fontSize: T.small, fontWeight: 600 }}>
                  Report settimanale {metrics.generatedAt ? `del ${new Date(metrics.generatedAt).toLocaleDateString("it-IT")}` : ""}
                </summary>
                <div style={{ whiteSpace: "pre-wrap", fontSize: T.small, lineHeight: 1.65, color: C.textMuted, maxHeight: 280, overflowY: "auto", marginTop: S.md }}>
                  {metrics.weeklyAnalysis}
                </div>
              </details>
            )}
            {!metrics.weeklyAnalysis && !metrics.proposedActions?.length && (
              <Banner tone="blue">
                Questo file è un export grezzo dell'API: contiene i dati, non le proposte.
                Le azioni arrivano dal <strong>Consulente</strong> in questa scheda, oppure dalla
                weekly analysis, che aggiunge la sua analisi al file pubblicato.
              </Banner>
            )}
            <ActionsPanel
              key={fileName}
              initialActions={allProposed}
              marketplace={metrics.meta?.marketplace || ""}
              onSelectionChange={setSelectedCount}
            />
          </div>
        )}
      </div>
    </div>
  );
}
