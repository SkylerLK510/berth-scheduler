import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DispatcherProvider } from "@/components/Dispatcher";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Berth Scheduler",
  description: "Berth reservations for the waterfront: vessels, events, double-booking and fit checks.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <DispatcherProvider>
          <Nav />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
          <footer className="px-4 py-4 text-center text-xs text-slate-400">
            Berth Scheduler · dates are inclusive whole days · anyone can view; changes need an account
          </footer>
        </DispatcherProvider>
      </body>
    </html>
  );
}
