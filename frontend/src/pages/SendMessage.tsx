import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fetchApi, postApi, uploadFile } from '@/lib/api';
import { Send } from 'lucide-react';

interface Group {
  id: string;
  name: string;
}

interface SendResult {
  success: boolean;
  transaction_id: string;
  results: Array<{
    number: string;
    success: boolean;
    error?: string;
    response_time_seconds: number;
  }>;
}

export default function SendMessage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [messageType, setMessageType] = useState<'text' | 'file' | 'url'>('text');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [groupFilter, setGroupFilter] = useState('');
  const [templates, setTemplates] = useState<{ id: string; name: string; content: string }[]>([]);

  useEffect(() => {
    fetchApi<{ success: boolean; groups: Group[] }>('/groups')
      .then(data => setGroups(data.groups || []))
      .catch(() => {});
    fetchApi<{ templates: { id: string; name: string; content: string }[] }>('/templates')
      .then(data => setTemplates(data.templates || []))
      .catch(() => {});
  }, []);

  function toggleGroup(groupId: string) {
    setSelectedGroups(prev =>
      prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId]
    );
  }

  async function handleSend() {
    if (selectedGroups.length === 0) return;
    setSending(true);
    setResult(null);

    try {
      let data: SendResult;

      if (messageType === 'file' && file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('number', selectedGroups[0]);
        formData.append('message', message);
        data = (await uploadFile('/send-media', formData)) as SendResult;
      } else if (messageType === 'url') {
        data = await postApi<SendResult>('/send-media-from-url', {
          number: selectedGroups[0],
          url: mediaUrl,
        });
      } else {
        data = await postApi<SendResult>('/send-message', {
          number: selectedGroups,
          message,
        });
      }

      setResult(data);
    } catch (err) {
      setResult({
        success: false,
        transaction_id: '',
        results: [{ number: '', success: false, error: String(err), response_time_seconds: 0 }],
      });
    } finally {
      setSending(false);
    }
  }

  const filteredGroups = groups.filter(
    g =>
      g.name?.toLowerCase().includes(groupFilter.toLowerCase()) ||
      g.id.includes(groupFilter)
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Send Message</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Message Type</Label>
            <select
              value={messageType}
              onChange={e => setMessageType(e.target.value as 'text' | 'file' | 'url')}
              className="w-full rounded-md border px-3 py-2 text-sm"
            >
              <option value="text">Text</option>
              <option value="file">File Upload</option>
              <option value="url">Media from URL</option>
            </select>
          </div>

          {messageType === 'text' && templates.length > 0 && (
            <div className="space-y-2">
              <Label>Load from Template</Label>
              <select
                onChange={e => {
                  const t = templates.find(t => t.id === e.target.value);
                  if (t) setMessage(t.content);
                  e.target.value = '';
                }}
                className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                defaultValue=""
              >
                <option value="" disabled>Select a template...</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {messageType === 'text' && (
            <div className="space-y-2">
              <Label>Message</Label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                rows={5}
                placeholder="Type your message..."
                className="w-full rounded-md border px-3 py-2 text-sm resize-y"
              />
            </div>
          )}

          {messageType === 'file' && (
            <>
              <div className="space-y-2">
                <Label>File</Label>
                <Input type="file" onChange={e => setFile(e.target.files?.[0] || null)} />
              </div>
              <div className="space-y-2">
                <Label>Caption (optional)</Label>
                <Input value={message} onChange={e => setMessage(e.target.value)} />
              </div>
            </>
          )}

          {messageType === 'url' && (
            <div className="space-y-2">
              <Label>Media URL</Label>
              <Input
                value={mediaUrl}
                onChange={e => setMediaUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>Select Groups ({selectedGroups.length} selected)</Label>
            <Input
              placeholder="Filter groups..."
              value={groupFilter}
              onChange={e => setGroupFilter(e.target.value)}
            />
            <div className="border rounded-md max-h-60 overflow-y-auto">
              {filteredGroups.map(g => (
                <label
                  key={g.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedGroups.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  <span className="text-sm truncate">{g.name || g.id}</span>
                </label>
              ))}
              {filteredGroups.length === 0 && (
                <p className="text-sm text-muted-foreground p-3">No groups found</p>
              )}
            </div>
          </div>

          <Button
            onClick={handleSend}
            disabled={sending || selectedGroups.length === 0}
            className="w-full"
          >
            <Send className="h-4 w-4 mr-2" />
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </div>

        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Result — {result.transaction_id}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.results?.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="truncate">{r.number}</span>
                  <Badge variant={r.success ? 'default' : 'destructive'}>
                    {r.success ? 'Sent' : r.error}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
