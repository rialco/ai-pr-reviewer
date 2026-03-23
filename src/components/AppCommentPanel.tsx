import { CommentView } from "./CommentView";
import { CloudCommentView } from "./CloudCommentView";
import { hasCloudEnv } from "../lib/cloud";

interface AppCommentPanelProps {
  repo: string;
  prNumber: number;
}

export function AppCommentPanel({ repo, prNumber }: AppCommentPanelProps) {
  return hasCloudEnv ? (
    <CloudCommentView repo={repo} prNumber={prNumber} />
  ) : (
    <CommentView repo={repo} prNumber={prNumber} />
  );
}
