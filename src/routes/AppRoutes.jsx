import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom"
import ReportPage from "../report/reportPage/Page"

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/reports" replace />} />
        <Route path="/reports" element={<ReportPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default AppRoutes
