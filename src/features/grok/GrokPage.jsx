import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import AppShell from "../../components/AppShell";
import { isSupabaseConfigured } from "../../lib/supabase.js";
import { deleteConversation, listConversations } from "../../lib/grok.js";
import GrokChat from "./GrokChat.jsx";
import TaskAlertsPanel from "./TaskAlertsPanel.jsx";

/**
 * The full Grok page: saved chats, the live conversation, and reminders.
 */
export default function GrokPage() {
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [listToken, setListToken] = useState(0);

  const refresh = useCallback(() => {
    setListToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    listConversations()
      .then((rows) => {
        if (!active) return;
        setConversations(rows);
        setError("");
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught?.message || "Chats could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [listToken]);

  const remove = async (id) => {
    setError("");
    try {
      await deleteConversation(id);
      if (conversationId === id) setConversationId(null);
      refresh();
    } catch (caught) {
      setError(caught?.message || "The chat could not be deleted.");
    }
  };

  return (
    <AppShell currentPath="/grok" className="flex flex-col">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Grok</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Chat is saved on your account. Reminders you set here, or from the button on other pages, use the same list.
          </p>
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Chats</h2>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setConversationId(null)}
              >
                <Plus aria-hidden="true" />
                New
              </Button>
            </div>
            {!isSupabaseConfigured ? (
              <p className="mt-3 text-sm text-muted-foreground">Not connected.</p>
            ) : null}
            {loading ? <p className="mt-3 text-sm text-muted-foreground">Loading chats…</p> : null}
            {error ? (
              <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>
            ) : null}
            <ul className="mt-3 flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
              {conversations.map((conversation) => {
                const selected = conversation.id === conversationId;
                return (
                  <li key={conversation.id} className="shrink-0 lg:shrink">
                    <div
                      className={`flex items-center gap-1 rounded-xl border px-2 py-1 ${
                        selected ? "border-primary bg-primary/5" : "border-border bg-background"
                      }`}
                    >
                      <button
                        type="button"
                        className="min-h-11 min-w-0 flex-1 truncate px-2 text-left text-sm text-foreground"
                        onClick={() => setConversationId(conversation.id)}
                      >
                        {conversation.title}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="min-h-11 min-w-11"
                        aria-label={`Delete ${conversation.title}`}
                        onClick={() => remove(conversation.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {isSupabaseConfigured && !loading && conversations.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No chats yet.</p>
            ) : null}
            <p className="mt-4 text-sm text-muted-foreground">
              <Link to="/settings/integrations" className="text-primary underline-offset-4 hover:underline">
                Connection status
              </Link>
            </p>
          </aside>
          <GrokChat
            conversationId={conversationId}
            onConversationId={setConversationId}
            onConversationsChanged={refresh}
            className="h-[calc(100dvh-14rem)] min-h-[32rem]"
          />
        </div>

        <TaskAlertsPanel />
      </div>
    </AppShell>
  );
}
