import { cn } from "@/lib/utils";
import { useEffect, useRef, type ReactNode } from "react";

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  content: ReactNode;
  align?: "left" | "right";
  className?: string;
  contentContainerClassName?: string;
  contentClassName?: string;
}

export function Popover({
  open,
  onOpenChange,
  children,
  content,
  align = "left",
  className,
  contentContainerClassName,
  contentClassName,
}: PopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={containerRef} className={cn("relative overflow-visible", className)}>
      {children}

      <div
        aria-hidden={!open}
        className={cn(
          "z-50 transition-all duration-200 ease-out",
          contentContainerClassName ?? "absolute bottom-full mb-2",
          !contentContainerClassName && (align === "left" ? "left-0" : "right-0"),
          open ? "visible translate-y-0 opacity-100" : "pointer-events-none invisible translate-y-1 opacity-0",
        )}
      >
        <div
          role="dialog"
          className={cn(
            "w-[20.75rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/35 animate-enter-fade-slide",
            contentClassName,
          )}
        >
          {content}
        </div>
      </div>
    </div>
  );
}
