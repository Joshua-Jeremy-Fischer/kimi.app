import webpush from "web-push";
import fs from "fs/promises";

const SUBS_FILE = "/data/push-subscriptions.json";

webpush.setVapidDetails(
  "mailto:agent@esovai.tech",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

let subscriptions = [];

export async function loadSubscriptions() {
  try {
    const raw = await fs.readFile(SUBS_FILE, "utf8");
    subscriptions = JSON.parse(raw);
  } catch {
    subscriptions = [];
  }
}

async function saveSubscriptions() {
  try {
    await fs.writeFile(SUBS_FILE, JSON.stringify(subscriptions, null, 2), "utf8");
  } catch (e) {
    console.error("[PUSH] Speichern fehlgeschlagen:", e.message);
  }
}

export function addSubscription(sub) {
  const exists = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subscriptions.push(sub);
    saveSubscriptions();
  }
}

export async function sendPush(payload) {
  if (!subscriptions.length) return;
  const dead = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    subscriptions = subscriptions.filter(s => !dead.includes(s.endpoint));
    saveSubscriptions();
  }
}

// Stündlicher Check-in
let checkinInterval = null;
export function startCheckin() {
  if (checkinInterval) return;
  checkinInterval = setInterval(async () => {
    await sendPush({
      title: "ESO Bot",
      body: "Kann ich dir helfen? Tippe Ja um eine Aufgabe zu vergeben.",
      url: "/agent?checkin=yes"
    });
    console.log("[CHECKIN] Push gesendet:", new Date().toLocaleString("de-DE"));
  }, 60 * 60 * 1000); // jede Stunde
  console.log("[CHECKIN] Stündlicher Check-in gestartet.");
}
