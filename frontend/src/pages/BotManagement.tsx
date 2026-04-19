import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchApi, postApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { Plus, RotateCcw, Power, Trash2 } from 'lucide-react';

interface BotStatusResponse {
  success: boolean;
  data: { active: string[]; inactive: string[] };
}

export default function BotManagement() {
  const [botData, setBotData] = useState<BotStatusResponse | null>(null);
  const [newBotId, setNewBotId] = useState('');
  const [isAdminBot, setIsAdminBot] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const { botStatuses, qrCode, setQrCode } = useSocket();

  useEffect(() => {
    loadBots();
  }, []);

  async function loadBots() {
    const data = await fetchApi<BotStatusResponse>('/bot-status');
    setBotData(data);
  }

  async function handleAddBot() {
    if (!newBotId.trim()) return;
    try {
      const data = await postApi<{ success: boolean; qr?: string; is_admin_bot?: boolean }>('/addbot', {
        botname: newBotId.trim(),
        is_admin_bot: isAdminBot,
      });
      if (data.qr) {
        setQrCode({ botId: newBotId.trim(), qr: data.qr });
      }
      await loadBots();
    } catch (err) {
      console.error('Failed to add bot:', err);
    }
  }

  async function handleRestart(botId: string) {
    setLoading(botId);
    try {
      await postApi('/restart', { botname: botId });
      await loadBots();
    } finally {
      setLoading(null);
    }
  }

  async function handleDisconnect(botId: string) {
    setLoading(botId);
    try {
      await postApi('/disconnect', { botId });
      await loadBots();
    } finally {
      setLoading(null);
    }
  }

  async function handleDelete(botId: string) {
    if (!confirm(`Delete bot "${botId}"? This will remove its session permanently.`)) return;
    setLoading(botId);
    try {
      await postApi('/deletebot', { botId });
      await loadBots();
    } finally {
      setLoading(null);
    }
  }

  const activeBots = botData?.data?.active || [];
  const inactiveBots = botData?.data?.inactive || [];
  const allBots = [...activeBots, ...inactiveBots];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Bot Management</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setQrCode(null); }}>
          <DialogTrigger render={<Button />}>
            <Plus className="h-4 w-4 mr-2" />Add Bot
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Bot</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Bot ID</Label>
                <Input
                  value={newBotId}
                  onChange={e => setNewBotId(e.target.value)}
                  placeholder="e.g. bot_03"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAdminBot}
                  onChange={e => setIsAdminBot(e.target.checked)}
                />
                <span className="text-sm">Set as Admin Bot (handles WhatsApp commands)</span>
              </label>
              <Button onClick={handleAddBot} disabled={!newBotId.trim()}>
                {isAdminBot ? 'Add Admin Bot' : 'Add Operation Bot'}
              </Button>
              {qrCode && (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-sm text-muted-foreground">Scan this QR code with WhatsApp:</p>
                  <img src={qrCode.qr} alt="QR Code" className="w-64 h-64" />
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border bg-accent border-border p-4 text-sm text-accent-foreground">
        <p><strong>admin_bot</strong> is the admin bot — it starts automatically when the server runs and handles WhatsApp commands (!addbot, !rst, !block, etc.).</p>
        <p className="mt-1">All other bots are <strong>operation bots</strong> — they handle message delivery via round-robin. Each bot requires a different WhatsApp number.</p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bot ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {allBots.map(botId => {
            const realtimeStatus = botStatuses.get(botId);
            const isOnline = realtimeStatus
              ? realtimeStatus.status === 'open'
              : activeBots.includes(botId);

            return (
              <TableRow key={botId}>
                <TableCell className="font-medium">{botId}</TableCell>
                <TableCell>
                  <Badge variant={isOnline ? 'default' : 'destructive'}>
                    {isOnline ? 'Online' : 'Offline'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestart(botId)}
                    disabled={loading === botId}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />Restart
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDisconnect(botId)}
                    disabled={loading === botId}
                  >
                    <Power className="h-3 w-3 mr-1" />Disconnect
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(botId)}
                    disabled={loading === botId}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />Delete
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {allBots.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground">No bots found</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
