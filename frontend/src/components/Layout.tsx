import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  LayoutDashboard,
  Bot,
  Send,
  Users,
  AlertTriangle,
  BarChart3,
  FileText,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
  Terminal,
  Building2,
} from 'lucide-react';
import { getUser, isSuperAdmin, clearToken } from '@/lib/auth';
import { disconnectSocket } from '@/lib/socket';
import { useTheme } from '@/hooks/useTheme';

export function Layout({ children, onLogout }: { children: React.ReactNode; onLogout: () => void }) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  const user = getUser();
  const brandName = user?.brandName || 'Dashboard';

  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/bots', label: 'Bot Management', icon: Bot },
    { path: '/send', label: 'Send Message', icon: Send },
    { path: '/groups', label: 'Groups', icon: Users },
    { path: '/failed', label: 'Failed Requests', icon: AlertTriangle },
    { path: '/stats', label: 'Statistics', icon: BarChart3 },
    { path: '/logs', label: 'Logs', icon: FileText },
    ...(user?.tenantId ? [{ path: '/commands', label: 'Custom Commands', icon: Terminal }] : []),
    ...(isSuperAdmin() ? [{ path: '/tenants', label: 'Tenants', icon: Building2 }] : []),
  ];

  function handleLogout() {
    clearToken();
    disconnectSocket();
    onLogout();
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 bg-card border-r border-border transform transition-transform lg:relative lg:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="flex items-center justify-between h-16 px-4 border-b border-border">
          <h1 className="text-lg font-bold">{brandName}</h1>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarOpen(false)}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <nav className="p-4 space-y-1">
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                location.pathname === item.path
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full p-4 border-t border-border space-y-2">
          <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </Button>
          <Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-card border-b border-border flex items-center px-4 lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
