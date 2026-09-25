import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Inventory data is only as fresh as the last scan, so refetching on
      // every window focus would be noise. Freshness is shown explicitly and
      // refreshed explicitly.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
