import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { fetchApi, postApi } from '@/lib/api';
import { ShieldBan, ShieldCheck } from 'lucide-react';

interface Group {
  id: string;
  name: string;
  member_count: number;
  bots: string[];
  is_blocked: boolean;
}

export default function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    setLoading(true);
    try {
      const data = await fetchApi<{ success: boolean; groups: Group[] }>('/groups');
      setGroups(data.groups || []);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleBlock(group: Group) {
    setActionLoading(group.id);
    try {
      if (group.is_blocked) {
        await postApi('/groups/unblock', { groupId: group.id });
      } else {
        await postApi('/groups/block', { groupId: group.id });
      }
      await loadGroups();
    } finally {
      setActionLoading(null);
    }
  }

  const filtered = groups.filter(g =>
    (g.name || '').toLowerCase().includes(filter.toLowerCase()) ||
    g.id.includes(filter)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Groups</h1>
        <span className="text-sm text-muted-foreground">{groups.length} total groups</span>
      </div>

      <Input
        placeholder="Search groups..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="max-w-sm"
      />

      {loading ? (
        <p className="text-muted-foreground">Loading groups...</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Group ID</th>
                <th className="text-left px-4 py-3 font-medium">Members</th>
                <th className="text-left px-4 py-3 font-medium">Bots</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(g => (
                <tr key={g.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">{g.name || '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{g.id}</td>
                  <td className="px-4 py-3">{g.member_count}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(g.bots || []).map(bot => (
                        <span key={bot} className="inline-block bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded font-mono">
                          {bot}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={g.is_blocked ? 'destructive' : 'default'}>
                      {g.is_blocked ? 'Blocked' : 'Active'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggleBlock(g)}
                      disabled={actionLoading === g.id}
                    >
                      {g.is_blocked ? (
                        <><ShieldCheck className="h-3 w-3 mr-1" />Unblock</>
                      ) : (
                        <><ShieldBan className="h-3 w-3 mr-1" />Block</>
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No groups found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
