import type { ReactNode } from 'react';
import { SectionShell } from '@/components/navigation/SectionShell';

export default function FleetLayout({ children }: { children: ReactNode }) {
  return <SectionShell>{children}</SectionShell>;
}
