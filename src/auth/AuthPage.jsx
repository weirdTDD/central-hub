import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import AuthIllustration from "./AuthIllustration";

const inputClass =
  "peer w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none transition placeholder:text-transparent focus:border-[#5B16E1] focus:ring-2 focus:ring-[#5B16E1]/20";

function FloatingField({ id, label, type = "text", value, onChange, autoComplete, trailing }) {
  return (
    <div className="relative">
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        placeholder={label}
        className={`${inputClass} ${trailing ? "pr-12" : ""}`}
        required
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute left-3 top-0 -translate-y-1/2 bg-[#f7f7fb] px-1 text-xs font-medium text-gray-500 transition peer-placeholder-shown:top-1/2 peer-placeholder-shown:bg-transparent peer-placeholder-shown:text-sm peer-placeholder-shown:text-gray-400 peer-focus:top-0 peer-focus:bg-[#f7f7fb] peer-focus:text-xs peer-focus:text-[#5B16E1]"
      >
        {label}
      </label>
      {trailing}
    </div>
  );
}

export default function AuthPage() {
  const navigate = useNavigate();
  const { isAuthenticated, login, loginWithGoogle } = useAuth();
  const [mode, setMode] = useState("signup");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    fullName: "Bright Kelly",
    email: "",
    password: "",
  });

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const update = (key) => (event) => {
    setError("");
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!form.email.trim() || !form.password.trim()) {
      setError("Email and password are required.");
      return;
    }
    if (mode === "signup" && !form.fullName.trim()) {
      setError("Full name is required.");
      return;
    }

    login({
      fullName: mode === "signup" ? form.fullName : form.email.split("@")[0],
      email: form.email,
    });
    navigate("/dashboard", { replace: true });
  };

  const handleGoogle = () => {
    loginWithGoogle();
    navigate("/dashboard", { replace: true });
  };

  return (
    <div className="min-h-screen bg-[#f7f7fb] text-gray-900">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.95fr)]">
        <section className="relative flex flex-col px-6 py-8 sm:px-10 lg:px-16 lg:py-10">
          <Link to="/login" className="inline-flex w-fit">
            <img src="/logo.svg" alt="Dailylogs" className="h-10 w-auto object-contain" />
          </Link>

          <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Hey, Your DailyLogs here!
            </h1>
            <p className="mt-2 text-sm text-gray-500 sm:text-base">
              Sign in with your BST Account to log your activities
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-4">
              {mode === "signup" ? (
                <FloatingField
                  id="fullName"
                  label="Full name"
                  value={form.fullName}
                  onChange={update("fullName")}
                  autoComplete="name"
                />
              ) : null}

              <FloatingField
                id="email"
                label="Email"
                type="email"
                value={form.email}
                onChange={update("email")}
                autoComplete="email"
              />

              <FloatingField
                id="password"
                label="Password"
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={update("password")}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                }
              />

              {error ? <p className="text-sm text-red-600">{error}</p> : null}

              <button
                type="submit"
                className="mt-2 w-full rounded-xl bg-[#5B16E1] px-4 py-3 text-sm font-semibold text-white hover:bg-[#4a11c0]"
              >
                Login to Continue
              </button>
            </form>

            <p className="mt-4 text-center text-sm text-gray-500">
              {mode === "signup" ? "Already have an Account? " : "Don't have an Account? "}
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setMode((current) => (current === "signup" ? "login" : "signup"));
                }}
                className="font-semibold text-[#5B16E1] hover:underline"
              >
                {mode === "signup" ? "Login" : "Sign up"}
              </button>
            </p>

            <button
              type="button"
              onClick={handleGoogle}
              className="mt-4 inline-flex w-full items-center justify-center gap-3 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
                <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1C3.4 21.3 7.4 24 12 24z" />
                <path fill="#FBBC05" d="M5.4 14.4c-.2-.7-.4-1.4-.4-2.4s.1-1.7.4-2.4V6.5H1.4C.5 8.3 0 10.1 0 12s.5 3.7 1.4 5.5l4-3.1z" />
                <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.1 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.5l4 3.1C6.3 6.8 8.9 4.8 12 4.8z" />
              </svg>
              Sign up with Google
            </button>

            <p className="mt-10 text-center text-xs text-gray-500">
              By creating an account, you agree to our{" "}
              <a href="#terms" className="underline underline-offset-2 hover:text-[#5B16E1]">
                Terms of Use
              </a>
            </p>
          </div>
        </section>

        <aside className="hidden p-6 lg:flex lg:items-stretch lg:p-8">
          <div className="flex w-full flex-col justify-between rounded-[28px] bg-[#2A0A8C] px-8 py-10 text-white shadow-xl">
            <div>
              <h2 className="text-3xl font-bold leading-tight">Track activities with DailyLog</h2>
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-violet-100">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
                exercitation.
              </p>
              <button
                type="button"
                className="mt-6 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#5B16E1] hover:bg-violet-50"
              >
                Learn More
              </button>
            </div>
            <AuthIllustration />
          </div>
        </aside>
      </div>
    </div>
  );
}
