import AppShell from "../components/AppShell";

export default function LogEntryLayout({ children }) {
  return (
    <AppShell currentPath="/logs">
      <div className="mx-auto max-w-3xl">{children}</div>
    </AppShell>
  );
}
