import { ChevronsUpDown, FileText, Inbox, KeyRound, LogOut, Store, Users } from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { ChangePasswordDialog } from '@/components/change-password-dialog';
import { useCurrentUser } from '@/lib/current-user';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLogout } from '@/lib/auth';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

// Daily work first; administration below the divider.
const workNav: NavItem[] = [
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/vendors', label: 'Vendors', icon: Store },
];
const adminNav: NavItem[] = [{ to: '/users', label: 'Users', icon: Users }];

function SidebarLink({ to, label, icon: Icon }: NavItem) {
  return (
    <NavLink
      to={to}
      className="relative flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-primary before:opacity-0 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground aria-[current=page]:before:opacity-100"
    >
      <Icon className="size-4 opacity-80" />
      {label}
    </NavLink>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function UserMenu() {
  const user = useCurrentUser();
  const logout = useLogout();
  const [changingPassword, setChangingPassword] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-sidebar-accent">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
            {initials(user.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-sidebar-accent-foreground">
              {user.name}
            </span>
            <span className="block truncate font-mono text-xs">{user.email}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            Signed in as {user.email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setChangingPassword(true)}>
            <KeyRound />
            Change password
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => logout.mutate()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </>
  );
}

export function AppLayout() {
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 bg-sidebar p-3 md:sticky md:top-0 md:h-svh md:w-60">
        <div className="flex items-baseline gap-2 px-3 pt-2 pb-1">
          <span className="text-lg font-bold tracking-tight text-white">Camex</span>
          <span className="text-sm text-sidebar-foreground">Invoice Tracker</span>
        </div>

        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible"
        >
          {workNav.map((item) => (
            <SidebarLink key={item.to} {...item} />
          ))}
          <div
            className="mx-1 w-px shrink-0 bg-sidebar-border md:my-2 md:h-px md:w-auto"
            role="separator"
          />
          {adminNav.map((item) => (
            <SidebarLink key={item.to} {...item} />
          ))}
        </nav>

        <div className="md:mt-auto">
          <UserMenu />
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
