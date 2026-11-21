'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Nav() {
  const path = usePathname();
  const items = [['/onboarding', 'Store setup'], ['/inventory', 'Inventory']] as const;
  return (
    <nav aria-label="Seller sections">
      {items.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</Link>
      ))}
    </nav>
  );
}
