import { SignInButton, UserButton } from "@clerk/react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation } from "convex/react";
import { Cloud, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { App } from "@/App";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { hasCloudEnv, missingCloudEnv } from "@/lib/cloud";
import { api } from "../../convex/_generated/api";

function CloudBootstrap() {
  const ensureCurrentUser = useMutation(api.bootstrap.ensureCurrentUser);
  const hasBootstrappedRef = useRef(false);

  useEffect(() => {
    if (hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;
    void ensureCurrentUser();
  }, [ensureCurrentUser]);

  return null;
}

function SignedInApp() {
  return (
    <div className="relative h-screen">
      <CloudBootstrap />
      <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-end px-3">
        <div className="pointer-events-auto flex items-start gap-2">
          <div className="rounded-full border border-border bg-card/90 p-1 shadow-lg backdrop-blur">
            <UserButton />
          </div>
        </div>
      </div>
      <App />
    </div>
  );
}

function CloudSetupRequiredScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-xl border-border/80 bg-card shadow-2xl">
        <CardHeader className="space-y-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Cloud className="h-5 w-5" />
          </div>
          <CardTitle className="text-lg">Cloud Setup Required</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>
            Local mode is no longer supported. This app now requires Clerk and Convex to load the
            workspace, machines, PR state, and job control plane.
          </p>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-foreground/80">
              Missing Env
            </p>
            <p>{missingCloudEnv.join(", ")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CloudAuthShell() {
  return (
    <>
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
      <Unauthenticated>
        <SignInScreen />
      </Unauthenticated>
      <Authenticated>
        <SignedInApp />
      </Authenticated>
    </>
  );
}

export function CloudAppShell() {
  if (!hasCloudEnv) {
    return <CloudSetupRequiredScreen />;
  }

  return (
    <div className="h-screen">
      <CloudAuthShell />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md border-border/80 bg-card/90 shadow-2xl">
        <CardHeader>
          <div className="flex items-center gap-2 text-primary">
            <Cloud className="h-4 w-4" />
            <CardTitle>Connecting Cloud Control Plane</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Loading your Clerk session and Convex subscriptions.
        </CardContent>
      </Card>
    </div>
  );
}

function SignInScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-xl border-border/80 bg-card shadow-2xl">
        <CardHeader className="space-y-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <CardTitle className="text-lg">Sign In To The Cloud Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-6 text-muted-foreground">
            The control plane moves to Clerk and Convex, but execution stays on your linked
            machines. Sign in here to access repo state, PR status, comments, fixes, jobs, and
            machine availability from anywhere.
          </p>
          <div className="flex flex-wrap gap-3">
            <SignInButton mode="modal">
              <Button size="lg">Continue With Clerk</Button>
            </SignInButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
