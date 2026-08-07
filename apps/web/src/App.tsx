import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./lib/theme";
import { Runs } from "./pages/Runs";
import { RunDetail } from "./pages/RunDetail";
import { Runners } from "./pages/Runners";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/runners" element={<Runners />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
