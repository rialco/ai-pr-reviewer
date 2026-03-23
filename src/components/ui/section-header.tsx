import { cn } from "@/lib/utils";

interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  detail?: React.ReactNode;
  pipClassName?: string;
  titleClassName?: string;
  interactive?: boolean;
}

export function SectionHeader({
  title,
  detail,
  pipClassName = "bg-muted-foreground/40",
  titleClassName,
  interactive = false,
  className,
  ...props
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex h-[40px] items-center gap-2.5 border-b border-border bg-white/[0.02] px-3",
        interactive && "cursor-pointer select-none transition-colors duration-100 hover:bg-white/[0.04] active:bg-white/[0.06]",
        className,
      )}
      {...props}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", pipClassName)} />
      <span className={cn("text-[11px] font-semibold uppercase tracking-wide text-muted-foreground", titleClassName)}>
        {title}
      </span>
      {detail ? (
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/50">
          {detail}
        </span>
      ) : null}
    </div>
  );
}
