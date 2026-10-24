import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Sidebar from "../report/components/Sidebar";
import { cn } from "../lib/utils";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isSupabaseConfigured } from "../lib/supabase";
import { listIntegrations } from "../lib/integrations";

/**
 * The shared frame for every signed-in page: themed sidebar, then the canvas.
 * Light and dark both come from the sidebar and background tokens.
 */
export default function AppShell({ currentPath, children, className }) {
  const [syncState, setSyncState] = useState({ status: isSupabaseConfigured ? "loading" : "not-connected", lastSyncAt: null });

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    listIntegrations()
      .then(({ rows }) => {
        if (!active) return;
        if (!rows.length) {
          setSyncState({ status: "not-connected", lastSyncAt: null });
          return;
        }
        const latest = rows.filter((row) => row.last_sync_at).sort((a, b) => Date.parse(b.last_sync_at) - Date.parse(a.last_sync_at))[0];
        const errored = rows.some((row) => row.status === "error");
        setSyncState({ status: errored ? "error" : latest ? "synced" : "not-connected", lastSyncAt: latest?.last_sync_at ?? null });
      })
      .catch(() => {
        if (active) setSyncState({ status: "not-connected", lastSyncAt: null });
      });
    return () => { active = false; };
  }, []);

  const syncLabel = syncState.status === "loading"
    ? "Checking sync status…"
    : syncState.status === "error"
      ? syncState.lastSyncAt ? `Sync error · last successful ${formatSyncTime(syncState.lastSyncAt)}` : "Sync error"
      : syncState.status === "synced"
        ? `Last synced ${formatSyncTime(syncState.lastSyncAt)}`
        : "Not connected";

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={false}>
        <Sidebar currentPath={currentPath} />
        <SidebarInset>
          <header className="sticky top-0 z-30 flex min-h-10 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:px-4 lg:px-6">
            <div className="md:hidden"><SidebarTrigger /></div>
            <Link to="/integrations" aria-label={`Integration sync status: ${syncLabel}`} className="ml-auto inline-flex min-h-9 max-w-[calc(100vw-3rem)] items-center truncate rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-none">
              <span className="truncate">{syncLabel}</span>
            </Link>
          </header>
          <main className={cn("hub-main mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-6", className)}>
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function formatSyncTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
