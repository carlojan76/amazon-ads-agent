import { useState, useEffect, useRef, useMemo } from "react";
import { C } from "./theme";
import {
  getUser,
  dispatchWorkflow, findLatestRun, getRun, getRepoFileContents,
  getLatestCommitForPath, latestRunId, waitForNewRun, followRun,
} from "./github";
import { checkBlueprint } from "./blueprintCheck";

const MARKETPLACES = ["IT", "FR", "DE", "ES", "UK", "NL", "SE", "PL", "BE", "IE"];
const KW_MATCH = ["EXACT", "PHRASE", "BROAD"];
const NEG_MATCH = ["NEGATIVE_EXACT", "NEGATIVE_PHRASE"];
const AUTO_EXPR = [
  "QUERY_HIGH_REL_MATCHES",
  "QUERY_BROAD_REL_MATCHES",
  "ASIN_SUBSTITUTE_RELATED",
  "ASIN_ACCESSORY_RELATED",
];
// Etichette leggibili: gli enum API non dicono niente a chi guarda la pagina.
const AUTO_LABEL = {
  QUERY_HIGH_REL_MATCHES: "corrispondenza stretta",
  QUERY_BROAD_REL_MATCHES: "corrispondenza ampia",
  ASIN_SUBSTITUTE_RELATED: "prodotti sostitutivi",
  ASIN_ACCESSORY_RELATED: "prodotti complementari",
};
const STRUCTURES = [
  { v: "auto", label: "Decide il modello", hint: "Raggruppa i child secondo le regole standard: stesso colore insieme, misure diverse separate." },
  { v: "shared", label: "Campagna di gruppo", hint: "Tutti i child nello stesso ad group. Dati concentrati, nessuna concorrenza fra le tue campagne." },
  { v: "per_child", label: "Una campagna per child", hint: "Ogni variante ha budget, bid e report suoi. Se i child cambiano solo colore, competono fra loro." },
];
// Lingua usata dal planner per keyword e negative: la stessa mappa di
// campaign_planner.MARKET_LOCALE, qui solo per mostrarla nel form.
const MARKET_LANG = {
  IT: "italiano", FR: "francese", DE: "tedesco", ES: "spagnolo", UK: "inglese britannico",
  NL: "olandese", SE: "svedese", PL: "polacco", BE: "olandese/francese", IE: "inglese",
};
const PLAN_WORKFLOW = "plan-campaign.yml";
const APPLY_WORKFLOW = "apply-actions.yml";

const ls = (k, d = "") => (typeof localStorage !== "undefined" ? localStorage.getItem(k) || d : d);

function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: C.textDim, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = {
  width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7,
  padding: "8px 10px", color: C.text, fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box",
};
const btn = (bg, fg = "#fff") => ({
  background: bg, color: fg, border: "none", borderRadius: 7, padding: "9px 16px",
  fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit",
});
const btnGhost = (color) => ({ ...btn("transparent", color), border: `1px solid ${color}` });

// ---- markdown minimale per la spiegazione ---------------------------------
function renderMd(text) {
  return (text || "").split("\n").map((line, i) => {
    const s = line.trim();
    if (!s) return <div key={i} style={{ height: 6 }} />;
    if (s.startsWith("# ")) return <div key={i} style={{ color: C.accent, fontWeight: 700, fontSize: 14, margin: "10px 0 4px" }}>{s.slice(2)}</div>;
    if (s.startsWith("## ")) return <div key={i} style={{ color: "#58a6ff", fontWeight: 600, fontSize: 13, margin: "8px 0 3px" }}>{s.slice(3)}</div>;
    const html = s.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
    const bullet = s.startsWith("- ") || s.startsWith("* ");
    return (
      <div key={i} style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.55, margin: "2px 0", paddingLeft: bullet ? 14 : 0 }}
        dangerouslySetInnerHTML={{ __html: (bullet ? "• " : "") + (bullet ? html.slice(2) : html) }} />
    );
  });
}

