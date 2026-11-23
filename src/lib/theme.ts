/**
 * Light / dark mode.
 * The choice ('light' | 'dark' | 'system') is saved on this device; 'system' follows the OS setting.
 * The resolved theme is set as <html data-theme="light|dark">, and the CSS variables in index.css
 * do the rest. index.html applies it before React loads, so the page never flashes white.
 */
import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
const KEY = 'tradmak.theme'
const CHANGE_EVENT = 'tradmak:theme'
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  return choice === 'system' ? (darkQuery().matches ? 'dark' : 'light') : choice
}

function apply(choice: ThemeChoice) {
  const theme = resolveTheme(choice)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // storage unavailable: still switch for this visit
  }
  apply(choice)
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

/** Call once at startup: applies the saved choice and follows OS changes while on "system". */
export function initTheme() {
  apply(getThemeChoice())
  darkQuery().addEventListener('change', () => {
    if (getThemeChoice() === 'system') {
      apply('system')
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
    }
  })
}

/** The current choice and the theme actually showing; re-renders when either changes. */
export function useTheme() {
  const [state, setState] = useState(() => ({ choice: getThemeChoice(), theme: resolveTheme(getThemeChoice()) }))
  useEffect(() => {
    const update = () => setState({ choice: getThemeChoice(), theme: resolveTheme(getThemeChoice()) })
    window.addEventListener(CHANGE_EVENT, update)
    return () => window.removeEventListener(CHANGE_EVENT, update)
  }, [])
  return { ...state, setChoice: setThemeChoice }
}
