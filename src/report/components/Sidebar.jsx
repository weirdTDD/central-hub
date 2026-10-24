import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bell,
  BarChart3,
  ChevronUp,
  Clock,
  Code2,
  GraduationCap,
  MessageSquare,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Plug,
  ScrollText,
  Settings,
} from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { initialsAvatar } from "../../lib/avatar";
import { personName } from "../../dashboard/todayView";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Logs", href: "/logs", icon: ScrollText },
  { name: "Tasks", href: "/tasks", icon: ListTodo },
  { name: "Tracking", href: "/tracking", icon: Clock },
  { name: "Coding", href: "/coding", icon: Code2 },
  { name: "Learning", href: "/learning", icon: GraduationCap },
  { name: "Notifications", href: "/notifications", icon: Bell },
  { name: "Integrations", href: "/integrations", icon: Plug },
  { name: "Ask", href: "/ask", icon: MessageSquare },
  { name: "Reports", href: "/reports", icon: BarChart3 },
];

export default function AppSidebar({ currentPath = "/reports" }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
  const [accountOpen, setAccountOpen] = useState(false);

  const name = personName(user) || user?.email || "Account";
  const closeAccountMenu = () => {
    setAccountOpen(false);
    setOpenMobile(false);
  };
  const toggleAccountMenu = () => {
    if (!isMobile && !open) setOpen(true);
    setAccountOpen((current) => !current);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
        <Link
          to="/dashboard"
          aria-label="Sentral Hub home"
          className="min-w-0 group-data-[collapsible=icon]:hidden"
        >
          <img
            src="/Sentral-Hub-Logo.png"
            alt="Sentral Hub"
            className="h-16 w-auto max-w-40 object-contain"
          />
        </Link>
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map(({ name: label, href, icon }) => {
                const Icon = icon;
                return (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton
                      render={<Link to={href} />}
                      isActive={currentPath === href}
                      tooltip={label}
                      onClick={() => setOpenMobile(false)}
                      className="text-xs"
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem className="relative">
            <SidebarMenuButton
              type="button"
              aria-label={`Account menu for ${name}`}
              aria-expanded={accountOpen}
              title="Account"
              onClick={toggleAccountMenu}
              className="h-11 rounded-xl border border-sidebar-border bg-sidebar-accent/35 px-2 group-data-[collapsible=icon]:size-9!"
            >
              <img
                src={initialsAvatar(name)}
                alt=""
                className="size-7 shrink-0 rounded-full object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-left text-xs font-semibold group-data-[collapsible=icon]:hidden">
                <span className="block truncate">{name}</span>
                <span className="block text-xs font-normal text-muted-foreground">Account</span>
              </span>
              <ChevronUp className={`ml-auto size-3.5 text-muted-foreground transition-transform group-data-[collapsible=icon]:hidden ${accountOpen ? "" : "rotate-180"}`} />
            </SidebarMenuButton>
            {accountOpen ? (
              <div className="absolute inset-x-0 bottom-full z-50 mb-2 space-y-1 rounded-xl border border-sidebar-border bg-sidebar p-2 shadow-lg group-data-[collapsible=icon]:hidden">
                {user?.email ? (
                  <p className="truncate px-2 pb-2 text-xs text-muted-foreground">{user.email}</p>
                ) : null}
                <Link
                  to="/settings"
                  onClick={closeAccountMenu}
                  aria-current={currentPath.startsWith("/settings") ? "page" : undefined}
                  className={`flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
                    currentPath.startsWith("/settings")
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground"
                  }`}
                >
                  <Settings className="size-4" aria-hidden="true" />
                  Settings
                </Link>
                <button
                  type="button"
                  onClick={async () => {
                    closeAccountMenu();
                    try {
                      await signOut();
                    } catch {
                      // The session is cleared locally regardless; continue to login.
                    }
                    navigate("/login", { replace: true });
                  }}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  Log out
                </button>
              </div>
            ) : null}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
