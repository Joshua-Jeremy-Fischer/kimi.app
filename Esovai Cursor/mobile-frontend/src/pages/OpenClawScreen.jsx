import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { Send, Globe, RefreshCw, Zap, ChevronDown, ChevronUp } from "lucide-react";

const TOKEN = () => localStorage.getItem("kimi_token") || "";

const QUICK_ACTIONS = [
  {
    emoji: "💼",
    label: "Jobs suchen",
    prompt: "Starte jetzt den Job-Crawler und suche nach neuen Stellen für alle Profile. Zeige das Ergebnis strukturiert.",
    useWeb: false,
  },
  {
    emoji: "🛡️",
    label: "Wazuh prüfen",
    prompt: "Prüfe die aktuellen Wazuh SIEM Alerts der letzten 2 Stunden. Fasse kritische und hohe Findings zusammen, ignoriere niedrige.",
    useWeb: false,
  },
  {
    emoji: "📊",
    label: "Status",
    prompt: "Gib einen kurzen Statusbericht: Agent-Zustand, letzte Job-Suche, offene Alerts, verfügbare Skills.",
    useWeb: false,
  },
  {
    emoji: "🌐",
    label: "Web-Suche",
    prompt: null, // öffnet Freitext-Input mit web=true
    useWeb: true,
  },
  {
    emoji: "📋",
    label: "Run-Log",
    prompt: "Zeige die letzten Aktionen und Ergebnisse des Agenten. Was wurde zuletzt ausgeführt?",
    useWeb: false,
  },
  {
    emoji: "🔔",
    label: "Alerts",
    prompt: "Liste alle aktuellen ungelesenen Postfach-Einträge und System-Alerts auf.",
    useWeb: false,
  },
];

async function fetchInbox() {
  try {
    const r = await fetch("/api/agent/inbox", { headers: { Authorization: `Bearer ${TOKEN()}` } });
    if (!r.ok) return [];
    return (await r.json()).messages || [];
  } catch { return []; }
}

