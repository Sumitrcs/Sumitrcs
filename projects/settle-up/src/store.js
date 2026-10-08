// State persistence: localStorage for the device, URL hash for sharing.

const KEY = "settle-up:v1";

export function emptyState() {
  return { name: "Goa trip", members: [], expenses: [], payments: [], nextId: 1 };
}

export function validate(state) {
  const ok =
    state &&
    typeof state.name === "string" &&
    Array.isArray(state.members) &&
    Array.isArray(state.expenses) &&
    Array.isArray(state.payments) &&
    state.members.every((m) => typeof m === "string");
  if (!ok) throw new Error("Not a valid settle-up file");
  state.nextId ||= 1 + Math.max(0, ...state.expenses.map((e) => e.id || 0));
  return state;
}

export function load() {
  try {
    const fromHash = decodeShare(location.hash.slice(1));
    if (fromHash) return fromHash;
  } catch {
    /* fall through to local copy */
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return validate(JSON.parse(raw));
  } catch {
    /* storage blocked or corrupt */
  }
  return emptyState();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode: keep working in memory */
  }
}

// base64url of UTF-8 JSON, so names like "Priyā" survive the trip.
export function encodeShare(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShare(s) {
  if (!s) return null;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return validate(JSON.parse(new TextDecoder().decode(bytes)));
}
