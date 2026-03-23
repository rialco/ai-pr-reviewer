import { ConvexReactClient } from "convex/react";

export const clerkPublishableKey =
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";
export const convexUrl = import.meta.env.VITE_CONVEX_URL ?? "";

export const missingCloudEnv = [
  !clerkPublishableKey ? "VITE_CLERK_PUBLISHABLE_KEY" : null,
  !convexUrl ? "VITE_CONVEX_URL" : null,
].filter((value): value is string => Boolean(value));

export const hasCloudEnv = missingCloudEnv.length === 0;

let convexClient: ConvexReactClient | null = null;

export function getConvexReactClient(): ConvexReactClient {
  if (!convexUrl) {
    throw new Error("VITE_CONVEX_URL is required to initialize Convex.");
  }

  convexClient ??= new ConvexReactClient(convexUrl);
  return convexClient;
}
