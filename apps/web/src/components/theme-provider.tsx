import { useTheme } from '@heroui/react';
import { type ReactNode, useMemo } from 'react';
import { ThemeContext, type ThemeState } from '@/lib/theme';

/**
 * The one theme controller (HeroUI's useTheme): it stores the choice in localStorage
 * ('heroui-theme'), follows the system while the choice is "system", and sets the `dark`/`light`
 * class and data-theme on <html>. index.html applies the stored choice before the first paint.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme('system');
  const value = useMemo<ThemeState>(
    () => ({ theme: theme === 'light' || theme === 'dark' ? theme : 'system', setTheme }),
    [theme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
