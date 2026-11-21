import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Nav } from '../components/Nav';
import './globals.css';

export const metadata: Metadata = { title: 'Seller Hub', description: 'Local seller workbench for the LastMile QA demo' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar"><div className="topbar-inner"><Link className="brand" href="/">Seller<span>Hub</span></Link><Nav /></div></header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
