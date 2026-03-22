import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface SwitchProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  checked: boolean;
  size?: "sm" | "md";
}

const sizeStyles = {
  sm: {
    track: "h-5 w-9",
    thumb: "h-3.5 w-3.5",
    on: "translate-x-5",
    off: "translate-x-1",
  },
  md: {
    track: "h-6 w-11",
    thumb: "h-4 w-4",
    on: "translate-x-6",
    off: "translate-x-1",
  },
} as const;

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, className, disabled, size = "md", ...props }, ref) => {
    const styles = sizeStyles[size];

    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "bg-primary shadow-[0_0_18px_rgba(109,91,247,0.28)]" : "bg-muted",
          disabled ? "cursor-not-allowed opacity-60" : "",
          styles.track,
          className,
        )}
      >
        <span
          className={cn(
            "pointer-events-none block rounded-full bg-foreground transition-transform",
            checked ? styles.on : styles.off,
            styles.thumb,
          )}
        />
      </button>
    );
  },
);

Switch.displayName = "Switch";
