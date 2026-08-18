import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ConfirmProvider } from "@/components/ui/confirm";
import { AppShell } from "@/components/AppShell";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { EnvPage } from "@/pages/EnvPage";
import { JiraPage } from "@/pages/JiraPage";
import { GitHubPage } from "@/pages/GitHubPage";
import { KnowledgePage } from "@/pages/KnowledgePage";
import { MemoryPage } from "@/pages/MemoryPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { WorkflowsPage } from "@/pages/WorkflowsPage";
import { SearchPage } from "@/pages/SearchPage";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", element: <ProjectsPage /> },
      // Matched so the URL stays canonical, but rendered by AppShell outside
      // the outlet — that is what keeps a project alive while you're elsewhere.
      { path: "projects/:id", element: null },
      { path: "env", element: <EnvPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "jira", element: <JiraPage /> },
      { path: "github", element: <GitHubPage /> },
      { path: "knowledge", element: <KnowledgePage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "workflows", element: <WorkflowsPage /> },
      { path: "search", element: <SearchPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
);
