import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, Lang } from './api';

const KEY = 'pl_lang';
type Ctx = { lang: string; setLang: (l: string) => void; languages: Lang[] };
const LangCtx = createContext<Ctx>({ lang: '', setLang: () => {}, languages: [] });
export const useLang = () => useContext(LangCtx);

export function LangProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['languages'], queryFn: api.languages });
  const languages = q.data ?? [];
  const [lang, setLangState] = useState(() => localStorage.getItem(KEY) ?? '');
  // Pick a valid language once the list is known: saved choice, else EN, else the first one.
  useEffect(() => {
    if (!languages.length) return;
    if (!languages.some(l => l.lang === lang)) {
      const next = languages.find(l => l.lang === 'EN')?.lang ?? languages[0].lang;
      setLangState(next);
    }
  }, [languages, lang]);
  const setLang = (l: string) => { localStorage.setItem(KEY, l); setLangState(l); };
  return <LangCtx.Provider value={{ lang, setLang, languages }}>{children}</LangCtx.Provider>;
}
