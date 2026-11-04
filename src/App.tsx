import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { FirstRunGate } from "./components/FirstRunGate";
import { Settings } from "./views/Settings";
import { Setup } from "./views/Setup";
import { TasksPage } from "./views/TasksPage";
import { TaskRun } from "./views/TaskRun";
import "./App.css";

function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/tasks" replace />} />
        <Route
          path="/tasks"
          element={
            <FirstRunGate>
              <TasksPage />
            </FirstRunGate>
          }
        />
        <Route path="/tasks/:id" element={<TaskRun />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    </AppShell>
  );
}

export default App;
