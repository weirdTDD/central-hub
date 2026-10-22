import { useEffect, useRef, useState } from "react";
import { ArrowUp, CircleAlert, Loader2, MessageCircleDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthContext";
import { isSupabaseConfigured } from "../../lib/supabase.js";
import {
  insertConversation,
  insertMessage,
  listMessages,
  readGrokModelPreference,
  streamGrokReply,
  updateConversation,
  writeGrokModelPreference,
} from "../../lib/grok.js";
import { GROK_MODELS, isListedGrokModel } from "./models.js";

const STARTERS = [
  "How much did I code this week?",
  "What have I been neglecting?",
  "Remind me at 6pm to finish the freeCodeCamp section",
];

const DEFAULT_MODEL = "server";

/**
 * One Grok conversation. The reply is streamed from the Edge Function.
 * History is the rows saved for this account.
 */
export default function GrokChat({
  conversationId = null,
  onConversationId,
  onConversationsChanged,
  className,
}) {
  const { isAuthenticated } = useAuth();
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [toolNote, setToolNote] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [loadedId, setLoadedId] = useState(null);
  const [localChatId, setLocalChatId] = useState(null);
  const formRef = useRef(null);
  const activeId = useRef(null);

  useEffect(() => {
    activeId.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!isSupabaseConfigured || !isAuthenticated) return undefined;
    let active = true;
    readGrokModelPreference()
      .then((saved) => {
        if (!active) return;
        if (isListedGrokModel(saved)) setModel(saved);
      })
      .catch(() => {
        // The chat still works with the server default.
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!conversationId || !isSupabaseConfigured || !isAuthenticated) return undefined;
    if (localChatId === conversationId || loadedId === conversationId) return undefined;
    let active = true;
    listMessages(conversationId)
      .then((rows) => {
        if (!active || activeId.current !== conversationId) return;
        setMessages(rows);
        setLoadedId(conversationId);
        setError(null);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught?.message || "The chat could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [conversationId, isAuthenticated, loadedId, localChatId]);

  const changeModel = async (next) => {
    setModel(next);
    const stored = next === DEFAULT_MODEL ? null : next;
    try {
      await writeGrokModelPreference(stored);
      if (conversationId) await updateConversation(conversationId, { model: stored });
    } catch (caught) {
      setError(caught?.message || "The model could not be saved.");
    }
  };

  const send = async (text) => {
    const question = text.replace(/\s+/g, " ").trim();
    if (!question || running) return;
    if (!isSupabaseConfigured) {
      setError("Supabase is not configured, so Grok cannot be reached.");
      return;
    }
    if (question.length > 4000) {
      setError("A message can be at most 4000 characters.");
      return;
    }

    setDraft("");
    setError(null);
    setToolNote("");
    setRunning(true);

    const optimistic = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content: question,
    };
    setMessages((current) => (conversationId ? [...current, optimistic] : [optimistic]));

    let chatId = conversationId;
    try {
      if (!chatId) {
        const created = await insertConversation({
          title: question.length > 80 ? `${question.slice(0, 77)}…` : question,
          model: model === DEFAULT_MODEL ? null : model,
        });
        chatId = created.id;
        activeId.current = chatId;
        setLocalChatId(chatId);
        onConversationId?.(chatId);
        onConversationsChanged?.();
      }

      await insertMessage({ conversationId: chatId, role: "user", content: question });

      let streamed = "";
      const streamId = `stream-${crypto.randomUUID()}`;
      setMessages((current) => [
        ...current,
        { id: streamId, role: "assistant", content: "" },
      ]);

      await streamGrokReply(
        {
          conversationId: chatId,
          model: model === DEFAULT_MODEL ? undefined : model,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        (event) => {
          if (activeId.current && activeId.current !== chatId) return;
          if (event.event === "delta" && event.data?.text) {
            streamed += event.data.text;
            const next = streamed;
            setMessages((current) =>
              current.map((message) =>
                message.id === streamId ? { ...message, content: next } : message
              )
            );
          }
          if (event.event === "tool") {
            const name = event.data?.name || "tool";
            setToolNote(
              event.data?.status === "done"
                ? event.data.summary || `Finished ${name}.`
                : `Using ${name}…`
            );
          }
        }
      );

      if (!activeId.current || activeId.current === chatId) {
        const rows = await listMessages(chatId);
        setMessages(rows);
        setLoadedId(chatId);
      }
      setToolNote("");
      onConversationsChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Grok could not reply.");
      if (chatId) {
        try {
          const rows = await listMessages(chatId);
          if (rows.length > 0) setMessages(rows);
        } catch {
          // The error above is the one to show.
        }
      }
    } finally {
      setLocalChatId((current) => (current === chatId ? null : current));
      setRunning(false);
    }
  };

  const attached =
    conversationId == null
      ? running
      : loadedId === conversationId || localChatId === conversationId;
  const visibleMessages = attached ? messages : [];
  const waiting = Boolean(conversationId) && !attached && !error;

  const turns = visibleMessages.filter((message) => {
    if (message.role === "tool") return Boolean(toolSummary(message));
    if (message.role === "assistant" && !message.content?.trim()) return false;
    return message.role === "user" || message.role === "assistant";
  });

  return (
    <MessageScrollerProvider autoScroll>
      <section
        className={cn(
          "flex h-[32rem] min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
          className
        )}
      >
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Grok</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Asks about your tasks, work logs, coding time, and learning time when you ask. The key stays on the server.
            </p>
          </div>
          <Select value={model} onValueChange={changeModel} disabled={running}>
            <SelectTrigger className="w-40" aria-label="Grok model">
              <SelectValue placeholder="Server default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL}>Server default</SelectItem>
              {GROK_MODELS.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>

        <div className="min-h-0 flex-1">
          {turns.length === 0 && !running ? (
            <Empty className="h-full border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleDashed />
                </EmptyMedia>
                <EmptyTitle>{waiting ? "Loading this chat" : "Chat with Grok"}</EmptyTitle>
                <EmptyDescription>
                  {isSupabaseConfigured
                    ? "Questions about your time read your own records. A reminder has to match a task you already have."
                    : "Not connected. Add the Supabase URL and anon key, then deploy the grok-chat function."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent aria-busy={running} className="gap-6 px-5 py-2">
                  {visibleMessages.map((message) => (
                    <ChatTurn key={message.id} message={message} />
                  ))}
                  {running && toolNote ? (
                    <MessageScrollerItem messageId="tool-note">
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        {toolNote}
                      </p>
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          )}
        </div>

        <div className="flex flex-col gap-3 px-5 pt-3 pb-5">
          {turns.length === 0 ? (
            <div className="no-scrollbar flex gap-2 overflow-x-auto overscroll-x-contain">
              {STARTERS.map((starter) => (
                <Button
                  key={starter}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 shrink-0"
                  disabled={running || !isSupabaseConfigured}
                  onClick={() => send(starter)}
                >
                  {starter}
                </Button>
              ))}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}

          <form
            ref={formRef}
            onSubmit={(event) => {
              event.preventDefault();
              send(draft);
            }}
          >
            <InputGroup>
              <InputGroupTextarea
                value={draft}
                rows={2}
                maxLength={4000}
                disabled={running}
                placeholder="Ask Grok, or ask for a reminder"
                aria-label="Message"
                className="min-h-16"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
              />
              <InputGroupAddon align="block-end" className="pt-1">
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  disabled={draft.trim() === "" || running}
                  className="ml-auto min-h-11 min-w-11 rounded-full"
                  aria-label="Send"
                >
                  {running ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <p className="text-xs text-muted-foreground">
            On request, Grok reads your tasks, work logs, coding totals, and learning totals for this account. It does not receive your email, file paths, page addresses, or window titles.
          </p>
        </div>
      </section>
    </MessageScrollerProvider>
  );
}

function ChatTurn({ message }) {
  if (message.role === "tool") {
    const summary = toolSummary(message);
    if (!summary) return null;
    return (
      <MessageScrollerItem messageId={message.id}>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </MessageScrollerItem>
    );
  }

  if (message.role === "user") {
    return (
      <MessageScrollerItem messageId={message.id} scrollAnchor>
        <Message align="end">
          <MessageContent>
            <Bubble align="end" variant="tinted">
              <BubbleContent className="whitespace-pre-wrap">{message.content}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    );
  }

  if (!message.content?.trim()) return null;

  return (
    <MessageScrollerItem messageId={message.id}>
      <Message>
        <MessageContent>
          <MessageHeader>Grok</MessageHeader>
          <p className="whitespace-pre-wrap leading-relaxed text-foreground">{message.content}</p>
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

function toolSummary(message) {
  if (typeof message?.content !== "string") return "";
  try {
    const parsed = JSON.parse(message.content);
    return typeof parsed.summary === "string" ? parsed.summary : "";
  } catch {
    return "";
  }
}
