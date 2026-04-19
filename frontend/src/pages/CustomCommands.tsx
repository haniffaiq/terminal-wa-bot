import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi, postApi } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Plus, Trash2, Edit, Eye } from 'lucide-react';

interface Command {
  id: string;
  command: string;
  response_template: string;
  created_at: string;
}

const VARIABLES = [
  { name: '{brand}', desc: 'Tenant brand name' },
  { name: '{date}', desc: 'Current date' },
  { name: '{time}', desc: 'Current time' },
  { name: '{group_name}', desc: 'Group name' },
  { name: '{group_id}', desc: 'Group ID' },
  { name: '{bot_count}', desc: 'Online bot count' },
  { name: '{member_count}', desc: 'Group member count' },
  { name: '{sender}', desc: 'Sender phone number' },
];

export default function CustomCommands() {
  const [commands, setCommands] = useState<Command[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ command: '', response_template: '' });
  const [editForm, setEditForm] = useState({ command: '', response_template: '' });
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');

  const user = getUser();

  useEffect(() => { loadCommands(); }, []);

  if (!user?.tenantId) {
    return <div className="text-muted-foreground">No tenant context. Super admin cannot manage commands directly.</div>;
  }

  async function loadCommands() {
    setLoading(true);
    try {
      const data = await fetchApi<{ commands: Command[] }>('/commands');
      setCommands(data.commands || []);
    } catch { setCommands([]); }
    finally { setLoading(false); }
  }

  function renderPreview(template: string) {
    return template
      .replace(/\{brand\}/g, user?.brandName || 'Brand')
      .replace(/\{date\}/g, new Date().toLocaleDateString('id-ID'))
      .replace(/\{time\}/g, new Date().toLocaleTimeString('id-ID'))
      .replace(/\{group_name\}/g, 'Sample Group')
      .replace(/\{group_id\}/g, '120363xxx@g.us')
      .replace(/\{bot_count\}/g, '3')
      .replace(/\{member_count\}/g, '42')
      .replace(/\{sender\}/g, '628123456789');
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await postApi('/commands', form);
      setForm({ command: '', response_template: '' });
      setShowCreate(false);
      await loadCommands();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleUpdate(id: string) {
    setError('');
    try {
      await fetchApi(`/commands/${id}`, { method: 'PUT', body: JSON.stringify(editForm) });
      setEditId(null);
      await loadCommands();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this command?')) return;
    try {
      await fetchApi(`/commands/${id}`, { method: 'DELETE' });
      await loadCommands();
    } catch {}
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Custom Commands</h1>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4 mr-2" />New Command
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Create Command</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>Command (must start with !)</Label>
                <Input value={form.command} onChange={e => setForm({ ...form, command: e.target.value })} placeholder="!mycommand" required />
              </div>
              <div className="space-y-2">
                <Label>Response Template</Label>
                <textarea
                  value={form.response_template}
                  onChange={e => setForm({ ...form, response_template: e.target.value })}
                  rows={5}
                  className="w-full rounded-md border px-3 py-2 text-sm resize-y bg-background"
                  placeholder="Hello from {brand}! Today is {date}."
                  required
                />
              </div>
              <div className="text-xs text-muted-foreground">
                <p className="font-medium mb-1">Available variables:</p>
                <div className="flex flex-wrap gap-2">
                  {VARIABLES.map(v => (
                    <span key={v.name} className="bg-muted px-2 py-0.5 rounded font-mono cursor-pointer" onClick={() => setForm({ ...form, response_template: form.response_template + v.name })} title={v.desc}>
                      {v.name}
                    </span>
                  ))}
                </div>
              </div>
              {form.response_template && (
                <div className="bg-muted rounded-md p-3 text-sm">
                  <p className="text-xs text-muted-foreground mb-1">Preview:</p>
                  <p className="whitespace-pre-wrap">{renderPreview(form.response_template)}</p>
                </div>
              )}
              <div className="flex gap-2">
                <Button type="submit">Create</Button>
                <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? <p className="text-muted-foreground">Loading...</p> : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Command</th>
                <th className="text-left px-4 py-3 font-medium">Template</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {commands.map(cmd => (
                <tr key={cmd.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-mono font-medium">{editId === cmd.id ? (
                    <Input value={editForm.command} onChange={e => setEditForm({ ...editForm, command: e.target.value })} className="h-8 w-32" />
                  ) : cmd.command}</td>
                  <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">{editId === cmd.id ? (
                    <textarea value={editForm.response_template} onChange={e => setEditForm({ ...editForm, response_template: e.target.value })} rows={3} className="w-full rounded-md border px-2 py-1 text-sm bg-background" />
                  ) : cmd.response_template.substring(0, 80)}{cmd.response_template.length > 80 && '...'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(cmd.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {editId === cmd.id ? (
                      <>
                        <Button size="sm" onClick={() => handleUpdate(cmd.id)}>Save</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" onClick={() => setPreview(preview === cmd.id ? null : cmd.id)}>
                          <Eye className="h-3 w-3 mr-1" />Preview
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setEditId(cmd.id); setEditForm({ command: cmd.command, response_template: cmd.response_template }); }}>
                          <Edit className="h-3 w-3 mr-1" />Edit
                        </Button>
                        <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDelete(cmd.id)}>
                          <Trash2 className="h-3 w-3 mr-1" />Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {commands.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No custom commands yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {preview && commands.find(c => c.id === preview) && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Preview: {commands.find(c => c.id === preview)!.command}</CardTitle></CardHeader>
          <CardContent>
            <div className="bg-muted rounded-md p-4 whitespace-pre-wrap font-mono text-sm">
              {renderPreview(commands.find(c => c.id === preview)!.response_template)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
