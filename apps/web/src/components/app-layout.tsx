import {
  Button,
  Drawer,
  Dropdown,
  Header,
  Label,
  Link,
  Separator,
  Tooltip,
  cn,
  useMediaQuery,
} from '@heroui/react';
import {
  ChevronsUpDown,
  FileText,
  House,
  Inbox,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  Store,
  Sun,
  Users,
} from 'lucide-react';
import { type ComponentType, Suspense, useState } from 'react';
import { Outlet, useLocation, useMatches } from 'react-router';
import { AppToasts } from '@/components/app-toasts';
import { ChangePasswordDialog } from '@/components/change-password-dialog';
import { PageFallback } from '@/components/root-layout';
import { useLogout } from '@/lib/auth';
import { useCurrentUser } from '@/lib/current-user';
import { type ThemeChoice, useThemeChoice } from '@/lib/theme';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

// Daily work at the top; Team and the user menu at the bottom.
const MAIN_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/vendors', label: 'Vendors', icon: Store },
];
const TEAM_NAV: NavItem = { to: '/team', label: 'Team', icon: Users };

/** ≥ 1024 px: the sidebar shows labels; below, icons with a tooltip. */
const WIDE = '(min-width: 1024px)';

function isActive(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

function Wordmark({ compact }: { compact: boolean }) {
  return compact ? (
    <span className="text-base font-bold" aria-label="Camex Invoices">
      C
    </span>
  ) : (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-base font-bold">Camex</span>
      <span className="text-base text-muted">Invoices</span>
    </span>
  );
}

function SidebarLink({ item, compact }: { item: NavItem; compact: boolean }) {
  const { pathname } = useLocation();
  const active = isActive(pathname, item.to);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.to}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? item.label : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-3 rounded-control px-2.5 text-sm text-foreground no-underline outline-none hover:no-underline focus-visible:focus-ring',
        compact && 'justify-center px-0',
        // The current page is a neutral grey, not the accent: colour stays for actions and alerts.
        active ? 'bg-default font-medium' : 'hover:bg-default/60',
      )}
    >
      <Icon className={cn('size-[18px] shrink-0', !active && 'text-muted')} aria-hidden />
      {!compact && item.label}
    </Link>
  );
  if (!compact) return link;
  return (
    <Tooltip delay={0} closeDelay={0}>
      {link}
      <Tooltip.Content placement="right">{item.label}</Tooltip.Content>
    </Tooltip>
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

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

function UserMenu({ compact }: { compact: boolean }) {
  const user = useCurrentUser();
  const logout = useLogout();
  const { theme, setTheme } = useThemeChoice();
  const [changingPassword, setChangingPassword] = useState(false);

  return (
    <>
      <Dropdown>
        <Dropdown.Trigger
          aria-label={`Account and settings for ${user.name}`}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-control p-1.5 text-left outline-none hover:bg-default focus-visible:focus-ring',
            compact && 'justify-center',
          )}
        >
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-control bg-default text-xs font-semibold"
          >
            {initials(user.name)}
          </span>
          {!compact && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{user.name}</span>
                <span className="block truncate text-xs text-muted">{user.email}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden />
            </>
          )}
        </Dropdown.Trigger>
        <Dropdown.Popover placement={compact ? 'right bottom' : 'top start'} className="min-w-60">
          <Dropdown.Menu aria-label="Account and settings">
            <Dropdown.Section
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set([theme])}
              onSelectionChange={(keys) => {
                const [next] = keys === 'all' ? [] : [...keys];
                if (next === 'light' || next === 'dark' || next === 'system') setTheme(next);
              }}
            >
              <Header>Theme</Header>
              {THEMES.map(({ id, label }) => (
                <Dropdown.Item key={id} id={id} textValue={label}>
                  <Dropdown.ItemIndicator type="dot" />
                  <Label>{label}</Label>
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
            <Separator />
            <Dropdown.Section>
              <Header className="truncate font-normal">Signed in as {user.email}</Header>
              <Dropdown.Item
                id="change-password"
                textValue="Change password"
                onAction={() => setChangingPassword(true)}
              >
                <KeyRound className="size-4 text-muted" aria-hidden />
                <Label>Change password</Label>
              </Dropdown.Item>
              <Dropdown.Item id="sign-out" textValue="Sign out" onAction={() => logout.mutate()}>
                <LogOut className="size-4 text-muted" aria-hidden />
                <Label>Sign out</Label>
              </Dropdown.Item>
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </>
  );
}

/** One click between light and dark; the user menu also offers "System". */
function ThemeToggle({ compact }: { compact: boolean }) {
  const { resolved, setTheme } = useThemeChoice();
  const label = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Tooltip delay={0} closeDelay={0}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={label}
        onPress={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
        className="shrink-0 text-muted"
      >
        {resolved === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </Button>
      <Tooltip.Content placement={compact ? 'right' : 'bottom'}>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function Sidebar({ compact }: { compact: boolean }) {
  return (
    <div className="flex h-full flex-col gap-6 px-3 py-4">
      {/* The theme toggle sits beside the wordmark; the icon-only sidebar has no room there. */}
      <div
        className={cn(
          'flex h-8 items-center justify-between pl-2.5',
          compact && 'justify-center pl-0',
        )}
      >
        <Wordmark compact={compact} />
        {!compact && <ThemeToggle compact={false} />}
      </div>
      <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
        {MAIN_NAV.map((item) => (
          <SidebarLink key={item.to} item={item} compact={compact} />
        ))}
        <div className="mt-auto flex flex-col gap-1">
          <SidebarLink item={TEAM_NAV} compact={compact} />
        </div>
      </nav>
      {compact && (
        <div className="flex justify-center">
          <ThemeToggle compact />
        </div>
      )}
      <UserMenu compact={compact} />
    </div>
  );
}

/**
 * The signed-in shell. A 224 px sidebar on the left; below 1024 px it shrinks to icons, and below
 * 640 px it becomes a drawer behind a menu button. Content is centred in the space beside the
 * sidebar, at most 1440 px wide, except on full-bleed routes (the invoice split view).
 */
export function AppLayout() {
  const wide = useMediaQuery(WIDE, { initializeWithValue: true });
  // A route can take the whole content area (the invoice split view) via `handle.fullBleed`.
  const fullBleed = useMatches().some(
    (match) =>
      typeof match.handle === 'object' &&
      match.handle !== null &&
      'fullBleed' in match.handle &&
      match.handle.fullBleed === true,
  );
  // The drawer belongs to the page it was opened on: following a link in it closes it.
  const location = useLocation();
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const drawerOpen = openedOn === location.key;
  const setDrawerOpen = (open: boolean) => setOpenedOn(open ? location.key : null);

  return (
    <div className="flex min-h-svh flex-col bg-background sm:flex-row">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-background px-2 sm:hidden">
        <Button
          isIconOnly
          variant="ghost"
          aria-label="Open navigation"
          onPress={() => setDrawerOpen(true)}
        >
          <Menu aria-hidden />
        </Button>
        <Wordmark compact={false} />
      </header>
      <Drawer.Backdrop isOpen={drawerOpen} onOpenChange={setDrawerOpen} className="sm:hidden">
        <Drawer.Content placement="left">
          <Drawer.Dialog aria-label="Navigation" className="h-full w-sidebar p-0">
            <Sidebar compact={false} />
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      <aside className="hidden w-sidebar-collapsed shrink-0 border-r border-line bg-surface sm:block lg:w-sidebar">
        <div className="sticky top-0 h-svh">
          <Sidebar compact={!wide} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <main
          className={
            fullBleed
              ? 'min-w-0'
              : 'mx-auto max-w-[1440px] px-4 pt-6 pb-16 sm:px-8 sm:pt-8 lg:px-10'
          }
        >
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <AppToasts />
    </div>
  );
}
