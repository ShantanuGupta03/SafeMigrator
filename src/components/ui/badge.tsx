import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium leading-4 whitespace-nowrap", {
  variants: {
    variant: {
      default: "bg-muted text-foreground",
      success: "bg-labs-accent-secondary text-success-foreground",
      brand: "bg-labs-accent text-safe-black",
      warning: "bg-warning/20 text-warning-foreground",
      danger: "bg-destructive/12 text-destructive",
      info: "bg-muted text-muted-foreground",
      outline: "border border-border text-muted-foreground",
      dark: "bg-primary text-primary-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
