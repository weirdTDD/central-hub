import AppShell from "../../components/AppShell";
import AskPanel from "./AskPanel.jsx";

/**
 * The chat, on its own page.
 *
 * Reports embeds the same panel scoped to the report's date range. Here the
 * question is about the records as a whole.
 */
export default function AskPage() {
  return (
    <AppShell currentPath="/ask" className="flex flex-col">
      <AskPanel className="mx-auto min-h-[32rem] w-full max-w-3xl flex-1" />
    </AppShell>
  );
}
