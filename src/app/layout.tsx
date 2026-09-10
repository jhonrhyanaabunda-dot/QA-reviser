import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "QA Reviser",
  description:
    "Audit dealership articles for accuracy, links, AI writing patterns and QA-rule compliance.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {

  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b" style={{ borderColor: "var(--border)" }}>
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span
                className="grid h-6 w-6 place-items-center rounded text-xs font-bold text-white"
                style={{ background: "var(--accent)" }}
                aria-hidden
              >
                QA
              </span>
              QA Reviser
            </Link>

            <nav className="flex items-center gap-1 text-sm">
              <Link className="btn" href="/">New audit</Link>
              <Link className="btn" href="/audits">Audits</Link>
              <Link className="btn" href="/dealerships">Dealerships</Link>
              <Link className="btn" href="/rules">Rules</Link>
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>

        <footer className="mx-auto max-w-6xl px-5 pb-10 pt-4 text-xs muted">
          Findings are advisory. Verify pricing, specifications and compliance claims
          before publishing.
        </footer>
      </body>
    </html>
  );
}
