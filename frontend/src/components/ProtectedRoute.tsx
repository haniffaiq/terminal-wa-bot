import { isAuthenticated } from '@/lib/auth';
import { Login } from './Login';

export function ProtectedRoute({
  children,
  onLogin,
}: {
  children: React.ReactNode;
  onLogin: () => void;
}) {
  if (!isAuthenticated()) {
    return <Login onLogin={onLogin} />;
  }
  return <>{children}</>;
}
