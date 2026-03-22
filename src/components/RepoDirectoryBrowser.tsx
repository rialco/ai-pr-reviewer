import { cn } from "@/lib/utils";
import { ArrowUp, Check, ChevronRight, FolderOpen, Home } from "lucide-react";
import { useBrowse } from "../hooks/useApi";
import { Button } from "./ui/button";

interface RepoDirectoryBrowserProps {
  path: string;
  onPathChange: (path: string) => void;
  onSelect: (path: string) => void;
  onCancel: () => void;
  className?: string;
  selectLabel?: string;
  requireGitRepo?: boolean;
  helperText?: string;
}

export function RepoDirectoryBrowser({
  path,
  onPathChange,
  onSelect,
  onCancel,
  className,
  selectLabel = "Select",
  requireGitRepo = false,
  helperText,
}: RepoDirectoryBrowserProps) {
  const { data: browseData, isLoading } = useBrowse(path);
  const currentPath = browseData?.current ?? path;
  const canSelect = requireGitRepo ? !!browseData?.isGitRepo : !isLoading;
  const footerText = browseData?.isGitRepo
    ? "This is a git repository"
    : helperText ?? "Navigate to a directory";

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-background", className)}>
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-2.5 py-1.5">
        <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span
          className="flex-1 truncate text-xs font-mono text-muted-foreground"
          title={currentPath}
        >
          {currentPath}
        </span>
        {browseData?.isGitRepo ? (
          <span className="shrink-0 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-500">
            git repo
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => onPathChange("~")}
        >
          <Home className="mr-1 h-3 w-3" />
          Home
        </Button>
        {browseData?.parent ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onPathChange(browseData.parent!)}
          >
            <ArrowUp className="mr-1 h-3 w-3" />
            Up
          </Button>
        ) : null}
      </div>

      <div className="max-h-56 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">Loading...</div>
        ) : browseData?.dirs.length ? (
          browseData.dirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50"
              onClick={() => onPathChange(`${currentPath}/${dir}`)}
            >
              <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{dir}</span>
              <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          ))
        ) : (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No subdirectories</div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-2.5 py-1.5">
        <span className="text-[10px] text-muted-foreground">{footerText}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!canSelect}
            onClick={() => onSelect(currentPath)}
          >
            <Check className="mr-1 h-3 w-3" />
            {selectLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
