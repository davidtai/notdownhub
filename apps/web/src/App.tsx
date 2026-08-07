import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./lib/theme";
import { Runs } from "./pages/Runs";
import { RunDetail } from "./pages/RunDetail";
import { Runners } from "./pages/Runners";
import { Settings } from "./pages/Settings";
import { Projects } from "./pages/Projects";
import { WorkflowPreview } from "./pages/WorkflowPreview";

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/workflow/:runId" element={<WorkflowPreview />} />
          <Route path="/runners" element={<Runners />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
