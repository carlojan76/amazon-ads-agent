import { useEffect, useState } from "react";
import { C } from "./theme";
import { startDeviceFlow, pollForToken, getUser, dispatchWorkflow, findLatestRun } from "./github";

const TYPE_LABELS = {
  update_bid: "💶 Modifica bid",
  pause_keyword: "⏸ Pausa keyword",
  enable_keyword: "▶️ Riattiva keyword",
  add_negative: "🚫 Aggiungi negativa",
  update_budget: "💰 Modifica budget",
  pause_campaign: "⏸ Pausa campagna",
  enable_campaign: "▶️ Riattiva campagna",
};

const MATCH_TYPES = ["NEGATIVE_EXACT", "NEGATIVE_PHRASE"];

let uid = 0;
const nextId = () => `a${Date.now()}_${uid++}`;

function describeAction(a) {
  switch (a.type) {
    case "update_bid":
      return `💶 BID  "${a.keyword || a.keywordId || "?"}": €${a.old_bid ?? "?"} → €${a.new_bid ?? "?"}`;
    case "pause_keyword":
      return `⏸ PAUSA keyword "${a.keyword || a.keywordId || "?"}"`;
    case "enable_keyword":
      return `▶️ RIATTIVA keyword "${a.keyword || a.keywordId || "?"}"`;
    case "add_negative": {
      const lvl = a.adGroupId ? "ad group" : "campagna";
      return `🚫 NEGATIVA "${a.keywordText || "?"}" [${a.matchType || "NEGATIVE_EXACT"}] a livello ${lvl} (camp ${a.campaign || a.campaignId || "?"})`;
    }
    case "update_budget":
      return `💰 BUDGET "${a.campaign || a.campaignId || "?"}": €${a.old_budget ?? "?"} → €${a.new_budget ?? "?"}/giorno`;
    case "pause_campaign":
      return `⏸ PAUSA campagna "${a.campaign || a.campaignId || "?"}"`;
    case "enable_campaign":
      return `▶️ RIATTIVA campagna "${a.campaign || a.campaignId || "?"}"`;
    default:
      return `? ${a.type}`;
  }
}

function isValidAction(a) {
  if (!(a.type in TYPE_LABELS)) return false;
  if (["update_bid", "pause_keyword", "enable_keyword"].includes(a.type) && !a.keywordId) return false;
  if (a.type === "update_bid" && typeof a.new_bid !== "number") return false;
  if (a.type === "add_negative" && (!a.campaignId || !a.keywordText)) return false;
  if (a.type === "add_negative" && a.matchType && !MATCH_TYPES.includes(a.matchType)) return false;
  if (["update_budget", "pause_campaign", "enable_campaign"].includes(a.type) && !a.campaignId) return false;
  if (a.type === "update_budget" && typeof a.new_budget !== "number") return false;
  return true;
}

