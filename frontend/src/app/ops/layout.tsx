import type { ReactNode } from 'react';
import { SectionShell } from '@/components/navigation/SectionShell';

export default function OpsLayout({ children }: { children: ReactNode }) {
  return <SectionShell>{children}</SectionShell>;
}
