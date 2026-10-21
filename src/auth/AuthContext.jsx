import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  SUPABASE_NOT_CONFIGURED_MESSAGE,
  isSupabaseConfigured,
  supabase,
} from "../lib/supabase";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // When Supabase is not configured there is no session to wait for, so the
  // initial state is already "not loading" and no effect has to write to it.
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return undefined;

    let mounted = true;

    const init = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (!mounted) return;
        if (error) {
          console.error("Supabase session error:", error.message);
        }
        setUser(session?.user ?? null);
      } catch (error) {
        if (!mounted) return;
        console.error("Supabase init error:", error.message);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!mounted) return;
        setUser(session?.user ?? null);
        setLoading(false);
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const requireSupabase = () => {
    if (!supabase) throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
    return supabase;
  };

  /**
   * Registers a new account.
   *
   * Returns { session, user }. When the project requires email confirmation the
   * response contains a user but NO session — the caller must not treat that as
   * a completed sign-in.
   */
  const signUp = useCallback(async ({ email, password, fullName }) => {
    const client = requireSupabase();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName ?? "" } },
    });
    if (error) throw error;
    return { session: data.session ?? null, user: data.user ?? null };
  }, []);

  const signIn = useCallback(async ({ email, password }) => {
    const client = requireSupabase();
    const { error } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const client = requireSupabase();
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
    });
    if (error) throw error;
  }, []);

  /**
   * Signs the user out.
   *
   * The local session is always torn down, even when the server call fails, so
   * a network error can never leave the user signed in on a shared machine.
   */
  const signOut = useCallback(async () => {
    if (!supabase) {
      setUser(null);
      return;
    }

    let failure = null;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) failure = error;
    } catch (err) {
      failure = err;
    }

    if (failure) {
      // Force the local session to be removed even if the global sign-out failed.
      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    }

    setUser(null);

    if (failure) throw failure;
  }, []);

  // The context value is memoized: a new object on every render would re-render
  // every `useAuth()` consumer and invalidate the derived memos downstream.
  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      loading,
      isConfigured: isSupabaseConfigured,
      notConfiguredMessage: SUPABASE_NOT_CONFIGURED_MESSAGE,
      signUp,
      signIn,
      signInWithGoogle,
      signOut,
    }),
    [user, loading, signUp, signIn, signInWithGoogle, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