function AddActionForm({ onAdd, onCancel }) {
  const [type, setType] = useState("update_bid");
  const [f, setF] = useState({});
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const submit = () => {
    const a = { type, ...f };
    if (a.new_bid !== undefined) a.new_bid = parseFloat(a.new_bid);
    if (a.new_budget !== undefined) a.new_budget = parseFloat(a.new_budget);
    if (!isValidAction(a)) return;
    onAdd(a);
    setF({});
  };

  const inputStyle = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text, fontSize: 12, outline: "none", fontFamily: "inherit", width: "100%" };
  const label = { fontSize: 10, color: C.textDim, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 };

  const field = (k, ph, numeric = false) => (
    <div style={{ flex: 1, minWidth: 120 }}>
      <div style={label}>{ph}</div>
      <input value={f[k] ?? ""} onChange={e => set(k, numeric ? e.target.value : e.target.value)}
        type={numeric ? "number" : "text"} step={numeric ? "0.01" : undefined}
        placeholder={ph} style={inputStyle} />
    </div>
  );

  return (
    <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={label}>Tipo azione</div>
          <select value={type} onChange={e => { setType(e.target.value); setF({}); }} style={inputStyle}>
            {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        {["update_bid", "pause_keyword", "enable_keyword"].includes(type) && <>
          {field("keywordId", "keywordId")}
          {field("keyword", "nome keyword (descrittivo)")}
        </>}
        {type === "update_bid" && <>
          {field("old_bid", "bid attuale (opz.)", true)}
          {field("new_bid", "nuovo bid €", true)}
        </>}
        {type === "add_negative" && <>
          {field("campaignId", "campaignId")}
          {field("campaign", "nome campagna (descrittivo)")}
          {field("adGroupId", "adGroupId (opz. — vuoto = livello campagna)")}
          {field("keywordText", "testo da negativizzare")}
          <div style={{ flex: 1, minWidth: 120 }}>
            <div style={label}>matchType</div>
            <select value={f.matchType || "NEGATIVE_EXACT"} onChange={e => set("matchType", e.target.value)} style={inputStyle}>
              {MATCH_TYPES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </>}
        {(type === "update_budget" || type === "pause_campaign" || type === "enable_campaign") && <>
          {field("campaignId", "campaignId")}
          {field("campaign", "nome campagna (descrittivo)")}
        </>}
        {type === "update_budget" && <>
          {field("old_budget", "budget attuale (opz.)", true)}
          {field("new_budget", "nuovo budget €/giorno", true)}
        </>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 14px", color: C.textMuted, fontSize: 12, cursor: "pointer" }}>Annulla</button>
        <button onClick={submit} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "7px 16px", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>+ Aggiungi</button>
      </div>
    </div>
  );
}

function ActionRow({ action, onToggle, onEdit, onRemove }) {
  const valid = isValidAction(action);
  const editableField = action.type === "update_bid" ? "new_bid" : action.type === "update_budget" ? "new_budget" : null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
      borderBottom: `1px solid ${C.border}`, background: !valid ? C.redDim : action.included ? "transparent" : "rgba(255,255,255,0.015)",
      opacity: action.included ? 1 : 0.5,
    }}>
      <input type="checkbox" checked={!!action.included} onChange={() => onToggle(action.id)} disabled={!valid}
        style={{ width: 16, height: 16, cursor: valid ? "pointer" : "not-allowed", flexShrink: 0 }} />
      <div style={{ flex: 1, fontSize: 12, color: C.text }}>
        {describeAction(action)}
        {!valid && <span style={{ color: C.red, fontSize: 10, marginLeft: 8 }}>⚠️ campi obbligatori mancanti</span>}
      </div>
      {editableField && (
        <input type="number" step="0.01" value={action[editableField] ?? ""} onChange={e => onEdit(action.id, editableField, parseFloat(e.target.value))}
          style={{ width: 90, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px", color: C.accent, fontSize: 12, fontFamily: "monospace", outline: "none" }} />
      )}
      <button onClick={() => onRemove(action.id)} title="Rimuovi"
        style={{ background: "transparent", border: "none", color: C.textDim, fontSize: 14, cursor: "pointer", padding: 4 }}>✕</button>
    </div>
  );
}

export default function ActionsPanel({ initialActions, marketplace }) {
  const [actions, setActions] = useState(() =>
    initialActions.map(a => ({ ...a, id: nextId(), included: isValidAction(a) }))
  );
  const [showAdd, setShowAdd] = useState(false);

  // GitHub connection state
  const [ghClientId, setGhClientId] = useState(() => localStorage.getItem("gh_client_id") || import.meta.env?.VITE_GITHUB_CLIENT_ID || "");
  const [ghRepo, setGhRepo] = useState(() => localStorage.getItem("gh_repo") || import.meta.env?.VITE_GITHUB_REPO || "");
  const [ghWorkflow, setGhWorkflow] = useState(() => localStorage.getItem("gh_workflow") || "apply-actions.yml");
  const [ghToken, setGhToken] = useState(() => localStorage.getItem("gh_token") || "");
  const [ghUser, setGhUser] = useState(null);
  const [ghMarketplace, setGhMarketplace] = useState(marketplace || "IT");
  const [showGhSettings, setShowGhSettings] = useState(!ghClientId || !ghRepo);

  const [deviceInfo, setDeviceInfo] = useState(null); // { user_code, verification_uri, secondsLeft }
  const [connecting, setConnecting] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [confirmText, setConfirmText] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null); // { ok, message, runUrl }

  useEffect(() => { localStorage.setItem("gh_client_id", ghClientId); }, [ghClientId]);
  useEffect(() => { localStorage.setItem("gh_repo", ghRepo); }, [ghRepo]);
  useEffect(() => { localStorage.setItem("gh_workflow", ghWorkflow); }, [ghWorkflow]);
  useEffect(() => {
    if (ghToken) { localStorage.setItem("gh_token", ghToken); getUser(ghToken).then(setGhUser).catch(() => { setGhToken(""); setGhUser(null); }); }
    else { localStorage.removeItem("gh_token"); setGhUser(null); }
  }, [ghToken]);

  const selected = actions.filter(a => a.included && isValidAction(a));

  const toggle = id => setActions(prev => prev.map(a => a.id === id ? { ...a, included: !a.included } : a));
  const edit = (id, field, value) => setActions(prev => prev.map(a => a.id === id ? { ...a, [field]: value } : a));
  const remove = id => setActions(prev => prev.filter(a => a.id !== id));
  const addAction = a => { setActions(prev => [...prev, { ...a, id: nextId(), included: true }]); setShowAdd(false); };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify({ actions: selected.map(({ id, included, ...rest }) => rest) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `actions_${ghMarketplace || "confirmed"}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const connectGithub = async () => {
    if (!ghClientId) { setShowGhSettings(true); return; }
    setConnecting(true);
    try {
      const d = await startDeviceFlow(ghClientId, "repo");
      setDeviceInfo({ user_code: d.user_code, verification_uri: d.verification_uri, secondsLeft: d.expires_in });
      const token = await pollForToken(ghClientId, d.device_code, d.interval, d.expires_in,
        secondsLeft => setDeviceInfo(prev => prev && ({ ...prev, secondsLeft })));
      setGhToken(token);
      setDeviceInfo(null);
    } catch (err) {
      setApplyResult({ ok: false, message: err.message });
      setDeviceInfo(null);
    } finally {
      setConnecting(false);
    }
  };

  const disconnectGithub = () => { setGhToken(""); setApplyResult(null); };

  const apply = async () => {
    if (!ghToken || !ghRepo) { setShowGhSettings(true); return; }
    const [owner, repo] = ghRepo.split("/").map(s => s.trim());
    if (!owner || !repo) { setApplyResult({ ok: false, message: "Repo non valido, usa il formato owner/repo" }); return; }

    setApplying(true);
    setApplyResult(null);
    try {
      const actionsJson = JSON.stringify({ actions: selected.map(({ id, included, ...rest }) => rest) });
      await dispatchWorkflow({
        token: ghToken, owner, repo, workflow: ghWorkflow,
        inputs: {
          marketplace: ghMarketplace,
          actions_json: actionsJson,
          confirm: dryRun ? "NO" : "APPLICA",
          dry_run: String(dryRun),
        },
      });
      let runUrl = null;
      try {
        const run = await findLatestRun({ token: ghToken, owner, repo, workflow: ghWorkflow });
        runUrl = run?.html_url || null;
      } catch { /* best-effort */ }
      setApplyResult({ ok: true, message: dryRun ? "Anteprima avviata su GitHub Actions." : "Applicazione avviata su GitHub Actions.", runUrl });
      setConfirmText("");
    } catch (err) {
      setApplyResult({ ok: false, message: err.message });
    } finally {
      setApplying(false);
    }
  };

  const inputStyle = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text, fontSize: 12, outline: "none", fontFamily: "inherit" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
          ✅ Azioni proposte — {selected.length} selezionate su {actions.length}
        </div>
        <button onClick={() => setShowAdd(v => !v)}
          style={{ background: showAdd ? C.border : C.accentGlow, border: `1px solid ${C.accent}`, borderRadius: 7, padding: "7px 14px", color: C.accent, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
          {showAdd ? "✕ Chiudi" : "+ Aggiungi azione manuale"}
        </button>
      </div>

      {showAdd && <AddActionForm onAdd={addAction} onCancel={() => setShowAdd(false)} />}

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
        {actions.length === 0
          ? <div style={{ padding: 30, textAlign: "center", color: C.textDim, fontSize: 12 }}>
              Nessuna azione proposta nei dati caricati. Usa "Aggiungi azione manuale" per crearne una, oppure vai su AI Advisor per generarne.
            </div>
          : <div style={{ maxHeight: 420, overflowY: "auto" }}>
              {actions.map(a => <ActionRow key={a.id} action={a} onToggle={toggle} onEdit={edit} onRemove={remove} />)}
            </div>}
      </div>

      {/* Esporta / Applica */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>🚀 Esporta o applica le azioni selezionate</div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <button onClick={downloadJson} disabled={selected.length === 0}
            style={{ background: C.blueDim, border: `1px solid ${C.blue}`, borderRadius: 7, padding: "9px 16px", color: C.blue, fontWeight: 700, fontSize: 12, cursor: selected.length ? "pointer" : "default", opacity: selected.length ? 1 : 0.5 }}>
            ⬇️ Scarica actions.json
          </button>
        </div>
        <div style={{ fontSize: 10, color: C.textDim, marginBottom: 16 }}>
          Il file scaricato può essere incollato nel campo "actions_json" del workflow "Apply Amazon Ads Changes" (tab Actions su GitHub) — nessuna configurazione extra richiesta.
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Oppure applica direttamente da qui via GitHub Actions</div>
            <button onClick={() => setShowGhSettings(v => !v)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 10px", color: C.textMuted, fontSize: 11, cursor: "pointer" }}>⚙️ Config</button>
          </div>

          {showGhSettings && (
            <div style={{ background: C.surface2, borderRadius: 8, padding: 12, marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 3 }}>GitHub OAuth Client ID (Device Flow abilitato)</div>
                <input value={ghClientId} onChange={e => setGhClientId(e.target.value)} placeholder="Iv1.xxxxxxxxxxxxxxxx" style={{ ...inputStyle, width: "100%" }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 3 }}>Repository (owner/repo)</div>
                <input value={ghRepo} onChange={e => setGhRepo(e.target.value)} placeholder="tuo-utente/amazon-ads-agent" style={{ ...inputStyle, width: "100%" }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 3 }}>Nome file workflow</div>
                <input value={ghWorkflow} onChange={e => setGhWorkflow(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
              </div>
              <div style={{ fontSize: 10, color: C.textDim }}>
                Vedi README per creare l'OAuth App con Device Flow. Il token resta solo nel tuo browser (localStorage) e non viene mai inviato ad Anthropic o a terzi: viene usato solo per chiamare l'API di GitHub.
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 11, color: C.textDim }}>Marketplace:</div>
            <input value={ghMarketplace} onChange={e => setGhMarketplace(e.target.value.toUpperCase())} style={{ ...inputStyle, width: 60, textAlign: "center" }} />
            {!ghUser ? (
              <button onClick={connectGithub} disabled={connecting}
                style={{ background: C.accentGlow, border: `1px solid ${C.accent}`, borderRadius: 7, padding: "8px 14px", color: C.accent, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                {connecting ? "⏳ Connessione..." : "🔗 Connetti con GitHub"}
              </button>
            ) : (
              <>
                <div style={{ fontSize: 12, color: C.green }}>✅ Connesso come @{ghUser.login}</div>
                <button onClick={disconnectGithub} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 10px", color: C.textMuted, fontSize: 11, cursor: "pointer" }}>Disconnetti</button>
              </>
            )}
          </div>

          {deviceInfo && (
            <div style={{ background: C.accentGlow, border: `1px solid ${C.accent}`, borderRadius: 8, padding: 14, marginBottom: 12, textAlign: "center" }}>
              <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
                Apri <a href={deviceInfo.verification_uri} target="_blank" rel="noreferrer" style={{ color: C.accent }}>{deviceInfo.verification_uri}</a> e inserisci il codice:
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: 4, color: C.accent, fontFamily: "monospace", marginBottom: 6 }}>{deviceInfo.user_code}</div>
              <div style={{ fontSize: 10, color: C.textDim }}>Scade tra {deviceInfo.secondsLeft ?? "…"}s</div>
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.text, marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={dryRun} onChange={e => { setDryRun(e.target.checked); setConfirmText(""); }} />
            Solo anteprima (dry-run) — consigliato prima di applicare per davvero
          </label>

          {!dryRun && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: C.red, marginBottom: 4 }}>Digita APPLICA per confermare {selected.length} modifiche reali su {ghMarketplace}:</div>
              <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="APPLICA" style={{ ...inputStyle, width: 160 }} />
            </div>
          )}

          <button onClick={apply} disabled={applying || selected.length === 0 || !ghUser || (!dryRun && confirmText !== "APPLICA")}
            style={{
              background: dryRun ? C.blue : C.red, border: "none", borderRadius: 7, padding: "10px 18px", color: "#fff",
              fontWeight: 700, fontSize: 12, cursor: "pointer",
              opacity: (applying || selected.length === 0 || !ghUser || (!dryRun && confirmText !== "APPLICA")) ? 0.5 : 1,
            }}>
            {applying ? "⏳ Avvio..." : dryRun ? "▶️ Avvia anteprima" : "🚀 Applica per davvero"}
          </button>

          {applyResult && (
            <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: applyResult.ok ? C.greenDim : C.redDim, fontSize: 12, color: C.text }}>
              {applyResult.ok ? "✅" : "❌"} {applyResult.message}
              {applyResult.runUrl && <> — <a href={applyResult.runUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>vedi il run su GitHub Actions</a></>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
