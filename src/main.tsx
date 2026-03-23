import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider, useAuth } from "@clerk/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import "./index.css";
import { CloudAppShell } from "./components/CloudAppShell";
import {
  clerkPublishableKey,
  getConvexReactClient,
  hasCloudEnv,
} from "./lib/cloud";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function AppProviders() {
  const app = (
    <QueryClientProvider client={queryClient}>
      <CloudAppShell />
    </QueryClientProvider>
  );

  if (!hasCloudEnv) {
    return app;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <ConvexProviderWithClerk client={getConvexReactClient()} useAuth={useAuth}>
        {app}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
