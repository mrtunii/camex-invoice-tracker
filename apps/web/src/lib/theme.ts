import { createContext, useContext } from 'react';

/** Light (the default), dark, or follow the system setting. */
export type ThemeChoice = 'light' | 'dark' | 'system';

export interface ThemeState {
  theme: ThemeChoice;
  /** What is on screen: the choice, or the system setting while the choice is "system". */
  resolved: 'light' | 'dark';
  setTheme: (theme: ThemeChoice) => void;
}

export const ThemeContext = createContext<ThemeState | null>(null);

/** The theme choice and its setter (the user menu). Only usable below <ThemeProvider>. */
export function useThemeChoice(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error('useThemeChoice() must be used below <ThemeProvider>');
  return state;
}
