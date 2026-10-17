import { Inter } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

// Inter is the only typeface in the Sisyphus design system; --font-sans resolves to it in globals.css.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })

export const metadata = { title: "Sisyphus", description: "Your life-admin assistant. It fills the forms with you and pauses for your approval." }

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en-GB"
      suppressHydrationWarning
      className={cn("antialiased", "font-sans", inter.variable)}
    >
      <body>
        <ThemeProvider defaultTheme="light">{children}</ThemeProvider>
      </body>
    </html>
  )
}
