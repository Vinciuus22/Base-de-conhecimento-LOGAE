import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionKey } from '@shared/permissions';
import { get, post, setCsrfToken } from '../lib/api';
import { setTimeZone } from '../lib/format';
import type { AppConfig, Me } from '../lib/types';

interface AuthState {
  user: Me | null;
  config: AppConfig | null;
  loading: boolean;
  isInternal: boolean;
  can: (perm: PermissionKey) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    const { user: me } = await get<{ user: Me | null }>('/api/auth/me');
    setUser(me);
    setCsrfToken(me?.csrfToken ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await get<AppConfig>('/api/config');
        setConfig(cfg);
        setTimeZone(cfg.timezone);
        document.title = cfg.appName;
        await refresh();
      } catch {
        /* a interface trata a ausência de configuração */
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await post<{ csrfToken: string }>('/api/auth/login', { email, password });
      setCsrfToken(res.csrfToken);
      await refresh();
      queryClient.clear();
    },
    [refresh, queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      setUser(null);
      setCsrfToken(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      config,
      loading,
      isInternal: user?.userType === 'internal',
      can: (perm) => !!user?.permissions.includes(perm),
      login,
      logout,
      refresh,
    }),
    [user, config, loading, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
