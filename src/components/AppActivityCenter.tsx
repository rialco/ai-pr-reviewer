import { JobCenter } from "./JobCenter";
import { CloudJobCenter } from "./CloudJobCenter";
import { hasCloudEnv } from "../lib/cloud";

interface AppActivityCenterProps {
  onNavigateToPR: (repo: string, prNumber: number) => void;
  lastPollAt?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppActivityCenter(props: AppActivityCenterProps) {
  return hasCloudEnv ? <CloudJobCenter {...props} /> : <JobCenter {...props} />;
}
