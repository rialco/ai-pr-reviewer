import { useState } from "react";
import { Button } from "./ui/button";
import { useAddRepo, useBrowse, useGitRemote } from "../hooks/useApi";
import { Plus, FolderOpen, ChevronRight, ArrowUp, Home, Check } from "lucide-react";

export function AddRepo() {
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState("~");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const addRepo = useAddRepo();
  const { data: browseData, isLoading } = useBrowse(browsing ? browsePath : "");
  const { data: gitRemote } = useGitRemote(selectedPath);

  function handleBrowseSelect(dirPath: string) {
    setSelectedPath(dirPath);
  }

  function handleConfirmBrowse() {
    if (!gitRemote || !selectedPath) return;
    addRepo.mutate(
      { owner: gitRemote.owner, repo: gitRemote.repo, localPath: selectedPath },
      {
        onSuccess: () => {
          setBrowsing(false);
          setSelectedPath(null);
          setBrowsePath("~");
        },
      },
    );
  }

  function handleCancelBrowse() {
    setBrowsing(false);
    setSelectedPath(null);
    setBrowsePath("~");
  }

  if (!browsing) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setBrowsing(true)}
      >
        <FolderOpen className="h-4 w-4 mr-1.5" />
        Browse for a git repo
      </Button>
    );
  }

  return (
    <div className="border border-border rounded-md overflow-hidden bg-background">
      {/* Show selected repo confirmation */}
      {selectedPath && gitRemote ? (
        <div className="p-3 space-y-2">
          <div className="text-sm">
            Found repo: <span className="font-medium">{gitRemote.owner}/{gitRemote.repo}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate" title={selectedPath}>
              {selectedPath}
            </span>
          </div>
          <div className="flex items-center gap-1.5 justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setSelectedPath(null)}
            >
              Back
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleConfirmBrowse}
              disabled={addRepo.isPending}
            >
              <Plus className="h-3 w-3 mr-1" />
              Add {gitRemote.owner}/{gitRemote.repo}
            </Button>
          </div>
        </div>
      ) : selectedPath && !gitRemote ? (
        <div className="p-3 space-y-2">
          <div className="text-sm text-destructive">
            Could not read git remote from this directory.
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setSelectedPath(null)}
          >
            Back
          </Button>
        </div>
      ) : (
        <>
          {/* Current path header */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border">
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate flex-1" title={browseData?.current}>
              {browseData?.current ?? browsePath}
            </span>
            {browseData?.isGitRepo && (
              <span className="text-[10px] font-medium text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded shrink-0">
                git repo
              </span>
            )}
          </div>

          {/* Navigation buttons */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => setBrowsePath("~")}
            >
              <Home className="h-3 w-3 mr-1" />
              Home
            </Button>
            {browseData?.parent && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setBrowsePath(browseData.parent!)}
              >
                <ArrowUp className="h-3 w-3 mr-1" />
                Up
              </Button>
            )}
          </div>

          {/* Directory list */}
          <div className="max-h-48 overflow-y-auto">
            {isLoading ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">Loading...</div>
            ) : browseData?.dirs.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">No subdirectories</div>
            ) : (
              browseData?.dirs.map((dir) => (
                <button
                  key={dir}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 text-left"
                  onClick={() => setBrowsePath(`${browseData.current}/${dir}`)}
                >
                  <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{dir}</span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
                </button>
              ))
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-border bg-muted/30">
            <span className="text-[10px] text-muted-foreground">
              {browseData?.isGitRepo ? "This is a git repository" : "Navigate to a git repository"}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={handleCancelBrowse}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-6 text-xs px-2"
                disabled={!browseData?.isGitRepo}
                onClick={() => handleBrowseSelect(browseData?.current ?? browsePath)}
              >
                <Check className="h-3 w-3 mr-1" />
                Select
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
