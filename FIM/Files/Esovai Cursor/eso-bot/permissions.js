// ── Eso Bot Permission System ────────────────────────────────
// Env-Variablen = Obergrenze (Ceiling)
// Runtime-Toggles können nur UNTER den Env-Werten liegen

// Env-Ceiling einmalig beim Start einfrieren
const CEILING = {
  shell: process.env.ALLOW_SHELL  === "true",
  web:   process.env.ALLOW_WEB   !== "false",
  files: process.env.ALLOW_FILES !== "false",
  git:   process.env.ALLOW_GIT   === "true",
};

// Runtime-State startet auf Ceiling-Wert
const permissions = { ...CEILING };

export function getPermissions() {
  return { ...permissions };
}

export function getCeiling() {
  return { ...CEILING };
}

export function setPermissions(updates) {
  for (const [key, val] of Object.entries(updates)) {
    if (!(key in permissions)) continue;
    const requested = Boolean(val);
    // Darf nie ÜBER das Env-Ceiling gehen
    permissions[key] = requested && CEILING[key];
    console.log(`[PERM] ${key} → ${permissions[key] ? "ON" : "OFF"}${!CEILING[key] && requested ? " (blocked by env ceiling)" : ""}`);
  }
  return { ...permissions };
}

export function can(permission) {
  return permissions[permission] === true;
}
