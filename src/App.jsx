import { useEffect } from "react"
import { LogsProvider } from "./dashboard/LogsContext"
import AppRoutes from "./routes/AppRoutes"
import { applyTheme, readTheme } from "./settings/theme"

function App() {
  useEffect(() => {
    applyTheme(readTheme())
  }, [])

  return (
    <LogsProvider>
      <AppRoutes />
    </LogsProvider>
  )
}

export default App
