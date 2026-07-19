import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppHeader } from "./components/AppHeader";
import { CurrentGameweekProvider } from "./lib/gameweekContext";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Fantasy League",
    template: "%s — Fantasy League",
  },
  description: "Private fantasy Premier League with friends: build a squad, make transfers, top the table.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CurrentGameweekProvider>
          <AppHeader />
          {children}
        </CurrentGameweekProvider>
      </body>
    </html>
  );
}
