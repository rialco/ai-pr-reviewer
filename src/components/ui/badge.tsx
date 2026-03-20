import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "must_fix" | "should_fix" | "nice_to_have" | "dismiss" | "already_addressed" | "fixing" | "fixed" | "fix_failed" | "confidence_high" | "confidence_low" | "outline";
  className?: string;
}

const variantStyles: Record<string, string> = {
  default: "bg-primary/15 text-primary border-primary/20",
  must_fix: "bg-must-fix/15 text-must-fix border-must-fix/20",
  should_fix: "bg-should-fix/15 text-should-fix border-should-fix/20",
  nice_to_have: "bg-nice-to-have/15 text-nice-to-have border-nice-to-have/20",
  dismiss: "bg-dismiss/15 text-dismiss border-dismiss/20",
  already_addressed: "bg-already-addressed/15 text-already-addressed border-already-addressed/20",
  fixing: "bg-fixing/15 text-fixing border-fixing/20",
  fixed: "bg-fixed/15 text-fixed border-fixed/20",
  fix_failed: "bg-fix-failed/15 text-fix-failed border-fix-failed/20",
  confidence_high: "bg-confidence-high/15 text-confidence-high border-confidence-high/20",
  confidence_low: "bg-confidence-low/15 text-confidence-low border-confidence-low/20",
  outline: "border-border text-muted-foreground",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
