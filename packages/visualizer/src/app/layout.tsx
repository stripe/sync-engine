import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stripe Schema Visualizer',
  description: 'Explore generated Stripe schema data with a browser-based SQL visualizer',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 font-sans antialiased">{children}</body>
    </html>
  )
}
