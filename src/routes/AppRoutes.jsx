import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom"
import DashboardPage from "../dashboard/DashboardPage"
import ReportPage from "../report/reportPage/Page"
import SettingsPage from "../settings/SettingsPage"
import ProfileScreen from "../settings/components/ProfileScreen"
import NotificationScreen from "../settings/components/NotificationScreen"
import IntegrationScreen from "../settings/components/IntegrationScreen"
import NewLogEntryPage from "../logs/NewLogEntryPage"
import EditLogEntryPage from "../logs/EditLogEntryPage"

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/logs/new" element={<NewLogEntryPage />} />
        <Route path="/logs/:id/edit" element={<EditLogEntryPage />} />
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
