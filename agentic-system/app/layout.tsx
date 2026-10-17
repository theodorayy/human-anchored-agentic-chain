import { Geist_Mono, Public_Sans, IBM_Plex_Sans } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

const ibmPlexSansHeading = IBM_Plex_Sans({subsets:['latin'],variable:'--font-heading'});

const publicSans = Public_Sans({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata = { title: "Sisyphus", description: "Your life-admin assistant. It fills the forms with you and pauses for your approval." }

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", publicSans.variable, ibmPlexSansHeading.variable)}
    >
      <body>
        <ThemeProvider defaultTheme="light">{children}</ThemeProvider>
      </body>
    </html>
  )
}
