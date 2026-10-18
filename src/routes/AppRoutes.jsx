import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom";
import AuthPage from "../auth/AuthPage";
import ProtectedRoute from "../auth/ProtectedRoute";
import { useAuth } from "../auth/AuthContext";
import DashboardPage from "../dashboard/DashboardPage";
import ReportPage from "../report/reportPage/Page";
import SettingsPage from "../settings/SettingsPage";
import ProfileScreen from "../settings/components/ProfileScreen";
import NotificationScreen from "../settings/components/NotificationScreen";
import IntegrationScreen from "../settings/components/IntegrationScreen";
import NewLogEntryPage from "../logs/NewLogEntryPage";
import EditLogEntryPage from "../logs/EditLogEntryPage";

function HomeRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? "/dashboard" : "/login"} replace />;
}

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<AuthPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/logs/new"
          element={
            <ProtectedRoute>
              <NewLogEntryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/logs/:id/edit"
          element={
            <ProtectedRoute>
              <EditLogEntryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute>
              <ReportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        >
          <Route index element={<ProfileScreen />} />
          <Route path="notifications" element={<NotificationScreen />} />
          <Route path="integrations" element={<IntegrationScreen />} />
        </Route>
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppRoutes;
