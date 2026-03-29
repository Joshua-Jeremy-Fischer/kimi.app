// ── Eso Bot Permission System ────────────────────────────────
// Live-updateable — kein Container-Neustart nötig
// Alle Permissions default OFF außer web + files (read-only)

const permissions = {
  shell: process.env.ALLOW_SHELL  === "true",   // Bash exec     — default OFF
  web:   process.env.ALLOW_WEB   !== "false",   // URL fetch     — default ON
  files: process.env.ALLOW_FILES !== "false",   // /workspace rw — default ON
  git:   process.env.ALLOW_GIT   === "true",    // git commands  — default OFF
};

export function getPermissions() {
  return { ...permissions };
}

export function setPermissions(updates) {
  for (const [key, val] of Object.entries(updates)) {
    if (key in permissions) {
      permissions[key] = Boolean(val);
      console.log(`[PERM] ${key} → ${permissions[key] ? "ON" : "OFF"}`);
    }
  }
  return { ...permissions };
}

export function can(permission) {
  return permissions[permission] === true;
}
