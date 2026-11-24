import type { ReactNode } from 'react';
const P = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
export const IconDash = () => <P><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></P>;
export const IconChart = () => <P><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></P>;
export const IconDocs = () => <P><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></P>;
export const IconUser = () => <P size={18}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></P>;
export const IconLock = () => <P size={18}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></P>;
export const IconEye = ({ off }: { off?: boolean }) => <P size={18}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{off && <path d="M3 3l18 18" />}</P>;
export const IconSearch = () => <P size={18}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></P>;
export const IconLogout = () => <P size={18}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></P>;
export const IconCheck = () => <P><path d="M20 6L9 17l-5-5" /></P>;
export const IconEdit = () => <P><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></P>;
export const IconClock = () => <P><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></P>;
export const IconWarn = () => <P><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" /></P>;
export const IconSend = () => <P><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></P>;

export const IconGear = () => <P><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></P>;
export const IconFilter = () => <P><path d="M3 5h18l-7 8v6l-4 2v-8z" /></P>;
export const IconType = () => <P><path d="M4 7V5h16v2M9 19h6M12 5v14" /></P>;

export const IconUsers = () => <P><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.3c1.8.8 3 2.6 3 4.7" /></P>;

export const IconMail = () => <P><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></P>;

export const IconStd = () => <P><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.3 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z" /></P>;
export const IconDep = () => <P><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></P>;
