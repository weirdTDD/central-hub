import { useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { applyTheme, readTheme, THEME_KEY } from "../theme";
import { initialsAvatar } from "../../lib/avatar";
import { personName } from "../../dashboard/todayView";
import { useAuth } from "../../auth/AuthContext";
import { supabase } from "../../lib/supabase";

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

/**
 * The fields that are stored on the account itself.
 *
 * The account row IS the profile: Supabase keeps `user_metadata` for exactly
 * this, so the profile is saved against the signed-in user instead of a table
 * that does not exist. The email address is not editable here — changing it
 * needs a confirmation email, which Supabase handles on its own.
 */
const PROFILE_FIELDS = [
  { key: "fullName", metadata: "full_name", label: "Full name", type: "text" },
  { key: "jobTitle", metadata: "job_title", label: "Job title", type: "text" },
  { key: "displayName", metadata: "display_name", label: "Display name", type: "text" },
  { key: "phone", metadata: "phone", label: "Phone", type: "tel" },
];

/**
 * Reads the profile out of an account.
 *
 * Nothing is invented: a field the account does not carry is simply empty, and
 * the same function is used for the account on screen and for the account the
 * server returns after a save, so the form always shows what is actually
 * stored.
 *
 * @param {object|null|undefined} user a Supabase user object
 * @returns {object} the profile fields
 */
function profileFromUser(user) {
  return {
    fullName: user?.user_metadata?.full_name ?? "",
    jobTitle: user?.user_metadata?.job_title ?? "",
    displayName: user?.user_metadata?.display_name ?? "",
    role: user?.user_metadata?.role ?? "",
    phone: user?.user_metadata?.phone ?? "",
    bio: user?.user_metadata?.bio ?? "",
  };
}

function Field({ id, label, children }) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";

/**
 * The editable form.
 *
 * It is mounted with a key derived from the ACCOUNT, so a different person
 * signing in resets the form to that person's values, while a save of your own
 * profile leaves the form mounted and the confirmation on screen. The draft is
 * initialised from the saved profile and is never patched from an effect, so a
 * background refresh cannot overwrite an edit in progress.
 */
function ProfileForm({ saved, name, email }) {
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  // The confirmation is a transient message, not a permanent state.
  useEffect(() => {
    if (!savedAt) return undefined;
    const timer = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const hasChanges = useMemo(
    () => Object.keys(saved).some((key) => saved[key] !== draft[key]),
    [saved, draft]
  );

  const update = (key) => (event) => {
    setError(null);
    setSavedAt(null);
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setError("Supabase is not configured, so the profile cannot be saved.");
      return;
    }

    setSaving(true);
    setError(null);
    setSavedAt(null);

    try {
      const { data, error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: draft.fullName,
          job_title: draft.jobTitle,
          display_name: draft.displayName,
          role: draft.role,
          phone: draft.phone,
          bio: draft.bio,
        },
      });

      if (updateError) throw updateError;

      // Adopt the account the server returned, so the form shows exactly what
      // was stored rather than what was typed.
      if (data?.user) setDraft(profileFromUser(data.user));

      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err?.message || "The profile could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(saved);
    setError(null);
    setSavedAt(null);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-4">
        <img
          src={initialsAvatar(name)}
          alt=""
          className="h-16 w-16 rounded-full object-cover ring-2 ring-primary/20"
        />
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">
            {name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {draft.jobTitle ? (
              <p className="text-sm text-muted-foreground">{draft.jobTitle}</p>
            ) : null}
            {draft.role ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                {draft.role}
              </span>
            ) : null}
            {draft.displayName && draft.displayName !== draft.fullName ? (
              <span className="text-xs text-muted-foreground">
                Shown as {draft.displayName}
              </span>
            ) : null}
            {!draft.jobTitle && !draft.role ? (
              <p className="text-sm text-muted-foreground">
                No job title set yet.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}

      {savedAt ? (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground"
        >
          <CircleCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span>Your profile was saved to your account.</span>
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {PROFILE_FIELDS.map((field) => (
          <Field key={field.key} id={`profile-${field.key}`} label={field.label}>
            <input
              id={`profile-${field.key}`}
              type={field.type}
              className={inputClass}
              value={draft[field.key]}
              onChange={update(field.key)}
            />
          </Field>
        ))}

        <Field id="profile-email" label="Email">
          <input
            id="profile-email"
            type="email"
            className={`${inputClass} cursor-not-allowed opacity-70`}
            value={email}
            readOnly
            aria-readonly="true"
            aria-describedby="profile-email-hint"
          />
          <p id="profile-email-hint" className="mt-1.5 text-xs text-muted-foreground">
            The email address is the sign-in for this account and is managed by
            your provider.
          </p>
        </Field>

        <div>
          <span
            id="profile-role-label"
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            Role
          </span>
          <Select
            value={draft.role}
            onValueChange={(role) => {
              setError(null);
              setSavedAt(null);
              setDraft((current) => ({ ...current, role }));
            }}
          >
            <SelectTrigger id="profile-role" aria-labelledby="profile-role-label">
              <SelectValue placeholder="No role set" />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((role) => (
                <SelectItem key={role} value={role}>
                  {role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="lg:col-span-2">
          <Field id="profile-bio" label="Bio">
            <textarea
              id="profile-bio"
              rows={4}
              className={`${inputClass} resize-none`}
              value={draft.bio}
              onChange={update("bio")}
            />
          </Field>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleCancel}
          disabled={!hasChanges || saving}
          className="rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !hasChanges}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </button>
      </div>
    </form>
  );
}

export default function ProfileScreen() {
  const { user } = useAuth();
  const [theme, setTheme] = useState(readTheme);

  // The saved profile is whatever the account actually holds. Nothing here is
  // invented: a field the account does not have is simply empty.
  const saved = useMemo(() => profileFromUser(user), [user]);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    if (theme !== "system") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const name = saved.fullName || personName(user) || user?.email || "Account";
  const email = user?.email ?? "";

  // The form is keyed by the ACCOUNT, not by the profile values: a different
  // person signing in resets the form, while a save of your own profile keeps
  // it mounted so the confirmation stays on screen.
  const formKey = user?.id ?? "anonymous";

  return (
    <div className="space-y-6">
      <ProfileForm
        key={formKey}
        saved={saved}
        name={name}
        email={email}
      />

      <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h2 className="text-base font-semibold text-foreground">Appearance</h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Theme</p>
            <p className="text-sm text-muted-foreground">
              Customize the look and feel of the application
            </p>
          </div>
          <div
            className="inline-flex rounded-xl bg-muted p-1"
            role="radiogroup"
            aria-label="Theme"
          >
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
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
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
