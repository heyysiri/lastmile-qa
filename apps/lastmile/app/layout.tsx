import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import './globals.css';
import './studio.css';
import './projects.css';
import { Shell } from '../components/Shell';

export const metadata: Metadata = { title: 'LastMile QA', description: 'Study how synthetic testers experience your connected application' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Shell>{children}</Shell></body>
    </html>
  );
}
