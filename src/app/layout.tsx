import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { AppHeader } from "./components/AppHeader";
import { CurrentGameweekProvider } from "./lib/gameweekContext";
import "./globals.css";

/* Three type roles, matchday-programme direction:
 *  - display: Archivo, carried wide and heavy. The wdth axis is what gives headings and shirt
 *    numbers their jersey-back weight; a condensed face would read as newsprint instead.
 *  - body: IBM Plex Sans. Legible at the small sizes the data tables need, with more character
 *    than the system stack it replaces.
 *  - data: IBM Plex Mono, for every figure a manager compares against another figure — prices,
 *    points, minutes, deadlines, invite codes. Tabular by construction, so columns line up. */
const displayTypeface = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-display",
  display: "swap",
});

const bodyTypeface = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

const dataTypeface = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-data",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Fantasy League",
    template: "%s — Fantasy League",
  },
  description: "Private fantasy Premier League with friends: build a squad, make transfers, top the table.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${displayTypeface.variable} ${bodyTypeface.variable} ${dataTypeface.variable}`}
    >
      <body>
        <CurrentGameweekProvider>
          <AppHeader />
          {children}
        </CurrentGameweekProvider>
      </body>
    </html>
  );
}
