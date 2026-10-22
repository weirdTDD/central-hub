import { useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

import { prepareAskRequest, reportRangeBounds } from "./ask.js";
import { xaiProvider } from "./xaiProvider.js";

const STARTERS = [
  "Where am I over plan?",
  "What should I work on next?",
  "Summarise this range",
];

/**
 * A conversation about the signed-in user's own records.
 *
 * The question goes to the Edge Function. The function rebuilds the evidence
 * and the planned-versus-actual totals, then asks Grok. This panel never
 * writes a task or a session: a reply is text, and accepting it changes nothing.
 */
export default function AskPanel({ from = null, to = null, className }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const formRef = useRef(null);
  const scoped = from != null || to != null;
  const canSend = draft.trim() !== "" && !running;
  const Title = scoped ? "h2" : "h1";

  const send = async (text) => {
    const prepared = prepareAskRequest({
      question: text,
      history: messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content })),
    });
    if (!prepared.ok || running) {
      if (!prepared.ok) setError(prepared.error);
      return;
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prepared.question,
    };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError(null);
    setRunning(true);

    const bounds = reportRangeBounds(from, to);

    try {
      const answer = await xaiProvider.analyse({
        kind: "ask",
        request: {
          question: prepared.question,
          history: prepared.history,
          from: bounds.from,
          to: bounds.to,
        },
      });
      setMessages((current) => [
        ...current,
        {
          id: answer.runId ?? crypto.randomUUID(),
          role: "assistant",
          content: answer.result.answer,
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The question could not be answered.");
    } finally {
      setRunning(false);
    }
  };

  const onSubmit = (event) => {
    event.preventDefault();
    send(draft);
  };

  return (
    <MessageScrollerProvider autoScroll>
      <section
        className={cn(
          "flex h-[32rem] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
          className
        )}
      >
        <header className="px-5 pt-5 pb-3">
          <Title className="text-lg font-semibold text-foreground">Ask</Title>
          <p className="mt-1 text-sm text-muted-foreground">
            {scoped
              ? "Questions use the date range on this page."
              : "Questions use your tasks, work logs, and planned-versus-actual totals."}
          </p>
        </header>

        <div className="min-h-0 flex-1">
          {messages.length === 0 ? (
            <Empty className="h-full border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleDashed />
                </EmptyMedia>
                <EmptyTitle>Ask about your records</EmptyTitle>
                <EmptyDescription>
                  Grok answers from your tasks, work logs, and the planned-versus-actual totals. It cannot change a task or add a session.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent aria-busy={running} className="gap-6 px-5 py-2">
                  {messages.map((message) =>
                    message.role === "user" ? (
                      <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end" variant="tinted">
                              <BubbleContent className="whitespace-pre-wrap">
                                {message.content}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ) : (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
                        <Message>
                          <MessageContent>
                            <MessageHeader>Grok</MessageHeader>
                            <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                              {message.content}
                            </p>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  )}
                  {running ? (
                    <MessageScrollerItem messageId="pending">
                      <Message>
                        <MessageContent>
                          <MessageHeader>Grok</MessageHeader>
                          <p className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            Asking Grok
                          </p>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          )}
        </div>

        <div className="flex flex-col gap-3 px-5 pt-3 pb-5">
          {messages.length === 0 ? (
            <div className="no-scrollbar flex gap-2 overflow-x-auto overscroll-x-contain">
              {STARTERS.map((starter) => (
                <Button
                  key={starter}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={running}
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

          <form ref={formRef} onSubmit={onSubmit}>
            <InputGroup>
              <InputGroupTextarea
                value={draft}
                rows={2}
                maxLength={2000}
                disabled={running}
                placeholder="Ask a question about your records"
                aria-label="Question"
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
                  disabled={!canSend}
                  className="ml-auto rounded-full"
                  aria-label="Send"
                >
                  <ArrowUp />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <p className="text-xs text-muted-foreground">
            Sent: task titles, notes, durations, and those totals. Withheld: your email, your display name, and window titles unless you have turned them on.
          </p>
        </div>
      </section>
    </MessageScrollerProvider>
  );
}
