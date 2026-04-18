import { useState, useRef } from "react";
import { Zap, RefreshCw, ExternalLink } from "lucide-react";

const OPENCLAW_URL = "/openclaw/";

export default function OpenClawScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const iframeRef             = useRef(null);

  const reload = () => {
    setLoading(true);
    setError(false);
    if (iframeRef.current) iframeRef.current.src = OPENCLAW_URL;
  };

  return (
    <div className="flex flex-col h-full">

      {/* Thin header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/95 backdrop-blur-xl safe-top flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <div>
            <span className="text-[14px] font-semibold">OpenClaw</span>
            <span className="ml-2 text-[10px] text-muted-foreground">shrimp.esovai.tech</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={reload}
            className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-full active:bg-accent"
            title="Neu laden"
          >
            <RefreshCw className={`w-4 h-4 text-muted-foreground ${loading ? "animate-spin" : ""}`} />
          </button>
          <a
            href="https://shrimp.esovai.tech"
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-full active:bg-accent"
            title="In neuem Tab öffnen"
          >
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </a>
        </div>
      </div>

      {/* iframe */}
      <div className="flex-1 relative overflow-hidden">
        {loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background gap-3 z-10">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary animate-pulse" />
            </div>
            <p className="text-sm text-muted-foreground">OpenClaw lädt...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background gap-4 px-8 z-10">
            <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center">
              <Zap className="w-6 h-6 text-destructive" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">OpenClaw nicht erreichbar</p>
              <p className="text-xs text-muted-foreground mt-1">Prüfe ob der Service läuft.</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={reload}
                className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium active:opacity-70"
              >
                Erneut versuchen
              </button>
              <a
                href="https://shrimp.esovai.tech"
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 active:opacity-70"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Direkt öffnen
              </a>
            </div>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src={OPENCLAW_URL}
          className="w-full h-full border-0"
          style={{ display: error ? "none" : "block" }}
          allow="clipboard-read; clipboard-write; microphone"
          onLoad={() => setLoading(false)}
          onError={() => { setLoading(false); setError(true); }}
          title="OpenClaw"
        />
      </div>
    </div>
  );
}
