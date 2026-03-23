import { CloudJobCenter } from "./CloudJobCenter";

interface AppActivityCenterProps {
  onNavigateToPR: (repo: string, prNumber: number) => void;
  lastPollAt?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppActivityCenter(props: AppActivityCenterProps) {
  return <CloudJobCenter {...props} />;
}
