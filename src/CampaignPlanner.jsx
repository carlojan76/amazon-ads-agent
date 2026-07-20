import { useState, useEffect, useRef } from "react";
import { C } from "./theme";
import {
  getUser,
  dispatchWorkflow, findLatestRun, getRun, getRepoFileContents,
  getLatestCommitForPath,
} from "./github";

const MARKETPLACES = ["IT", "FR", "DE", "ES", "UK", "NL", "SE", "PL", "BE", "IE"];
const KW_MATCH = ["EXACT", "PHRASE", "BROAD"];
const NEG_MATCH = ["NEGATIVE_EXACT", "NEGATIVE_PHRASE"];
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
        return (
          <div key={ci} style={{ background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>
                CAMPAGNA {a.campaign?.targetingType || "MANUAL"}
              </div>
              <button onClick={() => removeCampaign(ci)} style={{ ...btn("transparent", C.red), border: `1px solid ${C.red}`, padding: "4px 10px" }}>✕ Rimuovi</button>
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
              <Field label="Stato iniziale" hint="Consiglio: PAUSED, la attivi a mano dopo il controllo">
                <select style={inputStyle} value={c.state || "PAUSED"} onChange={e => upd(ci, x => { x.campaign.state = e.target.value; return x; })}>
                  <option>PAUSED</option><option>ENABLED</option>
                </select>
              </Field>
            </div>

            {(a.adGroups || []).map((g, gi) => (
              <AdGroupEditor key={gi} g={g}
                onChange={ng => upd(ci, x => { x.adGroups[gi] = ng; return x; })}
                onRemove={() => upd(ci, x => { x.adGroups.splice(gi, 1); return x; })}
                isAuto={(c.targetingType || "MANUAL") === "AUTO"} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function AdGroupEditor({ g, onChange, onRemove, isAuto }) {
  const set = fn => onChange(fn(structuredClone(g)));
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <input style={{ ...inputStyle, maxWidth: 260, fontWeight: 600 }} value={g.name || ""} onChange={e => set(x => { x.name = e.target.value; return x; })} />
        <button onClick={onRemove} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}`, padding: "3px 8px" }}>✕ ad group</button>
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
          <button onClick={() => set(x => { x.products.splice(pi, 1); return x; })} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}`, padding: "4px 8px" }}>✕</button>
        </div>
      ))}
      <button onClick={() => set(x => { (x.products ||= []).push({ sku: "", asin: "" }); return x; })} style={{ ...btn("transparent", C.accent), border: `1px dashed ${C.accent}`, padding: "5px 10px", fontSize: 11 }}>+ prodotto</button>

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
              <button onClick={() => set(x => { x.keywords.splice(ki, 1); return x; })} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}`, padding: "4px 8px" }}>✕</button>
            </div>
          ))}
          <button onClick={() => set(x => { (x.keywords ||= []).push({ keywordText: "", matchType: "EXACT", bid: g.defaultBid || 0.4 }); return x; })} style={{ ...btn("transparent", C.accent), border: `1px dashed ${C.accent}`, padding: "5px 10px", fontSize: 11 }}>+ keyword</button>
        </>
      )}

      {/* Auto targets (solo AUTO) */}
      {isAuto && (g.autoTargets || []).length > 0 && (
        <>
          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, margin: "12px 0 4px" }}>Auto targets (bid)</div>
          {(g.autoTargets || []).map((t, ti) => (
            <div key={ti} style={{ display: "flex", gap: 6, marginBottom: 5, alignItems: "center" }}>
              <span style={{ flex: 2, fontSize: 11, color: C.textMuted }}>{t.expressionType}</span>
              <input type="number" step="0.05" style={{ ...inputStyle, width: 90 }} value={t.bid ?? ""} onChange={e => set(x => { x.autoTargets[ti].bid = parseFloat(e.target.value) || 0; return x; })} />
            </div>
          ))}
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
          <button onClick={() => set(x => { x.negatives.splice(ni, 1); return x; })} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}`, padding: "4px 8px" }}>✕</button>
        </div>
      ))}
      <button onClick={() => set(x => { (x.negatives ||= []).push({ keywordText: "", matchType: "NEGATIVE_EXACT" }); return x; })} style={{ ...btn("transparent", C.textMuted), border: `1px dashed ${C.border}`, padding: "5px 10px", fontSize: 11 }}>+ negative</button>
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
    seedKeywords: "", noAmazonRecs: false, days: "60",
  });
  const setField = (k, v) => setF(p => ({ ...p, [k]: v }));

  // stato flusso
  const [phase, setPhase] = useState("form"); // form | waiting | review | error
  const [status, setStatus] = useState("");
  const [runUrl, setRunUrl] = useState("");
  const [plan, setPlan] = useState(null); // { actions, _meta }
  const [actions, setActions] = useState([]);
  const [applyMsg, setApplyMsg] = useState("");
  const pollRef = useRef(null);

  useEffect(() => { localStorage.setItem("gh_owner", owner); }, [owner]);
  useEffect(() => { localStorage.setItem("gh_repo", repo); }, [repo]);
  useEffect(() => { if (token) localStorage.setItem("gh_token", token); }, [token]);
  useEffect(() => () => clearInterval(pollRef.current), []);
  useEffect(() => {
    if (token && !ghUser) getUser(token).then(setGhUser).catch(() => { setToken(""); localStorage.removeItem("gh_token"); });
  }, [token]); // eslint-disable-line

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

  const planPath = `plans/${f.marketplace}/${f.asin.trim()}.json`;

  const generate = async () => {
    if (!token || !owner || !repo) { setStatus("Configura e connetti GitHub prima."); return; }
    if (!f.asin.trim()) { setStatus("Inserisci un ASIN."); return; }
    setPhase("waiting"); setStatus("Leggo lo stato attuale del file..."); setPlan(null); setActions([]);

    // Prendo l'ultimo commit che ha toccato il file: la Commits API e' fresca,
    // la Contents API ha cache lunga e non e' affidabile per rilevare cambi.
    let beforeCommitSha = null;
    try {
      const prev = await getLatestCommitForPath({ token, owner, repo, path: planPath });
      beforeCommitSha = prev?.sha || null;
    } catch { /* file non esiste ancora */ }

    setStatus("Avvio del workflow di generazione...");
    try {
      await dispatchWorkflow({
        token, owner, repo, workflow: PLAN_WORKFLOW,
        inputs: {
          marketplace: f.marketplace, asin: f.asin.trim(), children: f.children.trim(),
          skus: f.skus.trim(), budget: f.budget, target_acos: f.targetAcos,
          child_note: f.childNote, listing_text: f.listingText, reviews_text: f.reviewsText,
          seed_keywords: f.seedKeywords, no_amazon_recs: f.noAmazonRecs ? "true" : "false", days: f.days,
        },
      });
    } catch (e) { setPhase("error"); setStatus(String(e.message || e)); return; }

    // trova il run (per link + rilevare fallimenti)
    let runId = null;
    setTimeout(async () => {
      const run = await findLatestRun({ token, owner, repo, workflow: PLAN_WORKFLOW });
      if (run) { runId = run.id; setRunUrl(run.html_url); }
    }, 4000);

    const start = Date.now();
    const TIMEOUT = 8 * 60 * 1000;
    setStatus("Generazione in corso (fetch dati + recommendations + Claude)... puo' richiedere 1-3 minuti.");
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      if (Date.now() - start > TIMEOUT) {
        clearInterval(pollRef.current); setPhase("error");
        setStatus("Timeout: il workflow non ha prodotto il blueprint in tempo. Controlla i log del run.");
        return;
      }
      // fallimento del run?
      if (runId) {
        const r = await getRun({ token, owner, repo, runId });
        if (r && r.status === "completed" && r.conclusion && r.conclusion !== "success") {
          clearInterval(pollRef.current); setPhase("error");
          setStatus(`Il workflow e' terminato con esito "${r.conclusion}". Controlla i log.`);
          return;
        }
      }
      // C'e' un commit nuovo sul path? (Commits API = sempre fresca)
      let commit = null;
      try { commit = await getLatestCommitForPath({ token, owner, repo, path: planPath }); }
      catch { /* retry */ }
      if (!commit || commit.sha === beforeCommitSha) return; // niente ancora

      // C'e' un commit nuovo: leggo il contenuto (potrebbe volerci qualche
      // secondo perche' la Contents API ha cache; provo con backoff).
      let res = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        try { res = await getRepoFileContents({ token, owner, repo, path: planPath }); }
        catch { /* retry */ }
        if (res && res.json) break;
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!res || !res.json) return; // riprovero' al prossimo tick

      clearInterval(pollRef.current);
      const pl = res.json;
      if (!pl.actions || pl.actions.length === 0) {
        setPhase("error");
        setStatus("Il planner non ha prodotto azioni valide. Spiegazione: " + (pl._meta?.explanation || "").slice(0, 400));
        return;
      }
      setPlan(pl); setActions(pl.actions); setPhase("review"); setStatus("");
    }, 8000);
  };

  const downloadBlueprint = () => {
    const blob = new Blob([JSON.stringify({ actions }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `blueprint_${f.marketplace}_${f.asin.trim()}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const applyPlan = async () => {
    if (!token || !owner || !repo) { setApplyMsg("Configura GitHub prima."); return; }
    if (!confirm(`Creare ${actions.length} campagna/e su ${f.marketplace}? Partono nello stato indicato (consigliato PAUSED).`)) return;
    setApplyMsg("Invio al workflow di apply...");
    try {
      await dispatchWorkflow({
        token, owner, repo, workflow: APPLY_WORKFLOW,
        inputs: {
          marketplace: f.marketplace,
          actions_json: JSON.stringify({ actions }),
          confirm: "APPLICA",
          dry_run: false,
        },
      });
      const run = await findLatestRun({ token, owner, repo, workflow: APPLY_WORKFLOW });
      setApplyMsg("Apply avviato ✅ " + (run ? "Segui il run su GitHub." : ""));
      if (run) setRunUrl(run.html_url);
    } catch (e) { setApplyMsg("Errore: " + (e.message || e)); }
  };

  const connected = token && ghUser;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: 14, fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 10, color: C.accent, fontWeight: 700, letterSpacing: 2 }}>AMAZON ADS AGENT</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>➕ Nuova campagna da ASIN</div>
          </div>
          <button onClick={onClose} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}` }}>← Indietro</button>
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
            <button onClick={() => { setToken(""); setGhUser(null); localStorage.removeItem("gh_token"); }} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}`, fontSize: 11 }}>
              Disconnetti
            </button>
          )}
        </div>

        {phase === "form" && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Marketplace">
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
              <Field label="Budget/giorno (EUR)">
                <input type="number" step="0.5" style={inputStyle} value={f.budget} onChange={e => setField("budget", e.target.value)} />
              </Field>
              <Field label="Target ACoS (%)">
                <input type="number" style={inputStyle} value={f.targetAcos} onChange={e => setField("targetAcos", e.target.value)} />
              </Field>
            </div>
            <Field label="Come differiscono i child?" hint="Guida il raggruppamento: colore -> insieme, misura -> ad group separati">
              <input style={inputStyle} value={f.childNote} onChange={e => setField("childNote", e.target.value)} placeholder="es. solo colore / misure S-M-L" />
            </Field>
            <Field label="Testo listing (titolo + bullet + descrizione)" hint="Fonte keyword per prodotti senza storico">
              <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical" }} value={f.listingText} onChange={e => setField("listingText", e.target.value)} />
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
            {status && <div style={{ marginTop: 10, fontSize: 12, color: C.red }}>{status}</div>}
          </div>
        )}

        {phase === "waiting" && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 28, textAlign: "center" }}>
            <div style={{ width: 34, height: 34, border: `3px solid ${C.border}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin .7s linear infinite", margin: "0 auto 14px" }} />
            <div style={{ color: C.accent, fontWeight: 600, fontSize: 13 }}>{status}</div>
            {runUrl && <div style={{ marginTop: 8, fontSize: 11 }}><a href={runUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>apri il run su GitHub →</a></div>}
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
            {plan?._meta && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.accent, marginBottom: 6 }}>💡 Piano proposto</div>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 8 }}>
                  {plan._meta.had_history ? "Con storico ads" : "Senza storico (cold start)"} • {plan._meta.recs_count} keyword da Amazon • generato {plan._meta.generated_at ? new Date(plan._meta.generated_at).toLocaleString("it-IT") : ""}
                </div>
                <div>{renderMd(plan._meta.explanation)}</div>
                {plan._meta.warnings?.length > 0 && (
                  <div style={{ marginTop: 10, padding: 10, background: C.bg, borderRadius: 7, border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: C.red, fontWeight: 600, marginBottom: 4 }}>Avvisi:</div>
                    {plan._meta.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: C.textMuted }}>• {w}</div>)}
                  </div>
                )}
              </div>
            )}

            <BlueprintEditor actions={actions} setActions={setActions} />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button onClick={applyPlan} style={{ ...btn(C.green || "#2ea043"), padding: "11px 22px", fontSize: 13 }}>🚀 Crea le campagne</button>
              <button onClick={downloadBlueprint} style={{ ...btn("transparent", C.accent), border: `1px solid ${C.accent}` }}>⬇️ Scarica blueprint.json</button>
              <button onClick={() => { setPhase("form"); setPlan(null); setActions([]); }} style={{ ...btn("transparent", C.textMuted), border: `1px solid ${C.border}` }}>↺ Nuovo piano</button>
            </div>
            {applyMsg && <div style={{ marginTop: 10, fontSize: 12, color: applyMsg.startsWith("Errore") ? C.red : C.green }}>{applyMsg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
