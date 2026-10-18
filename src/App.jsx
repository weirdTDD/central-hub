import { useEffect } from "react";
import { AuthProvider } from "./auth/AuthContext";
import { LogsProvider } from "./dashboard/LogsContext";
import AppRoutes from "./routes/AppRoutes";
import { applyTheme, readTheme } from "./settings/theme";

function App() {
  useEffect(() => {
    applyTheme(readTheme());
  }, []);

  return (
    <AuthProvider>
      <LogsProvider>
        <AppRoutes />
      </LogsProvider>
    </AuthProvider>
  );
}

export default App;