// ---- editor del blueprint --------------------------------------------------
function BlueprintEditor({ actions, setActions }) {
  const upd = (ci, fn) => setActions(actions.map((a, i) => (i === ci ? fn(structuredClone(a)) : a)));
  const removeCampaign = ci => setActions(actions.filter((_, i) => i !== ci));

  const addCampaign = () => setActions([...actions, {
    type: "create_campaign",
    campaign: { name: "", targetingType: "MANUAL", dailyBudget: 4, biddingStrategy: "LEGACY_FOR_SALES", state: "PAUSED" },
    adGroups: [{ name: "AG-1", defaultBid: 0.4, products: [{ sku: "", asin: "" }], keywords: [], negatives: [] }],
  }]);

  return (
    <div>
      {actions.map((a, ci) => {
        if (a.type !== "create_campaign") {
          return (
            <div key={ci} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 11, color: C.textMuted }}>
              Azione non-create ({a.type}) — verra' inviata cosi' com'e'.
            </div>
          );
        }
        const c = a.campaign || {};
        const isAuto = (c.targetingType || "MANUAL") === "AUTO";
        const willSpendNow = c.state === "ENABLED";
        return (
          <div key={ci} style={{ background: C.surface, border: `1px solid ${willSpendNow ? C.red : C.accent}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>
                CAMPAGNA {c.targetingType || "MANUAL"} {c.name ? `— ${c.name}` : ""}
              </div>
              <button onClick={() => removeCampaign(ci)} style={{ ...btnGhost(C.red), padding: "4px 10px" }}>✕ Rimuovi</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Nome">
                <input style={inputStyle} value={c.name || ""} onChange={e => upd(ci, x => { x.campaign.name = e.target.value; return x; })} />
              </Field>
              <Field label="Targeting">
                <select style={inputStyle} value={c.targetingType || "MANUAL"} onChange={e => upd(ci, x => { x.campaign.targetingType = e.target.value; return x; })}>
                  <option>MANUAL</option><option>AUTO</option>
                </select>
              </Field>
              <Field label="Budget/giorno (EUR)">
                <input type="number" step="0.5" style={inputStyle} value={c.dailyBudget ?? ""} onChange={e => upd(ci, x => { x.campaign.dailyBudget = parseFloat(e.target.value) || 0; return x; })} />
              </Field>
              <Field label="Stato iniziale">
                <select style={{ ...inputStyle, borderColor: willSpendNow ? C.red : C.border, color: willSpendNow ? C.red : C.text }}
                  value={c.state || "PAUSED"} onChange={e => upd(ci, x => { x.campaign.state = e.target.value; return x; })}>
                  <option>PAUSED</option><option>ENABLED</option>
                </select>
              </Field>
            </div>
            {willSpendNow && (
              <div style={{ fontSize: 11, color: C.red, fontWeight: 600, margin: "-4px 0 10px" }}>
                ⚠️ Questa campagna partira' SUBITO: la spesa inizia nel momento in cui viene creata.
                Metti PAUSED se prima vuoi controllarla su Seller Central.
              </div>
            )}

            {(a.adGroups || []).map((g, gi) => (
              <AdGroupEditor key={gi} g={g}
                onChange={ng => upd(ci, x => { x.adGroups[gi] = ng; return x; })}
                onRemove={() => upd(ci, x => { x.adGroups.splice(gi, 1); return x; })}
                isAuto={isAuto} />
            ))}
            <button
              onClick={() => upd(ci, x => {
                (x.adGroups ||= []).push({
                  name: `AG-${(x.adGroups.length || 0) + 1}`, defaultBid: 0.4,
                  products: [{ sku: "", asin: "" }], keywords: [], negatives: [],
                });
                return x;
              })}
              style={{ ...btnGhost(C.accent), borderStyle: "dashed", padding: "6px 12px", fontSize: 11, marginTop: 10 }}>
              + ad group
            </button>
          </div>
        );
      })}
      <button onClick={addCampaign} style={{ ...btnGhost(C.accent), borderStyle: "dashed", padding: "9px 16px", fontSize: 12, marginBottom: 14 }}>
        + campagna
      </button>
    </div>
  );
}

function AdGroupEditor({ g, onChange, onRemove, isAuto }) {
  const set = fn => onChange(fn(structuredClone(g)));
  const usedExpr = (g.autoTargets || []).map(t => t.expressionType);
  const freeExpr = AUTO_EXPR.filter(e => !usedExpr.includes(e));
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <input style={{ ...inputStyle, maxWidth: 260, fontWeight: 600 }} value={g.name || ""} onChange={e => set(x => { x.name = e.target.value; return x; })} />
        <button onClick={onRemove} style={{ ...btnGhost(C.textMuted), padding: "3px 8px" }}>✕ ad group</button>
      </div>
      <Field label="Bid base (EUR)">
        <input type="number" step="0.05" style={{ ...inputStyle, maxWidth: 120 }} value={g.defaultBid ?? ""} onChange={e => set(x => { x.defaultBid = parseFloat(e.target.value) || 0; return x; })} />
      </Field>

      {/* Prodotti */}
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, margin: "8px 0 4px" }}>Prodotti (SKU necessario da seller)</div>
      {(g.products || []).map((p, pi) => (
        <div key={pi} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
          <input placeholder="SKU" style={{ ...inputStyle, flex: 1 }} value={p.sku || ""} onChange={e => set(x => { x.products[pi].sku = e.target.value; return x; })} />
          <input placeholder="ASIN" style={{ ...inputStyle, flex: 1 }} value={p.asin || ""} onChange={e => set(x => { x.products[pi].asin = e.target.value; return x; })} />
          <button onClick={() => set(x => { x.products.splice(pi, 1); return x; })} style={{ ...btnGhost(C.textMuted), padding: "4px 8px" }}>✕</button>
        </div>
      ))}
      <button onClick={() => set(x => { (x.products ||= []).push({ sku: "", asin: "" }); return x; })} style={{ ...btnGhost(C.accent), borderStyle: "dashed", padding: "5px 10px", fontSize: 11 }}>+ prodotto</button>

      {/* Keyword (solo MANUAL) */}
      {!isAuto && (
        <>
          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, margin: "12px 0 4px" }}>Keyword</div>
          {(g.keywords || []).map((k, ki) => (
            <div key={ki} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
              <input placeholder="keyword" style={{ ...inputStyle, flex: 2 }} value={k.keywordText || ""} onChange={e => set(x => { x.keywords[ki].keywordText = e.target.value; return x; })} />
              <select style={{ ...inputStyle, flex: 1 }} value={k.matchType || "EXACT"} onChange={e => set(x => { x.keywords[ki].matchType = e.target.value; return x; })}>
                {KW_MATCH.map(m => <option key={m}>{m}</option>)}
              </select>
              <input type="number" step="0.05" placeholder="bid" style={{ ...inputStyle, width: 80 }} value={k.bid ?? ""} onChange={e => set(x => { x.keywords[ki].bid = parseFloat(e.target.value) || 0; return x; })} />
              <button onClick={() => set(x => { x.keywords.splice(ki, 1); return x; })} style={{ ...btnGhost(C.textMuted), padding: "4px 8px" }}>✕</button>
            </div>
          ))}
          <button onClick={() => set(x => { (x.keywords ||= []).push({ keywordText: "", matchType: "EXACT", bid: g.defaultBid || 0.4 }); return x; })} style={{ ...btnGhost(C.accent), borderStyle: "dashed", padding: "5px 10px", fontSize: 11 }}>+ keyword</button>
        </>
      )}

      {/* Auto targets (solo AUTO) — ora aggiungibili e rimovibili: prima si
          potevano solo modificare, e solo se il modello ne aveva proposti. */}
      {isAuto && (
        <>
          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, margin: "12px 0 4px" }}>Auto targets (bid)</div>
          {(g.autoTargets || []).map((t, ti) => (
            <div key={ti} style={{ display: "flex", gap: 6, marginBottom: 5, alignItems: "center" }}>
              <span style={{ flex: 2, fontSize: 11, color: C.textMuted }}>
                {AUTO_LABEL[t.expressionType] || t.expressionType}
                <span style={{ color: C.textDim }}> — {t.expressionType}</span>
              </span>
              <input type="number" step="0.05" style={{ ...inputStyle, width: 90 }} value={t.bid ?? ""} onChange={e => set(x => { x.autoTargets[ti].bid = parseFloat(e.target.value) || 0; return x; })} />
              <button onClick={() => set(x => { x.autoTargets.splice(ti, 1); return x; })} style={{ ...btnGhost(C.textMuted), padding: "4px 8px" }}>✕</button>
            </div>
          ))}
          {freeExpr.length > 0 && (
            <select style={{ ...inputStyle, maxWidth: 260, fontSize: 11 }} value=""
              onChange={e => { const v = e.target.value; if (v) set(x => { (x.autoTargets ||= []).push({ expressionType: v, bid: g.defaultBid || 0.3 }); return x; }); }}>
              <option value="">+ aggiungi auto target...</option>
              {freeExpr.map(m => <option key={m} value={m}>{AUTO_LABEL[m] || m}</option>)}
            </select>
          )}
        </>
      )}

      {/* Negative */}
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, margin: "12px 0 4px" }}>Negative</div>
      {(g.negatives || []).map((n, ni) => (
        <div key={ni} style={{ display: "flex", gap: 6, marginBottom: 5 }}>
          <input placeholder="termine" style={{ ...inputStyle, flex: 2 }} value={n.keywordText || ""} onChange={e => set(x => { x.negatives[ni].keywordText = e.target.value; return x; })} />
          <select style={{ ...inputStyle, flex: 1 }} value={n.matchType || "NEGATIVE_EXACT"} onChange={e => set(x => { x.negatives[ni].matchType = e.target.value; return x; })}>
            {NEG_MATCH.map(m => <option key={m}>{m}</option>)}
          </select>
          <button onClick={() => set(x => { x.negatives.splice(ni, 1); return x; })} style={{ ...btnGhost(C.textMuted), padding: "4px 8px" }}>✕</button>
        </div>
      ))}
      <button onClick={() => set(x => { (x.negatives ||= []).push({ keywordText: "", matchType: "NEGATIVE_EXACT" }); return x; })} style={{ ...btnGhost(C.border), color: C.textMuted, borderStyle: "dashed", padding: "5px 10px", fontSize: 11 }}>+ negative</button>
    </div>
  );
}

// ---- riepilogo + controlli prima di creare ---------------------------------
function ReviewSummary({ check, meta, marketplace }) {
  const s = check.stats;
  const cur = meta?.currency || "EUR";
  const box = { background: C.bg, borderRadius: 7, padding: "8px 10px", border: `1px solid ${C.border}` };
  const num = (v, label, color) => (
    <div style={box}>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || C.text }}>{v}</div>
      <div style={{ fontSize: 10, color: C.textDim }}>{label}</div>
    </div>
  );
  const overBudget = meta?.budget_requested && s.totalBudget > Number(meta.budget_requested) + 0.001;
  return (
    <div style={{ background: C.surface, border: `1px solid ${check.errors.length ? C.red : C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>
        Cosa stai per creare su {marketplace}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginBottom: 10 }}>
        {num(s.campaigns, "campagne")}
        {num(s.adGroups, "ad group")}
        {num(s.keywords, "keyword")}
        {num(s.negatives, "negative")}
        {num(s.products, "prodotti")}
        {num(`${cur} ${s.totalBudget.toFixed(2)}`, "budget/giorno", overBudget ? C.red : C.green)}
      </div>
      {meta?.budget_requested != null && (
        <div style={{ fontSize: 11, color: overBudget ? C.red : C.textDim, marginBottom: 6 }}>
          Budget richiesto: {cur} {Number(meta.budget_requested).toFixed(2)}/giorno
          {overBudget ? ` — il piano ne propone ${(s.totalBudget - Number(meta.budget_requested)).toFixed(2)} in piu'` : " — rispettato"}
        </div>
      )}

      {check.errors.length > 0 && (
        <div style={{ marginTop: 8, padding: 10, background: C.bg, borderRadius: 7, border: `1px solid ${C.red}` }}>
          <div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 4 }}>
            Da correggere prima di procedere ({check.errors.length}):
          </div>
          {check.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>• {e}</div>)}
        </div>
      )}
      {check.warnings.length > 0 && (
        <div style={{ marginTop: 8, padding: 10, background: C.bg, borderRadius: 7, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, color: C.yellow || "#d29922", fontWeight: 700, marginBottom: 4 }}>Da guardare:</div>
          {check.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>• {w}</div>)}
        </div>
      )}
    </div>
  );
}

