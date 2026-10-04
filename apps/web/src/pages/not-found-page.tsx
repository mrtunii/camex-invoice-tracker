import { Link } from '@heroui/react';
import { PageHeader } from '@/components/page-header';

export function NotFoundPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Page not found" description="This address doesn't match any page." />
      <Link href="/" className="text-primary">
        Go to Home
      </Link>
    </div>
  );
}
