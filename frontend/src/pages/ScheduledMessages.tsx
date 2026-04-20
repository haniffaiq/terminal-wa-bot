import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fetchApi, postApi } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';

interface Group {
  id: string;
  name: string;
}

interface Schedule {
  id: string;
  targets: string[];
  message: string;
  type: 'once' | 'cron';
  schedule: string;
  active: boolean;
  last_run: string | null;
  created_at: string;
}

export default function ScheduledMessages() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');
  const [groupFilter, setGroupFilter] = useState('');

  const [form, setForm] = useState({
    targets: [] as string[],
    message: '',
    type: 'once' as 'once' | 'cron',
    schedule: '',
  });

  const user = getUser();

  useEffect(() => {
    loadSchedules();
    loadGroups();
  }, []);

  if (!user?.tenantId) {
    return <div className="text-muted-foreground">No tenant context. Super admin cannot manage schedules directly.</div>;
  }

  async function loadSchedules() {
    setLoading(true);
    try {
      const data = await fetchApi<{ schedules: Schedule[] }>('/schedules');
      setSchedules(data.schedules || []);
    } catch {
      setSchedules([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadGroups() {
    try {
      const data = await fetchApi<{ groups: Group[] }>('/groups');
      setGroups(data.groups || []);
    } catch {
      setGroups([]);
    }
  }

  function toggleTarget(groupId: string) {
    setForm(prev => ({
      ...prev,
      targets: prev.targets.includes(groupId)
        ? prev.targets.filter(g => g !== groupId)
        : [...prev.targets, groupId],
    }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await postApi('/schedules', form);
      setForm({ targets: [], message: '', type: 'once', schedule: '' });
      setShowCreate(false);
      await loadSchedules();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleToggle(id: string) {
    try {
      await postApi(`/schedules/${id}/toggle`, {});
      await loadSchedules();
    } catch {}
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this scheduled message?')) return;
    try {
      await fetchApi(`/schedules/${id}`, { method: 'DELETE' });
      await loadSchedules();
    } catch {}
  }

  const filteredGroups = groups.filter(
    g =>
      g.name?.toLowerCase().includes(groupFilter.toLowerCase()) ||
      g.id.includes(groupFilter)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Scheduled Messages</h1>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4 mr-2" />New Schedule
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Create Scheduled Message</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>Select Groups ({form.targets.length} selected)</Label>
                <Input
                  placeholder="Filter groups..."
                  value={groupFilter}
                  onChange={e => setGroupFilter(e.target.value)}
                />
                <div className="border rounded-md max-h-48 overflow-y-auto">
                  {filteredGroups.map(g => (
                    <label
                      key={g.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={form.targets.includes(g.id)}
                        onChange={() => toggleTarget(g.id)}
                      />
                      <span className="text-sm truncate">{g.name || g.id}</span>
                    </label>
                  ))}
                  {filteredGroups.length === 0 && (
                    <p className="text-sm text-muted-foreground p-3">No groups found</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Message</Label>
                <textarea
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  rows={4}
                  className="w-full rounded-md border px-3 py-2 text-sm resize-y bg-background"
                  placeholder="Type your scheduled message..."
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Schedule Type</Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scheduleType"
                      checked={form.type === 'once'}
                      onChange={() => setForm({ ...form, type: 'once', schedule: '' })}
                    />
                    <span className="text-sm">Once</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="scheduleType"
                      checked={form.type === 'cron'}
                      onChange={() => setForm({ ...form, type: 'cron', schedule: '' })}
                    />
                    <span className="text-sm">Cron (Recurring)</span>
                  </label>
                </div>
              </div>

              <div className="space-y-2">
                {form.type === 'once' ? (
                  <>
                    <Label>Date & Time</Label>
                    <Input
                      type="datetime-local"
                      value={form.schedule}
                      onChange={e => setForm({ ...form, schedule: e.target.value })}
                      required
                    />
                  </>
                ) : (
                  <>
                    <Label>Cron Expression</Label>
                    <Input
                      value={form.schedule}
                      onChange={e => setForm({ ...form, schedule: e.target.value })}
                      placeholder="*/5 * * * *"
                      required
                    />
                    <p className="text-xs text-muted-foreground">e.g. "0 9 * * 1-5" = weekdays at 9 AM</p>
                  </>
                )}
              </div>

              <div className="flex gap-2">
                <Button type="submit" disabled={form.targets.length === 0}>Create</Button>
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
                <th className="text-left px-4 py-3 font-medium">Targets</th>
                <th className="text-left px-4 py-3 font-medium">Message</th>
                <th className="text-left px-4 py-3 font-medium">Type</th>
                <th className="text-left px-4 py-3 font-medium">Schedule</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Last Run</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map(s => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="px-4 py-3 text-muted-foreground">{s.targets?.length || 0} group(s)</td>
                  <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">
                    {s.message.substring(0, 60)}{s.message.length > 60 && '...'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={s.type === 'cron' ? 'default' : 'secondary'}>
                      {s.type === 'cron' ? 'Cron' : 'Once'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{s.schedule}</td>
                  <td className="px-4 py-3">
                    <Badge variant={s.active ? 'default' : 'secondary'}>
                      {s.active ? 'Active' : 'Paused'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {s.last_run ? new Date(s.last_run).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <Button variant="outline" size="sm" onClick={() => handleToggle(s.id)}>
                      {s.active ? <ToggleRight className="h-3 w-3 mr-1" /> : <ToggleLeft className="h-3 w-3 mr-1" />}
                      {s.active ? 'Pause' : 'Activate'}
                    </Button>
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => handleDelete(s.id)}>
                      <Trash2 className="h-3 w-3 mr-1" />Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {schedules.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No scheduled messages yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
