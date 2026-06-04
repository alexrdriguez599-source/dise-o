import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogIn, Shield } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import AdminPanel from "@/components/admin-panel";
import HabitaLogo from "@/components/habita-logo";

export default function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  // Panel de administrador (módulo independiente)
  const [showAdmin, setShowAdmin] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err?.message ?? "Credenciales incorrectas");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Animaciones del fondo (scoped a esta pantalla) */}
      <style>{`
        @keyframes atriaFade {
          0%   { opacity: 0; transform: scale(1.0); }
          6%   { opacity: 1; }
          28%  { opacity: 1; transform: scale(1.09); }
          36%  { opacity: 0; }
          100% { opacity: 0; }
        }
        .atria-slide {
          position: absolute; inset: 0;
          background-size: cover; background-position: center;
          opacity: 0; transform: scale(1.06);
          animation: atriaFade 21s infinite;
          will-change: opacity, transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .atria-slide { animation: none; }
          .atria-slide:first-child { opacity: 1; }
        }
      `}</style>

      <div className="relative min-h-[100dvh] w-full flex flex-col items-center justify-center px-4 py-8 gap-4 overflow-y-auto overflow-x-hidden">
        {/* ── Fondo full-bleed: slideshow de renders con crossfade + zoom sutil ── */}
        <div className="absolute inset-0 z-0" aria-hidden="true">
          <div className="atria-slide" style={{ backgroundImage: "url('/atria-bg-1.jpg')", animationDelay: "0s" }} />
          <div className="atria-slide" style={{ backgroundImage: "url('/atria-bg-2.jpg')", animationDelay: "7s" }} />
          <div className="atria-slide" style={{ backgroundImage: "url('/atria-bg-3.jpg')", animationDelay: "14s" }} />
        </div>
        {/* ── Capa de oscurecido/tinte para legibilidad ── */}
        <div
          className="absolute inset-0 z-[1]"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(120% 90% at 50% 30%, rgba(8,28,20,0.25), rgba(8,28,20,0.62) 70%, rgba(6,20,15,0.82) 100%), linear-gradient(180deg, rgba(22,53,42,0.28), rgba(14,36,27,0.55))",
          }}
        />

        {/* ── Tarjeta de login (glassmorphism) ── */}
        <div className="relative z-[2] w-full max-w-sm">
          <form
            onSubmit={handleSubmit}
            className="rounded-3xl border border-white/25 p-8 space-y-6"
            style={{
              background: "rgba(255,255,255,0.10)",
              backdropFilter: "blur(22px) saturate(140%)",
              WebkitBackdropFilter: "blur(22px) saturate(140%)",
              boxShadow: "0 30px 80px -20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.25)",
            }}
          >
            <div className="flex flex-col items-center gap-2">
              <h1 className="sr-only">Atria</h1>
              <HabitaLogo bg="dark" size={50} withHouse />
              <span
                className="text-[11px] font-light tracking-[0.42em] uppercase text-[#d9cfa6] pl-[0.42em]"
                style={{ fontFamily: "'Jost', sans-serif" }}
              >
                Diseño de Espacios
              </span>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white/85">Usuario</label>
                <Input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Usuario"
                  autoComplete="username"
                  autoFocus
                  className="h-12 rounded-xl bg-white/10 border-white/30 text-white placeholder:text-white/55 focus-visible:ring-white/40 focus-visible:border-white/50"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-white/85">Contraseña</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Contraseña"
                  autoComplete="current-password"
                  className="h-12 rounded-xl bg-white/10 border-white/30 text-white placeholder:text-white/55 focus-visible:ring-white/40 focus-visible:border-white/50"
                />
              </div>
            </div>

            {error && (
              <div className="text-sm text-white bg-red-500/30 border border-red-300/50 rounded-xl px-4 py-2.5 text-center font-medium">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={!username || !password || loading}
              className="w-full h-12 rounded-xl text-base font-semibold gap-2 border-0 bg-gradient-to-b from-[#d8bd84] to-[#c8a96a] text-[#0e241b] hover:from-[#e0c890] hover:to-[#cdb074] shadow-lg disabled:opacity-60"
            >
              <LogIn className="w-5 h-5" />
              {loading ? "Verificando..." : "Entrar"}
            </Button>
          </form>
        </div>

        {/* ── Botón ADMINISTRADOR (módulo independiente) ── */}
        <div className="relative z-[2] w-full max-w-sm">
          <button
            onClick={() => setShowAdmin(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/25 bg-white/10 text-white/80 hover:text-white hover:border-white/40 hover:bg-white/20 text-xs font-semibold uppercase tracking-widest transition-all backdrop-blur-md shadow-sm"
          >
            <Shield className="w-3.5 h-3.5" />
            Administrador
          </button>
        </div>
      </div>

      {/* ── Panel admin — módulo completamente independiente ── */}
      {showAdmin && (
        <AdminPanel onClose={() => setShowAdmin(false)} />
      )}
    </>
  );
}
