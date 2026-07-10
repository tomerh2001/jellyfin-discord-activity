import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
};

export function Button({ children, icon, type = "button", ...props }: ButtonProps) {
  return (
    <button className="button" type={type} {...props}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
