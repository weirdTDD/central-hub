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
import LogsPage from "../logs/LogsPage";
import NewLogEntryPage from "../logs/NewLogEntryPage";
import EditLogEntryPage from "../logs/EditLogEntryPage";
import TasksPage from "../features/tasks/TasksPage";
import { TasksProvider } from "../features/tasks/TasksContext";
import IntegrationsPage from "../features/integrations/IntegrationsPage";
import { IntegrationsProvider } from "../features/integrations/IntegrationsContext";
import TrackingPage from "../features/tracking/TrackingPage";
import CodingPage from "../features/coding/CodingPage";
import { TrackingProvider } from "../features/tracking/TrackingContext";
import NotificationsPage from "../features/notifications/NotificationsPage";
import AskPage from "../features/ai/AskPage";
import { NotificationsProvider } from "../features/notifications/NotificationsContext";

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
           path="/tasks"
           element={
             <ProtectedRoute>
               {/* The tasks provider lives on the route that needs it: the task
                   data (and its realtime channel) is not loaded on other pages. */}
               <TasksProvider>
                 <TasksPage />
               </TasksProvider>
             </ProtectedRoute>
           }
         />
         <Route
           path="/integrations"
           element={
             <ProtectedRoute>
               {/* The integrations provider lives on the route that needs it: the
                   connection data (and its realtime channel) is not loaded on other pages. */}
               <IntegrationsProvider>
                 <IntegrationsPage />
               </IntegrationsProvider>
             </ProtectedRoute>
           }
         />
         <Route
           path="/tracking"
           element={
             <ProtectedRoute>
               {/* The tracking provider lives on the route that needs it: the
                   session data (and its realtime channels) is not loaded on other pages. */}
               <TrackingProvider>
                 <TrackingPage />
               </TrackingProvider>
             </ProtectedRoute>
           }
         />
         <Route
           path="/coding"
           element={
             <ProtectedRoute>
               <CodingPage />
             </ProtectedRoute>
           }
         />
         <Route
           path="/notifications"
           element={
             <ProtectedRoute>
               {/* The notifications provider lives on the route that needs it: the
                   notification data (and its realtime channels) is not loaded on other pages. */}
               <NotificationsProvider>
                 <NotificationsPage />
               </NotificationsProvider>
             </ProtectedRoute>
           }
         />
        <Route
          path="/logs"
          element={
            <ProtectedRoute>
              <LogsPage />
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
          path="/ask"
          element={
            <ProtectedRoute>
              <AskPage />
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
