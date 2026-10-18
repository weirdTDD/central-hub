import { Link } from "react-router-dom";

export default function LogEntryLayout({ children }) {
  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-zinc-950 dark:text-gray-100">
      <header className="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-zinc-800">
        <Link to="/dashboard" className="inline-flex items-center">
          <img src="/logo.svg" alt="Dailylogs" className="h-10 w-auto object-contain" />
        </Link>
        <div className="flex items-center gap-2">
          <img
            src="https://i.pravatar.cc/150?u=kwakye"
            alt=""
            className="h-8 w-8 rounded-full object-cover"
          />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Kwakye</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
    </div>
  );
}