// ---- componente principale -------------------------------------------------
export default function CampaignPlanner({ onClose }) {
  // GitHub config (condivisa con ActionsPanel via localStorage)
  const [owner, setOwner] = useState(() => ls("gh_owner"));
  const [repo, setRepo] = useState(() => ls("gh_repo"));
  const [token, setToken] = useState(() => ls("gh_token"));
  const [ghUser, setGhUser] = useState(null);
  const [connecting, setConnecting] = useState(false);

  // form
  const [f, setF] = useState({
    marketplace: "IT", asin: "", children: "", skus: "", budget: "8",
    targetAcos: "30", childNote: "", listingText: "", reviewsText: "",
    seedKeywords: "", noAmazonRecs: false, days: "60", structure: "auto",
  });
  const setField = (k, v) => setF(p => ({ ...p, [k]: v }));

  // stato flusso
  const [phase, setPhase] = useState("form"); // form | waiting | review | error
  const [status, setStatus] = useState("");
  const [runUrl, setRunUrl] = useState("");
  const [plan, setPlan] = useState(null); // { actions, _meta }
  const [actions, setActions] = useState([]);
  const [debug, setDebug] = useState([]);
  const [savedEdit, setSavedEdit] = useState(null); // modifiche locali recuperabili

  // gate anteprima -> APPLICA (stesso patto di ActionsPanel)
  const [preview, setPreview] = useState({ state: "idle", msg: "", url: "" });
  const [previewSig, setPreviewSig] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [apply, setApply] = useState({ state: "idle", msg: "", url: "" });

  const pollRef = useRef(null);
  const addDebug = (msg) => setDebug(d => [...d, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-20));

  useEffect(() => { localStorage.setItem("gh_owner", owner); }, [owner]);
  useEffect(() => { localStorage.setItem("gh_repo", repo); }, [repo]);
  useEffect(() => { if (token) localStorage.setItem("gh_token", token); }, [token]);
  useEffect(() => () => clearInterval(pollRef.current), []);
  useEffect(() => {
    if (token && !ghUser) getUser(token).then(setGhUser).catch(() => { setToken(""); localStorage.removeItem("gh_token"); });
  }, [token]); // eslint-disable-line

  const planPath = `plans/${f.marketplace}/${f.asin.trim()}.json`;
  const editKey = `aa_plan_edit_${f.marketplace}_${f.asin.trim()}`;

  // Le modifiche fatte a mano restano nel browser: il file nel repo e' sempre
  // la versione originale di Claude (la UI non ha permessi di scrittura sul
  // repo), quindi senza questo ricaricare un piano buttava via l'editing.
  useEffect(() => {
    if (phase !== "review" || !actions.length || !f.asin.trim()) return;
    try { localStorage.setItem(editKey, JSON.stringify(actions)); } catch { /* quota */ }
  }, [actions, phase, editKey, f.asin]);

  const currentSig = useMemo(() => JSON.stringify(actions), [actions]);
  const check = useMemo(
    () => checkBlueprint(actions, { budgetRequested: plan?._meta?.budget_requested }),
    [actions, plan]);

  // L'anteprima vale solo per il piano ESATTO che e' stata usata a validare:
  // se dopo l'anteprima tocchi un bid, il gate si richiude.
  const previewValid = preview.state === "ok" && previewSig === currentSig;
  const canApply = previewValid && confirmText === "APPLICA" && check.errors.length === 0;

  useEffect(() => {
    if (preview.state === "ok" && previewSig !== currentSig) {
      setPreview({ state: "idle", msg: "Hai modificato il piano dopo l'anteprima: rifalla prima di creare.", url: "" });
      setConfirmText("");
    }
  }, [currentSig]); // eslint-disable-line

  const connect = async () => {
    if (!token.trim()) { setStatus("Incolla il Personal Access Token (PAT) di GitHub."); return; }
    if (!owner.trim() || !repo.trim()) { setStatus("Inserisci owner e repo."); return; }
    setConnecting(true); setStatus("");
    try {
      const user = await getUser(token.trim());
      setGhUser(user);
      localStorage.setItem("gh_token", token.trim());
    } catch (e) { setStatus("Token non valido o scaduto. Rigenera il PAT su GitHub."); setToken(""); localStorage.removeItem("gh_token"); }
    finally { setConnecting(false); }
  };

  const enterReview = (pl) => {
    setPlan(pl);
    setActions(pl.actions);
    setPhase("review");
    setStatus("");
    setPreview({ state: "idle", msg: "", url: "" });
    setPreviewSig("");
    setConfirmText("");
    setApply({ state: "idle", msg: "", url: "" });
    try {
      const raw = localStorage.getItem(editKey);
      if (raw && raw !== JSON.stringify(pl.actions)) setSavedEdit(JSON.parse(raw));
      else setSavedEdit(null);
    } catch { setSavedEdit(null); }
  };

  // Prende il testo del listing gia' presente nel repo invece di farlo
  // incollare a mano: il file lo scrive build-listing.yml.
  const pullListingFromRepo = async () => {
    if (!token || !owner || !repo || !f.asin.trim()) { setStatus("Serve connessione e ASIN."); return; }
    setStatus("Cerco il listing nel repo...");
    const path = `listings/content/${f.asin.trim()}_${f.marketplace}.json`;
    const res = await getRepoFileContents({ token, owner, repo, path }).catch(() => null);
    if (!res || !res.json) { setStatus(`Nessun listing generato in ${path}. Usa prima la scheda Listing, oppure incolla il testo a mano.`); return; }
    const j = res.json;
    const src = j.content || j.current_copy || j;
    const bullets = Array.isArray(src.bullet_point) ? src.bullet_point : [];
    const txt = [src.item_name || "", ...bullets, src.product_description || ""].filter(Boolean).join("\n");
    if (!txt.trim()) { setStatus("Il file esiste ma non contiene testo utilizzabile."); return; }
    setField("listingText", txt);
    setStatus("");
  };

  const generate = async () => {
    if (!token || !owner || !repo) { setStatus("Configura e connetti GitHub prima."); return; }
    if (!f.asin.trim()) { setStatus("Inserisci un ASIN."); return; }
    setPhase("waiting"); setStatus("Leggo lo stato attuale del file..."); setPlan(null); setActions([]);
    setDebug([`start: ${new Date().toLocaleTimeString()}`]);

    // Prendo l'ultimo commit che ha toccato il file: la Commits API e' fresca,
    // la Contents API ha cache lunga e non e' affidabile per rilevare cambi.
    let beforeCommitSha = null;
    try {
      const prev = await getLatestCommitForPath({ token, owner, repo, path: planPath });
      beforeCommitSha = prev?.sha || null;
    } catch { /* file non esiste ancora */ }
    addDebug(`beforeCommitSha=${beforeCommitSha ? beforeCommitSha.substring(0, 7) : "(none)"}`);

    setStatus("Avvio del workflow di generazione...");
    try {
      await dispatchWorkflow({
        token, owner, repo, workflow: PLAN_WORKFLOW,
        inputs: {
          marketplace: f.marketplace, asin: f.asin.trim(), children: f.children.trim(),
          skus: f.skus.trim(), budget: f.budget, target_acos: f.targetAcos,
          child_note: f.childNote, listing_text: f.listingText, reviews_text: f.reviewsText,
          seed_keywords: f.seedKeywords, no_amazon_recs: f.noAmazonRecs ? "true" : "false",
          days: f.days, structure: f.structure,
        },
      });
    } catch (e) { setPhase("error"); setStatus(String(e.message || e)); return; }
    addDebug("workflow dispatched");

    let runId = null;
    let runSucceeded = false;
    setTimeout(async () => {
      const run = await findLatestRun({ token, owner, repo, workflow: PLAN_WORKFLOW });
      if (run) { runId = run.id; setRunUrl(run.html_url); addDebug(`runId=${run.id}`); }
    }, 4000);

    const start = Date.now();
    // 50 minuti, non 8. La parte lenta e' Amazon che genera i report Ads: in un
    // run reale (60 giorni = 2 finestre, 10 report) ci ha messo 12m52s, con il
    // job intero a 15 minuti. Con il tetto a 8 minuti questa pagina dichiarava
    // "Timeout" mentre il workflow stava lavorando benissimo, e il blueprint
    // finiva committato nel repo senza che l'utente lo vedesse mai.
    // Il valore deve restare PIU' ALTO del timeout-minutes del workflow (45),
    // altrimenti si torna a mollare prima che GitHub abbia detto la sua.
    const TIMEOUT = 50 * 60 * 1000;
    setStatus("Generazione in corso (report Ads + recommendations + Claude)... "
      + "i report Amazon sono la parte lenta: in genere 10-15 minuti.");
    clearInterval(pollRef.current);
    let tickCount = 0;
    let lastRunStatus = null;
    const mmss = (ms) => {
      const s = Math.round(ms / 1000);
      return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
    };

    const loadPlan = async (fromLabel) => {
      addDebug(`loadPlan(${fromLabel}): reading file`);
      let res = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        try { res = await getRepoFileContents({ token, owner, repo, path: planPath }); }
        catch (e) { addDebug(`read err: ${e.message}`); }
        if (res && res.json) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!res || !res.json) { addDebug("read: nessun JSON dopo retry"); return false; }

      const pl = res.json;
      addDebug(`read OK: ${pl.actions?.length || 0} actions, status=${pl._meta?.status}`);
      clearInterval(pollRef.current);
      if (!pl.actions || pl.actions.length === 0) {
        setPhase("error");
        setStatus("Il planner non ha prodotto azioni valide. Spiegazione: " + (pl._meta?.explanation || "").slice(0, 400));
        return true;
      }
      enterReview(pl);
      return true;
    };

    pollRef.current = setInterval(async () => {
      tickCount++;
      if (Date.now() - start > TIMEOUT) {
        clearInterval(pollRef.current); setPhase("error");
        setStatus(
          lastRunStatus === "completed"
            ? "Il run e' finito ma il blueprint non e' comparso nel repo entro "
              + `${mmss(Date.now() - start)}. Controlla i log del run e il commit su plans/.`
            : `Ho smesso di attendere dopo ${mmss(Date.now() - start)}, ma il run su GitHub `
              + `risulta ancora in corso: NON e' detto che sia fallito. Aprilo dal link, e quando `
              + `lo vedi finito torna qui e usa "Carica ultimo piano" per recuperare il blueprint.`);
        return;
      }

      let runStatus = null;
      if (runId) {
        try {
          const r = await getRun({ token, owner, repo, runId });
          if (r) runStatus = r;
        } catch (e) { addDebug(`getRun err: ${e.message}`); }
        if (runStatus?.status) lastRunStatus = runStatus.status;
        if (runStatus?.status === "completed") {
          if (runStatus.conclusion && runStatus.conclusion !== "success") {
            clearInterval(pollRef.current); setPhase("error");
            setStatus(`Il workflow e' terminato con esito "${runStatus.conclusion}". Controlla i log.`);
            return;
          }
          runSucceeded = true;
        }
      }
      addDebug(`tick ${tickCount}: run=${runStatus?.status || "?"} conc=${runStatus?.conclusion || "?"}`);

      // Tempo trascorso a schermo: un'attesa di 15 minuti senza nessun segnale
      // sembra un blocco, ed e' il motivo per cui viene la tentazione di
      // ricaricare la pagina proprio mentre il workflow sta lavorando.
      if (!runSucceeded) {
        const stato = lastRunStatus === "in_progress" ? "in esecuzione su GitHub"
          : lastRunStatus === "queued" ? "in coda su GitHub"
            : lastRunStatus || "avvio in corso";
        setStatus(`Generazione in corso da ${mmss(Date.now() - start)} (${stato}). `
          + "I report Amazon richiedono in genere 10-15 minuti: puoi lasciare la pagina aperta.");
      }

      if (runSucceeded) {
        const ok = await loadPlan("run-success");
        if (ok) return;
      }

      let commit = null;
      try { commit = await getLatestCommitForPath({ token, owner, repo, path: planPath }); }
      catch (e) { addDebug(`getCommit err: ${e.message}`); }
      if (!commit) { addDebug("commit=null"); return; }
      addDebug(`latestCommit=${commit.sha.substring(0, 7)}`);
      if (commit.sha === beforeCommitSha) return;

      await loadPlan("new-commit");
    }, 8000);
  };

  const downloadBlueprint = () => {
    const blob = new Blob([JSON.stringify({ actions }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `blueprint_${f.marketplace}_${f.asin.trim()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  // Lancia apply-actions.yml e segue il run fino alla fine.
  const runApplyWorkflow = async ({ dryRun, setState }) => {
    const sig = JSON.stringify(actions);
    setState({ state: "running", msg: dryRun ? "Avvio anteprima (non scrive nulla)..." : "Avvio creazione...", url: "" });
    try {
      const before = await latestRunId({ token, owner, repo, workflow: APPLY_WORKFLOW });
      await dispatchWorkflow({
        token, owner, repo, workflow: APPLY_WORKFLOW,
        inputs: {
          marketplace: f.marketplace,
          actions_json: JSON.stringify({ actions }),
          confirm: dryRun ? "NO" : "APPLICA",
          dry_run: dryRun ? "true" : "false",
        },
      });
      const run = await waitForNewRun({
        token, owner, repo, workflow: APPLY_WORKFLOW, afterId: before,
        onTick: s => setState(p => ({ ...p, msg: `Attendo l'avvio del run... ${s}s` })),
      });
      if (!run) {
        setState({ state: "fail", msg: "Non ho visto partire il run. Controlla il tab Actions su GitHub.", url: "" });
        return null;
      }
      setState({ state: "running", msg: dryRun ? "Anteprima in corso..." : "Creazione in corso...", url: run.html_url });
      const done = await followRun({
        token, owner, repo, runId: run.id,
        // 20 minuti: apply-actions.yml ha timeout-minutes 15, e il default di
        // followRun e' esattamente 15 — cioe' avremmo mollato nello stesso
        // istante in cui GitHub decide, senza mai leggere l'esito. Meglio
        // sopravvivere al job che stiamo seguendo.
        timeoutMs: 20 * 60 * 1000,
        onUpdate: i => setState(p => ({ ...p, msg: `${dryRun ? "Anteprima" : "Creazione"}: ${i.status}...`, url: i.html_url })),
      });
      return { done, sig, url: done?.html_url || run.html_url };
    } catch (e) {
      setState({ state: "fail", msg: String(e.message || e), url: "" });
      return null;
    }
  };

  const doPreview = async () => {
    if (!token || !owner || !repo) { setPreview({ state: "fail", msg: "Configura GitHub prima.", url: "" }); return; }
    if (check.errors.length) {
      setPreview({ state: "fail", msg: "Ci sono errori bloccanti nel piano: correggili prima di lanciare l'anteprima.", url: "" });
      return;
    }
    const r = await runApplyWorkflow({ dryRun: true, setState: setPreview });
    if (!r) return;
    if (r.done?.conclusion === "success") {
      setPreviewSig(r.sig);
      setPreview({ state: "ok", msg: "Anteprima riuscita: Amazon accetta questo piano. Ora puoi creare le campagne.", url: r.url });
    } else {
      setPreview({
        state: "fail",
        msg: `Anteprima fallita (esito "${r.done?.conclusion || "sconosciuto"}"). Apri i log: quello che blocca l'anteprima bloccherebbe anche la creazione.`,
        url: r.url,
      });
    }
  };

  const doApply = async () => {
    if (!canApply) return;
    const r = await runApplyWorkflow({ dryRun: false, setState: setApply });
    if (!r) return;
    if (r.done?.conclusion === "success") {
      setApply({ state: "ok", msg: "Campagne create. Il log completo con gli ID e il file di rollback sono negli artefatti del run (sezione Artifacts).", url: r.url });
      setConfirmText("");
      setPreview({ state: "idle", msg: "Piano gia' applicato: rifai l'anteprima se vuoi riapplicarlo.", url: "" });
      setPreviewSig("");
    } else {
      setApply({
        state: "fail",
        msg: `Il run e' finito con esito "${r.done?.conclusion || "sconosciuto"}". Attenzione: puo' voler dire che SOLO UNA PARTE e' stata creata — apri i log e l'artefatto prima di rilanciare, per non creare doppioni.`,
        url: r.url,
      });
    }
  };

  const connected = token && ghUser;
  const statusColor = (s) => (s === "ok" ? C.green : s === "fail" ? C.red : C.accent);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: 14, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 10, color: C.accent, fontWeight: 700, letterSpacing: 2 }}>AMAZON ADS AGENT</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>➕ Nuova campagna da ASIN</div>
          </div>
          <button onClick={onClose} style={btnGhost(C.textMuted)}>← Indietro</button>
        </div>

        {/* Connessione GitHub */}
        <div style={{ background: C.surface, border: `1px solid ${connected ? C.green : C.border}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 8 }}>
            {connected ? `🟢 GitHub: ${ghUser.login}` : "🔗 Connetti GitHub"}
          </div>
          {!connected && (
            <div style={{ fontSize: 10, color: C.textDim, marginBottom: 8, lineHeight: 1.5 }}>
              Serve un Personal Access Token (PAT). Crealo su GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Permessi: Contents (read/write) + Actions (read/write) sul repo.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <input placeholder="owner (il tuo username GitHub)" style={inputStyle} value={owner} onChange={e => setOwner(e.target.value)} />
            <input placeholder="repo (es. amazon-ads-agent)" style={inputStyle} value={repo} onChange={e => setRepo(e.target.value)} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <input placeholder="Incolla qui il Personal Access Token (github_pat_...)" type="password" style={inputStyle} value={token} onChange={e => setToken(e.target.value)} />
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 3 }}>Il token resta solo nel tuo browser (localStorage), non viene inviato da nessuna parte.</div>
          </div>
          {!connected && (
            <button onClick={connect} disabled={connecting} style={btn(C.accent)}>
              {connecting ? "Verifica in corso..." : "Connetti"}
            </button>
          )}
          {connected && (
            <button onClick={() => { setToken(""); setGhUser(null); localStorage.removeItem("gh_token"); }} style={{ ...btnGhost(C.textMuted), fontSize: 11 }}>
              Disconnetti
            </button>
          )}
        </div>

        {phase === "form" && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Marketplace" hint={`Keyword e negative verranno scritte in ${MARKET_LANG[f.marketplace] || "lingua locale"}`}>
                <select style={inputStyle} value={f.marketplace} onChange={e => setField("marketplace", e.target.value)}>
                  {MARKETPLACES.map(m => <option key={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="ASIN principale">
                <input style={inputStyle} value={f.asin} onChange={e => setField("asin", e.target.value)} placeholder="B0XXXXXXX" />
              </Field>
              <Field label="Child ASIN (virgola)" hint="Lascia vuoto se non hai varianti">
                <input style={inputStyle} value={f.children} onChange={e => setField("children", e.target.value)} placeholder="B0YYY,B0ZZZ" />
              </Field>
              <Field label="Mappa ASIN=SKU (virgola)" hint="Da seller lo SKU serve per i product ad">
                <input style={inputStyle} value={f.skus} onChange={e => setField("skus", e.target.value)} placeholder="B0XXX=SKU-A,B0YYY=SKU-B" />
              </Field>
              <Field label="Budget/giorno (EUR)" hint="Tetto COMPLESSIVO: se propone piu' campagne, lo splitta">
                <input type="number" step="0.5" style={inputStyle} value={f.budget} onChange={e => setField("budget", e.target.value)} />
              </Field>
              <Field label="Target ACoS (%)">
                <input type="number" style={inputStyle} value={f.targetAcos} onChange={e => setField("targetAcos", e.target.value)} />
              </Field>
            </div>

            {/* Struttura: gruppo vs singoli child */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, fontWeight: 600 }}>Struttura delle campagne</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
                {STRUCTURES.map(s => {
                  const on = f.structure === s.v;
                  return (
                    <button key={s.v} onClick={() => setField("structure", s.v)}
                      style={{
                        textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                        background: on ? C.bg : "transparent",
                        border: `1px solid ${on ? C.accent : C.border}`,
                        borderRadius: 8, padding: 10,
                      }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: on ? C.accent : C.text, marginBottom: 3 }}>
                        {on ? "● " : "○ "}{s.label}
                      </div>
                      <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.5 }}>{s.hint}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <Field label="Come differiscono i child?" hint="Guida il raggruppamento: colore -> insieme, misura -> ad group separati">
              <input style={inputStyle} value={f.childNote} onChange={e => setField("childNote", e.target.value)} placeholder="es. solo colore / misure S-M-L" />
            </Field>
            <Field label="Testo listing (titolo + bullet + descrizione)" hint="Fonte keyword per prodotti senza storico">
              <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical" }} value={f.listingText} onChange={e => setField("listingText", e.target.value)} />
              <button onClick={pullListingFromRepo} style={{ ...btnGhost(C.accent), padding: "5px 10px", fontSize: 11, marginTop: 6 }}>
                📄 Prendi il listing dal repo
              </button>
            </Field>
            <Field label="Recensioni (opzionale)" hint="Incolla estratti: long-tail e pain point">
              <textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={f.reviewsText} onChange={e => setField("reviewsText", e.target.value)} />
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textMuted, margin: "6px 0 14px" }}>
              <input type="checkbox" checked={f.noAmazonRecs} onChange={e => setField("noAmazonRecs", e.target.checked)} />
              Salta le keyword recommendations di Amazon
            </label>
            <button onClick={generate} disabled={!connected} style={{ ...btn(connected ? C.accent : C.border, connected ? "#fff" : C.textDim), padding: "11px 22px", fontSize: 13 }}>
              ⚡ Genera piano
            </button>
            <button onClick={async () => {
              if (!connected || !f.asin.trim()) { setStatus("Serve connessione e ASIN."); return; }
              setStatus("Cerco piano esistente nel repo...");
              addDebug("load-existing");
              const res = await getRepoFileContents({ token, owner, repo, path: planPath }).catch(() => null);
              if (!res || !res.json) { setStatus(`Nessun piano trovato per ${f.marketplace}/${f.asin}. Genera un piano nuovo.`); return; }
              const pl = res.json;
              if (!pl.actions?.length) { setStatus("Piano esistente vuoto. " + (pl._meta?.explanation || "").slice(0, 200)); return; }
              enterReview(pl);
            }} style={{ ...btnGhost(C.accent), padding: "11px 20px", fontSize: 12, marginLeft: 8 }}>
              📂 Carica ultimo piano
            </button>
            {status && <div style={{ marginTop: 10, fontSize: 12, color: C.red }}>{status}</div>}
          </div>
        )}

        {phase === "waiting" && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 28, textAlign: "center" }}>
            <div style={{ width: 34, height: 34, border: `3px solid ${C.border}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin .7s linear infinite", margin: "0 auto 14px" }} />
            <div style={{ color: C.accent, fontWeight: 600, fontSize: 13 }}>{status}</div>
            {runUrl && <div style={{ marginTop: 8, fontSize: 11 }}><a href={runUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>apri il run su GitHub →</a></div>}
            <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <button onClick={async () => {
                clearInterval(pollRef.current);
                setStatus("Lettura diretta del file dal repo...");
                addDebug("MANUAL: forced load");
                const res = await getRepoFileContents({ token, owner, repo, path: planPath }).catch(() => null);
                if (!res || !res.json) { setPhase("error"); setStatus("File non trovato nel repo. Il workflow potrebbe non essere ancora finito."); return; }
                const pl = res.json;
                if (!pl.actions?.length) { setPhase("error"); setStatus("Nessuna azione nel piano. " + (pl._meta?.explanation || "").slice(0, 300)); return; }
                enterReview(pl);
              }} style={{ ...btnGhost(C.accent), fontSize: 11 }}>
                📥 Carica direttamente (bypassa attesa)
              </button>
              <button onClick={() => { clearInterval(pollRef.current); setPhase("form"); setStatus(""); }} style={{ ...btnGhost(C.textMuted), fontSize: 11 }}>
                ✕ Annulla
              </button>
            </div>
            {debug.length > 0 && (
              <details style={{ marginTop: 14, textAlign: "left" }}>
                <summary style={{ fontSize: 10, color: C.textDim, cursor: "pointer" }}>Debug ({debug.length})</summary>
                <pre style={{ fontSize: 10, color: C.textDim, background: C.bg, padding: 8, borderRadius: 6, marginTop: 6, maxHeight: 200, overflow: "auto" }}>{debug.join("\n")}</pre>
              </details>
            )}
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {phase === "error" && (
          <div style={{ background: C.surface, border: `1px solid ${C.red}`, borderRadius: 10, padding: 18 }}>
            <div style={{ color: C.red, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>⚠️ {status}</div>
            {runUrl && <div style={{ fontSize: 11, marginBottom: 10 }}><a href={runUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>apri i log del run →</a></div>}
            <button onClick={() => { setPhase("form"); setStatus(""); }} style={btn(C.accent)}>← Torna al form</button>
          </div>
        )}

        {phase === "review" && (
          <div>
            {savedEdit && (
              <div style={{ background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 10, padding: 12, marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ fontSize: 11, color: C.textMuted, flex: 1, lineHeight: 1.5 }}>
                  Su questo ASIN avevi delle modifiche non applicate, salvate in questo browser.
                </div>
                <button onClick={() => { setActions(savedEdit); setSavedEdit(null); }} style={{ ...btnGhost(C.accent), fontSize: 11 }}>Riprendi le mie modifiche</button>
                <button onClick={() => { try { localStorage.removeItem(editKey); } catch { /* noop */ } setSavedEdit(null); }} style={{ ...btnGhost(C.textMuted), fontSize: 11 }}>Scarta</button>
              </div>
            )}

            {plan?._meta && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.accent, marginBottom: 6 }}>💡 Piano proposto</div>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 8, lineHeight: 1.6 }}>
                  {plan._meta.had_history ? "Con storico ads" : "Senza storico (cold start)"} • {plan._meta.recs_count} keyword da Amazon
                  {plan._meta.sqp_used ? " • volume di ricerca reale incluso" : ""}
                  {plan._meta.language ? ` • keyword in ${plan._meta.language}` : ""}
                  {plan._meta.structure ? ` • struttura: ${(STRUCTURES.find(s => s.v === plan._meta.structure) || {}).label || plan._meta.structure}` : ""}
                  {plan._meta.generated_at ? ` • generato ${new Date(plan._meta.generated_at).toLocaleString("it-IT")}` : ""}
                </div>
                {plan._meta.existing_campaigns?.length > 0 && (
                  <div style={{ fontSize: 10, color: C.textDim, marginBottom: 8, lineHeight: 1.6 }}>
                    Campagne gia' esistenti su questi ASIN (passate al modello per evitare doppioni):{" "}
                    {plan._meta.existing_campaigns.map(e => `${e.name}${e.ended ? " (ended)" : e.state !== "ENABLED" ? ` (${e.state.toLowerCase()})` : ""}`).join(", ")}
                  </div>
                )}
                <div>{renderMd(plan._meta.explanation)}</div>
                {plan._meta.warnings?.length > 0 && (
                  <div style={{ marginTop: 10, padding: 10, background: C.bg, borderRadius: 7, border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: C.red, fontWeight: 600, marginBottom: 4 }}>Avvisi dalla generazione:</div>
                    {plan._meta.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>• {w}</div>)}
                  </div>
                )}
              </div>
            )}

            <ReviewSummary check={check} meta={plan?._meta} marketplace={f.marketplace} />

            <BlueprintEditor actions={actions} setActions={setActions} />

            {/* Gate: anteprima -> APPLICA, come nel pannello azioni */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>Creazione in due passi</div>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 12, lineHeight: 1.6 }}>
                L'anteprima gira lo stesso workflow in modalita' dry run: non crea niente, ma fa vedere
                se Amazon accetta il piano. Solo dopo un'anteprima riuscita si sblocca la creazione.
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <button onClick={doPreview}
                  disabled={preview.state === "running" || apply.state === "running" || check.errors.length > 0}
                  style={{
                    ...btn(check.errors.length ? C.border : C.accent, check.errors.length ? C.textDim : "#fff"),
                    padding: "10px 18px",
                    cursor: check.errors.length ? "not-allowed" : "pointer",
                  }}>
                  {preview.state === "running" ? "Anteprima in corso..." : "1. Crea anteprima"}
                </button>
                {previewValid && <span style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>✓ anteprima valida</span>}
              </div>
              {preview.msg && (
                <div style={{ fontSize: 11, color: statusColor(preview.state), marginBottom: 12, lineHeight: 1.5 }}>
                  {preview.msg}
                  {preview.url && <> <a href={preview.url} target="_blank" rel="noreferrer" style={{ color: C.accent }}>apri il run →</a></>}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input value={confirmText} onChange={e => setConfirmText(e.target.value)}
                  placeholder="scrivi APPLICA" disabled={!previewValid} aria-label="Conferma digitando APPLICA"
                  style={{ ...inputStyle, maxWidth: 160, opacity: previewValid ? 1 : 0.5 }} />
                <button onClick={doApply} disabled={!canApply || apply.state === "running"}
                  style={{
                    ...btn(canApply ? (C.green || "#2ea043") : C.border, canApply ? "#fff" : C.textDim),
                    padding: "10px 18px", cursor: canApply ? "pointer" : "not-allowed",
                  }}>
                  {apply.state === "running" ? "Creazione in corso..." : `2. Crea ${check.stats.campaigns} campagna/e`}
                </button>
                <button onClick={downloadBlueprint} style={btnGhost(C.accent)}>⬇️ Scarica blueprint.json</button>
                <button onClick={() => { setPhase("form"); setPlan(null); setActions([]); }} style={btnGhost(C.textMuted)}>↺ Nuovo piano</button>
              </div>
              {apply.msg && (
                <div style={{ marginTop: 12, fontSize: 12, color: statusColor(apply.state), lineHeight: 1.6 }}>
                  {apply.msg}
                  {apply.url && <> <a href={apply.url} target="_blank" rel="noreferrer" style={{ color: C.accent }}>apri il run →</a></>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
