import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi, postApi } from '@/lib/api';
import { isSuperAdmin } from '@/lib/auth';
import { Plus, Trash2, Edit } from 'lucide-react';

interface Tenant {
  id: string;
  name: string;
  brand_name: string;
  is_active: boolean;
  bot_count: string;
  user_count: string;
  created_at: string;
}

export default function TenantManagement() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', brand_name: '', username: '', password: '' });
  const [editForm, setEditForm] = useState({ name: '', brand_name: '' });
  const [error, setError] = useState('');

  useEffect(() => { loadTenants(); }, []);

  if (!isSuperAdmin()) {
    return <div className="text-muted-foreground">Access denied. Super admin only.</div>;
  }

  async function loadTenants() {
    setLoading(true);
    try {
      const data = await fetchApi<{ tenants: Tenant[] }>('/tenants');
      setTenants(data.tenants || []);
    } catch { setTenants([]); }
    finally { setLoading(false); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await postApi('/tenants', form);
      setForm({ name: '', brand_name: '', username: '', password: '' });
      setShowCreate(false);
      await loadTenants();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleUpdate(id: string) {
    try {
      await fetchApi(`/tenants/${id}`, { method: 'PUT', body: JSON.stringify(editForm) });
      setEditId(null);
      await loadTenants();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDeactivate(id: string) {
    if (!confirm('Deactivate this tenant?')) return;
    try {
      await fetchApi(`/tenants/${id}`, { method: 'DELETE' });
      await loadTenants();
    } catch {}
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tenant Management</h1>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4 mr-2" />New Tenant
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Create Tenant</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Tenant Name</Label>
                <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label>Brand Name</Label>
                <Input value={form.brand_name} onChange={e => setForm({ ...form, brand_name: e.target.value })} placeholder="Displayed in bot responses" required />
              </div>
              <div className="space-y-2">
                <Label>Admin Username</Label>
                <Input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label>Admin Password</Label>
                <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
              </div>
              <div className="sm:col-span-2 flex gap-2">
                <Button type="submit">Create</Button>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              </div>
              {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? <p className="text-muted-foreground">Loading...</p> : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Brand</th>
                <th className="text-left px-4 py-3 font-medium">Bots</th>
                <th className="text-left px-4 py-3 font-medium">Users</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map(t => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">
                    {editId === t.id ? (
                      <Input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} className="h-8" />
                    ) : t.name}
                  </td>
                  <td className="px-4 py-3">
                    {editId === t.id ? (
                      <Input value={editForm.brand_name} onChange={e => setEditForm({ ...editForm, brand_name: e.target.value })} className="h-8" />
                    ) : (
                      <span className="bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded font-mono">{t.brand_name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{t.bot_count}</td>
                  <td className="px-4 py-3">{t.user_count}</td>
                  <td className="px-4 py-3">
                    <Badge variant={t.is_active ? 'default' : 'destructive'}>
                      {t.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {editId === t.id ? (
                      <>
                        <Button size="sm" onClick={() => handleUpdate(t.id)}>Save</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" onClick={() => { setEditId(t.id); setEditForm({ name: t.name, brand_name: t.brand_name }); }}>
                          <Edit className="h-3 w-3 mr-1" />Edit
                        </Button>
                        {t.is_active && (
                          <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDeactivate(t.id)}>
                            <Trash2 className="h-3 w-3 mr-1" />Deactivate
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No tenants</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
