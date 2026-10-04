import { Link } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Page not found" description="This address doesn't match any page." />
      <Button asChild variant="outline">
        <Link to="/invoices">Go to invoices</Link>
      </Button>
    </div>
  );
}
