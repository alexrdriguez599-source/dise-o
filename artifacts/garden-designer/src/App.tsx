import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppProvider } from "@/context/app-context";
import { AuthProvider, useAuth } from "@/context/auth-context";
import ClientFormPage from "@/pages/client-form";
import ClientesPage from "@/pages/clientes";
import DesignPage from "@/pages/design";
import Inventario from "@/pages/inventario";
import PresentacionPage from "@/pages/presentacion";
import LoginScreen from "@/components/login-screen";
import CadDesignerPage from "@/pages/cad-designer";
import BrushPage from "@/pages/brush";
import AdminPage from "@/pages/admin";
import { OfflineBanner } from "@/components/offline-banner";
import { Shield, Coins } from "lucide-react";
import { useEffect } from "react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Ping silencioso a /api/healthz para despertar el servidor en cold-start */
function useServerWarmup() {
  useEffect(() => {
    // Ping inmediato al montar la app
    const ping = () => fetch(`${API_BASE}/api/healthz`, { credentials: "include" }).catch(() => {});
    ping();
    // Re-ping cuando el usuario vuelve a la pestaña tras inactividad
    const onVisible = () => { if (document.visibilityState === "visible") ping(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cold-start de autoscale tarda ~3s — 6 reintentos con backoff
      // da hasta ~30s de espera total antes de mostrar error real.
      retry: 6,
      retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 12000),
      staleTime: 60 * 1000,
      refetchOnWindowFocus: true,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/"            component={ClientFormPage} />
      <Route path="/clientes"    component={ClientesPage} />
      <Route path="/design"      component={DesignPage} />
      <Route path="/inventario"  component={Inventario} />
      <Route path="/presentacion" component={PresentacionPage} />
      <Route path="/cad"         component={CadDesignerPage} />
      <Route path="/brush"       component={BrushPage} />
      <Route path="/admin"       component={AdminPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function LogoutButton() {
  const { user, logout, isAdmin, credits } = useAuth();

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2">
      {isAdmin && (
        <a
          href="/admin"
          className="bg-card border border-border text-primary hover:bg-stone-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors flex items-center gap-1.5"
        >
          <Shield className="w-3.5 h-3.5" />
          Admin
        </a>
      )}
      {!isAdmin && (
        <span className="bg-card border border-amber-200 text-amber-700 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-sm flex items-center gap-1.5">
          <Coins className="w-3 h-3" />
          {credits}
        </span>
      )}
      <button
        onClick={() => logout()}
        className="bg-card border border-border text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors"
        title={user ? `@${user.username}` : ""}
      >
        {user ? `@${user.username} · Salir` : "Salir"}
      </button>
    </div>
  );
}

function SuspendedScreen({ username, onLogout }: { username: string; onLogout: () => void }) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-stone-50 p-4">
      <div className="bg-white border border-border rounded-2xl shadow-sm p-8 max-w-sm w-full text-center space-y-4">
        <div className="w-14 h-14 rounded-full bg-red-50 border border-red-200 flex items-center justify-center mx-auto">
          <Shield className="w-7 h-7 text-red-500" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Cuenta suspendida</h2>
          <p className="text-sm text-muted-foreground mt-1">
            La cuenta <strong>@{username}</strong> ha sido suspendida. Contacta al administrador para reactivarla.
          </p>
        </div>
        <button
          onClick={onLogout}
          className="w-full h-10 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-stone-50 transition-colors"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

function AppShell() {
  useServerWarmup();
  const { user, loading, isSuspended, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-stone-50">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  if (isSuspended) {
    return <SuspendedScreen username={user.username} onLogout={logout} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppProvider key={user.id}>
          <OfflineBanner />
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
          <LogoutButton />
        </AppProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;
