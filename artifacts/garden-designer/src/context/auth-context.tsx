import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  fetchMe,
  login  as apiLogin,
  logout as apiLogout,
  clearAuth,
  getCachedUser,
} from "@/services/auth";
import type { AuthUser } from "@/services/auth";
import { setCRMUser, clearCRMUser } from "@/services/crm-db";

interface AuthContextValue {
  user:         AuthUser | null;
  loading:      boolean;
  isAdmin:      boolean;
  isSuspended:  boolean;
  credits:      number;
  refreshUser:  () => Promise<void>;
  login:        (username: string, password: string) => Promise<void>;
  logout:       () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(getCachedUser);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cached = getCachedUser();
    if (cached) setCRMUser(cached.id);
  }, []);

  useEffect(() => {
    fetchMe()
      .then(u => {
        if (u) setCRMUser(u.id);
        setUser(u);
      })
      .finally(() => setLoading(false));
  }, []);

  const refreshUser = useCallback(async () => {
    const u = await fetchMe();
    if (u) setUser(u);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const u = await apiLogin(username, password);
    setCRMUser(u.id);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    clearCRMUser();
    clearAuth();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      isAdmin:     user?.role === "admin",
      isSuspended: user?.status === "suspended",
      credits:     user?.credits ?? 0,
      refreshUser,
      login,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
