import { Bell, Link2, User } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import Sidebar from "../report/components/Sidebar";

const TABS = [
  { to: "/settings", label: "Profile", icon: User, end: true },
  { to: "/settings/notifications", label: "Notification", icon: Bell },
  { to: "/settings/integrations", label: "Integration", icon: Link2 },
];

function UserChip() {
  return (
    <div className="flex items-center gap-2">
      <span className="relative">
        <img
          src="https://i.pravatar.cc/150?u=kwakye"
          alt=""
          className="h-8 w-8 rounded-full object-cover"
        />
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[#f6f7fb] dark:ring-zinc-950" />
      </span>
      <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Kwakye</span>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-[#f6f7fb] text-gray-900 dark:bg-zinc-950 dark:text-gray-100">
      <Sidebar currentPath="/settings" />

      <main className="min-h-screen px-4 py-4 sm:px-8 md:ml-72 md:px-10 md:py-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Profile & Setting</p>
          <UserChip />
        </div>

        <div className="mt-8 max-w-3xl">
          <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Manage your personal information, privacy setting and public profile.
          </p>

          <nav aria-label="Profile sections" className="mt-6 flex gap-6 border-b border-gray-200 dark:border-zinc-800">
            {TABS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 border-b-2 pb-3 text-sm font-medium transition-colors ${
                    isActive
                      ? "border-[#5B16E1] text-[#5B16E1]"
                      : "border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="mt-6 pb-16">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
