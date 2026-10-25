import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-5xl font-bold text-slate-300">403</p>
      <h1 className="text-lg font-semibold">You don&apos;t have access to this page</h1>
      <p className="text-sm text-slate-500">Ask your administrator if you need this permission.</p>
      <Link href="/dashboard" className="text-sm font-medium text-brand-700 hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
