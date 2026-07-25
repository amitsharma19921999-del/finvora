// Auth context — session state, role guards, live account-status updates
// (e.g. the moment the admin approves KYC+bank and the account activates).
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, getToken, getStoredUser, storeSession, updateStoredUser, clearSession } from './api';
import { subscribe, disconnect, reconnect } from './realtime';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(getStoredUser());
  const [me, setMe] = useState(null); // full /api/auth/me payload (investor onboarding state)

  const refreshMe = useCallback(async () => {
    if (!getToken()) return null;
    try {
      const data = await api.get('/api/auth/me');
      setUser(data.user);
      updateStoredUser(data.user);
      setMe(data);
      return data;
    } catch (e) {
      // A 403 means the account was suspended server-side — reflect it locally
      // (the API's 403 body can't reach /me, so we mark status from the error).
      if (e.status === 403) {
        const u = { ...(getStoredUser() || {}), status: 'Suspended' };
        setUser(u);
        updateStoredUser(u);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (getToken()) refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    if (!user) return undefined;
    const un = subscribe('accountStatus', () => refreshMe());
    return un;
  }, [user, refreshMe]);

  const login = useCallback((token, u) => {
    storeSession(token, u);
    setUser(u);
    reconnect();
    refreshMe();
  }, [refreshMe]);

  const logout = useCallback(() => {
    clearSession();
    disconnect();
    setUser(null);
    setMe(null);
    window.location.href = '/login';
  }, []);

  return <AuthCtx.Provider value={{ user, me, refreshMe, login, logout }}>{children}</AuthCtx.Provider>;
}

export function RequireRole({ role, children }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user || !getToken()) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (role && user.role !== role) return <Navigate to={user.role === 'admin' ? '/admin' : '/app'} replace />;
  return children;
}
