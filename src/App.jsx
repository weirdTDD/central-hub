import { LogsProvider } from "./dashboard/LogsContext"
import AppRoutes from "./routes/AppRoutes"

function App() {
  return (
    <LogsProvider>
      <AppRoutes />
    </LogsProvider>
  )
}

export default App
