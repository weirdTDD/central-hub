import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom"
import ReportPage from "../report/reportPage/Page"
import SettingsPage from "../settings/SettingsPage"
import ProfileScreen from "../settings/components/ProfileScreen"
import NotificationScreen from "../settings/components/NotificationScreen"
import IntegrationScreen from "../settings/components/IntegrationScreen"

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/reports" replace />} />
        <Route path="/reports" element={<ReportPage />} />
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<ProfileScreen />} />
          <Route path="notifications" element={<NotificationScreen />} />
          <Route path="integrations" element={<IntegrationScreen />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default AppRoutes
