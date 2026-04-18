import { Outlet, Link, useLocation } from "react-router-dom";
import { MessageSquare, Bot, Settings, Zap } from "lucide-react";
import BottomNav from "./chat/BottomNav";
import OfflineIndicator from "./chat/OfflineIndicator";

const navItems = [
  { path: "/inbox",    label: "ESO Bot",       isEso: true },
  { path: "/",         icon: MessageSquare,    label: "Chat" },
  { path: "/openclaw", icon: Zap,              label: "OpenClaw" },
  { path: "/agent",    icon: Bot,              label: "Agent" },
  { path: "/settings", icon: Settings,         label: "Einstellungen" },
];

function Sidebar() {
  const location = useLocation();

  return (
    <aside className="hidden md:flex flex-col w-56 h-full border-r border-border bg-card/60 flex-shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
        <img
          src="https://media.base44.com/images/public/69d2b419042c20a2d77a9f12/efa5802c0_image.png"
          alt="ESO Bot"
          className="w-8 h-8 rounded-full object-cover"
        />
        <div>
          <p className="text-sm font-bold leading-none">ESO Bot</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">KI-Assistent</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {navItems.map(({ path, icon: Icon, label, isEso }) => {
          const active = location.pathname === path || (path === "/" && location.pathname === "/");
          return (
            <Link
              key={path}
              to={path}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              {isEso ? (
                <img
                  src="https://media.base44.com/images/public/69d2b419042c20a2d77a9f12/efa5802c0_image.png"
                  alt="ESO Bot"
                  className={`w-5 h-5 rounded-full object-cover ${active ? "ring-2 ring-primary" : "opacity-70"}`}
                />
              ) : (
                <Icon className="w-5 h-5 flex-shrink-0" strokeWidth={active ? 2.2 : 1.6} />
              )}
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-border">
        <p className="text-[10px] text-muted-foreground">remote.esovai.tech</p>
      </div>
    </aside>
  );
}

export default function MobileLayout() {
  return (
    <div className="flex h-full w-full bg-background">
      <Sidebar />

      {/* Haupt-Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
        <OfflineIndicator />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Outlet />
        </div>
        {/* BottomNav nur auf Mobile */}
        <BottomNav />
      </div>
    </div>
  );
}
