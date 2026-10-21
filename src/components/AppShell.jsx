import Sidebar from "../report/components/Sidebar";
import { cn } from "../lib/utils";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The shared frame for every signed-in page: themed sidebar, then the canvas.
 * Light and dark both come from the sidebar and background tokens.
 */
export default function AppShell({ currentPath, children, className }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar currentPath={currentPath} />
        <SidebarInset>
          <div className="flex h-12 items-center border-b border-border px-2 md:hidden">
            <SidebarTrigger />
          </div>
          <div className={cn("flex-1 px-4 py-6 sm:px-8 md:px-10", className)}>
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
