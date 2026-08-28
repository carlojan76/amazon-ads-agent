// Design tokens.
// La palette resta quella di prima (dark GitHub + arancio): cambia il MODO in
// cui si usa il testo. Prima tutta l'app era in monospace a 10-11px, che e' il
// motivo principale per cui risultava faticosa da leggere. Ora il monospace e'
// riservato ai NUMERI e agli ID (dove l'allineamento aiuta davvero), mentre
// testo, etichette e pulsanti usano il font di sistema.

export const C = {
  bg: "#06090f", surface: "#0d1117", surface2: "#161b22", surface3: "#1c2230",
  border: "#21262d", borderStrong: "#30363d",
  accent: "#f0883e", accentDim: "#c6561a", accentGlow: "rgba(240,136,62,0.12)",
  green: "#3fb950", greenDim: "rgba(63,185,80,0.1)",
  red: "#f85149", redDim: "rgba(248,81,73,0.1)",
  blue: "#58a6ff", blueDim: "rgba(88,166,255,0.1)",
  purple: "#bc8cff", purpleDim: "rgba(188,140,255,0.1)",
  yellow: "#d29922", yellowDim: "rgba(210,153,34,0.12)",
  text: "#e6edf3", textMuted: "#8b949e", textDim: "#484f58",
  focus: "#58a6ff",
};

export const F = {
  ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif",
  mono: "'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
};

// Scala tipografica: pochi gradini, usati con coerenza.
export const T = {
  micro: 11, small: 12, body: 13, lead: 15, h3: 17, h2: 21, h1: 28,
};

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const R = { sm: 6, md: 8, lg: 12, pill: 999 };

/** Stile base di un pulsante. `kind`: primary | ghost | danger | quiet | accentGhost */
export function button(kind = "ghost", { small = false, disabled = false } = {}) {
  const base = {
    fontFamily: F.ui,
    fontSize: small ? T.small : T.body,
    fontWeight: 600,
    borderRadius: R.sm,
    padding: small ? "6px 12px" : "9px 16px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    transition: "background 0.15s, border-color 0.15s",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    lineHeight: 1.2,
  };
  const kinds = {
    primary: { background: C.accent, color: "#0b0d12", border: "1px solid transparent" },
    danger: { background: C.red, color: "#fff", border: "1px solid transparent" },
    ghost: { background: "transparent", color: C.text, border: `1px solid ${C.borderStrong}` },
    quiet: { background: "transparent", color: C.textMuted, border: "1px solid transparent" },
    accentGhost: { background: C.accentGlow, color: C.accent, border: `1px solid ${C.accent}` },
  };
  return { ...base, ...(kinds[kind] || kinds.ghost) };
}

export const input = {
  background: C.bg,
  border: `1px solid ${C.borderStrong}`,
  borderRadius: R.sm,
  padding: "8px 11px",
  color: C.text,
  fontSize: T.body,
  fontFamily: F.ui,
  outline: "none",
  boxSizing: "border-box",
};

export const card = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: R.lg,
};

/** CSS globale: focus visibile da tastiera, reduced-motion, scrollbar sobria. */
export const GLOBAL_CSS = `
  *:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; border-radius: 4px; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: ${C.borderStrong}; border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  input[type="checkbox"] { accent-color: ${C.accent}; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slideUp { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
`;
