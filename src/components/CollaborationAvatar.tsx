'use client';

import Image from 'next/image';
import { useState } from 'react';

type CollaborationAvatarSize = 'xs' | 'sm' | 'lg';

type CollaborationAvatarProps = {
  name: string;
  src?: string;
  initials?: string;
  size?: CollaborationAvatarSize;
  className?: string;
};

const SIZE_STYLES: Record<CollaborationAvatarSize, { className: string; pixels: number }> = {
  xs: { className: 'h-5 w-5 text-[8px]', pixels: 20 },
  sm: { className: 'h-6 w-6 text-[9px]', pixels: 24 },
  lg: { className: 'h-14 w-14 text-lg', pixels: 56 },
};

function getNameInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '--';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export default function CollaborationAvatar({
  name,
  src,
  initials,
  size = 'sm',
  className = '',
}: CollaborationAvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const sizeStyle = SIZE_STYLES[size];

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)] font-bold text-white ring-1 ring-black/10 dark:ring-white/15 ${sizeStyle.className} ${className}`}
      role="img"
      aria-label={`${name} profile photo`}
      title={name}
    >
      {src && failedSrc !== src ? (
        <Image
          src={src}
          alt=""
          aria-hidden="true"
          width={sizeStyle.pixels}
          height={sizeStyle.pixels}
          unoptimized
          draggable={false}
          className="h-full w-full object-cover"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span aria-hidden="true">{initials || getNameInitials(name)}</span>
      )}
    </span>
  );
}
