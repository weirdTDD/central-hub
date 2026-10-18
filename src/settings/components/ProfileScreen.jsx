import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { applyTheme, readTheme, THEME_KEY } from "../theme";

const INITIAL_PROFILE = {
  fullName: "Kwakye Amoah",
  jobTitle: "Project Manager",
  displayName: "Kwakye Amoah",
  role: "Project Manager",
  email: "kwakyamoah@gmail.com",
  phone: "+233 54 000 0000",
  bio: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
};

const ROLES = [
  "Project Manager",
  "Project Lead",
  "Product Designer",
  "Frontend Dev",
  "Software Engineer",
  "Security Analyst",
];

const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none transition focus:border-[#5B16E1] focus:ring-2 focus:ring-[#5B16E1]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-gray-100";

export default function ProfileScreen() {
  const [profile, setProfile] = useState(INITIAL_PROFILE);
  const [savedProfile, setSavedProfile] = useState(INITIAL_PROFILE);
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    if (theme !== "system") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);

  const update = (key) => (event) => {
    setSaved(false);
    setProfile((current) => ({ ...current, [key]: event.target.value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setSavedProfile(profile);
    setSaved(true);
  };

  const handleCancel = () => {
    setProfile(savedProfile);
    setSaved(false);
  };

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-4">
          <img
            src="https://i.pravatar.cc/150?u=ransford"
            alt=""
            className="h-14 w-14 rounded-full object-cover"
          />
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Ransford Bediako</h2>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">Project Manager</p>
              <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                Project Lead
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Field label="Full name">
            <input className={inputClass} value={profile.fullName} onChange={update("fullName")} />
          </Field>
          <Field label="Job Title">
            <input className={inputClass} value={profile.jobTitle} onChange={update("jobTitle")} />
          </Field>
          <Field label="Display name">
            <input className={inputClass} value={profile.displayName} onChange={update("displayName")} />
          </Field>
          <Field label="Role">
            <span className="relative block">
              <select className={`${inputClass} appearance-none pr-9`} value={profile.role} onChange={update("role")}>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            </span>
          </Field>
          <Field label="Email">
            <input type="email" className={inputClass} value={profile.email} onChange={update("email")} />
          </Field>
          <Field label="Phone">
            <input type="tel" className={inputClass} value={profile.phone} onChange={update("phone")} />
          </Field>
          <div className="lg:col-span-2">
            <Field label="Bio">
              <textarea rows={4} className={`${inputClass} resize-none`} value={profile.bio} onChange={update("bio")} />
            </Field>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-[#5B16E1] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4a11c0]"
          >
            {saved ? "Saved" : "Save Changes"}
          </button>
        </div>
      </form>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-base font-semibold">Appearance</h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Theme</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">Customize the look and feel of the application</p>
          </div>
          <div className="inline-flex rounded-xl bg-gray-100 p-1 dark:bg-zinc-800" role="radiogroup" aria-label="Theme">
            {THEMES.map((option) => {
              const selected = theme === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTheme(option.id)}
                  className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                    selected
                      ? "bg-white text-gray-900 shadow-sm dark:bg-zinc-700 dark:text-white"
                      : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
