import { BrowserRouter, Route, Routes } from "react-router-dom"

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<div className="p-8 text-xl font-semibold">DailyLogs</div>} />
      </Routes>
    </BrowserRouter>
  )
}

export default AppRoutes
