import type { ReactNode } from 'react';
import { SectionShell } from '@/components/navigation/SectionShell';

export default function PaymentsLayout({ children }: { children: ReactNode }) {
  return <SectionShell>{children}</SectionShell>;
}
