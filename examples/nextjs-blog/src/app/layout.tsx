// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { ReactNode } from 'react';

export const metadata = {
  title: 'HeoPress Next.js Blog',
  description: 'Posts served from a HeoPress collection.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, backgroundColor: '#fff' }}>{children}</body>
    </html>
  );
}
