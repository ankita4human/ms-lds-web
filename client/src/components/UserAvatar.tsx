import { useEffect, useState } from 'react';

/** Photo of a user from /photos/<IdAcc>.jpg (drop the files into client/public/photos); a neutral silhouette when there is none. */
export default function UserAvatar({ id, className = 'avatar', title }: { id?: number; className?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [id]);
  if (id && !failed) return <img className={className} src={`/photos/${id}.jpg`} alt="" title={title} onError={() => setFailed(true)} />;
  return (
    <svg className={`${className} avatar-ph`} viewBox="0 0 64 64" role="img" aria-label={title ?? 'No photo'} xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="avph-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#cfd8e6" /><stop offset="1" stopColor="#9fb0c8" /></linearGradient></defs>
      <rect width="64" height="64" fill="url(#avph-bg)" />
      <circle cx="32" cy="24" r="11" fill="#6b7c96" opacity=".85" />
      <path d="M8 64c0-13 10-21 24-21s24 8 24 21z" fill="#6b7c96" opacity=".85" />
    </svg>
  );
}
