// Saved settings for Ship Desk, kept in this browser's localStorage.
// Every call is guarded: when the browser blocks storage (private window, strict settings, full disk)
// the app keeps working with the values held in memory for this visit.

export const KEYS = {
  profiles: "shipdesk.profiles",
  activeProfile: "shipdesk.activeProfile",
  design: "shipdesk.design",
  output: "shipdesk.output",
  plan: "shipdesk.plan",
  shipped: "shipdesk.shipped",
  history: "shipdesk.history",
  historyCopy: "shipdesk.historyCopy", // "on" once this browser's History is the one copied to Saved\History
  welcome: "shipdesk.welcome", // the first-run checklist: { hidden, format, sample, phone }
  updateSkip: "shipdesk.updateSkip", // a newer version the person said "Not now" to
  batch: "shipdesk.batch", // the loaded orders (file or pasted text) so a reload keeps them; app.js BATCH_DAYS
};

const memory = new Map(); // key -> JSON text written during this visit

function storage() {
  try { return window.localStorage || null; } catch { return null; }
}

function parse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** The saved value for `key`, or `fallback` when nothing (readable) is saved. */
export function load(key, fallback) {
  if (memory.has(key)) return parse(memory.get(key), fallback);
  let text = null;
  try { const s = storage(); text = s ? s.getItem(key) : null; } catch { text = null; }
  return text == null ? fallback : parse(text, fallback);
}

/** Save `value` (JSON). Returns true when it reached localStorage, false when only kept in memory. */
export function save(key, value) {
  let text;
  try { text = JSON.stringify(value); } catch { return false; }
  if (text === undefined) return remove(key);
  memory.set(key, text);
  try { const s = storage(); if (!s) return false; s.setItem(key, text); return true; } catch { return false; }
}

/** Forget a saved value. */
export function remove(key) {
  memory.delete(key);
  try { const s = storage(); if (!s) return false; s.removeItem(key); return true; } catch { return false; }
}
