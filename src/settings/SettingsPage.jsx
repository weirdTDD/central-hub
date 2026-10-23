import { Bell, Link2, User } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import AppShell from "../components/AppShell";
import { useAuth } from "../auth/AuthContext";
import { initialsAvatar } from "../lib/avatar";
import { personName } from "../dashboard/todayView";

/**
 * The settings sections.
 *
 * Each entry carries the heading and the description for its own screen, so the
 * page never claims to be the Profile screen while a different section is open.
 */
const TABS = [
  {
    to: "/settings",
    label: "Profile",
    icon: User,
    end: true,
    title: "Profile",
    description:
      "Your name, role and bio. These are stored on your account, so they follow you into every part of Sentral Hub.",
  },
  {
    to: "/settings/notifications",
    label: "Notification",
    icon: Bell,
    end: false,
    title: "Notifications",
    description:
      "Delivery channels, quiet hours and the workflows that schedule your reminders.",
  },
  {
    to: "/settings/integrations",
    label: "Integration",
    icon: Link2,
    end: false,
    title: "Integrations",
    description:
      "The bridges between Sentral Hub and the other tools you use, each with a documented contract.",
  },
];

function UserChip() {
  const { user } = useAuth();
  const name = personName(user) || user?.email || "Account";
  return (
    <div className="flex items-center gap-2">
      <img
        src={initialsAvatar(name)}
        alt=""
        className="h-8 w-8 rounded-full object-cover"
      />
      <span className="text-sm font-medium text-foreground">{name}</span>
    </div>
  );
}

export default function SettingsPage() {
  const { pathname } = useLocation();

  // The active section drives the heading, so opening Notifications does not
  // leave the page titled "Profile".
  const active =
    TABS.find((tab) => (tab.end ? pathname === tab.to : pathname.startsWith(tab.to))) ??
    TABS[0];

  return (
    <AppShell currentPath="/settings">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">
            Profile &amp; Setting
          </p>
          <UserChip />
        </div>

        <div className="mt-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {active.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{active.description}</p>
        </div>

        <nav
          aria-label="Settings sections"
          className="mt-6 flex gap-6 overflow-x-auto border-b border-border"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `inline-flex shrink-0 items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors ${
                    isActive
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`
                }
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="mt-6 pb-16">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
