import React from "react";
import { Link, useLocation } from "wouter";
import { Leaf, Package, Shield } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import HabitaLogo from "@/components/habita-logo";

interface AppLayoutProps {
  children: React.ReactNode;
  imageBase64?: string | null;
  inventoryContext?: string | null;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();
  const { isAdmin } = useAuth();

  const navLinks = [
    { href: "/", label: "Diseño", icon: Leaf },
    { href: "/inventario", label: "Inventario", icon: Package },
    ...(isAdmin ? [{ href: "/admin", label: "Admin", icon: Shield }] : []),
  ];

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden relative">
      {/* Top Navigation - Desktop */}
      <header className="hidden md:flex items-center justify-between h-16 px-6 border-b border-border bg-card/80 backdrop-blur z-20">
        <div className="flex items-center">
          <HabitaLogo bg="light" size={26} />
        </div>
        <nav className="flex items-center gap-6">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-2 text-sm font-medium transition-colors hover:text-primary ${
                location === link.href ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <link.icon className="w-4 h-4" />
              {link.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* Top Header - Mobile */}
      <header className="md:hidden flex items-center justify-center h-14 border-b border-border bg-card/80 backdrop-blur z-20">
        <div className="flex items-center">
          <HabitaLogo bg="light" size={20} />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden relative pb-16 md:pb-0">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 border-t border-border bg-card/95 backdrop-blur z-40 flex items-center justify-around px-4">
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors ${
              location === link.href ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <link.icon className="w-5 h-5" />
            <span className="text-[10px] font-medium">{link.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
