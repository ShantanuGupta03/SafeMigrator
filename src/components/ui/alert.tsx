import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const styles = {
  info: { box: "border-transparent bg-muted", icon: Info, iconClass: "text-foreground" },
  warning: { box: "border-warning/50 bg-warning/10", icon: AlertTriangle, iconClass: "text-warning-foreground" },
  danger: { box: "border-destructive/40 bg-destructive/5", icon: ShieldAlert, iconClass: "text-destructive" },
  success: { box: "border-labs-accent-secondary bg-labs-accent", icon: CheckCircle2, iconClass: "text-success-foreground" },
} as const;

export function Alert({
  variant = "info",
  title,
  children,
  className,
}: {
  variant?: keyof typeof styles;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const s = styles[variant];
  const Icon = s.icon;
  return (
    <div role={variant === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-xl border p-3 text-sm", s.box, className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", s.iconClass)} />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium leading-tight">{title}</p>}
        {children && <div className="text-muted-foreground [&_a]:underline">{children}</div>}
      </div>
    </div>
  );
}
