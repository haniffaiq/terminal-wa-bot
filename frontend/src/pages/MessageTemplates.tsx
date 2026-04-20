import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi, postApi } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Plus, Trash2, Edit, Eye } from 'lucide-react';

interface Template {
  id: string;
  name: string;
  content: string;
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

export default function MessageTemplates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', content: '' });
  const [editForm, setEditForm] = useState({ name: '', content: '' });
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');

  const user = getUser();

  useEffect(() => { loadTemplates(); }, []);

  if (!user?.tenantId) {
    return <div className="text-muted-foreground">No tenant context. Super admin cannot manage templates directly.</div>;
  }

  async function loadTemplates() {
    setLoading(true);
    try {
      const data = await fetchApi<{ templates: Template[] }>('/templates');
      setTemplates(data.templates || []);
    } catch { setTemplates([]); }
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
      await postApi('/templates', form);
      setForm({ name: '', content: '' });
      setShowCreate(false);
      await loadTemplates();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleUpdate(id: string) {
    setError('');
    try {
      await fetchApi(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(editForm) });
      setEditId(null);
      await loadTemplates();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this template?')) return;
    try {
      await fetchApi(`/templates/${id}`, { method: 'DELETE' });
      await loadTemplates();
    } catch {}
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Message Templates</h1>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4 mr-2" />New Template
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Create Template</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>Template Name</Label>
                <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Welcome Message" required />
              </div>
              <div className="space-y-2">
                <Label>Content</Label>
                <textarea
                  value={form.content}
                  onChange={e => setForm({ ...form, content: e.target.value })}
                  rows={5}
                  className="w-full rounded-md border px-3 py-2 text-sm resize-y bg-background"
                  placeholder="Hello from {brand}! Today is {date}."
                  required
                />
              </div>
              <div className="text-xs text-muted-foreground">
                <p className="font-medium mb-1">Available variables (click to insert):</p>
                <div className="flex flex-wrap gap-2">
                  {VARIABLES.map(v => (
                    <span key={v.name} className="bg-muted px-2 py-0.5 rounded font-mono cursor-pointer" onClick={() => setForm({ ...form, content: form.content + v.name })} title={v.desc}>
                      {v.name}
                    </span>
                  ))}
                </div>
              </div>
              {form.content && (
                <div className="bg-muted rounded-md p-3 text-sm">
                  <p className="text-xs text-muted-foreground mb-1">Preview:</p>
                  <p className="whitespace-pre-wrap">{renderPreview(form.content)}</p>
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
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Content</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map(tpl => (
                <tr key={tpl.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{editId === tpl.id ? (
                    <Input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} className="h-8 w-40" />
                  ) : tpl.name}</td>
                  <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">{editId === tpl.id ? (
                    <textarea value={editForm.content} onChange={e => setEditForm({ ...editForm, content: e.target.value })} rows={3} className="w-full rounded-md border px-2 py-1 text-sm bg-background" />
                  ) : (
                    <>{tpl.content.substring(0, 60)}{tpl.content.length > 60 && '...'}</>
                  )}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(tpl.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {editId === tpl.id ? (
                      <>
                        <Button size="sm" onClick={() => handleUpdate(tpl.id)}>Save</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" onClick={() => setPreview(preview === tpl.id ? null : tpl.id)}>
                          <Eye className="h-3 w-3 mr-1" />Preview
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setEditId(tpl.id); setEditForm({ name: tpl.name, content: tpl.content }); }}>
                          <Edit className="h-3 w-3 mr-1" />Edit
                        </Button>
                        <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDelete(tpl.id)}>
                          <Trash2 className="h-3 w-3 mr-1" />Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No templates yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {preview && templates.find(t => t.id === preview) && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Preview: {templates.find(t => t.id === preview)!.name}</CardTitle></CardHeader>
          <CardContent>
            <div className="bg-muted rounded-md p-4 whitespace-pre-wrap font-mono text-sm">
              {renderPreview(templates.find(t => t.id === preview)!.content)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
