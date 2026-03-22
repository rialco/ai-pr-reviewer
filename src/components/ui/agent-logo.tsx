import { cn } from "@/lib/utils";
import { Bot } from "lucide-react";

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  greptile: "Greptile",
};

const AGENT_LOGOS: Record<string, { src: string; alt: string; imageClassName?: string }> = {
  claude: {
    src: "https://upload.wikimedia.org/wikipedia/commons/b/b0/Claude_AI_symbol.svg",
    alt: "Claude Code logo",
  },
  codex: {
    src: "https://upload.wikimedia.org/wikipedia/commons/6/66/OpenAI_logo_2025_%28symbol%29.svg",
    alt: "Codex logo",
    imageClassName: "brightness-0 invert opacity-90",
  },
};

export function getAgentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

export function AgentLogo({
  agent,
  className,
}: {
  agent: string;
  className?: string;
}) {
  const logo = AGENT_LOGOS[agent];

  if (!logo) {
    return <Bot className={cn("text-muted-foreground/60", className)} />;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center overflow-hidden rounded-sm",
        className,
      )}
      title={logo.alt}
      aria-hidden="true"
    >
      <img
        src={logo.src}
        alt={logo.alt}
        className={cn("h-full w-full object-contain", logo.imageClassName)}
        loading="lazy"
      />
    </span>
  );
}
