import { useEffect, useState } from "react";
import { Zap, ExternalLink } from "lucide-react";

const OPENCLAW_URL = "https://shrimp.esovai.tech";

export default function OpenClawScreen() {
  const [opened, setOpened] = useState(false);

  // Beim ersten Aufrufen direkt öffnen
  useEffect(() => {
    const t = setTimeout(() => {
      window.open(OPENCLAW_URL, "_blank", "noopener,noreferrer");
      setOpened(true);
    }, 400);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
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
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Zap className="w-8 h-8 text-primary" />
        </div>

        <div className="text-center">
          <p className="text-base font-semibold">OpenClaw</p>
          <p className="text-sm text-muted-foreground mt-1">
            {opened
              ? "OpenClaw wurde in einem neuen Tab geöffnet."
              : "Öffnet gleich..."}
          </p>
        </div>

        <a
          href={OPENCLAW_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpened(true)}
          className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-medium active:opacity-70"
        >
          <ExternalLink className="w-4 h-4" />
          {opened ? "Erneut öffnen" : "OpenClaw öffnen"}
        </a>

        <p className="text-xs text-muted-foreground text-center max-w-[240px]">
          OpenClaw läuft auf einem separaten Server und kann nicht eingebettet werden.
        </p>
      </div>
    </div>
  );
}
