import { createContext, useContext, useMemo, useState } from "react";

const AUTH_KEY = "dailylogs-auth";

const AuthContext = createContext(null);

function readStoredUser() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistUser(user) {
  if (user) localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  else localStorage.removeItem(AUTH_KEY);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readStoredUser);

  const value = useMemo(() => {
    const login = ({ fullName, email }) => {
      const next = {
        name: fullName?.trim() || email.split("@")[0],
        email: email.trim().toLowerCase(),
        avatar: `https://i.pravatar.cc/150?u=${encodeURIComponent(email.trim().toLowerCase())}`,
        role: "Team Member",
      };
      persistUser(next);
      setUser(next);
      return next;
    };

    const loginWithGoogle = () =>
      login({
        fullName: "Bright Kelly",
        email: "bright.kelly@bst.com",
      });

    const logout = () => {
      persistUser(null);
      setUser(null);
    };

    return {
      user,
      isAuthenticated: Boolean(user),
      login,
      loginWithGoogle,
      logout,
    };
  }, [user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
