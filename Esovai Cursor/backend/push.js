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

const CHECKIN_MESSAGES = [
  "Ich bin verfügbar — soll ich etwas für dich tun?",
  "Kann ich dir helfen? Gib mir eine Aufgabe oder schreib 'Nein'.",
  "Bereit für neue Aufgaben. Was soll ich erledigen?",
  "Ich warte auf Anweisungen — soll ich aktiv werden?",
  "Check-in: Gibt es etwas, das ich für dich recherchieren oder erledigen soll?",
];

// Stündlicher Check-in
let checkinInterval = null;
export async function startCheckin() {
  if (checkinInterval) return;

  // Sofort einmal beim Start
  await _doCheckin();

  checkinInterval = setInterval(_doCheckin, 60 * 60 * 1000); // jede Stunde
  console.log("[CHECKIN] Stündlicher Check-in gestartet.");
}

async function _doCheckin() {
  const msg = CHECKIN_MESSAGES[Math.floor(Math.random() * CHECKIN_MESSAGES.length)];

  // In Inbox schreiben (immer — auch ohne PWA)
  try {
    const { addInboxMessage } = await import("./agent.js");
    await addInboxMessage("assistant", msg);
    console.log("[CHECKIN] Inbox-Nachricht:", new Date().toLocaleString("de-DE"));
  } catch (e) {
    console.warn("[CHECKIN] Inbox-Write fehlgeschlagen:", e.message);
  }

  // Push-Notification zusätzlich (nur wenn Subscriptions vorhanden)
  if (subscriptions.length) {
    await sendPush({
      title: "ESO Bot",
      body: msg,
      url: "/inbox"
    });
    console.log("[CHECKIN] Push gesendet:", new Date().toLocaleString("de-DE"));
  }
}
