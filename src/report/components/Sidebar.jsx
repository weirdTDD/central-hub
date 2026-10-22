import { Link, useNavigate } from "react-router-dom";
import {
  Bell,
  BarChart3,
  Clock,
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
  { name: "Notifications", href: "/notifications", icon: Bell },
  { name: "Integrations", href: "/integrations", icon: Plug },
  { name: "Ask", href: "/ask", icon: MessageSquare },
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Settings", href: "/settings", icon: Settings },
];

export default function AppSidebar({ currentPath = "/reports" }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { setOpenMobile } = useSidebar();

  const name = personName(user) || user?.email || "Account";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="group-data-[collapsible=icon]:items-center">
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
        <div className="flex items-center gap-2 px-2 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img
            src={initialsAvatar(name)}
            alt=""
            className="size-8 shrink-0 rounded-full object-cover"
          />
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            {name}
          </span>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Logout"
              onClick={async () => {
                setOpenMobile(false);
                try {
                  await signOut();
                } catch {
                  // The session is cleared locally regardless; continue to login.
                }
                navigate("/login", { replace: true });
              }}
            >
              <LogOut />
              <span>Logout</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
