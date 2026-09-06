import type { Metadata } from 'next'
import { Poppins } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

// Geometric sans matching the TransPay product deck. Self-hosted by next/font
// at build time, so the running app makes no request to a font CDN.
const brandFont = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-brand',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'TransPay — Simulated chat (demo)',
  description:
    'TransPay demo: USD → PHP remittance flow with a simulated chat interface. No real messaging platform integration.',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={brandFont.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
