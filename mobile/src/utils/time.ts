export function formatRelativeTime(value?: number | string | Date | null): string {
  if (!value) return '';
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value > 1e11 ? value : value * 1000);
  } else {
    const num = Number(value);
    if (!isNaN(num) && num > 0) {
      date = new Date(num > 1e11 ? num : num * 1000);
    } else {
      date = new Date(value);
    }
  }
  if (isNaN(date.getTime())) return typeof value === 'string' ? value : '';

  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));

  if (diffSec < 5) return '1s';
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo`;
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears}y`;
}

export function formatPresence(online: boolean, lastActive?: number | string | null): string {
  if (online) return '● Active now';
  if (lastActive) {
    const rel = formatRelativeTime(lastActive);
    if (rel) return `○ Active ${rel} ago`;
  }
  return '○ Offline';
}

export function getMessageTimestamp(
  msg: {id: string; timestamp?: number},
  fallbackCreated?: string,
): number {
  if (msg.id) {
    const parts = msg.id.split('_');
    if (parts.length >= 2) {
      const idTime = Number(parts[1]);
      if (!isNaN(idTime) && idTime > 1e11) {
        return idTime;
      }
    }
  }
  if (msg.timestamp && msg.timestamp > 1e11) return msg.timestamp;
  if (fallbackCreated) {
    const sec = Number(fallbackCreated);
    if (!isNaN(sec) && sec > 0) return sec > 1e11 ? sec : sec * 1000;
  }
  return msg.timestamp || Date.now();
}