async function postToInbox(text, webMode = false) {
  const r = await fetch("/api/agent/inbox", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN()}` },
    body: JSON.stringify({ content: text, webMode }),
  });
  if (!r.ok) return [];
  return (await r.json()).messages || [];
}

function TaskCard({ msg }) {
  const [expanded, setExpanded] = useState(true);
  const isLong = (msg.content || "").length > 500;
  const isUser = msg.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2.5">
          <p className="text-[14px] leading-snug">{msg.content}</p>
          <p className="text-[10px] text-primary-foreground/50 text-right mt-1">
            {new Date(msg.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 items-start">
      <div className="w-7 h-7 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Zap className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0 bg-card border border-border rounded-2xl rounded-tl-sm overflow-hidden">
        <div className={`px-4 py-3 relative ${!expanded && isLong ? "max-h-32 overflow-hidden" : ""}`}>
          <div className="text-[14px] leading-relaxed prose prose-sm prose-invert max-w-none">
            <ReactMarkdown>{msg.content}</ReactMarkdown>
          </div>
          {!expanded && isLong && (
            <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-card to-transparent pointer-events-none" />
          )}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/40">
          <p className="text-[10px] text-muted-foreground">
            {new Date(msg.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
          </p>
          {isLong && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-[11px] text-primary flex items-center gap-0.5 active:opacity-70"
            >
              {expanded
                ? <><ChevronUp className="w-3 h-3" /> Weniger</>
                : <><ChevronDown className="w-3 h-3" /> Mehr</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TypingIndicator({ label }) {
  return (
    <div className="flex gap-2 items-start">
      <div className="w-7 h-7 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Zap className="w-3.5 h-3.5 text-primary animate-pulse" />
      </div>
      <div className="bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
        {label && <p className="text-[10px] text-muted-foreground mt-1">{label}</p>}
      </div>
    </div>
  );
}

export default function OpenClawScreen() {
  const [messages, setMessages]       = useState([]);
  const [text, setText]               = useState("");
  const [sending, setSending]         = useState(false);
  const [webMode, setWebMode]         = useState(false);
  const [activeAction, setActiveAction] = useState(null);
  const bottomRef   = useRef(null);
  const textareaRef = useRef(null);

  const load = useCallback(async () => {
    const msgs = await fetchInbox();
    setMessages(prev => JSON.stringify(prev) === JSON.stringify(msgs) ? prev : msgs);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const sendMessage = useCallback(async (content, web = webMode) => {
    if (!content.trim() || sending) return;
    setSending(true);
    try {
      const msgs = await postToInbox(content.trim(), web);
      if (msgs.length) setMessages(msgs);
      else await load();
    } finally {
      setSending(false);
      setActiveAction(null);
    }
  }, [sending, webMode, load]);

  const handleQuickAction = (action) => {
    if (action.prompt === null) {
      setWebMode(action.useWeb ?? true);
      textareaRef.current?.focus();
      return;
    }
    setActiveAction(action.label);
    sendMessage(action.prompt, action.useWeb ?? false);
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    sendMessage(trimmed);
  };

  const recentMessages = messages.slice(-30);

  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/95 backdrop-blur-xl safe-top flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${sending ? "bg-primary/25" : "bg-primary/10"}`}>
            <Zap className={`w-5 h-5 text-primary ${sending ? "animate-pulse" : ""}`} />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold">OpenClaw</h2>
            <p className="text-[11px] text-muted-foreground">
              {sending ? `⚡ ${activeAction || "Arbeitet..."}` : "Bereit"}
            </p>
          </div>
        </div>
        <button
          onClick={load}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full active:bg-accent"
        >
          <RefreshCw className={`w-4 h-4 text-muted-foreground ${sending ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Quick Actions — Telegram Bot-Keyboard-Style */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0">
        <div className="grid grid-cols-3 gap-2">
          {QUICK_ACTIONS.map(action => (
            <button
              key={action.label}
              onClick={() => handleQuickAction(action)}
              disabled={sending}
              className={`flex flex-col items-center justify-center gap-1.5 py-3 px-2 rounded-2xl border transition-all active:scale-95 active:opacity-70 min-h-[72px] disabled:opacity-40 ${
                activeAction === action.label
                  ? "bg-primary/15 border-primary/40"
                  : "bg-card border-border"
              }`}
            >
              <span className="text-2xl leading-none">{action.emoji}</span>
              <span className="text-[11px] font-medium text-center leading-tight text-foreground">
                {action.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Task Feed */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 space-y-3"
        style={{ paddingBottom: "7.5rem" }}
      >
        {recentMessages.length === 0 && !sending && (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <Zap className="w-8 h-8 mb-2 opacity-20" />
            <p className="text-sm">Wähle eine Aktion oder schreib einen Befehl</p>
          </div>
        )}

        {recentMessages.map(msg => (
          <TaskCard key={msg.id} msg={msg} />
        ))}

        {sending && <TypingIndicator label={activeAction} />}

        <div ref={bottomRef} />
      </div>

      {/* Input Bar */}
      <div className="fixed bottom-14 left-0 right-0 md:static md:bottom-auto md:left-auto md:right-auto border-t border-border bg-card/95 backdrop-blur-xl px-3 py-2 md:py-3 flex items-end gap-2 z-40 max-w-lg md:max-w-none mx-auto md:mx-0">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
            }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
            placeholder="Befehl eingeben..."
            rows={1}
            disabled={sending}
            className="w-full bg-secondary text-foreground rounded-2xl px-4 py-3 text-[15px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 max-h-[120px] overflow-y-auto resize-none"
          />
        </div>
        <button
          onClick={() => setWebMode(w => !w)}
          title={webMode ? "Web-Suche deaktivieren" : "Web-Suche aktivieren"}
          className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-all active:scale-95 flex-shrink-0 ${
            webMode ? "bg-blue-500 text-white" : "bg-secondary text-muted-foreground"
          }`}
        >
          <Globe className="w-5 h-5" />
        </button>
        <button
          onClick={handleSend}
          disabled={sending || !text.trim()}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30 active:scale-95 transition-transform flex-shrink-0"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>

    </div>
  );
}
