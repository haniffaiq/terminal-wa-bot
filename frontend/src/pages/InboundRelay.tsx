import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { fetchApi } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { Inbox, Save, Trash2 } from 'lucide-react';

interface Relay {
  marker: string;
  destination_url: string;
  reply_text: string | null;
  is_active: boolean;
  secret_set: boolean;
}

interface RelayResponse {
  success: boolean;
  exists: boolean;
  relay: Relay | null;
}

export default function InboundRelay() {
  const [relay, setRelay] = useState<Relay | null>(null);
  const [marker, setMarker] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [replyText, setReplyText] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const user = getUser();

  useEffect(() => { loadRelay(); }, []);

  if (!user?.tenantId) {
    return <div className="text-muted-foreground">No tenant context. Super admin cannot manage inbound relays directly.</div>;
  }

  async function loadRelay() {
    setLoading(true);
    try {
      const data = await fetchApi<RelayResponse>('/inbound-relays');
      setRelay(data.relay);
      if (data.relay) {
        setMarker(data.relay.marker);
        setDestinationUrl(data.relay.destination_url);
        setReplyText(data.relay.reply_text || '');
        setIsActive(data.relay.is_active);
      }
    } catch {
      setRelay(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      await fetchApi('/inbound-relays', {
        method: 'PUT',
        body: JSON.stringify({
          marker,
          destination_url: destinationUrl,
          // Omitted when blank, which tells the API to keep the stored secret.
          ...(secret ? { secret } : {}),
          reply_text: replyText || null,
          is_active: isActive,
        }),
      });
      setSecret('');
      setSaved(true);
      await loadRelay();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save relay');
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this relay? Inbound verification messages will stop being forwarded.')) return;
    setError(null);
    try {
      await fetchApi('/inbound-relays', { method: 'DELETE' });
      setRelay(null);
      setMarker('');
      setDestinationUrl('');
      setSecret('');
      setReplyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete relay');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Inbound Relay</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Inbox className="h-4 w-4" />Configuration
            {relay && <Badge variant={relay.is_active ? 'default' : 'secondary'}>{relay.is_active ? 'Active' : 'Paused'}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-sm font-medium">Marker</label>
                <Input value={marker} onChange={(e) => setMarker(e.target.value)} placeholder="PETAG-VERIFY:" />
                <p className="text-xs text-muted-foreground">Direct messages starting with this text are forwarded. Everything else is ignored.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Destination URL</label>
                <Input value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://api.petag.id/webhooks/zyron" />
                <p className="text-xs text-muted-foreground">Must be https. Private and loopback addresses are rejected.</p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Shared Secret</label>
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={relay?.secret_set ? 'Stored — leave blank to keep it' : 'Paste the shared HMAC secret'}
                />
                <p className="text-xs text-muted-foreground">
                  Used to sign every forwarded message (<code className="bg-muted px-1 py-0.5 rounded">X-Zyron-Signature</code>). Must match the destination's secret exactly. Never shown again after saving.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium">Confirmation Reply (optional)</label>
                <textarea
                  className="w-full min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Leave blank to send no reply"
                />
                <p className="text-xs text-muted-foreground">Sent in-chat only after the destination accepts the message.</p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Active
              </label>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {saved && <p className="text-sm text-muted-foreground">Saved.</p>}

              <div className="flex gap-2">
                <Button onClick={handleSave}>
                  <Save className="h-4 w-4 mr-2" />Save
                </Button>
                {relay && (
                  <Button variant="outline" className="text-destructive" onClick={handleDelete}>
                    <Trash2 className="h-4 w-4 mr-2" />Delete
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
