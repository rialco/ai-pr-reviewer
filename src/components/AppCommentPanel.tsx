import { CloudCommentView } from "./CloudCommentView";

interface AppCommentPanelProps {
  repo: string;
  prNumber: number;
}

export function AppCommentPanel({ repo, prNumber }: AppCommentPanelProps) {
  return <CloudCommentView repo={repo} prNumber={prNumber} />;
}
